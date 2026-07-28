import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAcpClient } from "../../../apps/desktop/src/mobile-control/acp-client.mjs";
import { createAcpRuntime } from "../../../apps/desktop/src/mobile-control/acp-runtime.mjs";
import { createClaudeRuntime, parseClaudeJsonl, cleanClaudeUserText } from "../../../apps/desktop/src/mobile-control/claude-runtime.mjs";
import { parseCodexRollout, cleanCodexUserPart } from "../../../apps/desktop/src/mobile-control/codex-runtime.mjs";
import { createGrokRuntime, parseGrokChatHistory, cleanGrokUserText } from "../../../apps/desktop/src/mobile-control/grok-runtime.mjs";
import { createOpenCodeRuntime } from "../../../apps/desktop/src/mobile-control/opencode-runtime.mjs";
import { materializeImageAttachments } from "../../../apps/desktop/src/mobile-control/temp-attachments.mjs";
import { toolFrom } from "../../../apps/desktop/src/mobile-control/message-parts.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    write(value) {
      this.writes.push(String(value));
      return true;
    },
    end() {}
  };
  child.kill = () => {};
  return child;
}

test("mobile image materialization is private and cannot escape its temporary directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-attachment-test-"));
  try {
    const materialized = materializeImageAttachments([{
      kind: "image",
      name: "../../outside.png",
      mimeType: "image/png",
      data: "aW1hZ2U="
    }], { root });
    const [image] = materialized.files;
    assert.equal(fs.statSync(materialized.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(image.path).mode & 0o777, 0o600);
    assert.equal(path.dirname(image.path), materialized.directory);
    assert.equal(path.basename(image.path), "01-outside.png");
    assert.equal(fs.existsSync(path.join(root, "outside.png")), false);
    materialized.cleanup();
    assert.equal(fs.existsSync(materialized.directory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACP client negotiates protocol and separates responses, notifications and requests", async () => {
  const child = fakeChild();
  const client = createAcpClient({
    command: "fake-agent",
    spawnProcess: () => child
  });
  const frames = [];
  client.subscribe((frame) => frames.push(frame));
  const connecting = client.connect();
  const initialize = JSON.parse(child.stdin.writes[0]);
  assert.deepEqual(initialize, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "switchyard", title: "Switchyard", version: "2.2.33" }
    }
  });
  child.stdout.emit("data", `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, fork: {}, delete: {} } }
    }
  })}\n`);
  await connecting;

  child.stdout.emit("data", [
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "你好" } }
      }
    }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "session/request_permission",
      params: { sessionId: "s1", options: [{ optionId: "allow_once", name: "Allow once" }] }
    })
  ].join("\n") + "\n");

  assert.deepEqual(frames.map((frame) => frame.kind), ["notification", "request"]);
  client.respond(99, { outcome: { outcome: "selected", optionId: "allow_once" } });
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), {
    jsonrpc: "2.0",
    id: 99,
    result: { outcome: { outcome: "selected", optionId: "allow_once" } }
  });
  client.close();
});

function fakeClient() {
  const calls = [];
  const subscribers = new Set();
  return {
    calls,
    initializeResult: {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, fork: {}, delete: {}, close: {} }
      }
    },
    async connect() {
      return this.initializeResult;
    },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "session/list") {
        return {
          sessions: [{
            sessionId: "s1",
            cwd: "/Users/alice/code/demo",
            title: "演示任务",
            updatedAt: "2026-07-23T12:00:00.000Z"
          }]
        };
      }
      if (method === "session/load") {
        this.emit({
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "继续" } }
          }
        });
        this.emit({
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "s1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已完成" } }
          }
        });
        return { models: { currentModelId: "m1", availableModels: [] } };
      }
      if (method === "session/new") return { sessionId: "s-new" };
      if (method === "session/fork") return { sessionId: "s-fork" };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    },
    notify(method, params) {
      calls.push({ method, params, notification: true });
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    emit(frame) {
      for (const listener of subscribers) listener(frame);
    },
    respond() {}
  };
}

test("ACP runtime lists, loads, prompts, cancels, switches model, forks and deletes", async () => {
  const client = fakeClient();
  const runtime = createAcpRuntime({ id: "claude-code", label: "Claude Code", client });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  const sessions = await runtime.listSessions();
  assert.equal(sessions[0].id, "s1");
  assert.equal(sessions[0].project, "demo");
  const detail = await runtime.readSession("s1");
  assert.deepEqual(detail.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "继续" },
    { role: "assistant", text: "已完成" }
  ]);
  assert.deepEqual(await runtime.createSession({ cwd: "/Users/alice/code/demo", model: "m2" }), {
    sessionId: "s-new"
  });
  assert.deepEqual(await runtime.sendMessage("s-new", { text: "开始", messageId: "8ab23d57-a941-49e6-b4cc-d3fe88c9a207" }), {
    accepted: true
  });
  await runtime.setModel("s-new", "m3");
  await runtime.cancel("s-new");
  assert.deepEqual(await runtime.fork("s1"), { sessionId: "s-fork" });
  await runtime.delete("s1");

  assert.ok(events.some((event) => event.type === "message" && event.summary === "已完成"));
  client.emit({
    kind: "notification",
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "Review changes" }] } }
  });
  assert.equal(events.some((event) => event.summary === "available_commands_update"), false);
  assert.deepEqual(runtime.listCommands(), [{ name: "review", description: "Review changes" }]);
  assert.deepEqual(client.calls.map((call) => call.method), [
    "session/list",
    "session/load",
    "session/new",
    "session/set_model",
    "session/prompt",
    "session/set_model",
    "session/cancel",
    "session/fork",
    "session/delete"
  ]);
});

test("ACP runtimes preserve mobile images as native image prompt blocks", async () => {
  const client = fakeClient();
  const runtime = createAcpRuntime({ id: "grok", label: "Grok Build", client });
  await runtime.createSession({ cwd: "/tmp/demo" });
  await runtime.sendMessage("s-new", {
    text: "描述图片",
    attachments: [{
      kind: "image",
      name: "screen.webp",
      mimeType: "image/webp",
      data: "aW1hZ2U="
    }]
  });
  const call = client.calls.filter((item) => item.method === "session/prompt").at(-1);
  assert.deepEqual(call.params.prompt, [
    { type: "text", text: "描述图片" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/webp" }
  ]);
});

test("ACP runtimes describe arbitrary uploaded files with a readable local path", async () => {
  const client = fakeClient();
  const runtime = createAcpRuntime({ id: "grok", label: "Grok", client });
  await runtime.createSession({ cwd: "/tmp/demo" });
  await runtime.sendMessage("s1", {
    text: "检查附件",
    attachments: [{
      kind: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
      path: "/tmp/switchyard/report.pdf"
    }]
  });
  const prompt = client.calls.find((call) => call.method === "session/prompt").params.prompt;
  assert.equal(prompt.length, 1);
  assert.match(prompt[0].text, /report\.pdf/);
  assert.match(prompt[0].text, /\/tmp\/switchyard\/report\.pdf/);
});

test("Claude, Grok and OpenCode wrappers expose overlay session management without shell access", () => {
  const overlayCalls = [];
  const overlay = {
    rename: async (id, title) => overlayCalls.push(["rename", id, title]),
    archive: async (id) => overlayCalls.push(["archive", id]),
    unarchive: async (id) => overlayCalls.push(["unarchive", id])
  };
  const client = fakeClient();
  const runtimes = [
    createClaudeRuntime({ client, overlay }),
    createGrokRuntime({ client, overlay }),
    createOpenCodeRuntime({ client, overlay })
  ];
  assert.deepEqual(runtimes.map((runtime) => runtime.id), ["claude-code", "grok", "opencode"]);
  for (const runtime of runtimes) {
    assert.equal(runtime.capabilities.sendMessage, true);
    assert.equal(runtime.capabilities.setModel, true);
    assert.equal(runtime.capabilities.rename, true);
    assert.equal(runtime.capabilities.archive, true);
    assert.equal(runtime.capabilities.shell, undefined);
    assert.equal(runtime.capabilityModes.rename, "overlay");
    assert.equal(runtime.capabilityModes.archive, "overlay");
  }
});

test("OpenCode uses native run transport for historical sessions when ACP load is unreliable", async () => {
  const calls = [];
  const child = fakeChild();
  const runtime = createOpenCodeRuntime({
    client: fakeClient(),
    storageRoot: "/missing-opencode-storage",
    spawnProcess: (_command, args) => {
      calls.push(args);
      queueMicrotask(() => {
        if (args[0] === "session" && args[1] === "list") {
          child.stdout.emit("data", JSON.stringify([{ id: "ses-history", title: "历史任务", directory: "/tmp/demo", updated: 10 }]));
          child.emit("close", 0);
          return;
        }
        child.stdout.emit("data", `${JSON.stringify({ type: "text", part: { type: "text", text: "继续成功" } })}\n`);
        child.stdout.emit("data", `${JSON.stringify({ type: "step_finish", part: { reason: "stop" } })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  const listed = await runtime.listSessions();
  assert.equal(listed[0].id, "ses-history");
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await runtime.sendMessage("ses-history", { text: "继续" });
  assert.deepEqual(calls, [
    ["session", "list", "--format", "json"],
    ["run", "--session", "ses-history", "--dir", "/tmp/demo", "--format", "json", "继续"]
  ]);
  assert.ok(events.some((event) => event.type === "message" && event.summary === "继续成功"));
  assert.equal((await runtime.readSession("ses-history")).messages.at(-1).text, "继续成功");
});

test("OpenCode exposes ACP available commands without rendering chat events", () => {
  const client = fakeClient();
  const runtime = createOpenCodeRuntime({
    client,
    storageRoot: "/missing-opencode-storage"
  });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  client.emit({
    kind: "notification",
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate: "available_commands_update",
        commands: [{ name: "review", description: "Review changes" }]
      }
    }
  });

  assert.deepEqual(runtime.listCommands(), [
    { name: "review", description: "Review changes" }
  ]);
  assert.equal(events.length, 0);
});

test("OpenCode creates mobile sessions lazily through native run and binds the real session id", async () => {
  const client = fakeClient();
  const spawned = [];
  const child = fakeChild();
  const runtime = createOpenCodeRuntime({
    client,
    storageRoot: "/missing-opencode-storage",
    spawnProcess: (_command, args) => {
      spawned.push(args);
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ type: "text", sessionID: "ses-native-new", part: { type: "text", text: "识图成功" } })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  const created = await runtime.createSession({ cwd: "/tmp/demo", model: "switchyard/hus-claude/claude-sonnet-5" });
  await runtime.sendMessage(created.sessionId, {
    text: "图片是什么内容",
    attachments: [{
      kind: "image",
      name: "screen.jpg",
      mimeType: "image/jpeg",
      data: "aW1hZ2U="
    }]
  });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].slice(0, 6), ["run", "--dir", "/tmp/demo", "--format", "json", "--model"]);
  assert.ok(spawned[0].some((arg) => arg.startsWith("--file=")));
  assert.deepEqual(client.calls, []);
});

test("OpenCode keeps stale local history visible but starts a replacement session instead of returning Session not found", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-opencode-stale-"));
  const staleId = "ses_stale_local";
  fs.mkdirSync(path.join(root, "message", staleId), { recursive: true });
  fs.writeFileSync(path.join(root, "message", staleId, "msg-1.json"), JSON.stringify({
    id: "msg-1", sessionID: staleId, role: "user", time: { created: 1 },
    path: { cwd: "/tmp/demo", root: "/tmp/demo" }
  }));
  const spawned = [];
  try {
    const runtime = createOpenCodeRuntime({
      client: fakeClient(),
      storageRoot: root,
      spawnProcess: (_command, args) => {
        spawned.push(args);
        const child = fakeChild();
        queueMicrotask(() => {
          if (args[0] === "session") child.stdout.emit("data", "[]");
          else child.stdout.emit("data", `${JSON.stringify({ type: "text", sessionID: "ses-replacement", part: { type: "text", text: "继续成功" } })}\n`);
          child.emit("close", 0);
        });
        return child;
      }
    });
    const listed = await runtime.listSessions();
    assert.equal(listed.some((row) => row.id === staleId), true);
    await runtime.sendMessage(staleId, {
      text: "继续",
      attachments: [{ kind: "image", name: "screen.png", mimeType: "image/png", data: "aW1hZ2U=" }]
    });
    const runArgs = spawned.find((args) => args[0] === "run");
    assert.ok(runArgs);
    assert.equal(runArgs.includes("--session"), false);
    assert.ok(runArgs.some((arg) => arg.startsWith("--file=")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("OpenCode materializes mobile images and passes them with unambiguous --file= arguments", async () => {
  const filePaths = [];
  const child = fakeChild();
  const runtime = createOpenCodeRuntime({
    client: fakeClient(),
    storageRoot: "/missing-opencode-storage",
    spawnProcess: (_command, args) => {
      queueMicrotask(() => {
        if (args[0] === "session") {
          child.stdout.emit("data", JSON.stringify([{ id: "ses-image", title: "图片任务", directory: "/tmp/demo", updated: 10 }]));
          child.emit("close", 0);
          return;
        }
        assert.equal(args.includes("--file"), false);
        const fileArg = args.find((arg) => arg.startsWith("--file="));
        assert.ok(fileArg);
        filePaths.push(fileArg.slice("--file=".length));
        assert.equal(args.at(-2), "描述图片");
        assert.equal(fs.existsSync(filePaths[0]), true);
        child.stdout.emit("data", `${JSON.stringify({ type: "step_finish", part: { reason: "stop" } })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  await runtime.listSessions();
  await runtime.sendMessage("ses-image", {
    text: "描述图片",
    attachments: [{
      kind: "image",
      name: "screen.jpg",
      mimeType: "image/jpeg",
      data: "aW1hZ2U="
    }]
  });
  assert.match(filePaths[0], /switchyard-mobile-attachments-/);
  assert.equal(fs.existsSync(filePaths[0]), false);
});

test("Claude Code sends native image blocks in a complete stream-json user envelope", async () => {
  const child = fakeChild();
  const runtime = createClaudeRuntime({
    command: "claude-test",
    scanSessions: () => [{ sessionId: "claude-history", cwd: "/tmp/demo", mtimeMs: 1 }],
    spawnProcess: (_command, args) => {
      assert.deepEqual(args.slice(0, 4), ["-p", "--verbose", "--resume", "claude-history"]);
      assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  await runtime.sendMessage("claude-history", {
    text: "图片里是什么？",
    attachments: [{
      kind: "image",
      name: "screen.gif",
      mimeType: "image/gif",
      data: "aW1hZ2U="
    }]
  });
  const payload = JSON.parse(child.stdin.writes[0]);
  assert.equal(payload.type, "user");
  assert.equal(payload.message.role, "user");
  assert.equal(payload.message.content[0].text, "图片里是什么？");
  assert.deepEqual(payload.message.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/gif", data: "aW1hZ2U=" }
  });
});

test("grok local chat history maps user/assistant/reasoning/tool lines without ACP", () => {
  const messages = parseGrokChatHistory([
    JSON.stringify({ type: "system", content: "skip me" }),
    JSON.stringify({ type: "user", content: [{ type: "text", text: "你好" }] }),
    JSON.stringify({ type: "reasoning", content: "想一下" }),
    JSON.stringify({ type: "assistant", content: "完成" }),
    JSON.stringify({ type: "tool_result", content: "读取文件成功" })
  ]);
  assert.deepEqual(messages.map((m) => [m.role, m.kind, m.text]), [
    ["user", "text", "你好"],
    ["assistant", "thinking", "想一下"],
    ["assistant", "text", "完成"],
    ["tool", "tool", "读取文件成功"]
  ]);
});

test("grok user text strips system-reminder noise and unwraps user_query", () => {
  assert.equal(
    cleanGrokUserText("<system-reminder>MCP servers failed</system-reminder>\n<user_query>查询一下home</user_query>"),
    "查询一下home"
  );
  assert.equal(cleanGrokUserText("  直接说的话  "), "直接说的话");
  assert.equal(cleanGrokUserText("<system-reminder>x</system-reminder>"), "");
  assert.equal(
    cleanGrokUserText("OS Version: macos Shell: /bin/zsh Workspace Path: /Users/demo Today's date: 2026-07-24 Note: Prefer using relative paths"),
    ""
  );
});

test("OpenCode prefixes gateway model ids with its switchyard namespace and surfaces error frames", async () => {
  const calls = [];
  const child = fakeChild();
  const runtime = createOpenCodeRuntime({
    client: fakeClient(),
    storageRoot: "/missing-opencode-storage",
    spawnProcess: (_command, args) => {
      calls.push(args);
      queueMicrotask(() => {
        if (args[0] === "session") { child.stdout.emit("data", JSON.stringify([{ id: "ses_1", directory: "/tmp/demo", updated: 1 }])); child.emit("close", 0); return; }
        child.stdout.emit("data", `${JSON.stringify({ type: "error", error: { name: "UnknownError", data: { message: "Unexpected server error" } } })}\n`);
        child.emit("close", 1);
      });
      return child;
    }
  });
  await runtime.listSessions();
  await runtime.setModel("ses_1", "hus-claude/claude-sonnet-5");
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await assert.rejects(() => runtime.sendMessage("ses_1", { text: "hi" }), /OpenCode 执行失败/);
  const runArgs = calls.find((args) => args[0] === "run");
  const modelIndex = runArgs.indexOf("--model");
  assert.deepEqual(runArgs.slice(modelIndex, modelIndex + 2), ["--model", "switchyard/hus-claude/claude-sonnet-5"]);
  assert.ok(events.some((event) => event.type === "error" && event.summary.includes("Unexpected server error")));
});

test("claude history keeps only real user text and maps tool_result to tool cards", () => {
  const rows = parseClaudeJsonl([
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "测试" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /Users/x/.claude/plugins\n<SUBAGENT-STOP>\n<EXTREMELY-IMPORTANT>必须</EXTREMELY-IMPORTANT>" }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: [{ type: "text", text: "读取完成" }] }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "收到" }] } })
  ]);
  assert.deepEqual(rows.map((r) => [r.role, r.kind, r.text]), [
    ["user", "text", "测试"],
    ["tool", "tool", "读取完成"],
    ["assistant", "text", "收到"]
  ]);
  assert.equal(cleanClaudeUserText("<system-reminder>noise</system-reminder> 你好"), "你好");
});

test("codex rollout drops system-injected blocks and keeps real user text", () => {
  const rows = parseCodexRollout([
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [
      { type: "input_text", text: "<environment_context><cwd>/tmp</cwd></environment_context>" },
      { type: "input_text", text: "继续移动端优化" }
    ] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "好的" }] } })
  ]);
  assert.deepEqual(rows.map((r) => [r.role, r.kind, r.text]), [
    ["user", "text", "继续移动端优化"],
    ["assistant", "text", "好的"]
  ]);
  assert.equal(cleanCodexUserPart("<recommended_plugins>\n- Slack\n</recommended_plugins>"), "");
});

test("agent histories preserve structured tool details and collapsible reasoning content", () => {
  const codex = parseCodexRollout([
    JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "先检查文件" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "npm test"], workdir: "/Users/alice/demo" }) } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ output: "42 tests passed", metadata: { exit_code: 0 } }) } })
  ]);
  assert.equal(codex[0].kind, "thinking");
  assert.match(codex[0].text, /先检查文件/);
  assert.equal(codex[1].tool.id, "call-1");
  assert.equal(codex[1].tool.command, "bash -lc npm test");
  assert.match(codex[1].tool.output, /42 tests passed/);
  assert.equal(codex[1].tool.status, "completed");

  const claude = parseClaudeJsonl([
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "passed" }] } })
  ]);
  assert.equal(claude.length, 1);
  assert.equal(claude[0].tool.name, "Bash");
  assert.equal(claude[0].tool.command, "npm test");
  assert.equal(claude[0].tool.output, "passed");
});

test("Codex tool cards use the concrete command instead of the generic commandExecution type", () => {
  const command = toolFrom({ type: "commandExecution", arguments: JSON.stringify({ cmd: "git status --short" }) });
  const plan = toolFrom({ name: "update_plan", arguments: JSON.stringify({ plan: [] }) });
  const followup = toolFrom({ name: "write_stdin", arguments: JSON.stringify({ session_id: 12 }) });
  assert.equal(command.title, "执行：git status --short");
  assert.equal(plan.title, "更新执行计划");
  assert.equal(followup.title, "继续读取命令输出");
});

test("Codex, Claude Code, OpenCode and Grok tools share mobile activity categories", () => {
  const rows = {
    codex: toolFrom({ type: "command_execution", command: "npm test" }),
    claude: toolFrom({ name: "Read", input: { file_path: "/tmp/app.js" } }),
    opencode: toolFrom({ toolName: "grep", rawInput: { pattern: "tool", path: "apps/mobile" } }),
    grok: toolFrom({ kind: { tool_type: "str_replace" }, action: { path: "/tmp/app.js" } })
  };
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([agent, tool]) => [agent, tool.activity])), {
    codex: "command",
    claude: "read",
    opencode: "search",
    grok: "edit"
  });
});

test("tool normalization extracts file paths for mobile file links", () => {
  const tool = toolFrom({
    name: "Write",
    input: {
      file_path: "/tmp/demo/src/app.js",
      path: "/tmp/demo/src/other.js",
      content: "secret source text"
    }
  });
  assert.deepEqual(tool.files, [
    { path: "/tmp/demo/src/app.js", activity: "edit" },
    { path: "/tmp/demo/src/other.js", activity: "edit" }
  ]);
});

test("Codex rollout live projection emits assistant text and update_plan tool events", async () => {
  const { projectCodexRolloutLiveEntry } = await import("../../../apps/desktop/src/mobile-control/codex-runtime.mjs");
  const message = projectCodexRolloutLiveEntry({
    type: "event_msg",
    payload: { type: "agent_message", message: "正在实时输出" }
  });
  const plan = projectCodexRolloutLiveEntry({
    type: "response_item",
    payload: {
      type: "function_call",
      id: "plan-live",
      name: "update_plan",
      arguments: JSON.stringify({ plan: [{ step: "同步输出", status: "in_progress" }] })
    }
  });
  assert.deepEqual(message, {
    type: "message",
    role: "assistant",
    summary: "正在实时输出",
    runtimeEvent: "codex/rollout-agent-message"
  });
  assert.equal(plan.type, "tool");
  assert.equal(plan.tool.id, "plan-live");
  assert.equal(plan.tool.name, "update_plan");
  assert.equal(plan.tool.status, "running");
});

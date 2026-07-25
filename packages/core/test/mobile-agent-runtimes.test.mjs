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
      clientInfo: { name: "switchyard", title: "Switchyard", version: "2.2.20" }
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
    params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update" } }
  });
  assert.equal(events.some((event) => event.summary === "available_commands_update"), false);
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

test("OpenCode materializes mobile images and passes them with --file", async () => {
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
        const fileIndex = args.indexOf("--file");
        assert.notEqual(fileIndex, -1);
        filePaths.push(args[fileIndex + 1]);
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

test("Claude Code sends image content through stream-json stdin", async () => {
  const calls = [];
  const child = fakeChild();
  const runtime = createClaudeRuntime({
    command: "claude-test",
    spawnProcess: (_command, args) => {
      calls.push(args);
      assert.equal(args.includes("--input-format"), true);
      assert.equal(args[args.indexOf("--input-format") + 1], "stream-json");
      assert.equal(args.includes("--add-dir"), false);
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ type: "result", is_error: false, result: "ok" })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  const created = await runtime.createSession({ cwd: "/tmp/demo", title: "图片任务" });
  await runtime.sendMessage(created.sessionId, {
    text: "图片里是什么？",
    attachments: [{
      kind: "image",
      name: "screen.gif",
      mimeType: "image/gif",
      data: "aW1hZ2U="
    }]
  });
  const payload = JSON.parse(child.stdin.writes[0]);
  assert.equal(payload.role, "user");
  assert.equal(payload.content[0].type, "text");
  assert.equal(payload.content[0].text, "图片里是什么？");
  assert.deepEqual(payload.content[1], {
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

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";

import { CodexAppServerClient } from "../../../apps/desktop/src/codex-app-server.mjs";
import { createCodexRuntime } from "../../../apps/desktop/src/mobile-control/codex-runtime.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    writes: [],
    write(value) {
      this.writes.push(String(value));
      return true;
    }
  };
  child.kill = () => {};
  return child;
}

test("Codex app-server routes responses, notifications and server requests separately", async () => {
  const child = fakeChild();
  const client = new CodexAppServerClient({
    spawnProcess: () => child
  });
  const frames = [];
  client.subscribe((frame) => frames.push(frame));

  const connecting = client.connect();
  const initialize = JSON.parse(child.stdin.writes[0]);
  child.stdout.emit("data", `${JSON.stringify({ id: initialize.id, result: { userAgent: "codex-test" } })}\n`);
  await connecting;

  child.stdout.emit("data", [
    JSON.stringify({ method: "thread/started", params: { thread: { id: "t1" } } }),
    JSON.stringify({ id: 41, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } })
  ].join("\n") + "\n");

  assert.deepEqual(frames.map((frame) => frame.kind), ["notification", "request"]);
  assert.equal(frames[0].method, "thread/started");
  assert.equal(frames[1].id, 41);

  client.respond(41, { decision: "decline" });
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), {
    id: 41,
    result: { decision: "decline" }
  });
  client.close();
});

function fakeRuntimeClient(handler) {
  const calls = [];
  const subscribers = new Set();
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      return handler(method, params);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    emit(frame) {
      for (const listener of subscribers) listener(frame);
    }
  };
}

test("Codex app-server falls back to stdio when the Desktop proxy cannot initialize", async () => {
  const children = [];
  const spawnedArgs = [];
  const client = new CodexAppServerClient({
    resolveDaemonSocket: () => "/tmp/stale-codex.sock",
    spawnProcess: (_binary, args) => {
      const child = fakeChild();
      children.push(child);
      spawnedArgs.push(args);
      queueMicrotask(() => {
        if (args.includes("proxy")) {
          child.emit("close", 1);
          return;
        }
        const initialize = JSON.parse(child.stdin.writes[0]);
        child.stdout.emit("data", `${JSON.stringify({ id: initialize.id, result: { userAgent: "codex-test" } })}\n`);
      });
      return child;
    }
  });

  await client.connect();
  assert.deepEqual(spawnedArgs, [
    ["app-server", "proxy", "--sock", "/tmp/stale-codex.sock"],
    ["app-server", "--stdio"]
  ]);
  assert.equal(client.usingProxy, false);
  assert.equal(client.child, children[1]);
  client.close();
});

test("Codex app-server can explicitly reconnect its current transport", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    resolveDaemonSocket: () => null,
    spawnProcess: (_binary, args) => {
      const child = fakeChild();
      children.push({ child, args });
      queueMicrotask(() => {
        const initialize = JSON.parse(child.stdin.writes[0]);
        child.stdout.emit("data", `${JSON.stringify({ id: initialize.id, result: {} })}\n`);
      });
      return child;
    }
  });

  await client.connect();
  await client.reconnect();
  assert.deepEqual(children.map((item) => item.args), [
    ["app-server", "--stdio"],
    ["app-server", "--stdio"]
  ]);
  assert.equal(client.child, children[1].child);
  client.close();
});

test("Codex app-server reconnects lazily after its child exits", async () => {
  const children = [];
  const client = new CodexAppServerClient({
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      queueMicrotask(() => {
        const initialize = JSON.parse(child.stdin.writes[0]);
        child.stdout.emit("data", `${JSON.stringify({ id: initialize.id, result: { userAgent: "codex-test" } })}\n`);
      });
      return child;
    }
  });

  await client.connect();
  assert.equal(children.length, 1);
  children[0].emit("close", 1);

  const requested = client.request("thread/start", { cwd: "/tmp/demo" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  const request = JSON.parse(children[1].stdin.writes.at(-1));
  assert.equal(request.method, "thread/start");
  children[1].stdout.emit("data", `${JSON.stringify({ id: request.id, result: { thread: { id: "t-new" } } })}\n`);
  assert.deepEqual(await requested, { thread: { id: "t-new" } });
  client.close();
});

test("Codex app-server coalesces concurrent lazy connections", async () => {
  const child = fakeChild();
  let spawns = 0;
  const client = new CodexAppServerClient({
    spawnProcess: () => {
      spawns += 1;
      return child;
    }
  });
  const first = client.request("thread/list", {});
  const second = client.request("thread/read", { threadId: "t1" });
  assert.equal(spawns, 1);
  const initialize = JSON.parse(child.stdin.writes[0]);
  child.stdout.emit("data", `${JSON.stringify({ id: initialize.id, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const requests = child.stdin.writes.slice(2).map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((row) => row.method), ["thread/list", "thread/read"]);
  for (const request of requests) child.stdout.emit("data", `${JSON.stringify({ id: request.id, result: {} })}\n`);
  await Promise.all([first, second]);
  client.close();
});

test("Codex runtime lists and reads native threads with mobile capabilities", async () => {
  const client = fakeRuntimeClient((method) => {
    if (method === "thread/list") {
      return {
        data: [{
          id: "t1",
          name: "修复网关",
          status: { type: "active" },
          updatedAt: 1784808000,
          model: "codex/gpt-5.5",
          cwd: "/Users/alice/code/switchyard"
        }],
        nextCursor: null
      };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: "t1",
          name: "修复网关",
          status: { type: "idle" },
          turns: [{
            id: "turn-1",
            status: "completed",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "继续" }] },
              { type: "agentMessage", text: "已经完成" }
            ]
          }]
        }
      };
    }
    return {};
  });
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });

  const sessions = await runtime.listSessions();
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].capabilities, {
    sendMessage: true,
    setModel: true,
    setEffort: true,
    cancel: true,
    rename: true,
    archive: true,
    unarchive: true,
    delete: true,
    fork: true,
    compact: true,
    approve: true
  });
  assert.equal(sessions[0].project, "switchyard");

  const detail = await runtime.readSession("t1");
  assert.equal(detail.messages[0].role, "user");
  assert.equal(detail.messages[0].text, "继续");
  assert.equal(detail.messages[1].role, "assistant");
  assert.equal(detail.messages[1].text, "已经完成");
});

test("Codex runtime creates, sends, switches next-turn model and manages a thread", async () => {
  const client = fakeRuntimeClient((method) => {
    if (method === "thread/start") return { thread: { id: "t-new" } };
    if (method === "turn/start") return { turn: { id: "turn-new" } };
    if (method === "thread/fork") return { thread: { id: "t-fork" } };
    return {};
  });
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });

  assert.deepEqual(await runtime.createSession({
    cwd: "/Users/alice/code/switchyard",
    title: "手机任务",
    model: "codex/gpt-5.5",
    effort: "high",
    permissionMode: "workspace-write"
  }), { sessionId: "t-new" });
  assert.deepEqual(await runtime.sendMessage("t-new", {
    text: "继续完成任务",
    messageId: "m1"
  }), { accepted: true, turnId: "turn-new" });
  await runtime.setModel("t-new", "deepseek/deepseek-v4", "medium");
  await runtime.cancel("t-new");
  await runtime.rename("t-new", "新名字");
  await runtime.archive("t-new");
  await runtime.unarchive("t-new");
  await runtime.compact("t-new");
  assert.deepEqual(await runtime.fork("t-new"), { sessionId: "t-fork" });
  await runtime.delete("t-new");

  assert.deepEqual(client.calls.map((call) => call.method), [
    "thread/start",
    "thread/name/set",
    "turn/start",
    "turn/interrupt",
    "thread/name/set",
    "thread/archive",
    "thread/unarchive",
    "thread/compact/start",
    "thread/fork",
    "thread/delete"
  ]);
  assert.deepEqual(client.calls[0].params, {
    cwd: "/Users/alice/code/switchyard",
    model: "codex/gpt-5.5",
    effort: "high",
    sandbox: "workspace-write",
    threadSource: "user"
  });
  assert.deepEqual(client.calls[2].params, {
    threadId: "t-new",
    input: [{ type: "text", text: "继续完成任务", text_elements: [] }],
    model: "codex/gpt-5.5",
    effort: "high",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false
    }
  });
  assert.deepEqual(client.calls[3].params, {
    threadId: "t-new",
    turnId: "turn-new"
  });
});

test("Codex app-server turns accept mobile image input as a data URL", async () => {
  const client = fakeRuntimeClient((method) => {
    if (method === "turn/start") return { turn: { id: "turn-image" } };
    return {};
  });
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });

  await runtime.sendMessage("t-image", {
    text: "描述这张图",
    attachments: [{
      kind: "image",
      name: "screen.png",
      mimeType: "image/png",
      data: "aW1hZ2U="
    }]
  });

  assert.deepEqual(client.calls.at(-1), {
    method: "turn/start",
    params: {
      threadId: "t-image",
      input: [
        { type: "text", text: "描述这张图", text_elements: [] },
        { type: "image", url: "data:image/png;base64,aW1hZ2U=" }
      ]
    }
  });
});

test("Codex app-server turns describe arbitrary uploaded files by their private local path", async () => {
  const client = fakeRuntimeClient((method) => method === "turn/start" ? { turn: { id: "turn-file" } } : {});
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });
  await runtime.sendMessage("t-file", {
    text: "检查附件",
    attachments: [{
      kind: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
      path: "/tmp/switchyard/report.pdf"
    }]
  });
  const input = client.calls.at(-1).params.input;
  assert.equal(input.length, 1);
  assert.match(input[0].text, /report\.pdf/);
  assert.match(input[0].text, /\/tmp\/switchyard\/report\.pdf/);
});

test("Codex runtime exposes app-server approval requests and can answer them", () => {
  const responses = [];
  const client = fakeRuntimeClient(() => ({}));
  client.respond = (requestId, result) => responses.push({ requestId, result });
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  client.emit({
    kind: "request",
    id: 77,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-approval",
      turnId: "turn-approval",
      command: "git status --short",
      reason: "需要读取仓库状态"
    }
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "approval");
  assert.equal(events[0].requestId, 77);
  assert.equal(events[0].request.method, "item/commandExecution/requestApproval");
  assert.equal(events[0].request.command, "git status --short");

  runtime.respond(77, { decision: "accept" });
  assert.deepEqual(responses, [{
    requestId: 77,
    result: { decision: "accept" }
  }]);
});

test("Codex mobile @ mentions use native plugin UserInput entries", async () => {
  const client = fakeRuntimeClient((method) => {
    if (method === "plugin/installed") return {
      marketplaces: [{ plugins: [{
        name: "chrome", installed: true, enabled: true,
        source: { type: "local", path: "/plugins/chrome" },
        interface: { shortDescription: "Control Chrome" }
      }] }]
    };
    if (method === "turn/start") return { turn: { id: "turn-mention" } };
    return {};
  });
  const runtime = createCodexRuntime({ client, scanSessions: () => [], command: "/missing-codex" });

  assert.deepEqual(await runtime.listMentions({ cwd: "/tmp/project" }), [{
    name: "chrome", description: "Control Chrome"
  }]);
  await runtime.sendMessage("t-mention", { text: "用 @chrome 检查页面" });

  assert.deepEqual(client.calls.at(-1), {
    method: "turn/start",
    params: {
      threadId: "t-mention",
      input: [
        { type: "text", text: "用 @chrome 检查页面", text_elements: [] },
        { type: "mention", name: "chrome", path: "/plugins/chrome" }
      ]
    }
  });
});

test("Codex runtime reconnects app-server before resuming a Desktop-owned thread", async () => {
  const sharedCalls = [];
  let reads = 0;
  let reconnects = 0;
  let nativeSpawns = 0;
  const client = {
    async request(method, params) {
      sharedCalls.push({ method, params });
      if (method === "thread/resume") {
        reads += 1;
        if (reads === 1) throw new Error("thread not found: desktop-thread");
        return { thread: { id: "desktop-thread" } };
      }
      if (method === "turn/start") return { turn: { id: "turn-desktop" } };
      return {};
    },
    async reconnect() {
      reconnects += 1;
    },
    subscribe() {
      return () => {};
    }
  };
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => [{
      sessionId: "desktop-thread",
      cwd: "/tmp/codex-desktop-smoke",
      filePath: "/missing-rollout.jsonl",
      title: "桌面任务",
      originator: "Codex Desktop",
      mtimeMs: 1
    }],
    spawnProcess: () => {
      nativeSpawns += 1;
      return fakeChild();
    }
  });

  assert.deepEqual(await runtime.sendMessage("desktop-thread", { text: "继续" }), {
    accepted: true,
    turnId: "turn-desktop"
  });
  assert.equal(reconnects, 1);
  assert.equal(nativeSpawns, 0);
  assert.deepEqual(sharedCalls.map((call) => call.method), [
    "thread/resume",
    "thread/resume",
    "turn/start"
  ]);
  assert.deepEqual(sharedCalls[1].params, {
    threadId: "desktop-thread",
    excludeTurns: true
  });
});

test("Codex runtime falls back to native resume for a local Switchyard rollout missing from app-server", async () => {
  const calls = [];
  const child = fakeChild();
  const runtime = createCodexRuntime({
    client: {
      async request(method) {
        if (method === "thread/read" || method === "turn/start") throw new Error("thread not found: switchyard-thread");
        return {};
      },
      subscribe() { return () => {}; }
    },
    command: "codex",
    scanSessions: () => [{
      sessionId: "switchyard-thread",
      cwd: "/tmp/codex-switchyard-smoke",
      filePath: "/tmp/rollout.jsonl",
      title: "Switchyard 任务",
      originator: "switchyard",
      mtimeMs: 1
    }],
    spawnProcess(_command, args) {
      calls.push(args);
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }
  });

  assert.deepEqual(await runtime.sendMessage("switchyard-thread", { text: "继续" }), { accepted: true });
  assert.deepEqual(calls[0].slice(0, 4), ["exec", "resume", "switchyard-thread", "--json"]);
});

test("Codex runtime reports an unavailable Desktop thread without starting a native owner", async () => {
  let nativeSpawns = 0;
  let reconnects = 0;
  const client = {
    async request() {
      throw new Error("thread not found: desktop-thread");
    },
    async reconnect() {
      reconnects += 1;
    },
    subscribe() {
      return () => {};
    }
  };
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => [{
      sessionId: "desktop-thread",
      cwd: "/tmp/codex-desktop-smoke",
      filePath: "/missing-rollout.jsonl",
      title: "桌面任务",
      originator: "Codex Desktop",
      mtimeMs: 1
    }],
    spawnProcess: () => {
      nativeSpawns += 1;
      return fakeChild();
    }
  });

  await assert.rejects(
    runtime.sendMessage("desktop-thread", { text: "继续" }),
    /Codex Desktop 会话暂时不可连接/
  );
  assert.equal(reconnects, 1);
  assert.equal(nativeSpawns, 0);
});

test("Codex runtime never switches a Desktop image turn to the native CLI", async () => {
  let nativeSpawns = 0;
  const client = {
    async request(method) {
      if (method === "thread/resume") return { thread: { id: "desktop-image-thread" } };
      throw new Error("historical thread rejected image input");
    },
    async reconnect() {},
    subscribe() {
      return () => {};
    }
  };
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => [{
      sessionId: "desktop-image-thread",
      cwd: "/tmp/codex-desktop-smoke",
      filePath: "/missing-rollout.jsonl",
      title: "桌面图片任务",
      originator: "Codex Desktop",
      mtimeMs: 1
    }],
    spawnProcess: () => {
      nativeSpawns += 1;
      return fakeChild();
    }
  });

  await assert.rejects(
    runtime.sendMessage("desktop-image-thread", {
      text: "看图",
      attachments: [{
        kind: "image",
        name: "screen.png",
        mimeType: "image/png",
        data: "aW1hZ2U="
      }]
    }),
    /historical thread rejected image input/
  );
  assert.equal(nativeSpawns, 0);
});

test("Codex runtime resumes a CLI-owned local rollout through the native CLI", async () => {
  const calls = [];
  const child = fakeChild();
  const client = fakeRuntimeClient((method) => {
    if (method === "turn/start") throw new Error("CLI thread must not be sent to mobile app-server");
    return {};
  });
  const scanSessions = () => [{
    sessionId: "cli-thread",
    cwd: "/tmp/codex-native-smoke",
    filePath: "/missing-rollout.jsonl",
    title: "CLI 任务",
    originator: "codex_cli_rs",
    mtimeMs: 1
  }];
  const runtime = createCodexRuntime({
    client,
    scanSessions,
    command: "codex-test",
    spawnProcess: (_command, args) => {
      calls.push(args);
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "恢复成功" }
        })}\n${JSON.stringify({ type: "turn.completed" })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  const events = [];
  runtime.subscribe((event) => events.push(event));
  await runtime.setModel("cli-thread", "deepseek/deepseek-v4", "low");
  await runtime.setSettings("cli-thread", {
    effort: "low",
    permissionMode: "read-only"
  });
  assert.deepEqual(await runtime.sendMessage("cli-thread", {
    text: "继续",
    attachments: [{ kind: "text", name: "note.md", text: "上下文" }]
  }), { accepted: true });
  assert.deepEqual(calls[0], [
    "exec", "resume", "cli-thread", "--json", "--skip-git-repo-check",
    "--model", "deepseek/deepseek-v4",
    "-c", 'model_reasoning_effort="low"',
    "-c", 'sandbox_mode="read-only"',
    "继续\n\n<attachment name=\"note.md\">\n上下文\n</attachment>"
  ]);
  assert.deepEqual(events.map(({ type, summary }) => [type, summary]), [
    ["message", "恢复成功"],
    ["status", "completed"]
  ]);
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
});

test("Codex native resume materializes image attachments, passes --image and removes temporary files", async () => {
  const calls = [];
  const imagePaths = [];
  const child = fakeChild();
  const runtime = createCodexRuntime({
    client: fakeRuntimeClient(() => ({})),
    scanSessions: () => [{
      sessionId: "cli-image-thread",
      cwd: "/tmp/codex-native-smoke",
      filePath: "/missing-rollout.jsonl",
      title: "CLI 图片任务",
      originator: "codex_cli_rs",
      mtimeMs: 1
    }],
    command: "codex-test",
    spawnProcess: (_command, args) => {
      calls.push(args);
      const imageIndex = args.indexOf("--image");
      assert.notEqual(imageIndex, -1);
      imagePaths.push(args[imageIndex + 1]);
      assert.equal(fs.existsSync(imagePaths[0]), true);
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ type: "turn.completed" })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });

  await runtime.sendMessage("cli-image-thread", {
    text: "看图",
    attachments: [{
      kind: "image",
      name: "screen.png",
      mimeType: "image/png",
      data: "aW1hZ2U="
    }]
  });

  assert.match(imagePaths[0], /switchyard-mobile-attachments-/);
  assert.equal(fs.existsSync(imagePaths[0]), false);
  assert.equal(calls[0].at(-1), "看图");
});

test("Codex native resume emits reasoning summaries and descriptive tool titles", async () => {
  const child = fakeChild();
  const runtime = createCodexRuntime({
    client: fakeRuntimeClient(() => ({})),
    scanSessions: () => [{
      sessionId: "cli-reasoning-thread",
      cwd: "/tmp/codex-native-smoke",
      filePath: "/missing-rollout.jsonl",
      title: "CLI 推理任务",
      originator: "codex_cli_rs",
      mtimeMs: 1
    }],
    command: "codex-test",
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({
          type: "item.updated",
          item: { type: "reasoning", summary: [{ type: "summary_text", text: "先检查当前状态" }] }
        })}\n${JSON.stringify({
          type: "item.completed",
          item: { type: "command_execution", id: "call-status", arguments: { cmd: "git status --short" } }
        })}\n${JSON.stringify({ type: "turn.completed" })}\n`);
        child.emit("close", 0);
      });
      return child;
    }
  });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  await runtime.sendMessage("cli-reasoning-thread", { text: "继续" });

  assert.deepEqual(events.map((event) => [event.type, event.summary, event.tool?.title || ""]), [
    ["thinking", "先检查当前状态", ""],
    ["tool", "执行：git status --short", "执行：git status --short"],
    ["status", "completed", ""]
  ]);
});

test("Codex runtime normalizes notifications and tracks the active turn", async () => {
  const client = fakeRuntimeClient((method) => {
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  });
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  await runtime.sendMessage("t1", { text: "开始" });
  client.emit({
    kind: "notification",
    method: "item/agentMessage/delta",
    params: { threadId: "t1", turnId: "turn-1", delta: "你好" }
  });
  client.emit({
    kind: "notification",
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } }
  });

  assert.deepEqual(events, [
    {
      sessionId: "t1",
      type: "message",
      summary: "你好",
      runtimeEvent: "item/agentMessage/delta",
      turnId: "turn-1"
    },
    {
      sessionId: "t1",
      type: "status",
      summary: "completed",
      runtimeEvent: "turn/completed",
      turnId: "turn-1"
    }
  ]);
});

test("Codex runtime maps generic item updates to streamed messages and plan tool cards", () => {
  const client = fakeRuntimeClient(() => ({}));
  const runtime = createCodexRuntime({ client, scanSessions: () => [] });
  const events = [];
  runtime.subscribe((event) => events.push(event));

  client.emit({
    kind: "notification",
    method: "item/updated",
    params: {
      threadId: "desktop-thread",
      turnId: "turn-live",
      item: { id: "msg-live", type: "agent_message", text: "正在" }
    }
  });
  client.emit({
    kind: "notification",
    method: "item/updated",
    params: {
      threadId: "desktop-thread",
      turnId: "turn-live",
      item: { id: "msg-live", type: "agent_message", text: "正在处理" }
    }
  });
  client.emit({
    kind: "notification",
    method: "item/updated",
    params: {
      threadId: "desktop-thread",
      turnId: "turn-live",
      item: {
        id: "plan-call",
        type: "function_call",
        name: "update_plan",
        arguments: JSON.stringify({
          plan: [
            { step: "检查现状", status: "completed" },
            { step: "实现实时同步", status: "in_progress" },
            { step: "回归验证", status: "pending" }
          ]
        })
      }
    }
  });

  assert.deepEqual(events.map((event) => ({ type: event.type, summary: event.summary, tool: event.tool && { id: event.tool.id, name: event.tool.name, status: event.tool.status } })), [
    { type: "message", summary: "正在", tool: undefined },
    { type: "message", summary: "处理", tool: undefined },
    { type: "tool", summary: "更新执行计划", tool: { id: "plan-call", name: "update_plan", status: "running" } }
  ]);
});

test("Codex goal tools project a durable goal with live plan progress", async () => {
  const { applyGoalTool } = await import("../../../apps/desktop/src/mobile-control/goal-state.mjs");
  const initial = applyGoalTool(null, {
    name: "create_goal",
    arguments: JSON.stringify({ objective: "让手机端展示任务目标", token_budget: 12000 })
  }, { at: "2026-07-27T10:00:00.000Z" });
  const running = applyGoalTool(initial, {
    name: "update_plan",
    arguments: JSON.stringify({ plan: [
      { step: "解析目标工具", status: "completed" },
      { step: "渲染顶部进度卡", status: "in_progress" }
    ] })
  }, { at: "2026-07-27T10:01:00.000Z" });
  const complete = applyGoalTool(running, {
    name: "update_goal",
    arguments: JSON.stringify({ status: "complete", token_usage: 8100 })
  }, { at: "2026-07-27T10:02:00.000Z" });
  assert.equal(initial.objective, "让手机端展示任务目标");
  assert.equal(initial.tokenBudget, 12000);
  assert.equal(running.plan[1].status, "in_progress");
  assert.equal(complete.status, "complete");
  assert.equal(complete.tokenUsage, 8100);
});

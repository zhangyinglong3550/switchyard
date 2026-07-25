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

test("Codex runtime resumes a Desktop-owned local rollout through the native CLI", async () => {
  const calls = [];
  const child = fakeChild();
  const client = fakeRuntimeClient((method) => {
    if (method === "turn/start") throw new Error("Desktop thread must not be sent to mobile app-server");
    return {};
  });
  const scanSessions = () => [{
    sessionId: "desktop-thread",
    cwd: "/tmp/codex-native-smoke",
    filePath: "/missing-rollout.jsonl",
    title: "桌面任务",
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
  await runtime.setModel("desktop-thread", "deepseek/deepseek-v4", "low");
  await runtime.setSettings("desktop-thread", {
    effort: "low",
    permissionMode: "read-only"
  });
  assert.deepEqual(await runtime.sendMessage("desktop-thread", {
    text: "继续",
    attachments: [{ kind: "text", name: "note.md", text: "上下文" }]
  }), { accepted: true });
  assert.deepEqual(calls[0], [
    "exec", "resume", "desktop-thread", "--json", "--skip-git-repo-check",
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
      sessionId: "desktop-image-thread",
      cwd: "/tmp/codex-native-smoke",
      filePath: "/missing-rollout.jsonl",
      title: "桌面图片任务",
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

  await runtime.sendMessage("desktop-image-thread", {
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

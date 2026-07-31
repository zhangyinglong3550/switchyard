import assert from "node:assert/strict";
import test from "node:test";

import { cleanCodexSessionTitle, createCodexRuntime } from "./codex-runtime.mjs";

function desktopSession(sessionId = "desktop-thread") {
  return {
    sessionId,
    originator: "Codex Desktop",
    cwd: "/tmp/project",
    filePath: "/tmp/desktop-thread.jsonl",
    mtimeMs: Date.now()
  };
}

function fakeClient({ usingProxy, reconnect } = {}) {
  const calls = [];
  return {
    usingProxy,
    calls,
    reconnect,
    subscribe() { return () => {}; },
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/resume") return { thread: { id: params.threadId } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      throw new Error(`Unexpected request: ${method}`);
    }
  };
}

test("Codex mobile runtime · blocks desktop-owned sends when the shared Desktop proxy is unavailable", async () => {
  const client = fakeClient({ usingProxy: false });
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => [desktopSession()]
  });

  await assert.rejects(
    () => runtime.sendMessage("desktop-thread", { text: "continue" }),
    (error) => error?.code === "CODEX_DESKTOP_SYNC_UNAVAILABLE"
  );
  assert.deepEqual(client.calls.map((call) => call.method), []);
});

test("Codex mobile runtime · reconnects to the shared Desktop proxy before resuming a desktop-owned thread", async () => {
  const client = fakeClient({ usingProxy: false });
  client.reconnect = async () => { client.usingProxy = true; };
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => [desktopSession()]
  });

  assert.deepEqual(
    await runtime.sendMessage("desktop-thread", { text: "continue" }),
    { accepted: true, turnId: "turn-1" }
  );
  assert.deepEqual(client.calls.map((call) => call.method), ["thread/resume", "turn/start"]);
});

test("Codex mobile runtime · sends desktop-owned messages only through the shared Desktop proxy", async () => {
  const client = fakeClient({ usingProxy: true });
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => [desktopSession()]
  });

  assert.deepEqual(
    await runtime.sendMessage("desktop-thread", { text: "continue" }),
    { accepted: true, turnId: "turn-1" }
  );
  assert.deepEqual(client.calls.map((call) => call.method), ["thread/resume", "turn/start"]);
});

test("Codex mobile runtime · never turn/starts on private app-server when a local rollout exists", async () => {
  let nativeSpawns = 0;
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() { return true; }, end() {} };
  child.kill = () => {};
  const client = fakeClient({ usingProxy: false });
  const runtime = createCodexRuntime({
    client,
    command: "codex",
    scanSessions: () => [{
      sessionId: "cli-thread",
      cwd: "/tmp/cli",
      filePath: "/tmp/cli-thread.jsonl",
      title: "CLI 任务",
      originator: "codex_cli_rs",
      mtimeMs: 1
    }],
    spawnProcess() {
      nativeSpawns += 1;
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }
  });

  assert.deepEqual(await runtime.sendMessage("cli-thread", { text: "手机续聊" }), { accepted: true });
  assert.equal(nativeSpawns, 1);
  assert.deepEqual(client.calls.map((call) => call.method), []);
});

test("Codex mobile runtime · refuses private sends when no shared proxy and no local rollout", async () => {
  const client = fakeClient({ usingProxy: false });
  const runtime = createCodexRuntime({
    client,
    scanSessions: () => []
  });
  await assert.rejects(
    () => runtime.sendMessage("ghost-thread", { text: "hello" }),
    (error) => error?.code === "CODEX_DESKTOP_SYNC_UNAVAILABLE"
  );
  assert.deepEqual(client.calls.map((call) => call.method), []);
});


test("Codex mobile runtime · turns tagged subagent notifications into a readable session title", () => {
  assert.equal(
    cleanCodexSessionTitle('<subagent_notification> {"agent_path":"019fac","status":{"completed":"已完成 **只读审查**"}}'),
    "子任务：已完成 只读审查"
  );
  assert.equal(cleanCodexSessionTitle("正常会话标题"), "正常会话标题");
});

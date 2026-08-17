import assert from "node:assert/strict";
import test from "node:test";

import { createDeepSeekRuntime, projectDshHistoryEvents } from "./dsh-runtime.mjs";

function fakeHostClient() {
  const calls = [];
  let frameHandler = null;
  const client = {
    calls,
    rpc: async (method, args) => {
      calls.push({ kind: "rpc", method, args });
      if (method === "session.list") {
        return {
          items: [
            { sessionId: "session-a", updatedAt: 1786898693865, running: true, blank: false, cwd: "/tmp/proj", projections: { values: { title: "正在做的任务" } } },
            { sessionId: "session-blank", updatedAt: 1, running: false, blank: true, cwd: "/tmp/proj" },
            { sessionId: "session-sub", updatedAt: 2, running: false, blank: false, origin: "subagent", parentSessionId: "session-a", cwd: "/tmp/proj" },
            { sessionId: "session-b", updatedAt: 1786898000000, running: false, blank: false, cwd: "/tmp/other", projections: { values: {} } }
          ]
        };
      }
      if (method === "session.history") {
        // DSH 按新到旧返回（beforeSeq 回溯分页）。
        return {
          events: [
            { event: { type: "tool/result", seq: 4, time: 4, data: { callId: "call-1", message: { source: { kind: "tool", callId: "call-1" }, content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "输出内容" }], isError: false }] } } } },
            { event: { type: "tool/call", seq: 3, time: 3, data: { callId: "call-1", name: "bash", arguments: "{\"command\":\"pwd\"}" } } },
            { event: { type: "assistant/message", seq: 2, time: 2, data: { turn: 1, message: { role: "assistant", content: [{ type: "text", text: "回答内容" }] } } } },
            { event: { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "你好" }], source: { kind: "user" } } } }
          ],
          hasMore: false
        };
      }
      if (method === "session.create") return { sessionId: "session-new" };
      if (method === "session.prompt") return { accepted: true };
      if (method === "session.models") {
        return { current: { provider: "switchyard", model: "ke/kimi-k3" }, routable: true, groups: [{ id: "switchyard", name: "Switchyard", models: [{ id: "ke/kimi-k3", name: "kimi-k3" }] }] };
      }
      if (method === "session.selectModel") return { selected: {} };
      if (method === "session.cancel" || method === "session.rename" || method === "session.fork") return { accepted: true };
      throw new Error(`Unexpected rpc: ${method}`);
    },
    respond: async (id, value) => {
      calls.push({ kind: "respond", id, value });
      return { accepted: true };
    },
    subscribe(handler) {
      frameHandler = handler;
      return () => { frameHandler = null; };
    },
    push(frame) {
      frameHandler?.(frame);
    },
    close() {}
  };
  return client;
}

function runtimeWith(client) {
  const events = [];
  const runtime = createDeepSeekRuntime({ hostClient: client });
  runtime.subscribe((event) => events.push(event));
  return { runtime, events };
}

test("DSH runtime · history projection keeps only real user input and merges tool cards", () => {
  const rows = projectDshHistoryEvents([
    { event: { type: "session", seq: 0, data: {} } },
    { event: { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "真实提问" }], source: { kind: "user" } } } },
    { event: { type: "user/message", seq: 2, data: { content: [{ type: "text", text: "runtime context 注入" }], source: { kind: "plugin" } } } },
    { event: { type: "assistant/message", seq: 3, data: { turn: 1, message: { role: "assistant", content: [{ type: "thinking", text: "先想一想" }, { type: "text", text: "正式回答" }] } } } },
    { event: { type: "tool/call", seq: 4, data: { callId: "call-9", name: "bash", arguments: "{\"command\":\"ls\"}" } } },
    { event: { type: "tool/result", seq: 5, data: { callId: "call-9", message: { source: { kind: "tool", callId: "call-9" }, content: [{ type: "tool-result", toolCallId: "call-9", content: [{ type: "text", text: "file-a\nfile-b" }], isError: false }] } } } }
  ]);
  assert.deepEqual(
    rows.map((row) => [row.role, row.kind]),
    [["user", "text"], ["assistant", "thinking"], ["assistant", "text"], ["tool", "tool"]]
  );
  assert.equal(rows.find((row) => row.kind === "thinking").text, "先想一想");
  const tool = rows.find((row) => row.kind === "tool");
  assert.equal(tool.tool.name, "bash");
  assert.equal(tool.tool.status, "completed");
  assert.match(tool.tool.output, /file-a/);
});

test("DSH runtime · failed tool results surface as failed cards", () => {
  const rows = projectDshHistoryEvents([
    { event: { type: "tool/call", seq: 1, data: { callId: "call-x", name: "bash", arguments: "{}" } } },
    { event: { type: "tool/result", seq: 2, data: { callId: "call-x", message: { source: { callId: "call-x" }, content: [{ type: "tool-result", toolCallId: "call-x", content: [{ type: "text", text: "boom" }], isError: true }] } } } }
  ]);
  assert.equal(rows[0].tool.status, "failed");
  assert.equal(rows[0].tool.error || rows[0].tool.output, rows[0].tool.output);
});

test("DSH runtime · listSessions skips blank and subagent sessions", async () => {
  const client = fakeHostClient();
  const { runtime } = runtimeWith(client);
  const rows = await runtime.listSessions();
  assert.deepEqual(rows.map((row) => row.id), ["session-a", "session-b"]);
  assert.equal(rows[0].name, "正在做的任务");
  assert.equal(rows[0].state, "running");
  assert.equal(rows[0].directory, "/tmp/proj");
});

test("DSH runtime · readSession reorders newest-first history and projects messages", async () => {
  const client = fakeHostClient();
  const { runtime } = runtimeWith(client);
  const detail = await runtime.readSession("session-a", { messageLimit: 100 });
  assert.equal(detail.name, "正在做的任务");
  assert.deepEqual(detail.messages.map((row) => row.role), ["user", "assistant", "tool"]);
  assert.equal(detail.messages[0].text, "你好");
});

test("DSH runtime · sendMessage maps text, wrapped text attachments and image parts", async () => {
  const client = fakeHostClient();
  const { runtime } = runtimeWith(client);
  await runtime.sendMessage("session-a", {
    text: "继续",
    attachments: [
      { kind: "text", name: "notes.md", text: "附件内容" },
      { kind: "image", name: "shot.png", mimeType: "image/png", data: "aGk=" }
    ]
  });
  const call = client.calls.find((row) => row.method === "session.prompt");
  assert.equal(call.args.sessionId, "session-a");
  assert.equal(call.args.mode, "queue");
  const text = call.args.content.find((part) => part.type === "text");
  assert.match(text.text, /继续/);
  assert.match(text.text, /<attachment name="notes.md">/);
  const image = call.args.content.find((part) => part.type === "image");
  assert.equal(image.mediaType, "image/png");
  assert.equal(image.data, "aGk=");
});

test("DSH runtime · setModel prefers catalog groups and passes reasoning effort", async () => {
  const client = fakeHostClient();
  const { runtime } = runtimeWith(client);
  await runtime.setModel("session-a", "ke/kimi-k3", "high");
  const call = client.calls.find((row) => row.method === "session.selectModel");
  assert.deepEqual(
    { provider: call.args.provider, model: call.args.model, reasoningEffort: call.args.reasoningEffort },
    { provider: "switchyard", model: "ke/kimi-k3", reasoningEffort: "high" }
  );
});

test("DSH runtime · unknown models fall back to the switchyard provider without effort off", async () => {
  const client = fakeHostClient();
  const { runtime } = runtimeWith(client);
  await runtime.setModel("session-a", "ke/new-model", "off");
  const call = client.calls.find((row) => row.method === "session.selectModel");
  assert.equal(call.args.provider, "switchyard");
  assert.equal(call.args.model, "ke/new-model");
  assert.equal(call.args.reasoningEffort, undefined);
});

test("DSH runtime · streaming deltas emit messages and suppress the duplicate final block", () => {
  const client = fakeHostClient();
  const { runtime, events } = runtimeWith(client);
  const sid = "session-a";
  client.push({ type: "server-request", rpcId: "r1", method: "session/event", payload: { type: "session/event", sessionId: sid, event: { type: "turn/start", data: { turn: 2 } } } });
  client.push({ type: "server-request", rpcId: "r2", method: "session/event", payload: { type: "session/event", sessionId: sid, event: { type: "assistant/chunk", data: { turn: 2, chunk: { type: "text-delta", index: 0, text: "你" } } } } });
  client.push({ type: "server-request", rpcId: "r3", method: "session/event", payload: { type: "session/event", sessionId: sid, event: { type: "assistant/message", data: { turn: 2, message: { role: "assistant", content: [{ type: "text", text: "你好" }] } } } } });
  client.push({ type: "server-request", rpcId: "r4", method: "session/event", payload: { type: "session/event", sessionId: sid, event: { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } } } });
  const messages = events.filter((event) => event.type === "message");
  assert.deepEqual(messages.map((event) => event.summary), ["你"]);
  assert.equal(events.at(-1).summary, "completed");
});

test("DSH runtime · approval frames produce mobile approvals and respond maps outcomes", async () => {
  const client = fakeHostClient();
  const { runtime, events } = runtimeWith(client);
  client.push({
    type: "server-request",
    rpcId: "rpc-approval-1",
    method: "approval/requested",
    payload: { type: "approval/requested", sessionId: "session-a", approvalId: "appr-1", toolName: "write", reason: "workspace-write 之外写入 ~/.dsh/settings.yaml" }
  });
  const approval = events.find((event) => event.type === "approval");
  assert.ok(approval);
  assert.equal(approval.requestId, "rpc-approval-1");
  assert.equal(approval.request.options.length, 2);
  assert.equal(approval.request.options[0].optionId, "allow");

  await runtime.respond("rpc-approval-1", { outcome: { outcome: "selected", optionId: "allow" } });
  const respond = client.calls.find((row) => row.kind === "respond");
  assert.deepEqual(respond.value, { sessionId: "session-a", approvalId: "appr-1", outcome: "allowed-once" });

  client.push({ type: "server-request", rpcId: "r5", method: "approval/resolved", payload: { type: "approval/resolved", sessionId: "session-a", approvalId: "appr-1", outcome: "allowed-once" } });
  assert.ok(events.some((event) => event.type === "approval_resolved"));
});

test("DSH runtime · todo/write history events become plan tool messages", () => {
  const rows = projectDshHistoryEvents([
    { event: { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "开始" }], source: { kind: "user" } } } },
    { event: { type: "todo/write", seq: 2, data: { todos: [
      { content: "读取文档", status: "completed" },
      { content: "写代码", status: "in_progress" },
      { content: "跑测试", status: "pending" }
    ] } } },
    { event: { type: "todo/write", seq: 3, data: { todos: [
      { content: "读取文档", status: "completed" },
      { content: "写代码", status: "completed" },
      { content: "跑测试", status: "in_progress" }
    ] } } }
  ]);
  const todoRows = rows.filter((row) => row.kind === "tool" && /^todo_?write$/i.test(row.tool.name));
  assert.equal(todoRows.length, 2);
  const parsed = JSON.parse(todoRows[1].tool.arguments);
  assert.equal(parsed.todos.length, 3);
  assert.equal(parsed.todos[2].status, "in_progress");
});

test("DSH runtime · live todo writes keep one stable card id", () => {
  const client = fakeHostClient();
  const { runtime, events } = runtimeWith(client);
  const sid = "session-a";
  client.push({ type: "server-request", rpcId: "t1", method: "session/event", payload: { type: "session/event", sessionId: sid, event: { type: "todo/write", data: { todos: [{ content: "第一步", status: "in_progress" }] } } } });
  client.push({ type: "server-request", rpcId: "t2", method: "session/event", payload: { type: "session/event", sessionId: sid, event: { type: "todo/write", data: { todos: [{ content: "第一步", status: "completed" }] } } } });  const todoEvents = events.filter((event) => event.runtimeEvent === "dsh/todo-write");
  assert.equal(todoEvents.length, 2);
  assert.deepEqual(todoEvents.map((event) => event.tool.id), ["dsh-todos", "dsh-todos"]);
  assert.match(JSON.parse(todoEvents[1].tool.arguments).todos[0].status, /completed/);
  runtime.close?.();
});

test("DSH runtime · listCommands maps native skills into slash commands", async () => {
  const client = fakeHostClient();
  client.rpc = async (method, args) => {
    if (method === "skill.list") return { skills: [
      { name: "code-review", description: "代码审查", modelInvocable: true },
      { name: "deploy", description: "部署", modelInvocable: false }
    ] };
    throw new Error(`Unexpected rpc: ${method}`);
  };
  const { runtime } = runtimeWith(client);
  const rows = await runtime.listCommands();
  assert.deepEqual(rows.map((row) => [row.kind, row.name]), [["skill", "code-review"], ["skill", "deploy"]]);
  assert.match(rows[0].insertText, /^\/code-review /);
});

test("DSH runtime · listCommands tolerates host failure", async () => {
  const client = fakeHostClient();
  client.rpc = async () => { throw new Error("host down"); };
  const { runtime } = runtimeWith(client);
  assert.deepEqual(await runtime.listCommands(), []);
});

test("DSH runtime · host status frames drive running/completed states", () => {
  const client = fakeHostClient();
  const { events } = runtimeWith(client);
  client.push({ type: "server-request", rpcId: "h1", method: "host/session-status", payload: { type: "host/session-status", sessionId: "session-b", running: true } });
  client.push({ type: "server-request", rpcId: "h2", method: "host/session-status", payload: { type: "host/session-status", sessionId: "session-b", running: false } });
  assert.deepEqual(events.filter((event) => event.runtimeEvent === "dsh/host-status").map((event) => event.summary), ["running", "completed"]);
});

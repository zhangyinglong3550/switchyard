import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMobileControlStore } from "../../../apps/desktop/src/mobile-control/store.mjs";
import { createEventLedger } from "../../../apps/desktop/src/mobile-control/event-ledger.mjs";
import {
  createSessionRegistry,
  decodeMobileSessionId,
  encodeMobileSessionId
} from "../../../apps/desktop/src/mobile-control/session-registry.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mobile-registry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-07-23T12:00:00.000Z");
  const store = createMobileControlStore({ root, now: () => now });
  const ledger = createEventLedger({ file: path.join(root, "events.jsonl"), now: () => now });
  const calls = [];
  let readCalls = 0;
  const listeners = new Set();
  const runtime = {
    id: "codex",
    label: "Codex",
    capabilities: { sendMessage: true, setModel: true, rename: true, archive: true },
    async listSessions() {
      return [{
        id: "native-1",
        agentId: "codex",
        name: "任务",
        state: "completed",
        model: "p1/m1",
        directory: "/Users/a/code/demo",
        capabilities: this.capabilities
      }];
    },
    async readSession(id) {
      readCalls += 1;
      return {
        id,
        agentId: "codex",
        name: "任务",
        state: "completed",
        model: "p1/m1",
        directory: "/Users/a/code/demo",
        capabilities: this.capabilities,
        messages: [{ role: "user", text: "你好" }]
      };
    },
    async sendMessage(id, payload) { calls.push(["sendMessage", id, payload]); },
    async setModel(id, model, effort) { calls.push(["setModel", id, model, effort]); },
    async setSettings(id, settings) { calls.push(["setSettings", id, settings]); },
    getSettings() { return { effort: "medium", permissionMode: "workspace-write" }; },
    settings: {
      effortOptions: ["low", "medium", "high"],
      permissionOptions: [{ id: "workspace-write", name: "可写工作区" }]
    },
    async rename(id, title) { calls.push(["rename", id, title]); },
    async archive(id) { calls.push(["archive", id]); },
    respond(requestId, result) { calls.push(["respond", requestId, result]); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    }
  };
  const readConfig = () => ({
    providers: [{ id: "p1", name: "Provider One" }],
    models: [
      { id: "p1/m1", providerId: "p1", enabled: true, allowedClients: ["codex"], capabilities: { tools: true }, contextWindow: 200000 },
      { id: "p1/hidden", providerId: "p1", enabled: false, allowedClients: ["codex"] },
      { id: "p1/claude-only", providerId: "p1", enabled: true, allowedClients: ["claude-code"], agentScopeOverride: true }
    ],
    clients: { codex: { enabled: true } }
  });
  const registry = createSessionRegistry({
    runtimes: [runtime],
    store,
    ledger,
    readConfig
  });
  return { registry, runtime, calls, store, ledger, readCalls() { return readCalls; }, advance(ms) { now += ms; } };
}

test("mobile session ids preserve agent and native id without exposing paths", () => {
  const id = encodeMobileSessionId("codex", "019f:test/value");
  assert.match(id, /^ms_/);
  assert.deepEqual(decodeMobileSessionId(id), {
    agentId: "codex",
    nativeId: "019f:test/value"
  });
  assert.throws(() => decodeMobileSessionId("bad"), /无效/);
});

test("deleting an unsupported native session persists a hidden tombstone", async (t) => {
  const { registry, store, runtime } = fixture(t);
  runtime.delete = async () => { throw new Error("native delete unsupported"); };
  const sessions = await registry.listSessions();
  const result = await registry.perform(sessions[0].id, "delete", {}, "phone-1");
  assert.deepEqual(result, { ok: true, hiddenOnly: true });
  assert.equal(store.getOverlay(sessions[0].id).hidden, true);
  assert.deepEqual(await registry.listSessions(), []);
});

test("registry windows long conversation payloads and reuses settled detail cache", async (t) => {
  const { registry, runtime, readCalls } = fixture(t);
  let reads = 0;
  runtime.readSession = async (id) => {
    reads += 1;
    const base = await Promise.resolve({
      id, agentId: "codex", name: "长会话", state: "completed", model: "p1/m1", directory: "/Users/a/code/demo", capabilities: runtime.capabilities,
      messages: Array.from({ length: 180 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: `消息 ${index}` }))
    });
    return base;
  };
  const id = (await registry.listSessions())[0].id;
  const first = await registry.readSession(id, { messageLimit: 120 });
  assert.equal(first.messages.length, 120);
  assert.equal(first.messages[0].text, "消息 60");
  assert.equal(first.messagesTotal, 180);
  assert.equal(first.hasMoreMessages, true);
  const expanded = await registry.readSession(id, { messageLimit: 500 });
  assert.equal(expanded.messages.length, 180);
  assert.equal(expanded.messages[0].text, "消息 0");
  assert.equal(expanded.hasMoreMessages, false);
  // The expanded view reuses the raw settled history from the first read.
  assert.equal(reads, 1);
});

test("registry returns persisted session index immediately and refreshes it in the background", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mobile-index-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMobileControlStore({ root });
  const ledger = createEventLedger({ file: path.join(root, "events.jsonl") });
  const id = encodeMobileSessionId("codex", "native-warm");
  fs.writeFileSync(path.join(root, "session-index.json"), JSON.stringify({
    updatedAt: Date.now(),
    rows: [{ id, title: "已缓存会话", agent: "codex", state: "completed", archived: false, updatedAt: "2026-07-26T00:00:00.000Z" }]
  }));
  let resolveScan;
  let scans = 0;
  const runtime = {
    id: "codex", label: "Codex", capabilities: {},
    listSessions: () => { scans += 1; return new Promise((resolve) => { resolveScan = resolve; }); },
    async readSession(nativeId) { return { id: nativeId, state: "completed", messages: [] }; }
  };
  const registry = createSessionRegistry({ runtimes: [runtime], store, ledger, readConfig: () => ({ providers: [], models: [] }) });
  const rows = await Promise.race([
    registry.listSessions(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("warm index did not return")), 50))
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "已缓存会话");
  assert.equal(scans, 0);
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  assert.equal(scans, 1);
  resolveScan([]);
});

test("registry lists projected sessions and only returns enabled client-visible models", async (t) => {
  const { registry } = fixture(t);
  const sessions = await registry.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "codex");
  assert.equal(sessions[0].project, "demo");
  // 工作区路径会原样下发供手机复制；其余字段仍应避免泄漏本机绝对路径。
  assert.equal(sessions[0].directory, "/Users/a/code/demo");
  assert.doesNotMatch(JSON.stringify({ ...sessions[0], directory: "" }), /Users/);

  const models = registry.availableModels("codex");
  assert.deepEqual(models, [{
    id: "p1/m1",
    name: "p1/m1",
    provider: "Provider One",
    contextWindow: 200000,
    capabilities: { tools: true }
  }]);
});

test("registry applies the Switchyard default model to new and existing sessions until manually overridden", async (t) => {
  const { registry, runtime, store, calls } = fixture(t);
  runtime.createSession = async (payload) => { calls.push(["createSession", payload]); return { sessionId: "native-new" }; };
  const agent = registry.agents().find((item) => item.id === "codex");
  assert.equal(agent.defaultModelId, "p1/m1");
  const existing = (await registry.listSessions())[0];
  assert.equal(existing.model, "p1/m1");
  const detail = await registry.readSession(existing.id);
  assert.equal(detail.model, "p1/m1");
  const created = await registry.createSession("codex", { cwd: "/tmp", prompt: "开始" }, "phone-1");
  assert.equal(store.getOverlay(created.sessionId).model, "p1/m1");
  assert.equal(calls.at(-1)[1].model, "p1/m1");
  await registry.setSessionModel(existing.id, "p1/m1", "high", "phone-1");
  assert.equal(store.getOverlay(existing.id).model, "p1/m1");
});

test("registry keeps installed Agents visible when one history scan fails and derives recent workspaces", async (t) => {
  const { registry, runtime } = fixture(t);
  const unavailable = {
    id: "claude-code",
    label: "Claude Code",
    capabilities: { sendMessage: true },
    async listSessions() { throw new Error("ACP agent 已退出（1）"); }
  };
  const resilient = createSessionRegistry({
    runtimes: [runtime, unavailable],
    store: fixture(t).store,
    ledger: fixture(t).ledger,
    readConfig: () => ({ providers: [], models: [] })
  });

  await resilient.listSessions();
  const agent = resilient.agents().find((item) => item.id === "claude-code");
  assert.equal(agent.available, true);
  assert.equal(agent.sessionDiscoveryAvailable, false);
  assert.match(agent.error, /ACP agent/);

  const workspaces = await registry.recentWorkspaces();
  assert.deepEqual(workspaces, [{
    id: "/Users/a/code/demo",
    path: "/Users/a/code/demo",
    name: "demo",
    agent: "codex",
    updatedAt: null
  }]);
});

test("registry accepts messages immediately, records visible state and runs the agent asynchronously", async (t) => {
  const { registry, calls, ledger } = fixture(t);
  const sessionId = encodeMobileSessionId("codex", "native-1");

  assert.deepEqual(await registry.perform(sessionId, "sendMessage", {
    text: "继续",
    messageId: "m1"
  }, "phone-1"), { accepted: true, duplicate: false, state: "running" });
  assert.deepEqual(await registry.perform(sessionId, "sendMessage", {
    text: "继续",
    messageId: "m1"
  }, "phone-1"), { accepted: true, duplicate: true });
  await assert.rejects(
    () => registry.perform(sessionId, "sendMessage", { text: "桌面输入", messageId: "m2" }, "desktop"),
    (error) => error?.code === "SESSION_WRITE_CONFLICT"
  );
  assert.deepEqual(ledger.list({ after: 0 }).map((event) => [event.type, event.role, event.summary]), [
    ["message", "user", "继续"],
    ["status", null, "running"]
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  await registry.setSessionModel(sessionId, "p1/m1", "high", "phone-1");

  assert.deepEqual(calls, [
    ["setModel", "native-1", "p1/m1", undefined],
    ["sendMessage", "native-1", { text: "继续", messageId: "m1" }],
    ["setModel", "native-1", "p1/m1", "high"]
  ]);
});

test("registry persists image and arbitrary-file attachments across final history reloads", async (t) => {
  const { registry, runtime, calls, ledger } = fixture(t);
  const sessionId = encodeMobileSessionId("codex", "native-1");
  runtime.readSession = async () => ({
    id: "native-1",
    agentId: "codex",
    name: "任务",
    state: "completed",
    model: "p1/m1",
    directory: "/Users/a/code/demo",
    capabilities: runtime.capabilities,
    messages: [
      { role: "user", text: "看附件" },
      { role: "assistant", text: "已收到" }
    ]
  });

  await registry.perform(sessionId, "sendMessage", {
    text: "看附件",
    messageId: "m-files",
    attachments: [
      { name: "screen.png", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
      { name: "report.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF-demo").toString("base64") }
    ]
  }, "phone-1");
  await new Promise((resolve) => setImmediate(resolve));

  const sent = calls.find((call) => call[0] === "sendMessage")[2];
  assert.equal(sent.attachments[0].kind, "image");
  assert.equal(sent.attachments[1].kind, "file");
  assert.equal(fs.readFileSync(sent.attachments[1].path, "utf8"), "%PDF-demo");
  const event = ledger.list({ after: 0 }).find((row) => row.type === "message");
  assert.deepEqual(event.attachments.map((item) => item.name), ["screen.png", "report.pdf"]);

  const detail = await registry.readSession(sessionId);
  assert.deepEqual(detail.messages[0].attachments.map((item) => item.name), ["screen.png", "report.pdf"]);
  assert.equal(detail.messages[1].attachments, undefined);
  const resolved = registry.resolveAsset(detail.messages[0].attachments[0].id);
  assert.equal(fs.readFileSync(resolved.path, "utf8"), "png");
});

test("registry converts tool file paths into safe clickable file references", async (t) => {
  const { registry, runtime } = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-tool-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "src", "app.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const ok = true;\n");
  runtime.readSession = async () => ({
    id: "native-1",
    agentId: "codex",
    name: "任务",
    state: "completed",
    model: "p1/m1",
    directory: root,
    capabilities: runtime.capabilities,
    messages: [{
      role: "tool",
      kind: "tool",
      text: "写入完成",
      tool: {
        id: "tool-write",
        name: "Write",
        activity: "edit",
        status: "completed",
        files: [{ path: file, activity: "edit" }]
      }
    }]
  });

  const detail = await registry.readSession(encodeMobileSessionId("codex", "native-1"));
  assert.equal(detail.messages[0].tool.files[0].name, "app.js");
  assert.equal(detail.directory, root);
  assert.equal(detail.nativeId, "native-1");
  // 工具附件路径应走 asset id，不应把本机绝对路径泄漏进消息内容。
  assert.doesNotMatch(JSON.stringify({ ...detail, directory: "" }), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(registry.resolveAsset(detail.messages[0].tool.files[0].id).path, file);
});

test("registry turns structured file_delivery events into safe delivered assets", async (t) => {
  const { registry, runtime, ledger } = fixture(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-file-delivery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "exports", "report.xlsx");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, "sheet bytes");
  runtime.listSessions = async () => [{
    id: "native-1", agentId: "codex", name: "任务", state: "completed", model: "p1/m1", directory: root,
    capabilities: runtime.capabilities
  }];
  await registry.listSessions();

  runtime.emit({
    sessionId: "native-1",
    type: "file_delivery",
    summary: "已生成报表",
    delivery: { path: output, name: "report.xlsx" }
  });
  const delivered = ledger.list({ after: 0 }).at(-1);
  assert.equal(delivered.delivery.name, "report.xlsx");
  assert.equal(delivered.delivery.source, "delivery");
  assert.doesNotMatch(JSON.stringify(delivered), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(registry.resolveAsset(delivered.delivery.id).path, output);

  runtime.emit({
    sessionId: "native-1",
    type: "file_delivery",
    summary: "越界文件",
    delivery: { path: path.join(root, "..", "outside.txt") }
  });
  assert.equal(ledger.list({ after: 0 }).at(-1).delivery, undefined);
});

test("registry validates and stores agent-native next-turn settings", async (t) => {
  const { registry, calls } = fixture(t);
  const sessionId = encodeMobileSessionId("codex", "native-1");
  assert.deepEqual(await registry.setSessionSettings(sessionId, {
    effort: "high",
    permissionMode: "workspace-write"
  }, "phone-1"), {
    ok: true,
    effectiveFrom: "next_turn",
    settings: { effort: "medium", permissionMode: "workspace-write" }
  });
  assert.deepEqual(calls, [[
    "setSettings",
    "native-1",
    { effort: "high", permissionMode: "workspace-write" }
  ]]);
  const codex = registry.agents().find((agent) => agent.id === "codex");
  assert.deepEqual(codex.settings, {
    effortOptions: ["low", "medium", "high"],
    permissionOptions: [{ id: "workspace-write", name: "可写工作区" }]
  });
});

test("registry publishes an error event when asynchronous message startup fails", async (t) => {
  const { registry, runtime, ledger } = fixture(t);
  runtime.sendMessage = async () => { throw new Error("Agent 未连接"); };
  const sessionId = encodeMobileSessionId("codex", "native-1");
  assert.equal((await registry.perform(sessionId, "sendMessage", { text: "继续", messageId: "m1" }, "phone-1")).accepted, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ledger.list({ after: 0 }).map((event) => [event.type, event.summary]), [
    ["message", "继续"], ["status", "running"], ["error", "Agent 未连接"]
  ]);
});

test("registry projects live route diagnostics into mobile events without credentials", async (t) => {
  const { registry, runtime } = fixture(t);
  runtime.emit({
    sessionId: "native-1",
    type: "status",
    summary: "running",
    route: {
      requestedModel: "gpt-alias",
      modelId: "p1/m1",
      providerId: "p1",
      upstreamModel: "provider-model",
      apiFormat: "openai_chat",
      accountEmail: "user@example.com",
      streamTerminal: { state: "incomplete", reason: "upstream_stall_timeout" },
      apiKey: "secret-key"
    }
  });
  const event = registry.listEvents({ after: 0 }).at(-1);
  assert.deepEqual(event.route, {
    requestedModel: "gpt-alias",
    modelId: "p1/m1",
    providerId: "p1",
    upstreamModel: "provider-model",
    apiFormat: "openai_chat",
    account: "user@example.com",
    terminalState: "incomplete",
    terminalReason: "upstream_stall_timeout"
  });
  assert.doesNotMatch(JSON.stringify(event), /secret-key/);
});

test("registry maps runtime events into replayable mobile events", async (t) => {
  const { registry, runtime, ledger } = fixture(t);
  runtime.emit({
    sessionId: "native-1",
    type: "message",
    summary: "输出增量"
  });
  const events = registry.listEvents({ after: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, encodeMobileSessionId("codex", "native-1"));
  assert.equal(events[0].summary, "输出增量");
  assert.equal(ledger.latestId(), events[0].id);
});

test("registry releases an incomplete runtime session so the next mobile turn can start", async (t) => {
  const { registry, runtime, calls } = fixture(t);
  const sessionId = encodeMobileSessionId("codex", "native-1");
  assert.equal((await registry.perform(sessionId, "sendMessage", { text: "第一条", messageId: "m-incomplete-1" }, "phone-1")).state, "running");
  await new Promise((resolve) => setImmediate(resolve));
  runtime.emit({ sessionId: "native-1", type: "status", summary: "incomplete" });
  assert.equal((await registry.perform(sessionId, "sendMessage", { text: "第二条", messageId: "m-incomplete-2" }, "phone-1")).state, "running");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter(([name]) => name === "sendMessage").map(([, , payload]) => payload.text), ["第一条", "第二条"]);
});

test("registry exposes one-shot ACP approvals to mobile", async (t) => {
  const { registry, runtime, calls } = fixture(t);
  runtime.emit({
    sessionId: "native-1",
    type: "approval",
    summary: "等待操作审批",
    requestId: 42,
    request: {
      command: "git status --short",
      options: [
        { kind: "allow_once", optionId: "allow" },
        { kind: "allow_always", optionId: "always" },
        { kind: "reject_once", optionId: "reject" }
      ]
    }
  });
  const approvals = registry.listApprovals();
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].actions, ["allow_once", "allow_session", "deny_once"]);
  assert.equal(approvals[0].detail.label, "将执行的命令");
  assert.equal(approvals[0].detail.content, "git status --short");
  assert.doesNotMatch(JSON.stringify(approvals[0]), /allow_always/);
  await registry.resolveApproval(approvals[0].id, "allow_once");
  assert.deepEqual(calls.at(-1), [
    "respond",
    42,
    { outcome: { outcome: "selected", optionId: "allow" } }
  ]);
  assert.equal(registry.listApprovals().length, 0);
});

test("registry exposes every Codex approval for one-shot mobile resolution", async (t) => {
  const { registry, runtime, calls } = fixture(t);
  runtime.emit({
    sessionId: "native-1",
    type: "approval",
    requestId: 51,
    request: {
      method: "item/commandExecution/requestApproval",
      command: "git status --short",
      reason: "查看仓库状态"
    }
  });
  runtime.emit({
    sessionId: "native-1",
    type: "approval",
    requestId: 52,
    request: {
      method: "item/permissions/requestApproval",
      reason: "请求更高权限"
    }
  });

  const approvals = registry.listApprovals();
  assert.equal(approvals.length, 2);
  assert.deepEqual(approvals[0].actions, ["allow_once", "allow_session", "deny_once"]);
  assert.equal(approvals[0].requiresDesktop, false);
  assert.deepEqual(approvals[1].actions, ["allow_once", "allow_session", "deny_once"]);
  assert.equal(approvals[1].requiresDesktop, false);

  await registry.resolveApproval(approvals[1].id, "allow_once");
  assert.deepEqual(calls.at(-1), [
    "respond",
    52,
    { decision: "accept" }
  ]);
  assert.equal(registry.listApprovals().length, 1);
});

test("registry queues follow-up instructions, runs one after completion, and supports edit/cancel", async (t) => {
  const { registry, runtime, calls } = fixture(t);
  const sessionId = encodeMobileSessionId("codex", "native-1");
  await registry.perform(sessionId, "sendMessage", { text: "第一条", messageId: "m1" }, "phone-1");
  await registry.perform(sessionId, "sendMessage", { text: "第二条", messageId: "m2" }, "phone-1");
  let detail = await registry.readSession(sessionId);
  assert.equal(detail.queue.length, 1);
  assert.equal(detail.queue[0].text, "第二条");
  const queueId = detail.queue[0].id;
  await registry.updateQueueItem(sessionId, queueId, { text: "修改后的第二条" }, "phone-1");
  assert.equal((await registry.readSession(sessionId)).queue[0].text, "修改后的第二条");
  runtime.emit({ sessionId: "native-1", type: "status", summary: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call[0] === "sendMessage").at(-1)[2].text, "修改后的第二条");
  assert.equal((await registry.readSession(sessionId)).queue.length, 0);
  await registry.perform(sessionId, "sendMessage", { text: "第三条", messageId: "m3" }, "phone-1");
  detail = await registry.readSession(sessionId);
  await registry.removeQueueItem(sessionId, detail.queue[0].id, "phone-1");
  assert.equal((await registry.readSession(sessionId)).queue.length, 0);
});

test("registry stop defaults to clearing queue while preserving queue requires explicit resume", async (t) => {
  const { registry, runtime, calls } = fixture(t);
  runtime.cancel = async (id) => calls.push(["cancel", id]);
  const sessionId = encodeMobileSessionId("codex", "native-1");
  await registry.perform(sessionId, "sendMessage", { text: "执行中", messageId: "m1" }, "phone-1");
  await registry.perform(sessionId, "sendMessage", { text: "清空我", messageId: "m2" }, "phone-1");
  assert.deepEqual(await registry.perform(sessionId, "cancel", {}, "phone-1"), { ok: true, cleared: 1, queuePaused: false });
  assert.equal((await registry.readSession(sessionId)).queue.length, 0);

  await registry.perform(sessionId, "sendMessage", { text: "再次执行", messageId: "m3" }, "phone-1");
  await registry.perform(sessionId, "sendMessage", { text: "保留我", messageId: "m4" }, "phone-1");
  assert.deepEqual(await registry.perform(sessionId, "cancel", { clearQueue: false }, "phone-1"), { ok: true, cleared: 0, queuePaused: true });
  assert.equal((await registry.readSession(sessionId)).queuePaused, true);
  await registry.resumeQueue(sessionId, "phone-1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call[0] === "sendMessage").at(-1)[2].text, "保留我");
});

test("registry puts guidance ahead of existing queued instructions without starting a parallel turn", async (t) => {
  const { registry, runtime, calls, store } = fixture(t);
  const sessionId = encodeMobileSessionId("codex", "native-1");
  await registry.perform(sessionId, "sendMessage", { text: "当前任务", messageId: "m1" }, "phone-1");
  await registry.perform(sessionId, "sendMessage", { text: "普通排队", messageId: "m2", deliveryMode: "queue" }, "phone-1");
  const result = await registry.perform(sessionId, "sendMessage", { text: "优先引导", messageId: "m3", deliveryMode: "guide" }, "phone-1");
  assert.deepEqual(result, {
    accepted: true, duplicate: false, queued: true, deliveryMode: "guide", position: 1,
    item: result.item, state: "queued"
  });
  assert.deepEqual(store.listQueue(sessionId).map((item) => item.text), ["优先引导", "普通排队"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call[0] === "sendMessage").length, 1);
  runtime.emit({ sessionId: "native-1", type: "status", summary: "completed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call[0] === "sendMessage")[1][2].text, "优先引导");
});

test("registry emits an approval event and waiting state so the current mobile session can render the decision card", async (t) => {
  const { registry, runtime, ledger } = fixture(t);
  runtime.emit({
    sessionId: "native-1",
    type: "approval",
    requestId: 91,
    request: {
      method: "item/commandExecution/requestApproval",
      command: "git status --short",
      reason: "检查工作区状态"
    }
  });

  const sessionId = encodeMobileSessionId("codex", "native-1");
  const events = ledger.list({ after: 0, sessionId });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].approval, {
    id: events[0].approval.id,
    requiresDesktop: false,
    summary: "低风险只读或验证命令"
  });
  assert.equal(events[0].summary, "等待手机端一次性审批");
  assert.equal(events[1].type, "status");
  assert.equal(events[1].summary, "waiting_for_approval");
});

test("registry correlates trusted Codex gateway routes to the exact mobile session", async (t) => {
  const { registry } = fixture(t);
  const sessionId = registry.recordGatewayRequest({
    traceLog: true,
    clientId: "codex",
    correlationThreadId: "019fa127-e5c6-76a3-8a45-41e97a44fed6",
    requestedModel: "gpt-alias",
    modelId: "p1/m1",
    providerId: "p1",
    upstreamModel: "provider-model",
    apiFormat: "openai_chat"
  });
  assert.equal(sessionId, encodeMobileSessionId("codex", "019fa127-e5c6-76a3-8a45-41e97a44fed6"));
  const started = registry.listEvents({ after: 0 }).at(-1);
  assert.equal(started.summary, "running");
  assert.equal(started.route.providerId, "p1");

  registry.recordGatewayRequest({
    requestLog: true,
    clientId: "codex",
    correlationThreadId: "019fa127-e5c6-76a3-8a45-41e97a44fed6",
    requestedModel: "gpt-alias",
    modelId: "p1/m1",
    providerId: "p1",
    upstreamModel: "provider-model",
    apiFormat: "openai_chat",
    status: 200,
    responseSummary: { streamTerminal: { state: "incomplete", reason: "adapter_eof" } }
  });
  const finished = registry.listEvents({ after: 0 }).at(-1);
  assert.equal(finished.summary, "incomplete");
  assert.deepEqual(finished.route, {
    requestedModel: "gpt-alias",
    modelId: "p1/m1",
    providerId: "p1",
    upstreamModel: "provider-model",
    apiFormat: "openai_chat",
    account: "",
    terminalState: "incomplete",
    terminalReason: "adapter_eof"
  });

  assert.equal(registry.recordGatewayRequest({
    requestLog: true,
    clientId: "codex",
    requestedModel: "unsafe-unmatched"
  }), null, "unmatched gateway calls must never be assigned heuristically");
});

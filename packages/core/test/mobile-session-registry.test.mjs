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
      { id: "p1/claude-only", providerId: "p1", enabled: true, allowedClients: ["claude-code"] }
    ],
    clients: { codex: { enabled: true } }
  });
  const registry = createSessionRegistry({
    runtimes: [runtime],
    store,
    ledger,
    readConfig
  });
  return { registry, runtime, calls, store, ledger, advance(ms) { now += ms; } };
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

test("registry lists projected sessions and only returns enabled client-visible models", async (t) => {
  const { registry } = fixture(t);
  const sessions = await registry.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "codex");
  assert.equal(sessions[0].project, "demo");
  assert.doesNotMatch(JSON.stringify(sessions[0]), /Users/);

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

test("registry exposes only low-risk one-shot approvals to mobile", async (t) => {
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
  assert.deepEqual(approvals[0].actions, ["allow_once", "deny_once"]);
  assert.doesNotMatch(JSON.stringify(approvals[0]), /git status|allow_always/);
  await registry.resolveApproval(approvals[0].id, "allow_once");
  assert.deepEqual(calls.at(-1), [
    "respond",
    42,
    { outcome: { outcome: "selected", optionId: "allow" } }
  ]);
  assert.equal(registry.listApprovals().length, 0);
});

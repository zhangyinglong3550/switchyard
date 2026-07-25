import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMobileControlStore } from "../../../apps/desktop/src/mobile-control/store.mjs";
import { createMobileControlServer } from "../../../apps/desktop/src/mobile-control/server.mjs";

test("mobile server pairs a device, protects APIs and routes session actions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mobile-server-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createMobileControlStore({ root });
  const calls = [];
  const registry = {
    agents: () => [{ id: "codex", name: "Codex", available: true, capabilities: { sendMessage: true } }],
    availableModels: () => [{ id: "p/m", name: "Model", provider: "P", contextWindow: 1000, capabilities: {} }],
    recentWorkspaces: async () => [{ id: "/approved/demo", name: "demo", agent: "codex" }],
    browseWorkspaces: async (directory) => ({ path: directory || "/Users/alice", name: "alice", parent: "/Users", directories: [{ path: "/Users/alice/demo", name: "demo" }] }),
    createWorkspaceDirectory: async (parent, name) => ({ path: `${parent}/${name}`, name }),
    deleteWorkspaceDirectory: async (directory) => ({ ok: true, path: directory }),
    renameWorkspaceDirectory: async (directory, name) => ({ path: `${directory}-renamed`, name }),
    listSessions: async () => [{ id: "ms_one", agent: "codex", title: "任务", state: "completed" }],
    readSession: async () => ({ id: "ms_one", agent: "codex", title: "任务", messages: [] }),
    createSession: async (agent, body, owner) => {
      calls.push(["create", agent, body, owner]);
      return { sessionId: "ms_new" };
    },
    perform: async (id, action, body, owner) => {
      calls.push(["perform", id, action, body, owner]);
      return { ok: true };
    },
    setSessionModel: async (id, model, effort, owner) => {
      calls.push(["model", id, model, effort, owner]);
      return { ok: true, effectiveFrom: "next_turn" };
    },
    setSessionSettings: async (id, settings, owner) => {
      calls.push(["settings", id, settings, owner]);
      return { ok: true, effectiveFrom: "next_turn", settings };
    },
    listEvents: () => [{ id: 1, sessionId: "ms_one", type: "status", createdAt: "2026-07-23T12:00:00Z", summary: "completed" }]
    ,
    listApprovals: () => [{ id: "approval_1", sessionId: "ms_one", title: "低风险操作", actions: ["allow_once", "deny_once"] }],
    resolveApproval: async (id, decision, owner) => {
      calls.push(["approval", id, decision, owner]);
      return { ok: true };
    }
  };
  const server = createMobileControlServer({
    host: "127.0.0.1",
    port: 0,
    store,
    registry,
    publicDir: path.resolve("apps/mobile")
  });
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.status().port}`;

  const challenge = store.createChallenge();
  const pairedResponse = await fetch(`${base}/mobile/pair/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: challenge.secret, name: "iPhone" })
  });
  assert.equal(pairedResponse.status, 201);
  const paired = await pairedResponse.json();
  assert.match(paired.token, /^sym_/);

  assert.equal((await fetch(`${base}/mobile/v1/sessions`)).status, 401);
  assert.equal((await fetch(`${base}/mobile/v1/sessions`, {
    headers: { authorization: `Bearer ${paired.token}`, origin: "http://evil.example" }
  })).status, 403);

  const headers = {
    authorization: `Bearer ${paired.token}`,
    "content-type": "application/json",
    origin: base
  };
  const sessions = await fetch(`${base}/mobile/v1/sessions`, { headers });
  assert.equal(sessions.status, 200);
  assert.deepEqual(await sessions.json(), [{ id: "ms_one", agent: "codex", title: "任务", state: "completed" }]);
  const workspaces = await fetch(`${base}/mobile/v1/workspaces`, { headers });
  assert.equal(workspaces.status, 200);
  assert.equal((await workspaces.json())[0].name, "demo");
  const browser = await fetch(`${base}/mobile/v1/workspaces/browse?path=${encodeURIComponent("/Users/alice")}`, { headers });
  assert.equal(browser.status, 200);
  assert.equal((await browser.json()).directories[0].name, "demo");
  const directory = await fetch(`${base}/mobile/v1/workspaces/directories`, {
    method: "POST", headers, body: JSON.stringify({ parent: "/Users/alice", name: "new-project" })
  });
  assert.equal(directory.status, 201);
  assert.equal((await directory.json()).path, "/Users/alice/new-project");
  const deleted = await fetch(`${base}/mobile/v1/workspaces/directories?path=${encodeURIComponent("/Users/alice/new-project")}`, {
    method: "DELETE",
    headers
  });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).ok, true);
  const renamed = await fetch(`${base}/mobile/v1/workspaces/directories/rename`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path: "/Users/alice/demo", name: "demo2" })
  });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "demo2");

  const created = await fetch(`${base}/mobile/v1/sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: "codex", cwd: "/approved/demo", prompt: "开始", model: "p/m" })
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { sessionId: "ms_new" });
  await new Promise((resolve) => setImmediate(resolve));

  const model = await fetch(`${base}/mobile/v1/sessions/ms_one/model`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "p/m", effort: "high" })
  });
  assert.equal(model.status, 200);
  assert.equal((await model.json()).effectiveFrom, "next_turn");
  const settings = await fetch(`${base}/mobile/v1/sessions/ms_one/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ effort: "high", permissionMode: "workspace-write" })
  });
  assert.equal(settings.status, 200);
  assert.deepEqual((await settings.json()).settings, {
    effort: "high",
    permissionMode: "workspace-write"
  });

  const events = await fetch(`${base}/mobile/v1/events?after=0`, { headers });
  assert.equal(events.status, 200);
  assert.equal((await events.json())[0].id, 1);
  const approvals = await fetch(`${base}/mobile/v1/approvals`, { headers });
  assert.equal(approvals.status, 200);
  assert.equal((await approvals.json())[0].id, "approval_1");
  const approvalResult = await fetch(`${base}/mobile/v1/approvals/approval_1/resolve`, {
    method: "POST",
    headers,
    body: JSON.stringify({ decision: "allow_once" })
  });
  assert.equal(approvalResult.status, 200);
  assert.equal(calls[0][0], "create");
  assert.equal(calls[1][0], "perform");
  assert.equal(calls[2][0], "model");
  assert.equal(calls[3][0], "settings");
  assert.equal(calls[4][0], "approval");
});

test("mobile server serves the PWA but never exposes arbitrary files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mobile-static-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = createMobileControlServer({
    host: "127.0.0.1",
    port: 0,
    store: createMobileControlStore({ root }),
    registry: { agents: () => [], listEvents: () => [] },
    publicDir: path.resolve("apps/mobile")
  });
  await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${server.status().port}`;
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/../../package.json`)).status, 404);
});

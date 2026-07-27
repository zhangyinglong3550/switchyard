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
    listCommands: async () => [{ id: "skill:review", kind: "skill", name: "review", description: "Review code", insertText: "$review ", source: "installed" }],
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
    updateQueueItem: async (id, itemId, body, owner) => {
      calls.push(["queue-update", id, itemId, body, owner]);
      return { id: itemId, text: body.text || "" };
    },
    removeQueueItem: async (id, itemId, owner) => {
      calls.push(["queue-remove", id, itemId, owner]);
      return { ok: true };
    },
    resumeQueue: async (id, owner) => {
      calls.push(["queue-resume", id, owner]);
      return { ok: true, dispatched: true };
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
    },
    resolveAsset: (id) => id === "asset_image"
      ? { id, name: "screen.png", mimeType: "image/png", kind: "image", path: path.join(root, "screen.png") }
      : null
  };
  fs.writeFileSync(path.join(root, "screen.png"), "image-data");
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
  const preferences = await fetch(`${base}/mobile/v1/preferences`, { headers });
  assert.deepEqual(await preferences.json(), { conversationSendMode: "ask" });
  const updatedPreferences = await fetch(`${base}/mobile/v1/preferences`, { method: "POST", headers, body: JSON.stringify({ conversationSendMode: "queue" }) });
  assert.deepEqual(await updatedPreferences.json(), { conversationSendMode: "queue" });

  const sessions = await fetch(`${base}/mobile/v1/sessions`, { headers });
  assert.equal(sessions.status, 200);
  assert.deepEqual(await sessions.json(), [{ id: "ms_one", agent: "codex", title: "任务", state: "completed" }]);
  const commands = await fetch(`${base}/mobile/v1/commands?agent=codex`, { headers });
  assert.equal(commands.status, 200);
  assert.equal((await commands.json())[0].insertText, "$review ");
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
    body: JSON.stringify({
      agent: "codex",
      cwd: "/approved/demo",
      prompt: "开始",
      model: "p/m",
      attachments: [{ name: "note.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") }]
    })
  });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { sessionId: "ms_new" });
  await new Promise((resolve) => setImmediate(resolve));

  registry.updateQueueItem = async (id, itemId, body, owner) => { calls.push(["queue-update", id, itemId, body, owner]); return { id: itemId, text: body.text }; };
  registry.removeQueueItem = async (id, itemId, owner) => { calls.push(["queue-remove", id, itemId, owner]); return { ok: true }; };
  registry.resumeQueue = async (id, owner) => { calls.push(["queue-resume", id, owner]); return { ok: true }; };
  const queueUpdate = await fetch(`${base}/mobile/v1/sessions/ms_one/queue/q1`, { method: "POST", headers, body: JSON.stringify({ text: "改后" }) });
  assert.equal(queueUpdate.status, 200);
  const queueRemove = await fetch(`${base}/mobile/v1/sessions/ms_one/queue/q1`, { method: "DELETE", headers });
  assert.equal(queueRemove.status, 200);
  const queueResume = await fetch(`${base}/mobile/v1/sessions/ms_one/queue/resume`, { method: "POST", headers, body: JSON.stringify({}) });
  assert.equal(queueResume.status, 200);

  const queueUpdated = await fetch(`${base}/mobile/v1/sessions/ms_one/queue/item_1`, {
    method: "POST", headers, body: JSON.stringify({ text: "编辑后的指令" })
  });
  assert.equal(queueUpdated.status, 200);
  assert.equal((await queueUpdated.json()).text, "编辑后的指令");
  const queueRemoved = await fetch(`${base}/mobile/v1/sessions/ms_one/queue/item_1`, { method: "DELETE", headers });
  assert.equal(queueRemoved.status, 200);
  const queueResumed = await fetch(`${base}/mobile/v1/sessions/ms_one/queue/resume`, { method: "POST", headers, body: "{}" });
  assert.equal(queueResumed.status, 200);

  const sentMessage = await fetch(`${base}/mobile/v1/sessions/ms_one/messages`, {
    method: "POST", headers, body: JSON.stringify({ text: "优先处理", messageId: "m-guide", deliveryMode: "guide" })
  });
  assert.equal(sentMessage.status, 202);

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
  const asset = await fetch(`${base}/mobile/v1/assets/asset_image`, { headers });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "image/png");
  assert.equal(await asset.text(), "image-data");
  assert.equal((await fetch(`${base}/mobile/v1/assets/asset_image`)).status, 401);
  assert.equal(calls[0][0], "create");
  assert.equal(calls[1][0], "perform");
  assert.equal(calls[1][3].attachments[0].name, "note.txt");
  assert.ok(calls.some((call) => call[0] === "queue-update"));
  assert.ok(calls.some((call) => call[0] === "queue-remove"));
  assert.ok(calls.some((call) => call[0] === "queue-resume"));
  assert.equal(calls.find((call) => call[0] === "perform" && call[2] === "sendMessage" && call[3].messageId === "m-guide")[3].deliveryMode, "guide");
  assert.ok(calls.some((call) => call[0] === "model"));
  assert.ok(calls.some((call) => call[0] === "settings"));
  assert.ok(calls.some((call) => call[0] === "approval"));
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

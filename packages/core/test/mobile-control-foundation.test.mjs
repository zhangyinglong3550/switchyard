import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMobileControlStore } from "../../../apps/desktop/src/mobile-control/store.mjs";
import { projectMobileEvent, projectMobileSession } from "../../../apps/desktop/src/mobile-control/dto.mjs";
import { createEventLedger } from "../../../apps/desktop/src/mobile-control/event-ledger.mjs";
import { mobileRuntimeEnv, detectMobileAgents } from "../../../apps/desktop/src/mobile-control-host.mjs";

const NOW = Date.parse("2026-07-23T12:00:00.000Z");

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mobile-control-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("mobile store consumes pairing challenge once and revocation is immediate", (t) => {
  const root = tempRoot(t);
  let now = NOW;
  const store = createMobileControlStore({
    root,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 7)
  });

  const challenge = store.createChallenge({ ttlMs: 10 * 60 * 1000 });
  assert.equal(challenge.expiresAt, "2026-07-23T12:10:00.000Z");
  const device = store.completePairing({ challenge: challenge.secret, name: "我的 iPhone" });

  assert.match(device.id, /^device_/);
  assert.match(device.token, /^sym_/);
  assert.equal(store.authenticate(device.token).name, "我的 iPhone");
  assert.throws(
    () => store.completePairing({ challenge: challenge.secret, name: "Replay" }),
    /已使用/
  );

  store.revokeDevice(device.id);
  assert.throws(() => store.authenticate(device.token), /已撤销/);

  const persisted = fs.readFileSync(path.join(root, "state.json"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(device.token));
  assert.doesNotMatch(persisted, new RegExp(challenge.secret));
});

test("mobile store rejects expired challenge and duplicate message ids", (t) => {
  const root = tempRoot(t);
  let now = NOW;
  const store = createMobileControlStore({ root, now: () => now });
  const challenge = store.createChallenge({ ttlMs: 1000 });
  now += 1001;
  assert.throws(
    () => store.completePairing({ challenge: challenge.secret, name: "Expired" }),
    /已过期/
  );

  assert.equal(store.rememberMessage({ sessionId: "s1", messageId: "m1" }).duplicate, false);
  assert.equal(store.rememberMessage({ sessionId: "s1", messageId: "m1" }).duplicate, true);
});

test("mobile store persists uploaded attachments and user-message metadata", (t) => {
  const root = tempRoot(t);
  const store = createMobileControlStore({ root });
  const attachment = store.putAttachment({
    sessionId: "s1",
    messageId: "m1",
    index: 0,
    name: "screen.png",
    mimeType: "image/png",
    kind: "image",
    data: Buffer.from("image-bytes").toString("base64")
  });
  store.rememberMobileMessage({
    sessionId: "s1",
    messageId: "m1",
    text: "看图",
    attachments: [attachment]
  });

  assert.match(attachment.id, /^asset_/);
  assert.equal(attachment.name, "screen.png");
  assert.equal(fs.readFileSync(store.resolveAsset(attachment.id).path, "utf8"), "image-bytes");
  assert.equal(fs.statSync(store.resolveAsset(attachment.id).path).mode & 0o777, 0o600);
  const messages = store.listMobileMessages("s1");
  assert.match(messages[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(messages.map(({ createdAt, ...message }) => message), [{
    messageId: "m1",
    text: "看图",
    attachments: [attachment]
  }]);

  const reloaded = createMobileControlStore({ root });
  assert.equal(reloaded.resolveAsset(attachment.id).name, "screen.png");
  assert.equal(reloaded.listMobileMessages("s1")[0].attachments[0].id, attachment.id);
});

test("mobile store exposes only workspace files through opaque references", (t) => {
  const root = tempRoot(t);
  const workspace = path.join(root, "workspace");
  const file = path.join(workspace, "src", "app.js");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "console.log('ok')\n");
  const store = createMobileControlStore({ root: path.join(root, "store") });

  const reference = store.registerWorkspaceFile({
    sessionId: "s1",
    workspaceRoot: workspace,
    filePath: file,
    activity: "edit"
  });
  assert.match(reference.id, /^asset_/);
  assert.deepEqual(reference, {
    id: reference.id,
    name: "app.js",
    mimeType: "text/javascript",
    kind: "workspace_file",
    byteLength: fs.statSync(file).size,
    activity: "edit"
  });
  assert.equal(store.resolveAsset(reference.id).path, file);
  assert.throws(() => store.registerWorkspaceFile({
    sessionId: "s1",
    workspaceRoot: workspace,
    filePath: path.join(root, "outside.txt"),
    activity: "read"
  }), /工作目录/);
});

test("mobile store overlays and write leases are scoped per session", (t) => {
  const root = tempRoot(t);
  let now = NOW;
  const store = createMobileControlStore({ root, now: () => now });

  store.patchOverlay("s1", { title: "新的任务名", archived: true, pinned: true });
  assert.deepEqual(store.getOverlay("s1"), {
    title: "新的任务名",
    archived: true,
    pinned: true,
    updatedAt: "2026-07-23T12:00:00.000Z"
  });

  const lease = store.acquireLease({ sessionId: "s1", ownerId: "phone-1", ttlMs: 5000 });
  assert.equal(lease.ownerId, "phone-1");
  assert.throws(
    () => store.acquireLease({ sessionId: "s1", ownerId: "desktop", ttlMs: 5000 }),
    (error) => error?.code === "SESSION_WRITE_CONFLICT"
  );
  now += 5001;
  assert.equal(
    store.acquireLease({ sessionId: "s1", ownerId: "desktop", ttlMs: 5000 }).ownerId,
    "desktop"
  );
  assert.equal(store.releaseLease({ sessionId: "s1", ownerId: "phone-1" }).released, false);
  assert.equal(store.releaseLease({ sessionId: "s1", ownerId: "desktop" }).released, true);
});

test("mobile DTO only exposes allowlisted session and event fields", () => {
  const session = projectMobileSession({
    id: "s1",
    agentId: "codex",
    name: "任务",
    state: "running",
    mtime: "2026-07-23T12:00:00.000Z",
    model: "codex/gpt-5.5",
    directory: "/Users/alice/secret/project",
    path: "/Users/alice/.codex/sessions/private.jsonl",
    apiKey: "sk-secret",
    conversation: { messages: [{ role: "user", text: "private prompt" }] },
    capabilities: {
      sendMessage: true,
      setModel: true,
      shell: true,
      providerConfig: true
    }
  }, {
    title: "手机显示名",
    pinned: true,
    archived: false
  });

  assert.deepEqual(session, {
    id: "s1",
    agent: "codex",
    title: "手机显示名",
    state: "running",
    updatedAt: "2026-07-23T12:00:00.000Z",
    model: "codex/gpt-5.5",
    project: "project",
    pinned: true,
    archived: false,
    capabilities: {
      sendMessage: true,
      setModel: true
    }
  });
  assert.doesNotMatch(JSON.stringify(session), /secret|private prompt|sk-/);

  const event = projectMobileEvent({
    id: 9,
    sessionId: "s1",
    type: "tool",
    createdAt: "2026-07-23T12:00:01.000Z",
    summary: "读取文件完成",
    rawInput: { path: "/Users/alice/.ssh/id_ed25519" },
    token: "Bearer hidden"
  });
  assert.deepEqual(event, {
    id: 9,
    sessionId: "s1",
    type: "tool",
    role: null,
    createdAt: "2026-07-23T12:00:01.000Z",
    summary: "读取文件完成"
  });
});

test("mobile DTO keeps safe attachment and clickable-file metadata", () => {
  const event = projectMobileEvent({
    id: 10,
    sessionId: "s1",
    type: "tool",
    summary: "修改文件",
    attachments: [{
      id: "asset_image",
      name: "screen.png",
      mimeType: "image/png",
      kind: "image",
      byteLength: 20,
      path: "/Users/alice/private/screen.png"
    }],
    tool: {
      id: "tool-1",
      name: "Write",
      status: "completed",
      files: [{
        id: "asset_file",
        name: "app.js",
        mimeType: "text/javascript",
        kind: "workspace_file",
        byteLength: 100,
        activity: "edit",
        path: "/Users/alice/project/app.js"
      }]
    }
  });
  assert.deepEqual(event.attachments, [{
    id: "asset_image",
    name: "screen.png",
    mimeType: "image/png",
    kind: "image",
    byteLength: 20
  }]);
  assert.equal(event.tool.files[0].id, "asset_file");
  assert.doesNotMatch(JSON.stringify(event), /\/Users\/alice/);
});

test("event ledger replays strictly after cursor without duplicates", (t) => {
  const root = tempRoot(t);
  const file = path.join(root, "events.jsonl");
  let now = NOW;
  const ledger = createEventLedger({ file, now: () => now, maxEvents: 3 });
  const one = ledger.append({ sessionId: "s1", type: "status", summary: "running" });
  now += 1;
  const two = ledger.append({ sessionId: "s1", type: "status", summary: "waiting" });
  now += 1;
  const three = ledger.append({ sessionId: "s1", type: "status", summary: "completed" });
  now += 1;
  const four = ledger.append({ sessionId: "s2", type: "status", summary: "failed" });

  assert.deepEqual(ledger.list({ after: one.id }).map((event) => event.id), [
    two.id,
    three.id,
    four.id
  ]);
  assert.deepEqual(ledger.list({ after: two.id, sessionId: "s1" }).map((event) => event.id), [
    three.id
  ]);
  assert.equal(ledger.latestId(), four.id);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 3);

  const reloaded = createEventLedger({ file, now: () => now, maxEvents: 3 });
  assert.equal(reloaded.latestId(), four.id);
  assert.deepEqual(reloaded.list({ after: 0 }).map((event) => event.id), [
    two.id,
    three.id,
    four.id
  ]);
});

test("mobile runtime restores user CLI paths lost by launchd", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-mobile-path-"));
  const npmBin = path.join(home, "npm-global", "bin");
  const localBin = path.join(home, ".local", "bin");
  fs.mkdirSync(npmBin, { recursive: true });
  fs.mkdirSync(localBin, { recursive: true });
  try {
    const env = mobileRuntimeEnv({ PATH: "/usr/bin:/bin", LANG: "zh_CN.UTF-8" }, home);
    const paths = env.PATH.split(path.delimiter);
    assert.ok(paths.includes(npmBin));
    assert.ok(paths.includes(localBin));
    assert.ok(paths.includes("/usr/bin"));
    assert.equal(env.HOME, home);
    assert.equal(env.LANG, "zh_CN.UTF-8");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("mobile agent discovery only exposes installed native clients", (t) => {
  const root = tempRoot(t);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "grok"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const agents = detectMobileAgents({ env: { PATH: bin }, home: root });
  assert.equal(agents.grok, path.join(bin, "grok"));
  assert.equal(agents["claude-code"], null);
  assert.equal(agents.opencode, null);
});

test("mobile event DTO keeps safe structured tool fields and redacts secrets", async () => {
  const { projectMobileEvent } = await import("../../../apps/desktop/src/mobile-control/dto.mjs");
  const event = projectMobileEvent({
    type: "tool",
    summary: "执行命令",
    tool: { id: "call-1", name: "shell", activity: "command", command: "curl -H 'Authorization: Bearer secret-token' /Users/alice/demo", arguments: '{"token":"sk-secret123456"}', status: "running", output: "ok" }
  });
  assert.equal(event.tool.id, "call-1");
  assert.equal(event.tool.status, "running");
  assert.equal(event.tool.activity, "command");
  assert.doesNotMatch(event.tool.command, /secret-token|\/Users\/alice/);
  assert.doesNotMatch(event.tool.arguments, /sk-secret123456/);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function fixture(t, records) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-handoff-"));
  process.env.SWITCHYARD_AGENT_HOME = home;
  const project = path.join(home, ".claude", "projects", "demo-project");
  fs.mkdirSync(project, { recursive: true });
  const source = path.join(project, "session.jsonl");
  fs.writeFileSync(source, records.map((item) => JSON.stringify(item)).join("\n") + "\n");
  const resources = await import(`../../../apps/desktop/src/agent-resources.mjs?handoff=${Date.now()}-${Math.random()}`);
  const row = resources.listAgentSessions({ agentId: "claude-code" })[0];
  const handoff = await import(`../../../apps/desktop/src/session-handoff.mjs?handoff=${Date.now()}-${Math.random()}`);
  t.after(() => {
    delete process.env.SWITCHYARD_AGENT_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, source, row, handoff };
}

const conversation = [
  { type: "user", timestamp: "2026-07-22T01:00:00.000Z", cwd: "/missing/project", message: { role: "user", content: [{ type: "text", text: "先分析项目" }, { type: "tool_result", content: "secret output" }] } },
  { type: "assistant", timestamp: "2026-07-22T01:00:01.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "分析完成" }, { type: "tool_use", name: "Read" }] } },
  { type: "attachment", attachment: { name: "design.png" } }
];

test("handoff preview normalizes Claude dialogue without modifying source", async (t) => {
  const { source, row, handoff } = await fixture(t, conversation);
  const before = { hash: sha256(source), mtime: fs.statSync(source).mtimeMs };
  const preview = handoff.previewSessionHandoffToCodex(row.id);

  assert.equal(preview.sourceAgent, "claude-code");
  assert.equal(preview.targetAgent, "codex");
  assert.equal(preview.messageCount, 2);
  assert.equal(preview.userCount, 1);
  assert.equal(preview.assistantCount, 1);
  assert.equal(preview.ignoredCount, 4);
  assert.deepEqual(preview.memory.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "先分析项目" },
    { role: "assistant", content: "分析完成" }
  ]);
  assert.equal(preview.truncated, false);
  assert.equal(sha256(source), before.hash);
  assert.equal(fs.statSync(source).mtimeMs, before.mtime);
  assert.match(preview.fingerprint, /^[a-f0-9]{64}$/);
});

test("handoff rejects non-Claude and oversized source sessions", async (t) => {
  const { home, handoff } = await fixture(t, conversation);
  const codexDir = path.join(home, ".codex", "sessions");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "rollout.jsonl"), "{}\n");
  const resources = await import(`../../../apps/desktop/src/agent-resources.mjs?reject=${Date.now()}`);
  const codex = resources.listAgentSessions({ agentId: "codex" })[0];
  assert.throws(() => handoff.previewSessionHandoffToCodex(codex.id), /仅支持 Claude Code/);
  assert.throws(() => handoff.previewSessionHandoffToCodex(Buffer.from(JSON.stringify({ agentId: "claude-code", root: path.join(home, ".claude", "projects"), target: path.join(home, ".claude", "projects", "demo-project", "session.jsonl") })).toString("base64url"), { maxSourceBytes: 10 }), /过大/);
});

test("handoff imports in batches, writes checkpoint, and leaves Claude source unchanged", async (t) => {
  const many = [];
  for (let i = 0; i < 205; i++) many.push({ type: i % 2 ? "assistant" : "user", cwd: i === 0 ? process.cwd() : undefined, message: { role: i % 2 ? "assistant" : "user", content: `m${i}` } });
  const { home, source, row, handoff } = await fixture(t, many);
  const calls = [];
  const rollout = path.join(home, ".codex", "sessions", "2026", "07", "rollout-thread-1.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  fs.writeFileSync(rollout, JSON.stringify({ timestamp: "2026-07-22T00:00:00.000Z", type: "session_meta", payload: { id: "thread-1", cwd: process.cwd() } }) + "\n");
  const fake = async (operation) => operation({ call: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" }, model: "gpt-test" };
    if (method === "thread/read") return { thread: { id: "thread-1", path: rollout } };
    return {};
  } });
  const before = sha256(source);
  const result = await handoff.handoffSessionToCodex(row.id, { title: "X".repeat(250), withAppServer: fake, home });

  assert.equal(result.targetThreadId, "thread-1");
  assert.equal(result.title.length, 200);
  assert.equal(sha256(source), before);
  assert.deepEqual(calls.map((item) => item.method), ["thread/start", "thread/inject_items", "thread/inject_items", "thread/name/set", "thread/read"]);
  assert.equal(calls.filter((item) => item.method === "thread/inject_items")[0].params.items.length, 200);
  assert.equal(calls.filter((item) => item.method === "thread/inject_items")[1].params.items.length, 5);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(home, ".switchyard", "session-handoffs.json"), "utf8"));
  assert.equal(checkpoint.handoffs[0].targetThreadId, "thread-1");
  const projection = fs.readFileSync(rollout, "utf8");
  assert.match(projection, /switchyard-session-handoff-v1/);
  assert.match(projection, /task_started/);
  assert.match(projection, /task_complete/);
  assert.ok(fs.readdirSync(path.join(home, ".switchyard", "backups", "session-handoff")).length >= 1);

  await assert.rejects(() => handoff.handoffSessionToCodex(row.id, { withAppServer: fake, home }), /已接力到 Codex/);
});

test("handoff archives a newly created Codex thread after import failure", async (t) => {
  const { home, row, handoff } = await fixture(t, conversation);
  const calls = [];
  const fake = async (operation) => operation({ call: async (method) => {
    calls.push(method);
    if (method === "thread/start") return { thread: { id: "thread-failed" } };
    if (method === "thread/inject_items") throw new Error("inject failed");
    return {};
  } });
  await assert.rejects(() => handoff.handoffSessionToCodex(row.id, { withAppServer: fake, home }), /inject failed/);
  assert.deepEqual(calls, ["thread/start", "thread/inject_items", "thread/archive"]);
  assert.equal(fs.existsSync(path.join(home, ".switchyard", "session-handoffs.json")), false);
});

test("projection repair restores the new rollout when atomic replacement fails", async (t) => {
  const { home, handoff } = await fixture(t, conversation);
  const rollout = path.join(home, ".codex", "sessions", "rollout-thread.jsonl");
  fs.mkdirSync(path.dirname(rollout), { recursive: true });
  const original = JSON.stringify({ type: "session_meta", payload: { id: "thread" } }) + "\n";
  fs.writeFileSync(rollout, original);
  assert.throws(() => handoff.repairCodexRolloutProjection(rollout, {
    messages: [{ role: "user", content: "hello" }]
  }, { home, replaceFile: (_temp, target) => {
    fs.rmSync(target);
    throw new Error("replace failed");
  } }), /replace failed/);
  assert.equal(fs.readFileSync(rollout, "utf8"), original);
});

test("desktop wires Claude handoff preview and import controls", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.mjs"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/desktop/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/renderer.js"), "utf8");
  assert.match(main, /agent:sessions:handoff-preview/);
  assert.match(main, /agent:sessions:handoff-to-codex/);
  assert.match(main, /memory: _memory/);
  assert.match(html, /id="session-handoff-wrap"/);
  assert.match(renderer, /data-session-handoff/);
  assert.match(renderer, /复制接力/);
});

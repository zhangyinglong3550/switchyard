import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function hasSqlite3() {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-history-"));
process.env.HOME = tmpHome;
process.env.SWITCHYARD_CODEX_STATE_DB = path.join(tmpHome, ".codex", "state_5.sqlite");

const history = await import("../src/history-unify.mjs");

function sqlite(db, sql) {
  execFileSync("sqlite3", [db, sql], { stdio: "pipe" });
}

function sqliteJson(db, sql) {
  const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" });
  return out.trim() ? JSON.parse(out) : [];
}

function setupState() {
  const root = fs.mkdtempSync(path.join(tmpHome, "case-"));
  const codexHome = path.join(root, ".codex");
  const sessions = path.join(codexHome, "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const db = path.join(codexHome, "state_5.sqlite");
  process.env.HOME = root;
  process.env.SWITCHYARD_CODEX_STATE_DB = db;
  sqlite(db, `
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      updated_at INTEGER,
      updated_at_ms INTEGER
    );
  `);
  const openaiRollout = path.join(sessions, "openai.jsonl");
  const customRollout = path.join(sessions, "custom.jsonl");
  const switchyardRollout = path.join(sessions, "switchyard.jsonl");
  fs.writeFileSync(openaiRollout, JSON.stringify({
    type: "session_meta",
    payload: { id: "thread-openai", model_provider: "openai" }
  }) + "\n", "utf8");
  fs.writeFileSync(customRollout, JSON.stringify({
    type: "session_meta",
    payload: { id: "thread-custom", model_provider: "custom" }
  }) + "\n", "utf8");
  fs.writeFileSync(switchyardRollout, JSON.stringify({
    type: "session_meta",
    payload: { id: "thread-switchyard", model_provider: "switchyard" }
  }) + "\n", "utf8");
  sqlite(db, `
    INSERT INTO threads (id, rollout_path, model_provider, updated_at, updated_at_ms)
    VALUES
      ('thread-openai', '${openaiRollout.replaceAll("'", "''")}', 'openai', 1, 1000),
      ('thread-custom', '${customRollout.replaceAll("'", "''")}', 'custom', 2, 2000),
      ('thread-switchyard', '${switchyardRollout.replaceAll("'", "''")}', 'switchyard', 3, 3000);
  `);
  return { root, db, openaiRollout, customRollout, switchyardRollout };
}

test("codex history unify · dry-run reports affected threads without writing", (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const { db, openaiRollout } = setupState();

  const result = history.unifyCodexHistory({ dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.affectedThreads, 2);
  assert.deepEqual(result.counts, { switchyard: 1, openai: 1 });
  const rows = sqliteJson(db, "SELECT id, model_provider FROM threads ORDER BY id");
  assert.deepEqual(rows, [
    { id: "thread-custom", model_provider: "custom" },
    { id: "thread-openai", model_provider: "openai" },
    { id: "thread-switchyard", model_provider: "switchyard" }
  ]);
  assert.match(fs.readFileSync(openaiRollout, "utf8"), /"model_provider":"openai"/);
});

test("codex history unify · rewrites source providers with backups", (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const { db, openaiRollout, customRollout, switchyardRollout } = setupState();

  const result = history.unifyCodexHistory();
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.affectedThreads, 2);
  assert.equal(result.backedUpRollouts, 2);
  assert.equal(result.updatedRollouts, 2);
  assert.ok(fs.existsSync(path.join(result.backupRoot, "state_5.sqlite")));
  assert.ok(fs.existsSync(path.join(result.backupRoot, "sessions", "openai.jsonl")));
  const rows = sqliteJson(db, "SELECT id, model_provider FROM threads ORDER BY id");
  assert.deepEqual(rows, [
    { id: "thread-custom", model_provider: "custom" },
    { id: "thread-openai", model_provider: "custom" },
    { id: "thread-switchyard", model_provider: "custom" }
  ]);
  assert.match(fs.readFileSync(openaiRollout, "utf8"), /"model_provider":"custom"/);
  assert.match(fs.readFileSync(customRollout, "utf8"), /"model_provider":"custom"/);
  assert.match(fs.readFileSync(switchyardRollout, "utf8"), /"model_provider":"custom"/);
});

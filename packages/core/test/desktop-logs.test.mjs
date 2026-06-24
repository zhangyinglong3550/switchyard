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

test("desktop logs · appendLog persists requestLog events to SQLite", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-logs-"));
  process.env.SWITCHYARD_LOG_DIR = path.join(tmp, "logs");
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(async () => {
    try { await logs.closeLogStreamForTest(); } catch {}
    delete process.env.SWITCHYARD_LOG_DIR;
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const logs = await import(`../../../apps/desktop/src/logs.mjs?v=${Date.now()}`);
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=${Date.now()}`);

  logs.appendLog({
    level: "info",
    msg: "request",
    requestLog: true,
    method: "POST",
    path: "/v1/chat/completions",
    clientId: "codex",
    providerId: "p",
    modelId: "p/a",
    status: 200,
    ms: 42,
    totalTokens: 7
  });

  const rows = store.listRequestLogs({ limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].client_id, "codex");
  assert.equal(rows[0].model_id, "p/a");
  assert.equal(rows[0].total_tokens, 7);
});

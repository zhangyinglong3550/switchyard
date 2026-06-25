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

test("request log store · writes sanitized SQLite rows and aggregates usage", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-"));
  const oldTz = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    if (oldTz === undefined) delete process.env.TZ;
    else process.env.TZ = oldTz;
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=${Date.now()}`);

  store.recordRequestEvent({
    ts: "2026-06-23T10:00:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/chat/completions",
    clientId: "claude-code",
    providerId: "p",
    modelId: "p/a",
    requestedModel: "p/a",
    upstreamModel: "a",
    apiFormat: "openai_chat",
    status: 200,
    ms: 123,
    promptTokens: 11,
    completionTokens: 2,
    totalTokens: 13,
    messages: [{ role: "user", content: "do not store me" }]
  });
  store.recordRequestEvent({
    ts: "2026-06-23T10:01:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/chat/completions",
    clientId: "codex",
    providerId: "p",
    modelId: "p/a",
    requestedModel: "p/a",
    upstreamModel: "a",
    apiFormat: "openai_chat",
    status: 500,
    ms: 50,
    promptTokens: 1,
    completionTokens: 0,
    totalTokens: 1,
    error: "upstream failed with secret body that should be clipped"
  });

  const rows = store.listRequestLogs({ limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].model_id, "p/a");
  assert.equal(rows[0].latency_ms, 50);
  assert.equal(JSON.stringify(rows).includes("do not store me"), false);

  const usage = store.usageByModel();
  assert.deepEqual(usage.map((row) => ({
    model_id: row.model_id,
    request_count: row.request_count,
    total_tokens: row.total_tokens,
    error_count: row.error_count
  })), [{ model_id: "p/a", request_count: 2, total_tokens: 14, error_count: 1 }]);
  assert.equal(store.usageByModel({ modelQuery: "p/a" }).length, 1);
  assert.equal(store.usageByModel({ modelQuery: "missing" }).length, 0);

  const agentUsage = store.usageByAgentModel();
  assert.deepEqual(agentUsage.map((row) => ({
    client_id: row.client_id,
    model_id: row.model_id,
    request_count: row.request_count,
    total_tokens: row.total_tokens
  })).sort((a, b) => a.client_id.localeCompare(b.client_id)), [
    { client_id: "claude-code", model_id: "p/a", request_count: 1, total_tokens: 13 },
    { client_id: "codex", model_id: "p/a", request_count: 1, total_tokens: 1 }
  ]);
  assert.deepEqual(store.usageByAgentModel({ agentId: "codex" }).map((row) => row.client_id), ["codex"]);
  assert.deepEqual(store.usageByAgentModel({ clientId: "claude-code" }).map((row) => row.client_id), ["claude-code"]);

  store.recordRequestEvent({
    ts: "2026-06-23T23:30:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/chat/completions",
    clientId: "codex",
    providerId: "p",
    modelId: "p/b",
    status: 200,
    ms: 10,
    totalTokens: 5
  });
  assert.ok(store.usageDaily({ modelId: "p/b" }).some((row) => row.day === "2026-06-24"));
});

test("request log store · cleanup removes old rows and caps max rows", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-"));
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=${Date.now()}`);

  for (let i = 0; i < 5; i++) {
    store.recordRequestEvent({
      ts: `2026-06-2${i}T10:00:00.000Z`,
      requestLog: true,
      method: "POST",
      path: "/v1/chat/completions",
      providerId: "p",
      modelId: `p/${i}`,
      status: 200,
      ms: 10,
      totalTokens: i + 1
    });
  }

  store.cleanupRequestLogs({ retainDays: 3650, maxRows: 3, now: new Date("2026-06-30T00:00:00.000Z") });
  assert.equal(store.listRequestLogs({ limit: 10 }).length, 3);
});

test("request log store · keeps oversized summaries as valid JSON with stream diagnostics", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-"));
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=${Date.now()}-${Math.random()}`);

  store.recordRequestEvent({
    ts: "2026-06-23T10:00:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/responses",
    providerId: "codex",
    modelId: "codex/gpt-5.5",
    status: 500,
    requestSummary: {
      protocol: "openai_responses",
      modelId: "codex/gpt-5.5",
      providerId: "codex",
      streamDiagnostics: {
        protocol: "responses",
        chunkCount: 2,
        dataTypeCounts: { "response.created": 1 },
        sawMeaningfulEvent: false,
        sawTerminalEvent: false
      },
      messages: {
        roleCounts: { system: 1, user: 1 },
        system: [{ role: "system", text: "s".repeat(20000) }],
        user: [{ role: "user", text: "u".repeat(20000) }]
      }
    }
  });

  const [row] = store.listRequestLogs({ limit: 1 });
  assert.equal(JSON.parse(row.request_summary).streamDiagnostics.chunkCount, 2);
  assert.equal(row.request_summary.length < 12000, true);
});

test("request log store · cleanup deletes rows when SQLite log exceeds max bytes", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-"));
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=${Date.now()}-${Math.random()}`);

  for (let i = 0; i < 8; i++) {
    store.recordRequestEvent({
      ts: `2026-06-23T10:0${i}:00.000Z`,
      requestLog: true,
      method: "POST",
      path: "/v1/chat/completions",
      providerId: "p",
      modelId: `p/${i}`,
      status: 200,
      ms: 10,
      totalTokens: i + 1,
      requestSummary: { payload: "x".repeat(1000) },
      responseSummary: { payload: "y".repeat(1000) }
    });
  }

  assert.equal(store.listRequestLogs({ limit: 20 }).length, 8);
  store.cleanupRequestLogs({ retainDays: 3650, maxRows: 100, maxBytes: 1, now: new Date("2026-06-30T00:00:00.000Z") });
  assert.equal(store.listRequestLogs({ limit: 20 }).length, 0);
});

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
    error_count: row.error_count,
    success_count: row.success_count,
    success_rate: row.success_rate
  })), [{
    model_id: "p/a",
    request_count: 2,
    total_tokens: 14,
    error_count: 1,
    success_count: 1,
    success_rate: 50
  }]);
  assert.equal(usage[0].avg_latency_ms, 86.5);
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

test("request log store · per-model success rate, failure and latency from real writes", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-stats-"));
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=stats-${Date.now()}`);

  // model A: 2 success (200, 201) + 1 fail (500) + 1 network fail (status 0)
  // latencies: 100, 200, 300, 400 → avg 250
  const samplesA = [
    { status: 200, ms: 100 },
    { status: 201, ms: 200 },
    { status: 500, ms: 300 },
    { status: 0, ms: 400 }
  ];
  for (const [i, s] of samplesA.entries()) {
    store.recordRequestEvent({
      ts: `2026-07-15T10:0${i}:00.000Z`,
      requestLog: true,
      method: "POST",
      path: "/v1/chat/completions",
      clientId: "codex",
      providerId: "beike",
      modelId: "beike/gpt-5.6",
      requestedModel: "beike/gpt-5.6",
      status: s.status,
      ms: s.ms,
      totalTokens: 10
    });
  }
  // model B: 1 success only — must not mix with A
  store.recordRequestEvent({
    ts: "2026-07-15T11:00:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/responses",
    clientId: "codex",
    providerId: "codex",
    modelId: "codex/gpt-5.6",
    requestedModel: "codex/gpt-5.6",
    status: 200,
    ms: 50,
    totalTokens: 5
  });

  const byModel = store.usageByModel();
  const a = byModel.find((row) => row.model_id === "beike/gpt-5.6");
  const b = byModel.find((row) => row.model_id === "codex/gpt-5.6");
  assert.ok(a, "beike model aggregate present");
  assert.ok(b, "codex model aggregate present");

  assert.equal(a.request_count, 4);
  assert.equal(a.success_count, 2);
  assert.equal(a.error_count, 2); // 500 + status 0
  assert.equal(a.success_rate, 50);
  assert.equal(a.avg_latency_ms, 250);
  assert.equal(a.provider_id, "beike");

  assert.equal(b.request_count, 1);
  assert.equal(b.success_count, 1);
  assert.equal(b.error_count, 0);
  assert.equal(b.success_rate, 100);
  assert.equal(b.avg_latency_ms, 50);
  assert.equal(b.provider_id, "codex");

  const agentRows = store.usageByAgentModel({ agentId: "codex" });
  assert.equal(agentRows.length, 2);
  const agentA = agentRows.find((row) => row.model_id === "beike/gpt-5.6");
  assert.equal(agentA.success_rate, 50);
  assert.equal(agentA.error_count, 2);

  // enrichUsageStatsRow pure unit on empty / zero
  const empty = store.enrichUsageStatsRow({ request_count: 0, error_count: 0 });
  assert.equal(empty.success_rate, null);
  assert.equal(empty.success_count, 0);
});

test("usage UI · model table headers include success rate and latency columns", () => {
  const htmlPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../../apps/desktop/renderer/index.html"
  );
  // Windows pathname fix
  const resolved = fs.existsSync(htmlPath)
    ? htmlPath
    : path.join(process.cwd(), "apps/desktop/renderer/index.html");
  const html = fs.readFileSync(resolved, "utf8");
  assert.match(html, /id="usage-model-table"/);
  assert.match(html, /成功率/);
  assert.match(html, /调用/);
  assert.match(html, /失败/);
  assert.match(html, /均延迟/);
  // renderer renders success_rate
  const rendererPath = path.join(path.dirname(resolved), "renderer.js");
  const renderer = fs.readFileSync(rendererPath, "utf8");
  assert.match(renderer, /success_rate/);
  assert.match(renderer, /success_count/);
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

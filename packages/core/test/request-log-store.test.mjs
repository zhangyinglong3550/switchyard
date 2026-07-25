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

test("usage UI · model table headers include success rate, cache and latency columns", () => {
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
  assert.match(html, /缓存命中/);
  assert.match(html, /缓存写入/);
  assert.match(html, /命中率/);
  assert.match(html, /均延迟/);
  // renderer renders success_rate + cache fields
  const rendererPath = path.join(path.dirname(resolved), "renderer.js");
  const renderer = fs.readFileSync(rendererPath, "utf8");
  assert.match(renderer, /success_rate/);
  assert.match(renderer, /success_count/);
  assert.match(renderer, /cache_read_tokens/);
  assert.match(renderer, /cache_creation_tokens/);
  assert.match(renderer, /cache_hit_rate/);
  assert.match(renderer, /data-session-rename/);
  assert.match(renderer, /agent:sessions:rename/);
});

test("request log store · discovery probes aggregate as (发现探测) not unknown", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-discovery-"));
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=discovery-${Date.now()}`);

  // new-style: gateway already or store labels discovery
  store.recordRequestEvent({
    ts: "2026-07-19T12:00:00.000Z",
    requestLog: true,
    method: "GET",
    path: "/hermes/v1/models",
    clientId: "hermes",
    status: 200,
    ms: 1
  });
  store.recordRequestEvent({
    ts: "2026-07-19T12:00:01.000Z",
    requestLog: true,
    method: "GET",
    path: "/hermes/api/tags",
    clientId: "hermes",
    status: 404,
    ms: 0
  });
  store.recordRequestEvent({
    ts: "2026-07-19T12:00:02.000Z",
    requestLog: true,
    method: "POST",
    path: "/hermes/api/show",
    clientId: "hermes",
    status: 404,
    ms: 0
  });
  // real chat
  store.recordRequestEvent({
    ts: "2026-07-19T12:00:03.000Z",
    requestLog: true,
    method: "POST",
    path: "/hermes/v1/chat/completions",
    clientId: "hermes",
    providerId: "codex",
    modelId: "codex/gpt-5.6-luna",
    requestedModel: "codex/gpt-5.6-luna",
    status: 200,
    ms: 100,
    promptTokens: 10,
    totalTokens: 12
  });

  const rows = store.listRequestLogs({ limit: 10 });
  const probeRows = rows.filter((r) => r.model_id === store.DISCOVERY_PROBE_MODEL_ID);
  assert.equal(probeRows.length, 3);

  const byAgent = store.usageByAgentModel({ agentId: "hermes" });
  const probe = byAgent.find((r) => r.model_id === store.DISCOVERY_PROBE_MODEL_ID);
  const chat = byAgent.find((r) => r.model_id === "codex/gpt-5.6-luna");
  assert.ok(probe, "discovery bucket present");
  assert.equal(probe.request_count, 3);
  assert.equal(probe.error_count, 2); // two 404
  assert.ok(chat);
  assert.equal(chat.request_count, 1);
  assert.equal(byAgent.some((r) => r.model_id === "(unknown)"), false);
});

test("request log store · aggregates cache_read / cache_creation and hit rate per model", async (t) => {
  if (!hasSqlite3()) return t.skip("sqlite3 cli not available");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-reqlog-cache-"));
  process.env.SWITCHYARD_REQUEST_LOG_DB = path.join(tmp, "requests.sqlite3");
  t.after(() => {
    delete process.env.SWITCHYARD_REQUEST_LOG_DB;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const store = await import(`../../../apps/desktop/src/request-log-store.mjs?v=cache-${Date.now()}`);

  // model A: two requests — cache read 400+300=700, prompt 500+500=1000 → hit 70%
  store.recordRequestEvent({
    ts: "2026-07-19T10:00:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/messages",
    clientId: "claude-code",
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet",
    status: 200,
    ms: 100,
    promptTokens: 500,
    completionTokens: 20,
    totalTokens: 520,
    cacheReadTokens: 400,
    cacheCreationTokens: 50
  });
  store.recordRequestEvent({
    ts: "2026-07-19T10:01:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/messages",
    clientId: "claude-code",
    providerId: "anthropic",
    modelId: "anthropic/claude-sonnet",
    status: 200,
    ms: 80,
    promptTokens: 500,
    completionTokens: 10,
    totalTokens: 510,
    cacheReadTokens: 300,
    cacheCreationTokens: 0
  });
  // model B: no cache
  store.recordRequestEvent({
    ts: "2026-07-19T10:02:00.000Z",
    requestLog: true,
    method: "POST",
    path: "/v1/chat/completions",
    clientId: "codex",
    providerId: "openai",
    modelId: "openai/gpt",
    status: 200,
    ms: 50,
    promptTokens: 100,
    completionTokens: 5,
    totalTokens: 105,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  });

  const byModel = store.usageByModel();
  const a = byModel.find((row) => row.model_id === "anthropic/claude-sonnet");
  const b = byModel.find((row) => row.model_id === "openai/gpt");
  assert.ok(a);
  assert.equal(a.cache_read_tokens, 700);
  assert.equal(a.cache_creation_tokens, 50);
  assert.equal(a.prompt_tokens, 1000);
  assert.equal(a.cache_hit_rate, 70);
  assert.ok(b);
  assert.equal(b.cache_read_tokens, 0);
  assert.equal(b.cache_hit_rate, 0);

  const agentRows = store.usageByAgentModel({ agentId: "claude-code" });
  assert.equal(agentRows.length, 1);
  assert.equal(agentRows[0].cache_hit_rate, 70);
  assert.equal(agentRows[0].cache_read_tokens, 700);

  const empty = store.enrichUsageStatsRow({ request_count: 1, prompt_tokens: 0, cache_read_tokens: 10 });
  assert.equal(empty.cache_hit_rate, null);
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

test("request log store · preserves rectifier metadata when verbose compatibility descriptors are present", async (t) => {
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
    providerId: "opencode-go",
    modelId: "opencode-go/deepseek-v4-pro",
    status: 400,
    requestSummary: {
      protocol: "openai_responses",
      modelId: "opencode-go/deepseek-v4-pro",
      providerId: "opencode-go",
      compatRules: {
        outbound: Array.from({ length: 12 }, (_, index) => ({
          id: `rule-${index}`,
          source: "auto",
          description: "x".repeat(6000),
          changes: ["x".repeat(6000)]
        }))
      },
      rectifiers: [{ id: "opencode-go-tool-manifest", retryStatus: 400, retryOk: false }],
      messages: { roleCounts: { assistant: 2, tool: 2 } }
    }
  });

  const [row] = store.listRequestLogs({ limit: 1 });
  const summary = JSON.parse(row.request_summary);
  assert.deepEqual(summary.compatRules.outbound[0], { id: "rule-0", source: "auto" });
  assert.deepEqual(summary.rectifiers, [{ id: "opencode-go-tool-manifest", retryStatus: 400, retryOk: false }]);
  assert.equal(summary.messages.roleCounts.tool, 2);
  assert.equal(summary.truncated, undefined);
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

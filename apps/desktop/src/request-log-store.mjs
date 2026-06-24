import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir, logDir, nowIso } from "../../../packages/core/src/utils.mjs";

const DEFAULT_RETAIN_DAYS = 14;
const DEFAULT_MAX_ROWS = 10000;
let initialized = false;
let writeCount = 0;
let cleanupTimer = null;

export function requestLogDbPath() {
  return process.env.SWITCHYARD_REQUEST_LOG_DB || path.join(logDir(), "requests.sqlite3");
}

function sqlite3Cli() {
  return process.env.SWITCHYARD_SQLITE3 || "sqlite3";
}

function runSql(sql, { json = false } = {}) {
  const db = requestLogDbPath();
  ensureDir(path.dirname(db));
  const args = json ? ["-json", db, sql] : [db, sql];
  const out = execFileSync(sqlite3Cli(), args, { encoding: "utf8", timeout: 5000, maxBuffer: 10 * 1024 * 1024 });
  return json ? JSON.parse(out || "[]") : out;
}

function valueSql(value) {
  if (value == null || value === "") return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return `'${String(value).slice(0, 20000).replace(/'/g, "''")}'`;
}

function intValue(value) {
  if (Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return 0;
}

export function initRequestLogStore() {
  if (initialized) return;
  runSql(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      method TEXT,
      path TEXT,
      client_id TEXT,
      provider_id TEXT,
      model_id TEXT,
      requested_model TEXT,
      upstream_model TEXT,
      api_format TEXT,
      status INTEGER,
      latency_ms INTEGER,
      prompt_tokens INTEGER DEFAULT 0,
      completion_tokens INTEGER DEFAULT 0,
      total_tokens INTEGER DEFAULT 0,
      prompt_preview TEXT,
      response_preview TEXT,
      request_summary TEXT,
      response_summary TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_logs_ts ON request_logs(ts);
    CREATE INDEX IF NOT EXISTS idx_request_logs_model ON request_logs(model_id, ts);
    CREATE INDEX IF NOT EXISTS idx_request_logs_provider ON request_logs(provider_id, ts);
    CREATE INDEX IF NOT EXISTS idx_request_logs_client ON request_logs(client_id, ts);
  `);
  ensureRequestLogColumns();
  initialized = true;
}

function ensureRequestLogColumns() {
  const rows = runSql("PRAGMA table_info(request_logs);", { json: true });
  const columns = new Set(rows.map((row) => row.name));
  for (const [name, type] of [
    ["prompt_preview", "TEXT"],
    ["response_preview", "TEXT"],
    ["request_summary", "TEXT"],
    ["response_summary", "TEXT"]
  ]) {
    if (columns.has(name)) continue;
    runSql(`ALTER TABLE request_logs ADD COLUMN ${name} ${type};`);
  }
}

function sanitizeEvent(entry) {
  return {
    ts: entry.ts || nowIso(),
    method: entry.method || null,
    path: entry.path || null,
    client_id: entry.clientId || null,
    provider_id: entry.providerId || null,
    model_id: entry.modelId || null,
    requested_model: entry.requestedModel || null,
    upstream_model: entry.upstreamModel || null,
    api_format: entry.apiFormat || null,
    status: intValue(entry.status),
    latency_ms: intValue(entry.ms ?? entry.latencyMs),
    prompt_tokens: intValue(entry.promptTokens),
    completion_tokens: intValue(entry.completionTokens),
    total_tokens: intValue(entry.totalTokens),
    prompt_preview: entry.promptPreview ? String(entry.promptPreview).slice(0, 1200) : null,
    response_preview: entry.responsePreview ? String(entry.responsePreview).slice(0, 1200) : null,
    request_summary: entry.requestSummary ? JSON.stringify(entry.requestSummary).slice(0, 12000) : null,
    response_summary: entry.responseSummary ? JSON.stringify(entry.responseSummary).slice(0, 12000) : null,
    error: entry.error ? String(entry.error).slice(0, 500) : null
  };
}

export function recordRequestEvent(entry) {
  if (!entry?.requestLog) return null;
  initRequestLogStore();
  const row = sanitizeEvent(entry);
  const columns = Object.keys(row);
  const values = columns.map((key) => valueSql(row[key]));
  runSql(`INSERT INTO request_logs (${columns.join(", ")}) VALUES (${values.join(", ")});`);
  writeCount += 1;
  if (writeCount % 50 === 0) cleanupRequestLogs();
  return row;
}

function whereClause(filters = {}) {
  const clauses = [];
  if (filters.modelId) clauses.push(`model_id = ${valueSql(filters.modelId)}`);
  if (filters.modelQuery) {
    const like = `%${String(filters.modelQuery).replace(/[%_]/g, "\\$&")}%`;
    clauses.push(`(model_id LIKE ${valueSql(like)} ESCAPE '\\' OR requested_model LIKE ${valueSql(like)} ESCAPE '\\')`);
  }
  if (filters.providerId) clauses.push(`provider_id = ${valueSql(filters.providerId)}`);
  const clientId = filters.clientId || filters.agentId;
  if (clientId) clauses.push(`client_id = ${valueSql(clientId)}`);
  if (filters.since) clauses.push(`ts >= ${valueSql(filters.since)}`);
  if (filters.until) clauses.push(`ts <= ${valueSql(filters.until)}`);
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export function listRequestLogs(filters = {}) {
  initRequestLogStore();
  const limit = Math.min(Math.max(intValue(filters.limit) || 100, 1), 1000);
  return runSql(`SELECT * FROM request_logs ${whereClause(filters)} ORDER BY ts DESC, id DESC LIMIT ${limit};`, { json: true });
}

export function usageByModel(filters = {}) {
  initRequestLogStore();
  const limit = Math.min(Math.max(intValue(filters.limit) || 100, 1), 1000);
  return runSql(`
    SELECT
      COALESCE(model_id, requested_model, '(unknown)') AS model_id,
      provider_id,
      COUNT(*) AS request_count,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens,
      ROUND(AVG(latency_ms), 1) AS avg_latency_ms
    FROM request_logs
    ${whereClause(filters)}
    GROUP BY COALESCE(model_id, requested_model, '(unknown)'), provider_id
    ORDER BY total_tokens DESC, request_count DESC
    LIMIT ${limit};
  `, { json: true });
}

export function usageByAgentModel(filters = {}) {
  initRequestLogStore();
  const limit = Math.min(Math.max(intValue(filters.limit) || 100, 1), 1000);
  return runSql(`
    SELECT
      COALESCE(client_id, '(unknown)') AS client_id,
      COALESCE(model_id, requested_model, '(unknown)') AS model_id,
      provider_id,
      COUNT(*) AS request_count,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens,
      ROUND(AVG(latency_ms), 1) AS avg_latency_ms
    FROM request_logs
    ${whereClause(filters)}
    GROUP BY COALESCE(client_id, '(unknown)'), COALESCE(model_id, requested_model, '(unknown)'), provider_id
    ORDER BY total_tokens DESC, request_count DESC
    LIMIT ${limit};
  `, { json: true });
}

export function usageDaily(filters = {}) {
  initRequestLogStore();
  const limit = Math.min(Math.max(intValue(filters.limit) || 30, 1), 366);
  return runSql(`
    SELECT
      date(ts, 'localtime') AS day,
      COALESCE(client_id, '(unknown)') AS client_id,
      COALESCE(model_id, requested_model, '(unknown)') AS model_id,
      COUNT(*) AS request_count,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS error_count,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens,
      ROUND(AVG(latency_ms), 1) AS avg_latency_ms
    FROM request_logs
    ${whereClause(filters)}
    GROUP BY date(ts, 'localtime'), COALESCE(client_id, '(unknown)'), COALESCE(model_id, requested_model, '(unknown)')
    ORDER BY day DESC, total_tokens DESC, request_count DESC
    LIMIT ${limit * 200};
  `, { json: true }).slice(0, limit * 200);
}

export function cleanupRequestLogs({ retainDays = DEFAULT_RETAIN_DAYS, maxRows = DEFAULT_MAX_ROWS, now = new Date() } = {}) {
  initRequestLogStore();
  const cutoff = new Date(now.getTime() - Math.max(1, retainDays) * 24 * 60 * 60 * 1000).toISOString();
  runSql(`DELETE FROM request_logs WHERE ts < ${valueSql(cutoff)};`);
  runSql(`
    DELETE FROM request_logs
    WHERE id NOT IN (
      SELECT id FROM request_logs ORDER BY ts DESC, id DESC LIMIT ${Math.max(1, intValue(maxRows))}
    );
  `);
}

export function scheduleRequestLogCleanup({ intervalMs = 6 * 60 * 60 * 1000 } = {}) {
  if (cleanupTimer) return cleanupTimer;
  try { cleanupRequestLogs(); } catch {}
  cleanupTimer = setInterval(() => {
    try { cleanupRequestLogs(); } catch {}
  }, Math.max(60_000, intervalMs));
  cleanupTimer.unref?.();
  return cleanupTimer;
}

export function stopRequestLogCleanupForTest() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
}

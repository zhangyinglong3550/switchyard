import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureDir, logDir, nowIso } from "../../../packages/core/src/utils.mjs";

const DEFAULT_RETAIN_DAYS = 14;
const DEFAULT_MAX_ROWS = 10000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
let initialized = false;
let writeCount = 0;
let cleanupTimer = null;
let _dbHandle = null;

export function requestLogDbPath() {
  return process.env.SWITCHYARD_REQUEST_LOG_DB || path.join(logDir(), "requests.sqlite3");
}

// 尝试加载 better-sqlite3 native 模块
function loadBetterSqlite() {
  try {
    const require = createRequire(import.meta.url);
    return require("better-sqlite3");
  } catch {
    return null;
  }
}

// 解析可用的 sqlite3 CLI 路径（打包内置 / 系统 PATH）
function resolveSqlite3Cli() {
  if (process.env.SWITCHYARD_SQLITE3 && fs.existsSync(process.env.SWITCHYARD_SQLITE3)) {
    return process.env.SWITCHYARD_SQLITE3;
  }
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, "win", "sqlite3.exe");
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.platform === "win32" ? "sqlite3.exe" : "sqlite3";
}

function sqlite3Cli() {
  return resolveSqlite3Cli();
}

// 优先使用 better-sqlite3（native 模块，性能更好且不依赖外部命令）
function getDbHandle() {
  if (_dbHandle) return _dbHandle;
  const BetterSqlite = loadBetterSqlite();
  if (!BetterSqlite) return null;
  try {
    const dbPath = requestLogDbPath();
    ensureDir(path.dirname(dbPath));
    _dbHandle = new BetterSqlite(dbPath);
    _dbHandle.pragma("journal_mode = WAL");
    return _dbHandle;
  } catch {
    // native 模块加载失败（ABI 不匹配 / 打包路径问题），回退到 CLI
    _dbHandle = false; // 标记为不可用，避免重复尝试
    return null;
  }
}

// 统一 SQL 执行入口：优先 better-sqlite3，fallback 到 sqlite3 CLI
function runSql(sql, { json = false } = {}) {
  // 优先 native 模块
  const db = getDbHandle();
  if (db) {
    try {
      if (json) {
        // 查询语句（SELECT / PRAGMA table_info），返回行数据
        const rows = db.prepare(sql).all();
        return rows;
      }
      // DDL/DML（可能多语句），用 exec
      db.exec(sql);
      return "";
    } catch (err) {
      // native 执行失败，fallback 到 CLI
    }
  }

  // fallback 到 sqlite3 CLI
  const dbPath = requestLogDbPath();
  ensureDir(path.dirname(dbPath));
  const args = json ? ["-json", dbPath, sql] : [dbPath, sql];
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

function compactMessageList(messages = [], maxItems = 2) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, maxItems).map((message) => ({
    ...message,
    text: typeof message?.text === "string" && message.text.length > 300
      ? `${message.text.slice(0, 300)}...`
      : message?.text
  }));
}

function compactSummaryForStorage(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const out = { ...summary };
  if (summary.messages && typeof summary.messages === "object") {
    out.messages = {
      roleCounts: summary.messages.roleCounts || {},
      images: intValue(summary.messages.images),
      skills: Array.isArray(summary.messages.skills) ? summary.messages.skills.slice(0, 40) : [],
      system: compactMessageList(summary.messages.system, 1),
      user: compactMessageList(summary.messages.user, 3),
      assistant: compactMessageList(summary.messages.assistant, 2),
      tool: compactMessageList(summary.messages.tool, 2)
    };
  }
  if (Array.isArray(summary.tools)) out.tools = summary.tools.slice(0, 40);
  return out;
}

function jsonSummary(value, max = 12000) {
  if (!value) return null;
  const compact = compactSummaryForStorage(value);
  const text = JSON.stringify(compact);
  if (text.length <= max) return text;
  const envelope = {
    truncated: true,
    protocol: compact?.protocol || "",
    modelId: compact?.modelId || "",
    providerId: compact?.providerId || "",
    upstreamModel: compact?.upstreamModel || "",
    conversionChain: compact?.conversionChain || null,
    compatRules: compact?.compatRules || null,
    rectifiers: compact?.rectifiers || null,
    requestOverrides: compact?.requestOverrides || null,
    params: compact?.params || null,
    vision: compact?.vision || null,
    toolCount: compact?.toolCount || 0,
    streamDiagnostics: compact?.streamDiagnostics || null,
    status: compact?.status,
    stream: compact?.stream,
    finishReason: compact?.finishReason,
    usage: compact?.usage || null,
    error: compact?.error || "",
    text: typeof compact?.text === "string" ? compact.text.slice(0, 800) : undefined,
    reasoning: typeof compact?.reasoning === "string" ? compact.reasoning.slice(0, 800) : undefined,
    toolCalls: Array.isArray(compact?.toolCalls) ? compact.toolCalls.slice(0, 20) : undefined,
    messages: compact?.messages || null
  };
  const fallback = JSON.stringify(envelope);
  return fallback.length <= max ? fallback : JSON.stringify({ truncated: true, streamDiagnostics: compact?.streamDiagnostics || null });
}

function maxBytesValue(value = process.env.SWITCHYARD_REQUEST_LOG_MAX_BYTES) {
  const parsed = Number(value ?? DEFAULT_MAX_BYTES);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_MAX_BYTES;
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
    request_summary: jsonSummary(entry.requestSummary),
    response_summary: jsonSummary(entry.responseSummary),
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

function requestLogDiskBytes() {
  const db = requestLogDbPath();
  let total = 0;
  for (const file of [db, `${db}-wal`, `${db}-shm`]) {
    try { total += fs.statSync(file).size; } catch {}
  }
  return total;
}

function compactRequestLogDb() {
  try { runSql("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;"); } catch {}
}

function requestLogRowCount() {
  const rows = runSql("SELECT COUNT(*) AS count FROM request_logs;", { json: true });
  return intValue(rows?.[0]?.count);
}

function enforceRequestLogMaxBytes(maxBytes) {
  const limit = maxBytesValue(maxBytes);
  compactRequestLogDb();
  while (requestLogDiskBytes() > limit) {
    const count = requestLogRowCount();
    if (count <= 0) break;
    const deleteCount = count <= 1 ? 1 : Math.ceil(count / 2);
    runSql(`
      DELETE FROM request_logs
      WHERE id IN (
        SELECT id FROM request_logs ORDER BY ts ASC, id ASC LIMIT ${deleteCount}
      );
    `);
    compactRequestLogDb();
  }
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

export function cleanupRequestLogs({ retainDays = DEFAULT_RETAIN_DAYS, maxRows = DEFAULT_MAX_ROWS, maxBytes = maxBytesValue(), now = new Date() } = {}) {
  initRequestLogStore();
  const cutoff = new Date(now.getTime() - Math.max(1, retainDays) * 24 * 60 * 60 * 1000).toISOString();
  runSql(`DELETE FROM request_logs WHERE ts < ${valueSql(cutoff)};`);
  runSql(`
    DELETE FROM request_logs
    WHERE id NOT IN (
      SELECT id FROM request_logs ORDER BY ts DESC, id DESC LIMIT ${Math.max(1, intValue(maxRows))}
    );
  `);
  enforceRequestLogMaxBytes(maxBytes);
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

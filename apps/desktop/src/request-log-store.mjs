import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ensureDir, logDir, nowIso } from "../../../packages/core/src/utils.mjs";
import { cacheHitRatePercent } from "../../../packages/core/src/stream-usage.mjs";
import { previewText } from "../../../packages/core/src/text-preview.mjs";
import {
  DISCOVERY_PROBE_MODEL_ID,
  isDiscoveryProbeRequest,
  resolveUsageModelKey,
  usageModelKeySql
} from "../../../packages/core/src/request-kind.mjs";

export { DISCOVERY_PROBE_MODEL_ID, isDiscoveryProbeRequest, resolveUsageModelKey };

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

function compactMessageText(text, max = 300) {
  if (typeof text !== "string") return text;
  return previewText(text, max, { strategy: "head-tail", headRatio: 0.25 });
}

/** 保留最近 N 条消息（旧实现 slice(0,N) 会丢掉本轮最新用户消息）。 */
function compactMessageList(messages = [], maxItems = 2, {
  textMax = 300,
  latestTextMax = 1200
} = {}) {
  if (!Array.isArray(messages)) return [];
  const selected = messages.slice(-Math.max(1, maxItems));
  return selected.map((message, index) => {
    const isLatest = index === selected.length - 1;
    const max = isLatest ? latestTextMax : textMax;
    const text = typeof message?.text === "string"
      ? compactMessageText(message.text, max)
      : message?.text;
    return { ...message, text };
  });
}

function compactSummaryForStorage(summary) {
  if (!summary || typeof summary !== "object") return summary;
  const out = { ...summary };
  if (summary.compatRules && typeof summary.compatRules === "object") {
    // Full patch descriptors contain documentation and test lists. With Codex's
    // large tool catalog that alone can exhaust the request-log limit and drop
    // the failure metadata we need for diagnosis. Retain the applied rule IDs
    // (and their source) instead; this is enough to compare requests without
    // storing request content or making the log unbounded.
    out.compatRules = Object.fromEntries(
      ["outbound", "inbound", "stream"].map((direction) => [
        direction,
        Array.isArray(summary.compatRules[direction])
          ? summary.compatRules[direction].map((rule) => ({
            id: rule?.id || "",
            source: rule?.source || ""
          })).filter((rule) => rule.id)
          : []
      ])
    );
  }
  if (summary.messages && typeof summary.messages === "object") {
    const users = Array.isArray(summary.messages.user) ? summary.messages.user : [];
    let latestSource = summary.messages.latestUser || null;
    if (!latestSource || latestSource.synthetic) {
      latestSource = null;
      for (let i = users.length - 1; i >= 0; i -= 1) {
        if (!users[i]?.synthetic) {
          latestSource = users[i];
          break;
        }
      }
      if (!latestSource && users.length) latestSource = users[users.length - 1];
    }
    const latestUser = latestSource
      ? compactMessageList([latestSource], 1, { latestTextMax: 2000 })[0]
      : null;
    // 近轮用户样本也优先保留非伪消息
    const meaningfulUsers = users.filter((item) => !item?.synthetic);
    const userSample = (meaningfulUsers.length ? meaningfulUsers : users);
    out.messages = {
      roleCounts: summary.messages.roleCounts || {},
      images: intValue(summary.messages.images),
      skills: Array.isArray(summary.messages.skills) ? summary.messages.skills.slice(0, 40) : [],
      system: compactMessageList(summary.messages.system, 1, { textMax: 800, latestTextMax: 800 }),
      user: compactMessageList(userSample, 3, { textMax: 400, latestTextMax: 2000 }),
      latestUser,
      assistant: compactMessageList(summary.messages.assistant, 2, { textMax: 400, latestTextMax: 800 }),
      tool: compactMessageList(summary.messages.tool, 2, { textMax: 300, latestTextMax: 600 })
    };
  }
  // 工具定义优先保留名称；描述压短，避免 Codex 大工具表撑爆 12KB 后整段丢失
  if (Array.isArray(summary.tools)) {
    out.tools = summary.tools.slice(0, 80).map((tool) => ({
      name: String(tool?.name || "").slice(0, 120),
      description: String(tool?.description || "").slice(0, 80),
      propertyCount: Number(tool?.propertyCount || 0) || undefined
    })).filter((tool) => tool.name);
  }
  if (summary.toolCount != null) out.toolCount = intValue(summary.toolCount);
  return out;
}

/** 截断信封里仍保留工具名列表，避免调用透视误显示「未携带 tools」。 */
function compactToolsForEnvelope(tools = [], limit = 60) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, limit).map((tool) => ({
    name: String(tool?.name || "").slice(0, 80)
  })).filter((tool) => tool.name);
}

function jsonSummary(value, max = 12000) {
  if (!value) return null;
  const compact = compactSummaryForStorage(value);
  const text = JSON.stringify(compact);
  if (text.length <= max) return text;
  // 系统提示再压短，优先给 tools 腾空间
  const messages = compact?.messages
    ? {
      ...compact.messages,
      system: Array.isArray(compact.messages.system)
        ? compactMessageList(compact.messages.system, 1, { textMax: 400, latestTextMax: 400 })
        : [],
      assistant: compactMessageList(compact.messages.assistant || [], 1, { textMax: 240, latestTextMax: 400 }),
      tool: compactMessageList(compact.messages.tool || [], 1, { textMax: 200, latestTextMax: 300 })
    }
    : null;
  const tools = compactToolsForEnvelope(compact?.tools, 60);
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
    reasoningEffortTrace: compact?.reasoningEffortTrace || null,
    vision: compact?.vision || null,
    toolCount: compact?.toolCount || tools.length || 0,
    tools,
    streamDiagnostics: compact?.streamDiagnostics || null,
    status: compact?.status,
    stream: compact?.stream,
    finishReason: compact?.finishReason,
    usage: compact?.usage || null,
    error: compact?.error || "",
    text: typeof compact?.text === "string" ? compact.text.slice(0, 800) : undefined,
    reasoning: typeof compact?.reasoning === "string" ? compact.reasoning.slice(0, 800) : undefined,
    toolCalls: Array.isArray(compact?.toolCalls) ? compact.toolCalls.slice(0, 20) : undefined,
    messages,
    turnPhase: compact?.turnPhase || "",
    continuation: Boolean(compact?.continuation),
    continueSteps: compact?.continueSteps,
    lastAction: typeof compact?.lastAction === "string" ? compact.lastAction.slice(0, 400) : undefined,
    lastRole: compact?.lastRole || "",
    requestBodyCapture: compact?.requestBodyCapture || null,
    outboundRequestBodyCapture: compact?.outboundRequestBodyCapture || null
  };
  let fallback = JSON.stringify(envelope);
  if (fallback.length <= max) return fallback;
  // 仍超限：只留工具名 + 关键轮次元数据
  const minimal = {
    truncated: true,
    protocol: envelope.protocol,
    modelId: envelope.modelId,
    providerId: envelope.providerId,
    toolCount: envelope.toolCount,
    tools: compactToolsForEnvelope(tools, 40),
    messages: messages
      ? {
        roleCounts: messages.roleCounts || {},
        skills: Array.isArray(messages.skills) ? messages.skills.slice(0, 20) : [],
        latestUser: messages.latestUser || null,
        system: Array.isArray(messages.system) ? compactMessageList(messages.system, 1, { textMax: 200, latestTextMax: 200 }) : [],
        user: Array.isArray(messages.user) ? compactMessageList(messages.user, 1, { latestTextMax: 800 }) : []
      }
      : null,
    turnPhase: envelope.turnPhase,
    continuation: envelope.continuation,
    lastAction: envelope.lastAction,
    streamDiagnostics: envelope.streamDiagnostics || null,
    requestBodyCapture: envelope.requestBodyCapture || null,
    outboundRequestBodyCapture: envelope.outboundRequestBodyCapture || null
  };
  fallback = JSON.stringify(minimal);
  return fallback.length <= max ? fallback : JSON.stringify({
    truncated: true,
    toolCount: envelope.toolCount,
    tools: compactToolsForEnvelope(tools, 20),
    streamDiagnostics: compact?.streamDiagnostics || null
  });
}

function retainDaysValue(value = process.env.SWITCHYARD_REQUEST_LOG_RETAIN_DAYS) { const parsed = Number(value ?? DEFAULT_RETAIN_DAYS); return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_RETAIN_DAYS; }
function maxRowsValue(value = process.env.SWITCHYARD_REQUEST_LOG_MAX_ROWS) { const parsed = Number(value ?? DEFAULT_MAX_ROWS); return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : DEFAULT_MAX_ROWS; }

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
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      prompt_preview TEXT,
      response_preview TEXT,
      request_summary TEXT,
      response_summary TEXT,
      request_body_ref TEXT,
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
    ["response_summary", "TEXT"],
    ["request_body_ref", "TEXT"],
    ["cache_read_tokens", "INTEGER DEFAULT 0"],
    ["cache_creation_tokens", "INTEGER DEFAULT 0"]
  ]) {
    if (columns.has(name)) continue;
    runSql(`ALTER TABLE request_logs ADD COLUMN ${name} ${type};`);
  }
}

function sanitizeEvent(entry) {
  const method = entry.method || null;
  const path = entry.path || null;
  let modelId = entry.modelId || null;
  let requestedModel = entry.requestedModel || null;
  // 探测请求统一落库为「发现探测」，避免用量页显示「未知」
  if (isDiscoveryProbeRequest({
    method,
    path,
    modelId,
    requestedModel
  })) {
    modelId = modelId || DISCOVERY_PROBE_MODEL_ID;
    requestedModel = requestedModel || DISCOVERY_PROBE_MODEL_ID;
  }
  return {
    ts: entry.ts || nowIso(),
    method,
    path,
    client_id: entry.clientId || null,
    provider_id: entry.providerId || null,
    model_id: modelId,
    requested_model: requestedModel,
    upstream_model: entry.upstreamModel || null,
    api_format: entry.apiFormat || null,
    status: intValue(entry.status),
    latency_ms: intValue(entry.ms ?? entry.latencyMs),
    prompt_tokens: intValue(entry.promptTokens),
    completion_tokens: intValue(entry.completionTokens),
    total_tokens: intValue(entry.totalTokens),
    cache_read_tokens: intValue(entry.cacheReadTokens ?? entry.cache_read_tokens),
    cache_creation_tokens: intValue(entry.cacheCreationTokens ?? entry.cache_creation_tokens),
    prompt_preview: entry.promptPreview
      ? compactMessageText(String(entry.promptPreview), Number(entry.status) >= 400 ? 800 : 500)
      : null,
    response_preview: entry.responsePreview
      ? compactMessageText(String(entry.responsePreview), Number(entry.status) >= 400 ? 1200 : 600)
      : null,
    request_summary: jsonSummary(entry.requestSummary),
    response_summary: jsonSummary(entry.responseSummary),
    request_body_ref: entry.requestBodyRef || entry.request_body_ref
      || entry.requestSummary?.requestBodyCapture?.ref
      || null,
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

/**
 * 失败判定：与请求日志语义对齐
 * - HTTP status >= 400：上游/业务失败
 * - status = 0：网络/连接失败等未拿到有效 HTTP 状态
 * 成功：status 在 [200, 399]
 */
export const REQUEST_ERROR_SQL = "(status = 0 OR status >= 400)";
export const REQUEST_SUCCESS_SQL = "(status BETWEEN 200 AND 399)";

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 为聚合行补充 success_count / success_rate（0 次调用时 rate=null） */
export function enrichUsageStatsRow(row = {}) {
  const request_count = numberOrZero(row.request_count);
  const error_count = numberOrZero(row.error_count);
  let success_count = row.success_count != null && row.success_count !== ""
    ? numberOrZero(row.success_count)
    : Math.max(0, request_count - error_count);
  // 防止脏数据：成功+失败不超过总数
  if (success_count + error_count > request_count && request_count > 0) {
    success_count = Math.max(0, request_count - error_count);
  }
  const success_rate = request_count > 0
    ? Math.round((success_count / request_count) * 1000) / 10
    : null;
  const prompt_tokens = numberOrZero(row.prompt_tokens);
  const cache_read_tokens = numberOrZero(row.cache_read_tokens);
  const cache_creation_tokens = numberOrZero(row.cache_creation_tokens);
  const cache_hit_rate = cacheHitRatePercent(cache_read_tokens, prompt_tokens);
  return {
    ...row,
    request_count,
    error_count,
    success_count,
    success_rate,
    prompt_tokens,
    cache_read_tokens,
    cache_creation_tokens,
    cache_hit_rate,
    avg_latency_ms: row.avg_latency_ms == null || row.avg_latency_ms === ""
      ? 0
      : numberOrZero(row.avg_latency_ms)
  };
}

function usageSelectMetrics() {
  return `
      COUNT(*) AS request_count,
      SUM(CASE WHEN ${REQUEST_ERROR_SQL} THEN 1 ELSE 0 END) AS error_count,
      SUM(CASE WHEN ${REQUEST_SUCCESS_SQL} THEN 1 ELSE 0 END) AS success_count,
      SUM(prompt_tokens) AS prompt_tokens,
      SUM(completion_tokens) AS completion_tokens,
      SUM(total_tokens) AS total_tokens,
      SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
      SUM(COALESCE(cache_creation_tokens, 0)) AS cache_creation_tokens,
      ROUND(AVG(latency_ms), 1) AS avg_latency_ms
  `;
}

export function usageByModel(filters = {}) {
  initRequestLogStore();
  const limit = Math.min(Math.max(intValue(filters.limit) || 100, 1), 1000);
  const modelKey = usageModelKeySql();
  const rows = runSql(`
    SELECT
      ${modelKey} AS model_id,
      provider_id,
      ${usageSelectMetrics()}
    FROM request_logs
    ${whereClause(filters)}
    GROUP BY ${modelKey}, provider_id
    ORDER BY request_count DESC, total_tokens DESC
    LIMIT ${limit};
  `, { json: true });
  return (rows || []).map(enrichUsageStatsRow);
}

export function usageByAgentModel(filters = {}) {
  initRequestLogStore();
  const limit = Math.min(Math.max(intValue(filters.limit) || 100, 1), 1000);
  const modelKey = usageModelKeySql();
  const rows = runSql(`
    SELECT
      COALESCE(client_id, '(unknown)') AS client_id,
      ${modelKey} AS model_id,
      provider_id,
      ${usageSelectMetrics()}
    FROM request_logs
    ${whereClause(filters)}
    GROUP BY COALESCE(client_id, '(unknown)'), ${modelKey}, provider_id
    ORDER BY request_count DESC, total_tokens DESC
    LIMIT ${limit};
  `, { json: true });
  return (rows || []).map(enrichUsageStatsRow);
}

export function usageDaily(filters = {}) {
  initRequestLogStore();
  const groupBy = String(filters.groupBy || "day") === "hour" ? "hour" : "day";
  // hour 时 limit 表示小时桶数；day 时表示天数。乘以 client×model 展开上限。
  const limit = Math.min(Math.max(intValue(filters.limit) || 30, 1), groupBy === "hour" ? 168 : 400);
  const modelKey = usageModelKeySql();
  const bucketExpr = groupBy === "hour"
    ? `strftime('%Y-%m-%dT%H:00', ts, 'localtime')`
    : `date(ts, 'localtime')`;
  const rows = runSql(`
    SELECT
      ${bucketExpr} AS day,
      COALESCE(client_id, '(unknown)') AS client_id,
      ${modelKey} AS model_id,
      ${usageSelectMetrics()}
    FROM request_logs
    ${whereClause(filters)}
    GROUP BY ${bucketExpr}, COALESCE(client_id, '(unknown)'), ${modelKey}
    ORDER BY day DESC, request_count DESC, total_tokens DESC
    LIMIT ${limit * 300};
  `, { json: true });
  return (rows || []).map(enrichUsageStatsRow).slice(0, limit * 300);
}

export function cleanupRequestLogs({ retainDays = retainDaysValue(), maxRows = maxRowsValue(), maxBytes = maxBytesValue(), now = new Date() } = {}) {
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


export function requestLogStats({ since } = {}) {
  initRequestLogStore();
  const clause = since ? `WHERE ts >= ${valueSql(since)}` : "";
  const row = runSql(`SELECT COUNT(*) AS total, SUM(CASE WHEN ${REQUEST_ERROR_SQL} THEN 1 ELSE 0 END) AS errors FROM request_logs ${clause};`, { json: true })?.[0] || {};
  return { total: intValue(row.total), errors: intValue(row.errors), bytes: requestLogDiskBytes(), maxBytes: maxBytesValue() };
}

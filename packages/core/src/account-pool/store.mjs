// 账号池持久化：token 与健康状态放在 ~/.switchyard/pools/，不进 config.json。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { ensureDir, atomicWriteFileSync } from "../utils.mjs";

export const POOL_KINDS = new Set(["xai_oauth", "antigravity_oauth", "codex_oauth", "cursor_subscription"]);
export const POOL_STRATEGIES = new Set([
  "weighted_round_robin",
  "least_recently_used",
  "lowest_error_rate"
]);

/** 运行时解析，便于测试通过 HOME / SWITCHYARD_HOME 注入。 */
export function resolvePoolHome(home) {
  if (home) return home;
  if (process.env.SWITCHYARD_HOME) return process.env.SWITCHYARD_HOME;
  return path.join(os.homedir(), ".switchyard");
}

export function poolsRoot(home) {
  return path.join(resolvePoolHome(home), "pools");
}

export function poolFilePath(providerId, poolKind = "xai_oauth", home) {
  const safeProvider = sanitizeId(providerId);
  const safeKind = sanitizeId(poolKind || "xai_oauth");
  return path.join(poolsRoot(home), safeKind, `${safeProvider}.json`);
}

function sanitizeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "default";
}

export function createEmptyPool({ providerId, poolKind = "xai_oauth", strategy = "weighted_round_robin" } = {}) {
  return {
    providerId: String(providerId || "").trim(),
    poolKind: poolKind || "xai_oauth",
    strategy: strategy || "weighted_round_robin",
    updatedAt: new Date().toISOString(),
    accounts: []
  };
}

function jwtExpIso(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return new Date(exp * 1000).toISOString();
  } catch {
    return null;
  }
}

export function normalizeAccount(raw = {}) {
  const id = String(raw.id || crypto.randomUUID()).trim();
  const weight = Number.isFinite(Number(raw.weight)) ? Math.max(1, Math.floor(Number(raw.weight))) : 1;
  const accessToken = String(raw.accessToken || raw.access_token || "").trim();
  // 优先用 access JWT 的 exp，避免 CPA 导出把 id_token 过期写到 expired 字段导致误判
  const expiresAt =
    jwtExpIso(accessToken) ||
    normalizeTime(raw.expiresAt || raw.expired || raw.expires_at);
  return {
    id,
    email: String(raw.email || "").trim(),
    name: String(raw.name || "").trim(),
    enabled: raw.enabled !== false,
    weight,
    accessToken,
    refreshToken: String(raw.refreshToken || raw.refresh_token || "").trim(),
    sessionToken: String(raw.sessionToken || raw.session_token || "").trim(),
    ssoToken: String(raw.ssoToken || raw.sso_token || raw.sso || "").trim(),
    idToken: String(raw.idToken || raw.id_token || "").trim(),
    accountId: String(raw.accountId || raw.account_id || raw.chatgpt_account_id || "").trim(),
    // Newer Codex subscription exports may authenticate with an Ed25519
    // Agent Identity instead of OAuth access / refresh tokens.
    agentIdentity: raw.agentIdentity === true || String(raw.authMode || raw.auth_mode || "").toLowerCase() === "agentidentity",
    authMode: String(raw.authMode || raw.auth_mode || "").trim(),
    // Cursor 订阅号：access token 之外，还需要 Cursor 设备标识用于 x-cursor-checksum。
    // 按用户确认，导入的 Cursor 账号统一复用本机 machine id，避免每号随机设备标识。
    machineId: String(raw.machineId || raw.machine_id || "").trim(),
    agentRuntimeId: String(raw.agentRuntimeId || raw.agent_runtime_id || "").trim(),
    agentPrivateKey: String(raw.agentPrivateKey || raw.agent_private_key || "").trim(),
    agentTaskId: String(raw.agentTaskId || raw.agent_task_id || raw.task_id || "").trim(),
    projectId: String(raw.projectId || raw.project_id || "").trim(),
    planType: String(raw.planType || raw.plan_type || raw.chatgpt_plan_type || "").trim(),
    tokenType: String(raw.tokenType || raw.token_type || "Bearer").trim() || "Bearer",
    expiresAt,
    tokenEndpoint: String(raw.tokenEndpoint || raw.token_endpoint || "").trim(),
    health: normalizeHealth(raw.health),
    cooldownUntil: normalizeTime(raw.cooldownUntil || raw.cooldown_until),
    consecutiveFailures: Number.isFinite(Number(raw.consecutiveFailures))
      ? Math.max(0, Math.floor(Number(raw.consecutiveFailures)))
      : 0,
    lastError: String(raw.lastError || raw.last_error || "").slice(0, 500),
    lastUsedAt: normalizeTime(raw.lastUsedAt || raw.last_used_at),
    lastSuccessAt: normalizeTime(raw.lastSuccessAt || raw.last_success_at),
    modelHealth: normalizeModelHealth(raw.modelHealth || raw.model_health),
    source: String(raw.source || "").trim(),
    notes: String(raw.notes || "").slice(0, 500),
    sub: String(raw.sub || "").trim(),
    // 单号额度快照（Codex wham/usage 等）
    quotaOk: raw.quotaOk === true,
    quotaSummary: String(raw.quotaSummary || raw.quota_summary || "").slice(0, 300),
    quotaError: String(raw.quotaError || raw.quota_error || "").slice(0, 300),
    quotaFetchedAt: normalizeTime(raw.quotaFetchedAt || raw.quota_fetched_at),
    quotaPrimaryRemainingPercent: parsePercent(raw.quotaPrimaryRemainingPercent ?? raw.quota_primary_remaining_percent),
    quotaSecondaryRemainingPercent: parsePercent(raw.quotaSecondaryRemainingPercent ?? raw.quota_secondary_remaining_percent),
    quotaLimitReached: raw.quotaLimitReached === true || raw.quota_limit_reached === true
  };
}

function parsePercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function normalizeModelHealth(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [model, value] of Object.entries(raw)) {
    const id = String(model || "").trim().slice(0, 240);
    if (!id || !value || typeof value !== "object") continue;
    out[id] = {
      health: normalizeHealth(value.health),
      cooldownUntil: normalizeTime(value.cooldownUntil || value.cooldown_until),
      consecutiveFailures: Number.isFinite(Number(value.consecutiveFailures)) ? Math.max(0, Math.floor(Number(value.consecutiveFailures))) : 0,
      lastError: String(value.lastError || value.last_error || "").slice(0, 500),
      lastUsedAt: normalizeTime(value.lastUsedAt || value.last_used_at),
      lastSuccessAt: normalizeTime(value.lastSuccessAt || value.last_success_at)
    };
  }
  return out;
}

function normalizeHealth(value) {
  const health = String(value || "healthy").toLowerCase();
  if (["healthy", "degraded", "cooldown", "disabled"].includes(health)) return health;
  return "healthy";
}

function normalizeTime(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  const text = String(value).trim();
  if (!text) return null;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function normalizePool(raw = {}, fallback = {}) {
  const providerId = String(raw.providerId || fallback.providerId || "").trim();
  const poolKind = String(raw.poolKind || fallback.poolKind || "xai_oauth").trim() || "xai_oauth";
  const strategy = String(raw.strategy || fallback.strategy || "weighted_round_robin").trim() || "weighted_round_robin";
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map(normalizeAccount) : [];
  return {
    providerId,
    poolKind,
    strategy: POOL_STRATEGIES.has(strategy) ? strategy : "weighted_round_robin",
    updatedAt: normalizeTime(raw.updatedAt) || new Date().toISOString(),
    accounts
  };
}

export function loadPool(providerId, { poolKind = "xai_oauth", home } = {}) {
  const file = poolFilePath(providerId, poolKind, home);
  if (!fs.existsSync(file)) {
    return createEmptyPool({ providerId, poolKind });
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return normalizePool(raw, { providerId, poolKind });
  } catch (err) {
    const empty = createEmptyPool({ providerId, poolKind });
    empty.loadError = err?.message || String(err);
    return empty;
  }
}

export function savePool(pool, { home } = {}) {
  const normalized = normalizePool(pool);
  if (!normalized.providerId) throw new Error("pool.providerId is required");
  const file = poolFilePath(normalized.providerId, normalized.poolKind, home);
  ensureDir(path.dirname(file));
  const payload = {
    ...normalized,
    updatedAt: new Date().toISOString()
  };
  atomicWriteFileSync(file, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  return { ok: true, path: file, pool: payload };
}

export function listPoolAccountsPublic(providerId, opts = {}) {
  const pool = loadPool(providerId, opts);
  return {
    ...pool,
    accounts: pool.accounts.map(publicAccountView)
  };
}

export function publicAccountView(account) {
  const accessExpired = isAccessExpired(account, 0);
  const hasRefresh = Boolean(account.refreshToken);
  const hasSession = Boolean(account.sessionToken);
  const canAutoRefresh = hasRefresh || hasSession;
  return {
    id: account.id,
    email: account.email,
    name: account.name,
    enabled: account.enabled,
    weight: account.weight,
    health: account.health,
    healthLabel: healthLabelOf(account.health),
    cooldownUntil: account.cooldownUntil,
    consecutiveFailures: account.consecutiveFailures || 0,
    lastError: account.lastError || "",
    lastUsedAt: account.lastUsedAt,
    lastSuccessAt: account.lastSuccessAt,
    modelHealth: account.modelHealth || {},
    source: account.source,
    notes: account.notes || "",
    hasAccessToken: Boolean(account.accessToken),
    hasRefreshToken: hasRefresh,
    hasSessionToken: hasSession,
    hasSsoToken: Boolean(account.ssoToken),
    hasAgentIdentity: account.agentIdentity === true && Boolean(account.agentRuntimeId && account.agentPrivateKey),
    // Cursor 订阅号：仅回传脱敏预览，完整 machine id 不离开主进程
    hasMachineId: Boolean(account.machineId),
    machineIdPreview: account.machineId ? account.machineId.slice(0, 8) + "..." : "",
    accountId: account.accountId || "",
    projectId: account.projectId || "",
    planType: account.planType || "",
    // access token 过期时间（不是订阅到期）
    expiresAt: account.expiresAt,
    accessExpiresAt: account.expiresAt,
    tokenExpired: accessExpired,
    accessExpired,
    accessStatusLabel: account.agentIdentity
      ? "Agent Identity（无需 OAuth Access）"
      : formatAccessStatusLabel({
      accessExpiresAt: account.expiresAt,
      accessExpired,
      hasRefreshToken: canAutoRefresh
    }),
    canAutoRefresh: account.agentIdentity ? false : canAutoRefresh,
    // 单号额度
    quotaOk: account.quotaOk === true,
    quotaSummary: account.quotaSummary || "",
    quotaError: account.quotaError || "",
    quotaFetchedAt: account.quotaFetchedAt || null,
    quotaPrimaryRemainingPercent: account.quotaPrimaryRemainingPercent,
    quotaSecondaryRemainingPercent: account.quotaSecondaryRemainingPercent,
    quotaLimitReached: account.quotaLimitReached === true,
    quotaLabel: formatQuotaLabel(account),
    subscriptionExpiresAt: account.subscriptionExpiresAt || null
  };
}

export function healthLabelOf(health) {
  const map = {
    healthy: "健康",
    degraded: "降级",
    cooldown: "冷却中",
    disabled: "已停用"
  };
  return map[String(health || "healthy")] || String(health || "健康");
}

export function formatQuotaLabel(account) {
  if (account?.quotaLimitReached) return "额度已用尽";
  if (account?.quotaSummary) return account.quotaSummary;
  if (account?.quotaError) return `查询失败 · ${account.quotaError}`;
  if (account?.quotaFetchedAt) return "已查询";
  return "未查询";
}

/** 账号池「Access」列展示：明确是 access token，不是订阅到期 */
export function formatAccessStatusLabel({ accessExpiresAt, accessExpired, hasRefreshToken } = {}) {
  const when = formatLocalDateTime(accessExpiresAt);
  if (!accessExpiresAt) {
    return hasRefreshToken ? "Access 未知 · 有 Refresh 可续" : "Access 未知";
  }
  if (accessExpired) {
    return hasRefreshToken
      ? `Access 已过期（${when}）· 有 Refresh 可自动续`
      : `Access 已过期（${when}）· 无 Refresh`;
  }
  return hasRefreshToken
    ? `Access 有效至 ${when} · 可自动续`
    : `Access 有效至 ${when}`;
}

function formatLocalDateTime(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso).slice(0, 16);
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  }
}

export function isAccessExpired(account, skewMs = 60_000) {
  if (!account?.accessToken) return true;
  if (!account.expiresAt) return false;
  const ms = Date.parse(account.expiresAt);
  if (Number.isNaN(ms)) return false;
  return Date.now() + skewMs >= ms;
}

export function upsertAccounts(providerId, incomingAccounts, {
  poolKind = "xai_oauth",
  strategy,
  skipDuplicates = true,
  home
} = {}) {
  const pool = loadPool(providerId, { poolKind, home });
  if (strategy) pool.strategy = strategy;
  const existingByKey = new Map();
  for (const account of pool.accounts) {
    existingByKey.set(accountKey(account, pool.poolKind), account);
  }
  let added = 0;
  let skipped = 0;
  let updated = 0;
  for (const raw of incomingAccounts || []) {
    const account = normalizeAccount(raw);
    const key = accountKey(account, pool.poolKind);
    const existing = existingByKey.get(key);
    if (existing) {
      if (skipDuplicates) {
        skipped += 1;
        continue;
      }
      Object.assign(existing, {
        ...account,
        id: existing.id,
        consecutiveFailures: existing.consecutiveFailures,
        health: existing.health,
        cooldownUntil: existing.cooldownUntil,
        lastUsedAt: existing.lastUsedAt,
        lastSuccessAt: existing.lastSuccessAt
      });
      updated += 1;
      continue;
    }
    pool.accounts.push(account);
    existingByKey.set(key, account);
    added += 1;
  }
  const saved = savePool(pool, { home });
  return {
    ok: true,
    added,
    skipped,
    updated,
    total: saved.pool.accounts.length,
    path: saved.path,
    pool: {
      ...saved.pool,
      accounts: saved.pool.accounts.map(publicAccountView)
    }
  };
}

function accountKey(account, poolKind = "") {
  // Cursor exports may change or omit email between dumps; the access token is
  // the stable identity of a subscription account in that pool.
  if (poolKind === "cursor_subscription" && account.accessToken) return `access:${account.accessToken}`;
  if (account.agentIdentity && account.agentRuntimeId) return `agent:${account.agentRuntimeId}`;
  if (account.refreshToken) return `rt:${account.refreshToken}`;
  if (account.sessionToken) return `st:${account.sessionToken}`;
  if (account.ssoToken) return `sso:${account.ssoToken}`;
  if (account.accountId) return `acct:${account.accountId}`;
  if (account.email) return `email:${account.email.toLowerCase()}`;
  if (account.sub) return `sub:${account.sub}`;
  return `id:${account.id}`;
}

export function patchAccounts(providerId, accountIds, patch = {}, opts = {}) {
  const pool = loadPool(providerId, opts);
  const idSet = new Set((accountIds || []).map(String));
  let changed = 0;
  pool.accounts = pool.accounts.map((account) => {
    if (!idSet.has(account.id)) return account;
    changed += 1;
    const next = { ...account };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (Number.isFinite(Number(patch.weight))) next.weight = Math.max(1, Math.floor(Number(patch.weight)));
    if (patch.clearCooldown) {
      next.health = "healthy";
      next.cooldownUntil = null;
      next.consecutiveFailures = 0;
      next.lastError = "";
    }
    if (patch.health) next.health = normalizeHealth(patch.health);
    return normalizeAccount(next);
  });
  const saved = savePool(pool, opts);
  return { ok: true, changed, pool: listPoolAccountsPublic(providerId, opts), path: saved.path };
}

export function deleteAccounts(providerId, accountIds, opts = {}) {
  const pool = loadPool(providerId, opts);
  const idSet = new Set((accountIds || []).map(String));
  const before = pool.accounts.length;
  pool.accounts = pool.accounts.filter((account) => !idSet.has(account.id));
  const saved = savePool(pool, opts);
  return {
    ok: true,
    deleted: before - pool.accounts.length,
    pool: listPoolAccountsPublic(providerId, opts),
    path: saved.path
  };
}

export function updateAccountRuntime(providerId, accountId, patch = {}, opts = {}) {
  const pool = loadPool(providerId, opts);
  let found = false;
  pool.accounts = pool.accounts.map((account) => {
    if (account.id !== accountId) return account;
    found = true;
    return normalizeAccount({ ...account, ...patch, id: account.id });
  });
  if (!found) return { ok: false, error: "account-not-found" };
  return savePool(pool, opts);
}

// 账号池选号、健康更新、绑定 provider 凭证。
import {
  isAccessExpired,
  loadPool,
  savePool,
  updateAccountRuntime
} from "./store.mjs";
import { readAntigravityCpaCredential } from "./import-multi.mjs";
import { refreshXaiTokens, XAI_API_BASE_URL } from "./oauth-xai.mjs";
import { refreshGoogleTokens } from "./oauth-google.mjs";
import { refreshCodexAccountTokens, CODEX_API_BASE_URL } from "./oauth-codex.mjs";
import { isAgentIdentityAccount } from "./agent-identity.mjs";

const rrCursor = new Map();
const sessionAffinity = new Map();
const AFFINITY_TTL_MS = 60 * 60 * 1000;

export const POOL_KIND_META = {
  xai_oauth: {
    label: "Grok / xAI",
    defaultBaseUrl: XAI_API_BASE_URL,
    defaultApiFormat: "openai_chat",
    emptyHint: "账号池为空：请先导入 Grok / xAI 账号"
  },
  antigravity_oauth: {
    label: "Antigravity",
    defaultBaseUrl: "https://daily-cloudcode-pa.googleapis.com",
    defaultApiFormat: "antigravity",
    emptyHint: "账号池为空：请先导入 Antigravity OAuth 凭证"
  },
  codex_oauth: {
    label: "Codex 订阅",
    defaultBaseUrl: CODEX_API_BASE_URL,
    defaultApiFormat: "openai_responses",
    emptyHint: "账号池为空：请导入多份 Codex auth.json / refresh_token"
  }
};

export function isAccountPoolProvider(provider) {
  // 已绑定具体账号的临时 provider 不再视为池
  if (provider?._accountPool) return false;
  return provider?.authMode === "account_pool" ||
    provider?.providerType === "account_pool";
}

export function poolKindOf(provider) {
  const kind = String(provider?.poolKind || "xai_oauth").trim() || "xai_oauth";
  return POOL_KIND_META[kind] ? kind : "xai_oauth";
}

export function poolStrategyOf(provider, pool) {
  return String(provider?.poolStrategy || pool?.strategy || "weighted_round_robin").trim() || "weighted_round_robin";
}

function affinityKey(provider, sessionKey) {
  const providerId = String(provider?.id || "").trim();
  const key = String(sessionKey || "").trim();
  return providerId && key ? `${providerId}::${key}` : "";
}

function clearExpiredAffinity() {
  const now = Date.now();
  for (const [key, item] of sessionAffinity) {
    if (!item || item.expiresAt <= now) sessionAffinity.delete(key);
  }
}

export function accountAffinityId(provider, sessionKey) {
  clearExpiredAffinity();
  return sessionAffinity.get(affinityKey(provider, sessionKey))?.accountId || "";
}

export function bindAccountAffinity(provider, sessionKey, accountId) {
  const key = affinityKey(provider, sessionKey);
  const id = String(accountId || "").trim();
  if (!key || !id) return;
  sessionAffinity.set(key, { accountId: id, expiresAt: Date.now() + AFFINITY_TTL_MS });
}

export function clearAccountAffinity(provider, sessionKey, accountId = "") {
  const key = affinityKey(provider, sessionKey);
  if (!key) return;
  const current = sessionAffinity.get(key);
  if (!accountId || current?.accountId === accountId) sessionAffinity.delete(key);
}

export function listEligibleAccounts(pool, { excludeIds = [], now = Date.now() } = {}) {
  const excluded = new Set((excludeIds || []).map(String));
  return (pool?.accounts || []).filter((account) => {
    if (!account || excluded.has(account.id)) return false;
    if (account.enabled === false) return false;
    if (account.health === "disabled") return false;
    if (!account.accessToken && !account.refreshToken && !account.sessionToken && !isAgentIdentityAccount(account)) return false;
    if (account.health === "cooldown" && account.cooldownUntil) {
      const until = Date.parse(account.cooldownUntil);
      if (!Number.isNaN(until) && until > now) return false;
    }
    return true;
  });
}

export function pickAccount(pool, {
  strategy = "weighted_round_robin",
  excludeIds = [],
  providerId = pool?.providerId || "",
  now = Date.now()
} = {}) {
  const candidates = listEligibleAccounts(pool, { excludeIds, now });
  if (!candidates.length) return null;

  // prefer healthy with zero failures
  const healthy = candidates.filter((a) => a.health === "healthy" && !a.consecutiveFailures);
  const poolCandidates = healthy.length ? healthy : candidates;

  if (strategy === "least_recently_used") {
    return [...poolCandidates].sort((a, b) => {
      const at = Date.parse(a.lastUsedAt || 0) || 0;
      const bt = Date.parse(b.lastUsedAt || 0) || 0;
      return at - bt;
    })[0];
  }

  if (strategy === "lowest_error_rate") {
    return [...poolCandidates].sort((a, b) => {
      if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures - b.consecutiveFailures;
      return Math.random() - 0.5;
    })[0];
  }

  // weighted_round_robin
  const key = `${providerId || "default"}::${pool?.poolKind || "xai_oauth"}`;
  const expanded = [];
  for (const account of poolCandidates) {
    const weight = Math.max(1, account.weight || 1);
    for (let i = 0; i < weight; i += 1) expanded.push(account);
  }
  if (!expanded.length) return null;
  const cursor = rrCursor.get(key) || 0;
  const index = cursor % expanded.length;
  rrCursor.set(key, cursor + 1);
  return expanded[index];
}

export async function ensureFreshAccount(account, {
  provider,
  proxyUrl = "",
  fetchImpl,
  force = false,
  skewMs = 60_000,
  home
} = {}) {
  if (!account) return { ok: false, error: "no-account" };
  const kind = poolKindOf(provider);
  let current = account;
  if (kind === "codex_oauth" && isAgentIdentityAccount(current)) {
    return { ok: true, account: current, refreshed: false };
  }
  if (kind === "antigravity_oauth") {
    const cpaCredential = readAntigravityCpaCredential(account, {
      authDir: provider?.antigravityAuthDir || undefined
    });
    if (cpaCredential) {
      const fromCpa = {
        ...account,
        accessToken: cpaCredential.accessToken,
        refreshToken: cpaCredential.refreshToken || account.refreshToken,
        tokenType: cpaCredential.tokenType || account.tokenType,
        expiresAt: cpaCredential.expiresAt || account.expiresAt,
        projectId: cpaCredential.projectId || account.projectId,
        email: cpaCredential.email || account.email,
        health: "healthy",
        lastError: ""
      };
      if (
        isAccessExpired(account, skewMs)
        || fromCpa.accessToken !== account.accessToken
        || fromCpa.expiresAt !== account.expiresAt
      ) {
        current = fromCpa;
        if (provider?.id) {
          updateAccountRuntime(provider.id, account.id, {
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            tokenType: current.tokenType,
            expiresAt: current.expiresAt,
            projectId: current.projectId,
            email: current.email,
            health: "healthy",
            lastError: ""
          }, { poolKind: kind, home });
        }
      }
    }
  }
  if (!force && current.accessToken && !isAccessExpired(current, skewMs)) {
    return { ok: true, account: current, refreshed: current !== account };
  }
  const canRefresh =
    Boolean(current.refreshToken) ||
    (kind === "codex_oauth" && Boolean(current.sessionToken));
  if (!canRefresh) {
    if (current.accessToken && !isAccessExpired(current, 0)) {
      return { ok: true, account: current, refreshed: current !== account };
    }
    return {
      ok: false,
      error: kind === "codex_oauth" ? "missing-refresh-or-session-token" : "missing-refresh-token",
      account: current
    };
  }
  const proxy = proxyUrl || provider?.proxyUrl || "";
  try {
    let tokens;
    if (kind === "antigravity_oauth") {
      tokens = await refreshGoogleTokens(current.refreshToken, { proxyUrl: proxy, fetchImpl });
    } else if (kind === "codex_oauth") {
      tokens = await refreshCodexAccountTokens(current, { proxyUrl: proxy, fetchImpl });
    } else {
      tokens = await refreshXaiTokens(current.refreshToken, {
        tokenEndpoint: current.tokenEndpoint || undefined,
        proxyUrl: proxy,
        fetchImpl
      });
    }
    const next = {
      ...current,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken || current.refreshToken,
      sessionToken: tokens.sessionToken || current.sessionToken,
      tokenType: tokens.tokenType || current.tokenType,
      expiresAt: tokens.expiresAt,
      email: tokens.email || current.email,
      sub: tokens.sub || current.sub,
      accountId: tokens.accountId || current.accountId || "",
      idToken: tokens.idToken || current.idToken || "",
      health: "healthy",
      lastError: ""
    };
    if (provider?.id) {
      updateAccountRuntime(provider.id, account.id, {
        accessToken: next.accessToken,
        refreshToken: next.refreshToken,
        sessionToken: next.sessionToken,
        tokenType: next.tokenType,
        expiresAt: next.expiresAt,
        email: next.email,
        sub: next.sub,
        accountId: next.accountId,
        idToken: next.idToken,
        health: "healthy",
        lastError: ""
      }, { poolKind: kind, home });
    }
    return { ok: true, account: next, refreshed: true };
  } catch (err) {
    const message = err?.message || String(err);
    if (provider?.id) {
      updateAccountRuntime(provider.id, account.id, {
        health: "degraded",
        consecutiveFailures: (account.consecutiveFailures || 0) + 1,
        lastError: message
      }, { poolKind: poolKindOf(provider), home });
    }
    return { ok: false, error: message, account: current };
  }
}

export async function pickAndRefreshAccount(provider, {
  excludeIds = [],
  home,
  fetchImpl,
  maxRefreshAttempts = 5,
  sessionKey = ""
} = {}) {
  if (!isAccountPoolProvider(provider)) {
    return { ok: false, error: "not-account-pool-provider" };
  }
  const poolKind = poolKindOf(provider);
  const pool = loadPool(provider.id, { poolKind, home });
  const strategy = poolStrategyOf(provider, pool);
  const tried = new Set((excludeIds || []).map(String));
  let lastError = "no eligible accounts";

  for (let i = 0; i < maxRefreshAttempts; i += 1) {
    const affinityId = poolKind === "antigravity_oauth" ? accountAffinityId(provider, sessionKey) : "";
    let account = affinityId && !tried.has(affinityId)
      ? listEligibleAccounts(pool, { excludeIds: [...tried] }).find((item) => item.id === affinityId)
      : null;
    if (!account) {
      if (affinityId) clearAccountAffinity(provider, sessionKey, affinityId);
      account = pickAccount(pool, {
        strategy,
        excludeIds: [...tried],
        providerId: provider.id
      });
    }
    if (!account) break;
    tried.add(account.id);
    const fresh = await ensureFreshAccount(account, {
      provider,
      proxyUrl: provider.proxyUrl,
      fetchImpl,
      home
    });
    if (fresh.ok) {
      if (poolKind === "antigravity_oauth") bindAccountAffinity(provider, sessionKey, fresh.account.id);
      return {
        ok: true,
        account: fresh.account,
        refreshed: fresh.refreshed,
        strategy,
        poolKind
      };
    }
    lastError = fresh.error || lastError;
  }

  const enabled = (pool.accounts || []).filter((a) => a.enabled !== false);
  if (!enabled.length) {
    const meta = POOL_KIND_META[poolKind] || POOL_KIND_META.xai_oauth;
    return { ok: false, error: meta.emptyHint };
  }
  return { ok: false, error: lastError || "账号池当前没有可用账号（可能均在冷却或 token 失效）" };
}

export function bindProviderToAccount(provider, account) {
  if (!provider || !account) return provider;
  const kind = poolKindOf(provider);
  const meta = POOL_KIND_META[kind] || POOL_KIND_META.xai_oauth;

  // Codex 多号：原生 Responses + OAuth headers
  if (kind === "codex_oauth") {
    if (isAgentIdentityAccount(account)) {
      return {
        ...provider,
        authMode: "codex_agent_identity",
        providerType: "codex_agent_identity",
        apiFormat: provider.apiFormat || "openai_responses",
        baseUrl: provider.baseUrl || CODEX_API_BASE_URL,
        apiKey: undefined,
        apiKeyEnv: undefined,
        _accountPool: true,
        _accountId: account.id,
        _accountEmail: account.email || "",
        _agentIdentity: {
          agentRuntimeId: account.agentRuntimeId,
          agentPrivateKey: account.agentPrivateKey,
          agentTaskId: account.agentTaskId
        }
      };
    }
    return {
      ...provider,
      authMode: "codex_oauth",
      providerType: "codex_oauth",
      apiFormat: provider.apiFormat || "openai_responses",
      baseUrl: provider.baseUrl || CODEX_API_BASE_URL,
      apiKey: undefined,
      apiKeyEnv: undefined,
      _accountPool: true,
      _accountId: account.id,
      _accountEmail: account.email || "",
      _codexAccessToken: account.accessToken,
      _codexAccountId: account.accountId || "",
      _codexIdToken: account.idToken || ""
    };
  }

  // Antigravity：直连 Google Cloud Code Assist。账号池负责 token 刷新、
  // 会话粘性和失败换号；不再依赖本机 CLIProxyAPI 8317。
  if (kind === "antigravity_oauth") {
    return {
      ...provider,
      authMode: "antigravity_oauth",
      providerType: "antigravity_oauth",
      apiKey: account.accessToken,
      apiKeyEnv: undefined,
      apiFormat: "antigravity",
      baseUrl: provider.baseUrl || meta.defaultBaseUrl,
      _accountPool: true,
      _accountId: account.id,
      _accountEmail: account.email || "",
      _antigravityAccessToken: account.accessToken,
      _antigravityProjectId: account.projectId || provider.projectId || provider.project || ""
    };
  }

  // Grok / xAI：直连 api.x.ai
  return {
    ...provider,
    authMode: "api_key",
    apiKey: account.accessToken,
    apiKeyEnv: undefined,
    _accountPool: true,
    _accountId: account.id,
    _accountEmail: account.email || "",
    baseUrl: provider.baseUrl || XAI_API_BASE_URL
  };
}

export function markAccountSuccess(provider, account, { home } = {}) {
  if (!provider?.id || !account?.id) return;
  updateAccountRuntime(provider.id, account.id, {
    health: "healthy",
    consecutiveFailures: 0,
    lastError: "",
    lastUsedAt: new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    cooldownUntil: null
  }, { poolKind: poolKindOf(provider), home });
}

export function markAccountFailure(provider, account, {
  status = 0,
  error = "",
  home,
  retryAfterSec
} = {}) {
  if (!provider?.id || !account?.id) return;
  const failures = (account.consecutiveFailures || 0) + 1;
  let health = "degraded";
  let cooldownUntil = null;
  if (status === 429 || status === 403) {
    health = "cooldown";
    const seconds = Number.isFinite(Number(retryAfterSec))
      ? Math.max(30, Number(retryAfterSec))
      : Math.min(900, 30 * failures);
    cooldownUntil = new Date(Date.now() + seconds * 1000).toISOString();
  } else if (status === 401) {
    health = "degraded";
  }
  updateAccountRuntime(provider.id, account.id, {
    health,
    consecutiveFailures: failures,
    lastError: String(error || `status ${status}`).slice(0, 500),
    lastUsedAt: new Date().toISOString(),
    cooldownUntil
  }, { poolKind: poolKindOf(provider), home });
}

export function accountPoolReady(provider, { home } = {}) {
  if (!isAccountPoolProvider(provider) || !provider?.id) return false;
  const pool = loadPool(provider.id, { poolKind: poolKindOf(provider), home });
  return listEligibleAccounts(pool).length > 0;
}

export function resetRoundRobinCursors() {
  rrCursor.clear();
  sessionAffinity.clear();
}

/** 测试辅助：直接改池策略 */
export function setPoolStrategy(providerId, strategy, opts = {}) {
  const pool = loadPool(providerId, opts);
  pool.strategy = strategy;
  return savePool(pool, opts);
}

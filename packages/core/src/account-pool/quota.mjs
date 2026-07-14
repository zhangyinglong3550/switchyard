// 账号池单号额度查询。
// - Codex：chatgpt.com/backend-api/wham/usage（5h + 周窗口 used_percent）
// - Grok/xAI：目前无稳定公开额度 API，返回 tier/说明
// - Antigravity：暂不支持
import { ProxyAgent } from "undici";
import {
  loadPool,
  savePool,
  updateAccountRuntime,
  isAccessExpired
} from "./store.mjs";
import { ensureFreshAccount, poolKindOf } from "./picker.mjs";

const PROXY_AGENTS = new Map();
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_URL_FALLBACK = "https://chatgpt.com/backend-api/codex/usage";

function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  const normalized = String(proxyUrl).trim();
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  if (!PROXY_AGENTS.has(normalized)) PROXY_AGENTS.set(normalized, new ProxyAgent(normalized));
  return PROXY_AGENTS.get(normalized);
}

function formatReset(seconds, resetAtUnix) {
  if (Number.isFinite(Number(resetAtUnix)) && Number(resetAtUnix) > 0) {
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(Number(resetAtUnix) * 1000));
    } catch {}
  }
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec < 0) return "";
  if (sec < 60) return `${Math.ceil(sec)}s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)}分钟`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}小时`;
  return `${(sec / 86400).toFixed(1)}天`;
}

function windowSummary(label, win) {
  if (!win || typeof win !== "object") return "";
  const used = Number(win.used_percent);
  if (!Number.isFinite(used)) return "";
  const remain = Math.max(0, Math.min(100, Math.round(100 - used)));
  const reset = formatReset(win.reset_after_seconds, win.reset_at);
  return reset ? `${label} 剩${remain}%（${reset}重置）` : `${label} 剩${remain}%`;
}

export function parseCodexUsagePayload(body) {
  const rate = body?.rate_limit || {};
  const primary = rate.primary_window || null;
  const secondary = rate.secondary_window || null;
  const primaryUsed = Number(primary?.used_percent);
  const secondaryUsed = Number(secondary?.used_percent);
  const primaryRemain = Number.isFinite(primaryUsed)
    ? Math.max(0, Math.min(100, Math.round(100 - primaryUsed)))
    : null;
  const secondaryRemain = Number.isFinite(secondaryUsed)
    ? Math.max(0, Math.min(100, Math.round(100 - secondaryUsed)))
    : null;
  const parts = [
    windowSummary("5h", primary),
    windowSummary("周", secondary)
  ].filter(Boolean);
  const limitReached = rate.limit_reached === true || rate.allowed === false;
  if (limitReached) parts.unshift("已达限额");
  const planType = String(body?.plan_type || "").trim();
  return {
    ok: true,
    source: "codex-wham-usage",
    planType,
    allowed: rate.allowed !== false && !limitReached,
    limitReached,
    primaryUsedPercent: Number.isFinite(primaryUsed) ? Math.round(primaryUsed) : null,
    primaryRemainingPercent: primaryRemain,
    primaryResetAt: primary?.reset_at || null,
    primaryResetAfterSec: primary?.reset_after_seconds ?? null,
    primaryWindowSec: primary?.limit_window_seconds ?? null,
    secondaryUsedPercent: Number.isFinite(secondaryUsed) ? Math.round(secondaryUsed) : null,
    secondaryRemainingPercent: secondaryRemain,
    secondaryResetAt: secondary?.reset_at || null,
    secondaryResetAfterSec: secondary?.reset_after_seconds ?? null,
    secondaryWindowSec: secondary?.limit_window_seconds ?? null,
    creditsBalance: body?.credits?.balance ?? null,
    summary: parts.join(" · ") || (planType ? `plan ${planType}` : "已查询"),
    rawEmail: body?.email || "",
    fetchedAt: new Date().toISOString(),
    error: ""
  };
}

async function fetchJson(url, { token, accountId, proxyUrl, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const init = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "codex_cli_rs/0.0.0",
      "OpenAI-Beta": "responses=experimental",
      ...(accountId ? { "ChatGPT-Account-Id": accountId, "chatgpt-account-id": accountId } : {})
    }
  };
  const dispatcher = proxyDispatcher(proxyUrl);
  if (dispatcher) init.dispatcher = dispatcher;
  const resp = await doFetch(url, init);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { ok: resp.ok, status: resp.status, body, text };
}

export async function fetchCodexAccountQuota(account, {
  proxyUrl = "",
  fetchImpl
} = {}) {
  if (!account?.accessToken && !account?.refreshToken && !account?.sessionToken) {
    return {
      ok: false,
      error: "no-token",
      summary: "无凭证",
      fetchedAt: new Date().toISOString()
    };
  }
  const token = account.accessToken;
  if (!token) {
    return {
      ok: false,
      error: "access-token-empty",
      summary: "Access 空",
      fetchedAt: new Date().toISOString()
    };
  }
  let lastErr = "";
  for (const url of [CODEX_USAGE_URL, CODEX_USAGE_URL_FALLBACK]) {
    try {
      const resp = await fetchJson(url, {
        token,
        accountId: account.accountId,
        proxyUrl,
        fetchImpl
      });
      if (!resp.ok) {
        lastErr = `${resp.status}`;
        continue;
      }
      return parseCodexUsagePayload(resp.body);
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  return {
    ok: false,
    error: lastErr || "codex-usage-failed",
    summary: `查询失败 ${lastErr || ""}`.trim(),
    fetchedAt: new Date().toISOString()
  };
}

export async function fetchXaiAccountQuota(account, {
  proxyUrl = "",
  fetchImpl
} = {}) {
  // xAI 订阅号目前没有稳定的「剩余额度」公开 API。
  // management-api /auth/teams 仅能确认团队/tier 存在。
  if (!account?.accessToken) {
    return {
      ok: false,
      error: "no-token",
      summary: "无凭证",
      fetchedAt: new Date().toISOString()
    };
  }
  try {
    const doFetch = fetchImpl || globalThis.fetch;
    const init = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        Accept: "application/json"
      }
    };
    const dispatcher = proxyDispatcher(proxyUrl);
    if (dispatcher) init.dispatcher = dispatcher;
    const resp = await doFetch("https://management-api.x.ai/auth/teams", init);
    const text = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        error: `teams ${resp.status}`,
        summary: `团队信息 ${resp.status}`,
        fetchedAt: new Date().toISOString()
      };
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    const team = Array.isArray(body?.teams) ? body.teams[0] : null;
    const tier = team?.tierId || team?.tier || "";
    const name = team?.name || "";
    return {
      ok: true,
      source: "xai-teams",
      planType: tier ? `tier-${tier}` : "xai",
      allowed: true,
      limitReached: false,
      primaryRemainingPercent: null,
      secondaryRemainingPercent: null,
      summary: tier
        ? `Grok ${name || "订阅"} · tier ${tier}（官方无剩余额度接口）`
        : "Grok 订阅有效（官方无剩余额度接口）",
      fetchedAt: new Date().toISOString(),
      error: ""
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      summary: "Grok 额度不可查",
      fetchedAt: new Date().toISOString()
    };
  }
}

export async function fetchAccountQuota(account, {
  poolKind = "xai_oauth",
  proxyUrl = "",
  fetchImpl
} = {}) {
  if (poolKind === "codex_oauth") {
    return fetchCodexAccountQuota(account, { proxyUrl, fetchImpl });
  }
  if (poolKind === "xai_oauth") {
    return fetchXaiAccountQuota(account, { proxyUrl, fetchImpl });
  }
  return {
    ok: false,
    error: "unsupported-pool-kind",
    summary: "该池暂不支持额度",
    fetchedAt: new Date().toISOString()
  };
}

function applyQuotaToAccount(account, quota) {
  return {
    ...account,
    planType: quota.planType || account.planType || "",
    quotaOk: quota.ok === true,
    quotaSummary: quota.summary || "",
    quotaError: quota.error || "",
    quotaFetchedAt: quota.fetchedAt || new Date().toISOString(),
    quotaPrimaryRemainingPercent: quota.primaryRemainingPercent ?? null,
    quotaSecondaryRemainingPercent: quota.secondaryRemainingPercent ?? null,
    quotaLimitReached: quota.limitReached === true,
    // 额度耗尽时标记冷却，避免继续选号
    ...(quota.limitReached
      ? {
          health: "cooldown",
          cooldownUntil: quota.primaryResetAt
            ? new Date(Number(quota.primaryResetAt) * 1000).toISOString()
            : new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          lastError: "usage_limit_reached"
        }
      : {})
  };
}

/**
 * 刷新单个账号额度（必要时先确保 access 有效）
 */
export async function refreshAccountQuota(provider, accountId, {
  home,
  fetchImpl,
  forceRefreshToken = false
} = {}) {
  const poolKind = poolKindOf(provider);
  const pool = loadPool(provider.id, { poolKind, home });
  const account = (pool.accounts || []).find((a) => a.id === accountId);
  if (!account) return { ok: false, error: "account-not-found" };

  let working = account;
  if (
    forceRefreshToken ||
    isAccessExpired(account, 60_000) ||
    !account.accessToken
  ) {
    const fresh = await ensureFreshAccount(account, {
      provider,
      proxyUrl: provider.proxyUrl,
      fetchImpl,
      home,
      force: forceRefreshToken
    });
    if (fresh.ok) working = fresh.account;
  }

  const quota = await fetchAccountQuota(working, {
    poolKind,
    proxyUrl: provider.proxyUrl,
    fetchImpl
  });
  const next = applyQuotaToAccount(working, quota);
  updateAccountRuntime(provider.id, accountId, {
    planType: next.planType,
    quotaOk: next.quotaOk,
    quotaSummary: next.quotaSummary,
    quotaError: next.quotaError,
    quotaFetchedAt: next.quotaFetchedAt,
    quotaPrimaryRemainingPercent: next.quotaPrimaryRemainingPercent,
    quotaSecondaryRemainingPercent: next.quotaSecondaryRemainingPercent,
    quotaLimitReached: next.quotaLimitReached,
    ...(quota.limitReached
      ? {
          health: next.health,
          cooldownUntil: next.cooldownUntil,
          lastError: next.lastError
        }
      : {})
  }, { poolKind, home });

  return {
    ok: quota.ok,
    accountId,
    email: next.email,
    quota
  };
}

/**
 * 批量刷新池内账号额度
 */
export async function refreshPoolQuotas(provider, {
  home,
  fetchImpl,
  accountIds = null,
  concurrency = 3
} = {}) {
  const poolKind = poolKindOf(provider);
  const pool = loadPool(provider.id, { poolKind, home });
  const targets = (pool.accounts || []).filter((a) => {
    if (accountIds?.length) return accountIds.includes(a.id);
    return a.enabled !== false;
  });
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const current = targets[idx++];
      try {
        const r = await refreshAccountQuota(provider, current.id, { home, fetchImpl });
        results.push(r);
      } catch (err) {
        results.push({
          ok: false,
          accountId: current.id,
          email: current.email,
          error: err?.message || String(err)
        });
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, targets.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  const updated = loadPool(provider.id, { poolKind, home });
  return {
    ok: true,
    total: targets.length,
    success: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
    pool: updated
  };
}

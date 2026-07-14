// OpenAI / ChatGPT Codex OAuth refresh（对齐 CLIProxyAPI / Codex CLI client）
import { ProxyAgent } from "undici";

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";

const PROXY_AGENTS = new Map();
const refreshInFlight = new Map();

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

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export function extractCodexAccountId(idToken, accessToken) {
  const fromId = decodeJwtPayload(idToken);
  const fromAccess = decodeJwtPayload(accessToken);
  const openaiAuth = fromId?.["https://api.openai.com/auth"] || fromAccess?.["https://api.openai.com/auth"] || {};
  return (
    openaiAuth.chatgpt_account_id ||
    fromId?.chatgpt_account_id ||
    fromAccess?.chatgpt_account_id ||
    fromId?.account_id ||
    fromAccess?.account_id ||
    ""
  );
}

export function extractEmailFromIdToken(idToken) {
  const payload = decodeJwtPayload(idToken);
  return String(payload.email || "").trim();
}

/**
 * 刷新 Codex / ChatGPT OAuth access_token（标准 refresh_token grant）
 */
export async function refreshCodexTokens(refreshToken, {
  proxyUrl = "",
  fetchImpl,
  clientId = CODEX_OAUTH_CLIENT_ID,
  tokenUrl = CODEX_TOKEN_URL
} = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("codex token refresh: refresh token is required");
  const key = `${tokenUrl}::${rt}`;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const task = (async () => {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: rt,
      scope: "openid profile email"
    });
    const doFetch = fetchImpl || globalThis.fetch;
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString()
    };
    const dispatcher = proxyDispatcher(proxyUrl);
    if (dispatcher) init.dispatcher = dispatcher;
    const resp = await doFetch(tokenUrl, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`codex token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("codex token refresh: invalid JSON");
    }
    if (!payload?.access_token) throw new Error("codex token refresh: missing access_token");
    const expiresIn = Number(payload.expires_in) || 3600;
    const idToken = String(payload.id_token || "").trim();
    const accessToken = String(payload.access_token).trim();
    return {
      accessToken,
      refreshToken: String(payload.refresh_token || rt).trim(),
      idToken,
      tokenType: String(payload.token_type || "Bearer").trim() || "Bearer",
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      accountId: extractCodexAccountId(idToken, accessToken),
      email: extractEmailFromIdToken(idToken)
    };
  })();

  refreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(key);
  }
}

export const CHATGPT_SESSION_URL = "https://chatgpt.com/api/auth/session";

/**
 * 用网页 session_token（__Secure-next-auth.session-token）换取新的 accessToken。
 * CPA 导出的 type:codex JSON 经常只有 session_token、没有 refresh_token。
 */
export async function refreshCodexViaSessionToken(sessionToken, {
  proxyUrl = "",
  fetchImpl,
  sessionUrl = CHATGPT_SESSION_URL
} = {}) {
  const st = String(sessionToken || "").trim();
  if (!st) throw new Error("codex session refresh: session_token is required");
  const key = `session::${st.slice(0, 48)}`;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const task = (async () => {
    const doFetch = fetchImpl || globalThis.fetch;
    const init = {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Cookie: `__Secure-next-auth.session-token=${st}`
      }
    };
    const dispatcher = proxyDispatcher(proxyUrl);
    if (dispatcher) init.dispatcher = dispatcher;
    const resp = await doFetch(sessionUrl, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`codex session refresh failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("codex session refresh: invalid JSON");
    }
    const accessToken = String(payload?.accessToken || payload?.access_token || "").trim();
    if (!accessToken) {
      throw new Error("codex session refresh: missing accessToken（session 可能已失效）");
    }
    const expiresRaw = payload?.expires || payload?.expiresAt || payload?.expired;
    let expiresAt = "";
    if (expiresRaw) {
      const ms = Date.parse(String(expiresRaw));
      if (!Number.isNaN(ms)) expiresAt = new Date(ms).toISOString();
    }
    if (!expiresAt) {
      const exp = decodeJwtPayload(accessToken)?.exp;
      if (exp) expiresAt = new Date(Number(exp) * 1000).toISOString();
    }
    if (!expiresAt) expiresAt = new Date(Date.now() + 3600_000).toISOString();

    const user = payload?.user || {};
    const account = payload?.account || {};
    return {
      accessToken,
      refreshToken: String(payload?.refreshToken || payload?.refresh_token || "").trim(),
      sessionToken: st,
      idToken: String(payload?.idToken || payload?.id_token || "").trim(),
      tokenType: "Bearer",
      expiresAt,
      accountId: String(
        account?.id ||
        payload?.account_id ||
        extractCodexAccountId("", accessToken) ||
        ""
      ).trim(),
      email: String(user?.email || payload?.email || extractEmailFromIdToken(payload?.idToken) || "").trim()
    };
  })();

  refreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(key);
  }
}

/**
 * 账号级刷新：优先 OAuth refresh_token，否则用 session_token。
 */
export async function refreshCodexAccountTokens(account, opts = {}) {
  if (account?.refreshToken) {
    return refreshCodexTokens(account.refreshToken, opts);
  }
  if (account?.sessionToken) {
    return refreshCodexViaSessionToken(account.sessionToken, opts);
  }
  throw new Error("codex token refresh: need refresh_token or session_token");
}

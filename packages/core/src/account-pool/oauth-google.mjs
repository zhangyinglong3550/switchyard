// Google OAuth refresh（Antigravity）
// 常规 CPA 导入会优先复用 ~/.cli-proxy-api 中已刷新的 access token，
// 不会走到这里，也不需要 OAuth client 配置。
// 仅当用户导入了脱离 CPA 的原始 refresh_token 时，才可用自管 OAuth client：
//   SWITCHYARD_ANTIGRAVITY_CLIENT_ID
//   SWITCHYARD_ANTIGRAVITY_CLIENT_SECRET
import { ProxyAgent } from "undici";

export const ANTIGRAVITY_CLIENT_ID = String(process.env.SWITCHYARD_ANTIGRAVITY_CLIENT_ID || "").trim();
export const ANTIGRAVITY_CLIENT_SECRET = String(process.env.SWITCHYARD_ANTIGRAVITY_CLIENT_SECRET || "").trim();
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const CLIPROXY_ANTIGRAVITY_AUTH_DIR_DEFAULT = "~/.cli-proxy-api";

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

/**
 * 刷新 Antigravity / Google OAuth access_token
 */
export async function refreshGoogleTokens(refreshToken, {
  proxyUrl = "",
  fetchImpl,
  clientId = ANTIGRAVITY_CLIENT_ID,
  clientSecret = ANTIGRAVITY_CLIENT_SECRET,
  tokenEndpoint = GOOGLE_TOKEN_ENDPOINT
} = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("google token refresh: refresh token is required");
  const cid = String(clientId || "").trim();
  const csec = String(clientSecret || "").trim();
  if (!cid || !csec) {
    throw new Error(
      "google token refresh: 本机 Antigravity 凭证未提供可用 access token。请先在 Antigravity / CLIProxyAPI 重新登录并刷新本机凭证；只有脱离本机凭证独立托管 refresh_token 时，才需要设置 SWITCHYARD_ANTIGRAVITY_CLIENT_ID / SWITCHYARD_ANTIGRAVITY_CLIENT_SECRET"
    );
  }
  const key = `${tokenEndpoint}::${rt}`;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const task = (async () => {
    const body = new URLSearchParams({
      client_id: cid,
      client_secret: csec,
      grant_type: "refresh_token",
      refresh_token: rt
    });
    const doFetch = fetchImpl || globalThis.fetch;
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Go-http-client/2.0"
      },
      body: body.toString()
    };
    const dispatcher = proxyDispatcher(proxyUrl);
    if (dispatcher) init.dispatcher = dispatcher;
    const resp = await doFetch(tokenEndpoint, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`google token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("google token refresh: invalid JSON");
    }
    if (!payload?.access_token) throw new Error("google token refresh: missing access_token");
    const expiresIn = Number(payload.expires_in) || 3600;
    return {
      accessToken: String(payload.access_token).trim(),
      refreshToken: String(payload.refresh_token || rt).trim(),
      tokenType: String(payload.token_type || "Bearer").trim() || "Bearer",
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString()
    };
  })();

  refreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(key);
  }
}

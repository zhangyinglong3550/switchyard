// xAI OAuth token refresh（对齐 CLIProxyAPI / Grok CLI public client）。
import { ProxyAgent } from "undici";

export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
export const XAI_API_BASE_URL = "https://api.x.ai/v1";

const refreshInFlight = new Map();
const PROXY_AGENTS = new Map();

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

export async function refreshXaiTokens(refreshToken, {
  tokenEndpoint = XAI_TOKEN_ENDPOINT,
  proxyUrl = "",
  fetchImpl,
  clientId = XAI_OAUTH_CLIENT_ID
} = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("xai token refresh: refresh token is required");
  const endpoint = String(tokenEndpoint || XAI_TOKEN_ENDPOINT).trim();
  const key = `${endpoint}::${rt}`;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const task = (async () => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rt
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
    const resp = await doFetch(endpoint, init);
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`xai token refresh failed: ${resp.status} ${text.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("xai token refresh: invalid JSON response");
    }
    if (!payload?.access_token) throw new Error("xai token refresh: missing access_token");
    const expiresIn = Number(payload.expires_in) || 21600;
    const identity = parseJwtIdentity(payload.id_token || "");
    return {
      accessToken: String(payload.access_token).trim(),
      refreshToken: String(payload.refresh_token || rt).trim(),
      idToken: String(payload.id_token || "").trim(),
      tokenType: String(payload.token_type || "Bearer").trim() || "Bearer",
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      email: identity.email,
      sub: identity.sub
    };
  })();

  refreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(key);
  }
}

function parseJwtIdentity(idToken) {
  const part = String(idToken || "").split(".")[1];
  if (!part) return { email: "", sub: "" };
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    return {
      email: String(payload.email || "").trim(),
      sub: String(payload.sub || "").trim()
    };
  } catch {
    return { email: "", sub: "" };
  }
}

// Upstream clients keyed by provider.apiFormat. Each function speaks the
// upstream-native wire format, so that callers can stay protocol-agnostic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import { ProxyAgent } from "undici";
import { safeJsonParse } from "../utils.mjs";
import { getProviderKeychainSecret, hasKeychainSecret } from "../keychain-store.mjs";
import { accountPoolReady, isAccountPoolProvider } from "../account-pool/index.mjs";

export const CODEX_OAUTH_CLIENT_VERSION = "1.0.0";
const PROXY_AGENTS = new Map();

try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

export function resolveApiKey(provider) {
  if (provider?.authMode === "none") return "";
  // 账号池在 dispatch 层绑定后会变成临时 api_key；未绑定前不在这里读池
  if (isAccountPoolProvider(provider) && !provider?.apiKey) return "";
  if (provider?.authMode === "keychain" || provider?.keychainAccount) return getProviderKeychainSecret(provider);
  if (provider?.apiKey) return provider.apiKey;
  if (provider?.apiKeyEnv) return process.env[provider.apiKeyEnv] || "";
  return "";
}

export function isCodexOAuthProvider(provider) {
  return provider?.authMode === "codex_oauth" ||
    provider?.authProvider === "codex_oauth" ||
    provider?.providerType === "codex_oauth";
}

export { isAccountPoolProvider };

export function codexAuthPath() {
  return path.join(os.homedir(), ".codex", "auth.json");
}

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function extractAccountId(auth, accessToken, provider) {
  const tokenPayload = decodeJwtPayload(accessToken);
  const openaiAuth = tokenPayload?.["https://api.openai.com/auth"];
  return provider?.codexAccountId ||
    provider?.accountId ||
    auth?.tokens?.account_id ||
    auth?.account_id ||
    openaiAuth?.chatgpt_account_id ||
    tokenPayload?.chatgpt_account_id ||
    tokenPayload?.account_id ||
    "";
}

export function readCodexOAuthAuth({ authFile = codexAuthPath(), provider = null } = {}) {
  // 账号池绑定的多 Codex 号：内存 token 优先
  if (provider?._codexAccessToken) {
    return {
      ok: true,
      authFile: "(account-pool)",
      accessToken: provider._codexAccessToken,
      accountId: provider._codexAccountId || provider.codexAccountId || provider.accountId || ""
    };
  }
  try {
    if (!fs.existsSync(authFile)) return { ok: false, reason: "missing-auth-file", authFile };
    const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
    const accessToken =
      auth?.tokens?.access_token ||
      auth?.access_token ||
      auth?.token ||
      auth?.credentials?.access_token ||
      "";
    if (!accessToken) return { ok: false, reason: "missing-access-token", authFile };
    return {
      ok: true,
      authFile,
      accessToken,
      accountId: extractAccountId(auth, accessToken, provider)
    };
  } catch (err) {
    return { ok: false, reason: err?.message || "invalid-auth-file", authFile };
  }
}

export function codexOAuthHeaders(provider) {
  const auth = readCodexOAuthAuth({ provider });
  if (!auth.ok) return {};
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0",
    ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {})
  };
}

export function providerAuthHeaders(provider, scheme) {
  if (isCodexOAuthProvider(provider)) return codexOAuthHeaders(provider);
  const key = resolveApiKey(provider);
  if (!key) return {};
  if (scheme === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { Authorization: `Bearer ${key}` };
}

function requestOverrideHeaders(opts) {
  const headers = opts?.requestHeaders;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return {};
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key || "").trim();
    if (!name || value == null) continue;
    out[name] = String(value);
  }
  return out;
}

/** 从 Codex App 入站请求提取应透传给上游的身份/协议头（对齐 CC Switch proxy 思路）。 */
export function extractForwardableClientHeaders(incoming = {}) {
  if (!incoming || typeof incoming !== "object") return {};
  const drop = new Set([
    "host", "connection", "content-length", "transfer-encoding", "keep-alive",
    "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
    // 请求体/协商类头必须由 Switchyard 自己写，避免覆盖上游 Content-Type 导致 xAI 等返回 415
    "content-type", "accept", "accept-encoding", "accept-language",
    "authorization", "x-api-key", "x-goog-api-key",
    "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto", "x-forwarded-for", "forwarded",
    "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "true-client-ip",
    "x-request-id", "x-correlation-id", "x-trace-id", "traceparent", "tracestate"
  ]);
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const key = String(rawKey || "").trim();
    if (!key || drop.has(key.toLowerCase())) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value == null || value === "") continue;
    out[key] = String(value);
  }
  return out;
}

export function buildOutboundAuthAndClientHeaders(provider, scheme, opts = {}) {
  const auth = providerAuthHeaders(provider, scheme);
  const overrides = requestOverrideHeaders(opts);
  const client = opts?.forwardClientHeaders === false
    ? {}
    : extractForwardableClientHeaders(opts?.incomingHeaders || opts?.clientHeaders || {});
  // 顺序：客户端身份头 → 供应商 auth（覆盖 dummy Authorization）→ requestOverrides
  return { ...client, ...auth, ...overrides };
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

export function canonicalProviderBaseUrl(provider) {
  const baseUrl = String(provider?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "opencode.ai" && path === "/zen/go" && (provider?.apiFormat || "openai_chat") !== "anthropic_messages") {
      url.pathname = "/zen/go/v1";
      return url.toString().replace(/\/+$/, "");
    }
    if ((provider?.apiFormat || "openai_chat") === "anthropic_messages" && path.endsWith("/v1")) {
      url.pathname = path.slice(0, -"/v1".length) || "/";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {}
  return baseUrl;
}

export function proxyDispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  const normalized = String(proxyUrl).trim();
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
  }
  if (!PROXY_AGENTS.has(normalized)) PROXY_AGENTS.set(normalized, new ProxyAgent(normalized));
  return PROXY_AGENTS.get(normalized);
}

function shouldRetryFetchError(err) {
  const code = err?.cause?.code || err?.code || "";
  return ["UND_ERR_SOCKET", "ECONNRESET", "EPIPE", "ETIMEDOUT", "HPE_INVALID_EOF_STATE"].includes(code) || /fetch failed|terminated|HPE_INVALID_EOF_STATE/i.test(err?.message || "");
}

async function postJson(url, body, headers, { signal, fetchImpl, proxyUrl, noKeepAlive = false, retryOnFetchError = false } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const requestHeaders = {
    "Content-Type": "application/json",
    Accept: body && body.stream ? "text/event-stream" : "application/json",
    "Accept-Encoding": "identity",
    ...headers
  };
  if (noKeepAlive) requestHeaders.Connection = "close";
  const init = {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(body),
    signal
  };
  const dispatcher = proxyDispatcher(proxyUrl);
  if (dispatcher) init.dispatcher = dispatcher;
  const attempts = retryOnFetchError ? 2 : 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await doFetch(url, init);
    } catch (err) {
      lastError = err;
      if (signal?.aborted || attempt >= attempts || !shouldRetryFetchError(err)) throw err;
    }
  }
  throw lastError;
}

export async function callOpenAIChat(provider, body, opts) {
  const url = joinUrl(canonicalProviderBaseUrl(provider), "/chat/completions");
  return postJson(url, body, buildOutboundAuthAndClientHeaders(provider, "bearer", opts), opts);
}

export async function callOpenAIResponses(provider, body, opts) {
  const url = joinUrl(canonicalProviderBaseUrl(provider), "/responses");
  const codexOAuth = isCodexOAuthProvider(provider);
  return postJson(url, body, buildOutboundAuthAndClientHeaders(provider, "bearer", opts), {
    ...opts,
    noKeepAlive: opts?.noKeepAlive ?? codexOAuth,
    retryOnFetchError: opts?.retryOnFetchError ?? codexOAuth
  });
}

export async function callAnthropicMessages(provider, body, opts) {
  const url = joinUrl(canonicalProviderBaseUrl(provider), "/v1/messages");
  return postJson(url, body, buildOutboundAuthAndClientHeaders(provider, "anthropic", opts), opts);
}

export function providerReady(provider) {
  if (!provider?.baseUrl) return false;
  if (isAccountPoolProvider(provider)) return accountPoolReady(provider);
  if (isCodexOAuthProvider(provider)) return readCodexOAuthAuth({ provider }).ok;
  if (provider.authMode === "none") return true;
  if (provider.authMode === "keychain" || provider.keychainAccount) return hasKeychainSecret(provider);
  if (provider.apiKey) return true;
  if (!provider.apiKeyEnv) return true;
  return Boolean(process.env[provider.apiKeyEnv]);
}

export async function readJsonResponse(res) {
  const text = await res.text();
  if (process.env.SWITCHYARD_DEBUG_RAW_UPSTREAM === "1") {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        status: res.status,
        url: res.url || "",
        bodyPreview: String(text || "").slice(0, 12000)
      });
      fs.appendFileSync(path.join(os.homedir(), "file", "codex", "switchyard-raw-upstream.log"), `${line}
`);
    } catch {}
  }
  return safeJsonParse(text, { error: text });
}

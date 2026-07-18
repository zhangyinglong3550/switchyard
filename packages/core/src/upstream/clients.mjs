// Upstream clients keyed by provider.apiFormat. Each function speaks the
// upstream-native wire format, so that callers can stay protocol-agnostic.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import { ProxyAgent } from "undici";
import { safeJsonParse } from "../utils.mjs";
import { getProviderKeychainSecret, hasKeychainSecret, keychainAccountForProvider } from "../keychain-store.mjs";
import { accountPoolReady, isAccountPoolProvider } from "../account-pool/index.mjs";
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_OAUTH_BETA,
  anthropicOAuthAuthPath,
  ensureAnthropicAccessToken,
  resolveAnthropicOAuthAuth
} from "../oauth-anthropic.mjs";
import {
  codexAuthPath as codexLocalAuthPath,
  ensureCodexLocalAccessToken,
  isAccessTokenUsable,
  readCodexLocalAuth,
  resolveAccessExpiresAt
} from "../oauth-codex-local.mjs";

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

export function isAnthropicOAuthProvider(provider) {
  return provider?.authMode === "anthropic_oauth" ||
    provider?.authProvider === "anthropic_oauth" ||
    provider?.providerType === "anthropic_oauth" ||
    provider?.presetId === "anthropic-oauth";
}

export { isAccountPoolProvider };

export function codexAuthPath() {
  return codexLocalAuthPath();
}

// ~/.codex/auth.json 读取缓存：按 mtime 失效，避免每次请求都同步读盘 + JSON.parse。
const codexAuthCache = new Map(); // authFile -> { mtimeMs, result }

export function resetCodexAuthCache() {
  codexAuthCache.clear();
}

/**
 * 读取本机 Codex OAuth。
 * ok=true 表示「有效登录」：access 未过期，或 access 过期但有 refresh_token 可续。
 * 请求头仍优先用 accessToken；若 access 已不可用，调用方应先 ensureCodexLocalAccessToken。
 */
export function readCodexOAuthAuth({ authFile = codexAuthPath(), provider = null } = {}) {
  // 账号池绑定的多 Codex 号：内存 token 优先（池子在 bind 时保证可用）
  if (provider?._codexAccessToken) {
    const accessToken = String(provider._codexAccessToken).trim();
    const expiresAt = String(provider._codexExpiresAt || "").trim();
    const accessUsable = isAccessTokenUsable(accessToken, { expiresAt });
    const refreshToken = String(provider._codexRefreshToken || "").trim();
    const valid = accessUsable || Boolean(refreshToken);
    return {
      ok: valid,
      reason: valid ? "" : "memory-token-unusable",
      authFile: "(account-pool)",
      source: "account-pool",
      accessToken,
      refreshToken,
      accountId: provider._codexAccountId || provider.codexAccountId || provider.accountId || "",
      email: provider._codexEmail || "",
      expiresAt: resolveAccessExpiresAt({ accessToken, expiresAt }),
      accessUsable,
      canRefresh: Boolean(refreshToken),
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken)
    };
  }

  const file = authFile || codexAuthPath();
  try {
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        reason: "missing-auth-file",
        authFile: file,
        accessUsable: false,
        canRefresh: false,
        hasAccessToken: false,
        hasRefreshToken: false
      };
    }
    const stat = fs.statSync(file);
    const mtimeMs = Number(stat.mtimeMs) || 0;
    const cached = codexAuthCache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) {
      return { ...cached.result };
    }
    const parsed = readCodexLocalAuth({ authFile: file, provider: null });
    // 不把 _raw 放进缓存副本，避免误用
    const { _raw, ...result } = parsed;
    codexAuthCache.set(file, { mtimeMs, result });
    return { ...result };
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || "invalid-auth-file",
      authFile: file,
      accessUsable: false,
      canRefresh: false,
      hasAccessToken: false,
      hasRefreshToken: false
    };
  }
}

export function codexOAuthHeaders(provider) {
  const auth = readCodexOAuthAuth({ provider });
  // 发请求需要可用的 access；仅有 refresh 时先不带头（dispatch 侧应 ensure）
  if (!auth.accessToken) return {};
  if (!auth.accessUsable && !auth.ok) return {};
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.0.0",
    ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {})
  };
}

export { ensureCodexLocalAccessToken };

export function readAnthropicOAuthAuth({ provider = null, authFile } = {}) {
  return resolveAnthropicOAuthAuth({ provider, authFile });
}

/**
 * 同步读取当前磁盘上的 Anthropic OAuth token（可能已过期）。
 * 异步刷新请用 ensureAnthropicAccessToken。
 */
export function anthropicOAuthHeaders(provider) {
  const auth = readAnthropicOAuthAuth({ provider });
  if (!auth.ok || !auth.accessToken) return {};
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "anthropic-version": ANTHROPIC_API_VERSION,
    "anthropic-beta": ANTHROPIC_OAUTH_BETA,
    "User-Agent": "claude-cli/2.0.0 (external, switchyard)"
  };
}

export { ensureAnthropicAccessToken, anthropicOAuthAuthPath };

export function providerAuthHeaders(provider, scheme) {
  if (isCodexOAuthProvider(provider)) return codexOAuthHeaders(provider);
  if (isAnthropicOAuthProvider(provider)) return anthropicOAuthHeaders(provider);
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
    "cookie", "set-cookie",
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
  // 本机 codex_oauth：发请求前尽量保证 access 未过期（可 refresh 时回写 auth.json）
  if (codexOAuth && !provider._codexAccessToken) {
    try {
      const ensured = await ensureCodexLocalAccessToken({
        provider,
        proxyUrl: provider.proxyUrl || opts?.proxyUrl || "",
        fetchImpl: opts?.fetchImpl
      });
      if (ensured.ok && ensured.accessToken) {
        provider = {
          ...provider,
          _codexAccessToken: ensured.accessToken,
          _codexRefreshToken: ensured.refreshToken || "",
          _codexAccountId: ensured.accountId || "",
          _codexEmail: ensured.email || "",
          _codexExpiresAt: ensured.expiresAt || ""
        };
        if (ensured.refreshed) resetCodexAuthCache();
      }
    } catch {
      // 刷新失败时仍用磁盘 access 尝试一次
    }
  }
  return postJson(url, body, buildOutboundAuthAndClientHeaders(provider, "bearer", opts), {
    ...opts,
    noKeepAlive: opts?.noKeepAlive ?? codexOAuth,
    retryOnFetchError: opts?.retryOnFetchError ?? codexOAuth
  });
}

export async function callAnthropicMessages(provider, body, opts) {
  const url = joinUrl(canonicalProviderBaseUrl(provider), "/v1/messages");
  // OAuth 在真正发请求前尽量刷新 access token，避免 401
  if (isAnthropicOAuthProvider(provider) && !provider._anthropicAccessToken) {
    try {
      const ensured = await ensureAnthropicAccessToken({
        provider,
        proxyUrl: provider.proxyUrl || opts?.proxyUrl || "",
        fetchImpl: opts?.fetchImpl
      });
      if (ensured.ok && ensured.accessToken) {
        provider = {
          ...provider,
          _anthropicAccessToken: ensured.accessToken,
          _anthropicEmail: ensured.email || "",
          _anthropicAccountId: ensured.accountId || ""
        };
      }
    } catch {
      // 刷新失败时仍用磁盘上的 access token 尝试一次
    }
  }
  return postJson(url, body, buildOutboundAuthAndClientHeaders(provider, "anthropic", opts), opts);
}

export function providerReady(provider) {
  if (!provider?.baseUrl) return false;
  if (isAccountPoolProvider(provider)) return accountPoolReady(provider);
  if (isCodexOAuthProvider(provider)) {
    // 有效登录：access 可用，或 access 过期但有 refresh 可续
    const auth = readCodexOAuthAuth({ provider });
    return Boolean(auth.ok && (auth.accessUsable || auth.canRefresh || auth.hasRefreshToken));
  }
  if (isAnthropicOAuthProvider(provider)) {
    const auth = readAnthropicOAuthAuth({ provider });
    return Boolean(auth.ok && (auth.accessToken || auth.refreshToken));
  }
  if (provider.authMode === "none") return true;
  if (provider.authMode === "keychain" || provider.keychainAccount) return hasKeychainSecret(keychainAccountForProvider(provider));
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
          .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1<redacted>")
          .replace(/(sk-)[A-Za-z0-9_\-]{8,}/g, "$1<redacted>")
      });
      fs.appendFileSync(path.join(os.homedir(), "file", "codex", "switchyard-raw-upstream.log"), `${line}
`);
    } catch {}
  }
  return safeJsonParse(text, { error: text });
}

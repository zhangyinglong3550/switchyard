// Anthropic / Claude 官方 OAuth（对齐 CLIProxyAPI / Claude Code public client）
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ProxyAgent } from "undici";

export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_OAUTH_AUTH_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_REDIRECT_URI = "http://localhost:54545/callback";
export const ANTHROPIC_OAUTH_CALLBACK_PORT = 54545;
export const ANTHROPIC_OAUTH_SCOPES =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
export const ANTHROPIC_API_VERSION = "2023-06-01";

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

export function anthropicOAuthAuthPath(providerId = "") {
  const dir = path.join(os.homedir(), ".switchyard", "oauth");
  const id = String(providerId || "").trim();
  if (id && id !== "anthropic" && id !== "anthropic-oauth") {
    return path.join(dir, `anthropic-${id}.json`);
  }
  return path.join(dir, "anthropic.json");
}

export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateOAuthState() {
  return crypto.randomBytes(16).toString("hex");
}

export function buildAnthropicAuthUrl({ state, codeChallenge, redirectUri = ANTHROPIC_OAUTH_REDIRECT_URI } = {}) {
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: ANTHROPIC_OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: state || ""
  });
  return `${ANTHROPIC_OAUTH_AUTH_URL}?${params.toString()}`;
}

function parseCodeAndState(rawCode) {
  const text = String(rawCode || "");
  const splits = text.split("#");
  return {
    code: splits[0] || "",
    stateFromCode: splits[1] || ""
  };
}

async function postTokenJson(body, { proxyUrl = "", fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  };
  const dispatcher = proxyDispatcher(proxyUrl);
  if (dispatcher) init.dispatcher = dispatcher;
  const resp = await doFetch(ANTHROPIC_OAUTH_TOKEN_URL, init);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`anthropic oauth token failed: ${resp.status} ${text.slice(0, 400)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("anthropic oauth token: invalid JSON");
  }
  if (!payload?.access_token) throw new Error("anthropic oauth token: missing access_token");
  const expiresIn = Number(payload.expires_in) || 3600;
  return {
    accessToken: String(payload.access_token).trim(),
    refreshToken: String(payload.refresh_token || body.refresh_token || "").trim(),
    tokenType: String(payload.token_type || "Bearer").trim() || "Bearer",
    expiresIn,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    email: String(payload.account?.email_address || "").trim(),
    accountId: String(payload.account?.uuid || "").trim(),
    organizationId: String(payload.organization?.uuid || "").trim(),
    organizationName: String(payload.organization?.name || "").trim()
  };
}

export async function exchangeAnthropicCode({
  code,
  state = "",
  codeVerifier,
  redirectUri = ANTHROPIC_OAUTH_REDIRECT_URI,
  proxyUrl = "",
  fetchImpl
} = {}) {
  const parsed = parseCodeAndState(code);
  const body = {
    grant_type: "authorization_code",
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    code: parsed.code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  };
  const effectiveState = parsed.stateFromCode || state;
  if (effectiveState) body.state = effectiveState;
  return postTokenJson(body, { proxyUrl, fetchImpl });
}

export async function refreshAnthropicTokens(refreshToken, { proxyUrl = "", fetchImpl } = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("anthropic token refresh: refresh token is required");
  if (refreshInFlight.has(rt)) return refreshInFlight.get(rt);

  const task = (async () => {
    return postTokenJson(
      {
        client_id: ANTHROPIC_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: rt
      },
      { proxyUrl, fetchImpl }
    );
  })();

  refreshInFlight.set(rt, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(rt);
  }
}

export function ensureOAuthDir() {
  const dir = path.join(os.homedir(), ".switchyard", "oauth");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readAnthropicOAuthFile(filePath = anthropicOAuthAuthPath()) {
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: "missing-auth-file", authFile: filePath };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const accessToken =
      raw?.access_token ||
      raw?.accessToken ||
      raw?.tokens?.access_token ||
      raw?.token_data?.access_token ||
      "";
    const refreshToken =
      raw?.refresh_token ||
      raw?.refreshToken ||
      raw?.tokens?.refresh_token ||
      raw?.token_data?.refresh_token ||
      "";
    if (!accessToken && !refreshToken) {
      return { ok: false, reason: "missing-tokens", authFile: filePath };
    }
    return {
      ok: true,
      authFile: filePath,
      accessToken: String(accessToken || "").trim(),
      refreshToken: String(refreshToken || "").trim(),
      expiresAt: String(raw?.expires_at || raw?.expiresAt || raw?.expire || raw?.token_data?.expired || "").trim(),
      email: String(raw?.email || raw?.account?.email_address || raw?.token_data?.email || "").trim(),
      accountId: String(raw?.account_id || raw?.accountId || raw?.account?.uuid || "").trim(),
      organizationId: String(raw?.organization_id || raw?.organizationId || "").trim(),
      updatedAt: String(raw?.updated_at || raw?.last_refresh || "").trim()
    };
  } catch (err) {
    return { ok: false, reason: err?.message || "invalid-auth-file", authFile: filePath };
  }
}

export function writeAnthropicOAuthFile(tokens, filePath = anthropicOAuthAuthPath()) {
  ensureOAuthDir();
  const payload = {
    access_token: tokens.accessToken || tokens.access_token || "",
    refresh_token: tokens.refreshToken || tokens.refresh_token || "",
    expires_at: tokens.expiresAt || tokens.expires_at || "",
    email: tokens.email || "",
    account_id: tokens.accountId || tokens.account_id || "",
    organization_id: tokens.organizationId || tokens.organization_id || "",
    organization_name: tokens.organizationName || tokens.organization_name || "",
    token_type: tokens.tokenType || tokens.token_type || "Bearer",
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return { ok: true, authFile: filePath, email: payload.email, expiresAt: payload.expires_at };
}

export function clearAnthropicOAuthFile(filePath = anthropicOAuthAuthPath()) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true, authFile: filePath };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), authFile: filePath };
  }
}

function tokenNearExpiry(expiresAt, skewMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now() + skewMs;
}

/**
 * 读取可用 access token；必要时用 refresh_token 刷新并回写。
 */
export async function ensureAnthropicAccessToken({
  provider = null,
  authFile,
  proxyUrl = "",
  fetchImpl,
  forceRefresh = false
} = {}) {
  if (provider?._anthropicAccessToken) {
    return {
      ok: true,
      accessToken: provider._anthropicAccessToken,
      email: provider._anthropicEmail || "",
      accountId: provider._anthropicAccountId || "",
      authFile: "(memory)"
    };
  }
  const file = authFile || anthropicOAuthAuthPath(provider?.id || provider?.anthropicOAuthFile || "");
  const current = readAnthropicOAuthFile(file);
  if (!current.ok) return current;

  const needsRefresh = forceRefresh || !current.accessToken || tokenNearExpiry(current.expiresAt);
  if (!needsRefresh) {
    return {
      ok: true,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      email: current.email,
      accountId: current.accountId,
      expiresAt: current.expiresAt,
      authFile: file
    };
  }
  if (!current.refreshToken) {
    return { ok: false, reason: "missing-refresh-token", authFile: file };
  }
  try {
    const refreshed = await refreshAnthropicTokens(current.refreshToken, {
      proxyUrl: proxyUrl || provider?.proxyUrl || "",
      fetchImpl
    });
    const merged = {
      ...refreshed,
      email: refreshed.email || current.email,
      accountId: refreshed.accountId || current.accountId
    };
    writeAnthropicOAuthFile(merged, file);
    return {
      ok: true,
      accessToken: merged.accessToken,
      refreshToken: merged.refreshToken,
      email: merged.email,
      accountId: merged.accountId,
      expiresAt: merged.expiresAt,
      authFile: file,
      refreshed: true
    };
  } catch (err) {
    if (current.accessToken && !forceRefresh) {
      return {
        ok: true,
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        email: current.email,
        accountId: current.accountId,
        expiresAt: current.expiresAt,
        authFile: file,
        refreshError: err?.message || String(err)
      };
    }
    return { ok: false, reason: err?.message || "refresh-failed", authFile: file };
  }
}

/**
 * 本地起临时 callback server，完成浏览器 OAuth 登录。
 * @returns {Promise<{ok:boolean, authFile?:string, email?:string, error?:string, authUrl?:string}>}
 */
export async function runAnthropicOAuthLogin({
  openUrl,
  proxyUrl = "",
  authFile = anthropicOAuthAuthPath(),
  timeoutMs = 5 * 60 * 1000,
  port = ANTHROPIC_OAUTH_CALLBACK_PORT,
  redirectUri = ANTHROPIC_OAUTH_REDIRECT_URI
} = {}) {
  const pkce = generatePKCE();
  const state = generateOAuthState();
  const authUrl = buildAnthropicAuthUrl({
    state,
    codeChallenge: pkce.challenge,
    redirectUri
  });

  return new Promise((resolve) => {
    let settled = false;
    let server;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        server?.close();
      } catch {}
      resolve(result);
    };

    server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body><h2>授权失败</h2><p>${error}</p><p>可关闭此页返回 Switchyard。</p></body></html>`);
          finish({ ok: false, error: error || "oauth_error", authUrl });
          return;
        }
        const code = url.searchParams.get("code") || "";
        const returnedState = url.searchParams.get("state") || "";
        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body><h2>缺少 authorization code</h2></body></html>");
          finish({ ok: false, error: "missing_code", authUrl });
          return;
        }
        if (returnedState && returnedState !== state) {
          // code 可能以 code#state 形式回到 code 参数
        }
        const tokens = await exchangeAnthropicCode({
          code,
          state: returnedState || state,
          codeVerifier: pkce.verifier,
          redirectUri,
          proxyUrl
        });
        writeAnthropicOAuthFile(tokens, authFile);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<html><body style="font-family:system-ui;padding:32px">
            <h2>Claude 登录成功</h2>
            <p>${tokens.email ? `账号：${tokens.email}` : "已获取 OAuth 令牌"}</p>
            <p>可关闭此页，返回 Switchyard 继续。</p>
          </body></html>`
        );
        finish({
          ok: true,
          authFile,
          email: tokens.email,
          expiresAt: tokens.expiresAt,
          accountId: tokens.accountId,
          authUrl
        });
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h2>换取令牌失败</h2><pre>${String(err?.message || err)}</pre></body></html>`);
        finish({ ok: false, error: err?.message || String(err), authUrl });
      }
    });

    server.on("error", (err) => {
      finish({
        ok: false,
        error: `无法监听 ${port}：${err?.message || err}。请确认端口未被占用后重试。`,
        authUrl
      });
    });

    server.listen(port, "127.0.0.1", () => {
      timer = setTimeout(() => {
        finish({ ok: false, error: "登录超时（5 分钟），请重试", authUrl });
      }, timeoutMs);
      timer.unref?.();
      try {
        if (typeof openUrl === "function") openUrl(authUrl);
      } catch (err) {
        finish({ ok: false, error: err?.message || String(err), authUrl });
      }
    });
  });
}

export function anthropicOAuthStatus(provider = null) {
  const file = anthropicOAuthAuthPath(provider?.id || "");
  const auth = readAnthropicOAuthFile(file);
  if (!auth.ok) {
    // 回退默认 anthropic.json
    const fallback = readAnthropicOAuthFile(anthropicOAuthAuthPath());
    if (!fallback.ok) return { ok: false, loggedIn: false, authFile: file, reason: auth.reason };
    return {
      ok: true,
      loggedIn: Boolean(fallback.accessToken || fallback.refreshToken),
      email: fallback.email,
      expiresAt: fallback.expiresAt,
      authFile: fallback.authFile
    };
  }
  return {
    ok: true,
    loggedIn: Boolean(auth.accessToken || auth.refreshToken),
    email: auth.email,
    expiresAt: auth.expiresAt,
    authFile: auth.authFile
  };
}

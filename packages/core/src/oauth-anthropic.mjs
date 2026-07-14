// Anthropic / Claude 官方 OAuth
// 主路径对齐 CC Switch：复用本机 Claude Code 登录态
//   1) macOS Keychain service "Claude Code-credentials"
//   2) ~/.claude/.credentials.json  → claudeAiOauth / claude.ai_oauth
// 辅路径：Switchyard 自管 ~/.switchyard/oauth/ + 可选浏览器 PKCE 登录
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
export const CLAUDE_CODE_KEYCHAIN_SERVICE = "Claude Code-credentials";

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

/** Claude Code 凭据文件（CC Switch 同源） */
export function claudeCredentialsPath() {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

export function anthropicOAuthAuthPath(providerId = "") {
  const dir = path.join(os.homedir(), ".switchyard", "oauth");
  const id = String(providerId || "").trim();
  if (id && id !== "anthropic" && id !== "anthropic-oauth") {
    return path.join(dir, `anthropic-${id}.json`);
  }
  return path.join(dir, "anthropic.json");
}

/**
 * 归一化 expiresAt：支持 Unix 秒/毫秒数字、ISO 字符串
 * @returns {string} ISO 字符串，无法解析时返回 ""
 */
export function normalizeExpiresAt(expiresAt) {
  if (expiresAt == null || expiresAt === "") return "";
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    const ms = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
    return new Date(ms).toISOString();
  }
  const s = String(expiresAt).trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    const ms = n > 1e12 ? n : n * 1000;
    return new Date(ms).toISOString();
  }
  const ts = Date.parse(s);
  if (Number.isFinite(ts)) return new Date(ts).toISOString();
  return s;
}

/**
 * 解析 Claude Code 凭据 JSON（Keychain 与文件共用）。
 * 对齐 CC Switch subscription.rs：claudeAiOauth / claude.ai_oauth
 */
export function parseClaudeCredentialsJson(content, source = "file") {
  let parsed;
  try {
    parsed = JSON.parse(String(content || ""));
  } catch (err) {
    return { ok: false, reason: `invalid-json: ${err?.message || err}`, source };
  }
  const entry =
    parsed?.claudeAiOauth ||
    parsed?.["claude.ai_oauth"] ||
    parsed?.claude_ai_oauth ||
    null;
  if (!entry || typeof entry !== "object") {
    return { ok: false, reason: "missing-claudeAiOauth", source };
  }
  const accessToken = String(
    entry.accessToken || entry.access_token || entry.token || ""
  ).trim();
  const refreshToken = String(
    entry.refreshToken || entry.refresh_token || ""
  ).trim();
  if (!accessToken && !refreshToken) {
    return { ok: false, reason: "missing-tokens", source };
  }
  const expiresAt = normalizeExpiresAt(entry.expiresAt ?? entry.expires_at ?? entry.expire ?? "");
  return {
    ok: true,
    source,
    authFile: source,
    accessToken,
    refreshToken,
    expiresAt,
    email: String(entry.emailAddress || entry.email || entry.accountEmailAddress || "").trim(),
    accountId: String(entry.accountUuid || entry.accountId || entry.account_uuid || "").trim(),
    organizationId: String(entry.organizationUuid || entry.organizationId || "").trim(),
    subscriptionType: String(entry.subscriptionType || entry.subscription_type || "").trim()
  };
}

function readClaudeCredentialsFromKeychain() {
  if (process.platform !== "darwin") return null;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", CLAUDE_CODE_KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
    );
    const json = String(out || "").trim();
    if (!json) return null;
    const parsed = parseClaudeCredentialsJson(json, "claude-code-keychain");
    return parsed.ok ? parsed : null;
  } catch {
    return null;
  }
}

function readClaudeCredentialsFromFile(filePath = claudeCredentialsPath()) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: "missing-auth-file", source: "claude-code-file", authFile: filePath };
    }
    const content = fs.readFileSync(filePath, "utf8");
    const parsed = parseClaudeCredentialsJson(content, "claude-code-file");
    if (!parsed.ok) return { ...parsed, authFile: filePath };
    return { ...parsed, authFile: filePath };
  } catch (err) {
    return { ok: false, reason: err?.message || "read-failed", source: "claude-code-file", authFile: filePath };
  }
}

/**
 * 读取 Claude Code 官方登录态（CC Switch 同序：Keychain → 文件）
 */
export function readClaudeCodeCredentials() {
  const fromKeychain = readClaudeCredentialsFromKeychain();
  if (fromKeychain?.ok) return fromKeychain;
  return readClaudeCredentialsFromFile();
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
    if (!fs.existsSync(filePath)) return { ok: false, reason: "missing-auth-file", authFile: filePath, source: "switchyard" };
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // 兼容 Claude Code 形状（若用户直接复制了 .credentials.json）
    if (raw?.claudeAiOauth || raw?.["claude.ai_oauth"]) {
      const parsed = parseClaudeCredentialsJson(JSON.stringify(raw), "switchyard-claude-shape");
      if (parsed.ok) return { ...parsed, authFile: filePath, source: "switchyard" };
    }
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
      return { ok: false, reason: "missing-tokens", authFile: filePath, source: "switchyard" };
    }
    return {
      ok: true,
      source: "switchyard",
      authFile: filePath,
      accessToken: String(accessToken || "").trim(),
      refreshToken: String(refreshToken || "").trim(),
      expiresAt: normalizeExpiresAt(raw?.expires_at || raw?.expiresAt || raw?.expire || raw?.token_data?.expired || ""),
      email: String(raw?.email || raw?.account?.email_address || raw?.token_data?.email || "").trim(),
      accountId: String(raw?.account_id || raw?.accountId || raw?.account?.uuid || "").trim(),
      organizationId: String(raw?.organization_id || raw?.organizationId || "").trim(),
      updatedAt: String(raw?.updated_at || raw?.last_refresh || "").trim()
    };
  } catch (err) {
    return { ok: false, reason: err?.message || "invalid-auth-file", authFile: filePath, source: "switchyard" };
  }
}

/**
 * 解析 Anthropic OAuth 凭证（优先级对齐 CC Switch + 本地扩展）
 * 1. provider 内存绑定
 * 2. Claude Code Keychain / ~/.claude/.credentials.json
 * 3. Switchyard 自管 oauth 文件
 */
export function resolveAnthropicOAuthAuth({ provider = null, authFile } = {}) {
  if (provider?._anthropicAccessToken) {
    return {
      ok: true,
      source: "memory",
      authFile: "(memory)",
      accessToken: provider._anthropicAccessToken,
      refreshToken: provider._anthropicRefreshToken || "",
      email: provider._anthropicEmail || "",
      accountId: provider._anthropicAccountId || "",
      expiresAt: provider._anthropicExpiresAt || ""
    };
  }
  const claude = readClaudeCodeCredentials();
  if (claude.ok && (claude.accessToken || claude.refreshToken)) {
    return claude;
  }
  const file = authFile || anthropicOAuthAuthPath(provider?.id || "");
  let auth = readAnthropicOAuthFile(file);
  if (!auth.ok && file !== anthropicOAuthAuthPath()) {
    auth = readAnthropicOAuthFile(anthropicOAuthAuthPath());
  }
  if (auth.ok) return auth;
  // 两者都失败时，保留 Claude 侧原因便于 UI 提示
  return {
    ok: false,
    reason: claude.reason || auth.reason || "missing-credentials",
    source: claude.source || auth.source || "none",
    authFile: claude.authFile || auth.authFile || claudeCredentialsPath(),
    claudeReason: claude.reason,
    switchyardReason: auth.reason
  };
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
  const iso = normalizeExpiresAt(expiresAt);
  const ts = Date.parse(iso || expiresAt);
  if (!Number.isFinite(ts)) return false;
  return ts <= Date.now() + skewMs;
}

/**
 * 读取可用 access token；必要时用 refresh_token 刷新。
 * - Claude Code 凭据：只读，刷新后缓存到 Switchyard oauth 文件（不改 Claude 原文件）
 * - Switchyard 自管：刷新后回写
 */
export async function ensureAnthropicAccessToken({
  provider = null,
  authFile,
  proxyUrl = "",
  fetchImpl,
  forceRefresh = false
} = {}) {
  if (provider?._anthropicAccessToken && !forceRefresh) {
    return {
      ok: true,
      source: "memory",
      accessToken: provider._anthropicAccessToken,
      email: provider._anthropicEmail || "",
      accountId: provider._anthropicAccountId || "",
      authFile: "(memory)"
    };
  }
  const current = resolveAnthropicOAuthAuth({ provider, authFile });
  if (!current.ok) return current;

  const needsRefresh = forceRefresh || !current.accessToken || tokenNearExpiry(current.expiresAt);
  if (!needsRefresh) {
    return {
      ok: true,
      source: current.source,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      email: current.email,
      accountId: current.accountId,
      expiresAt: current.expiresAt,
      authFile: current.authFile
    };
  }
  if (!current.refreshToken) {
    // 无 refresh 时仍尝试用现有 access（与 CC Switch 行为一致）
    if (current.accessToken && !forceRefresh) {
      return {
        ok: true,
        source: current.source,
        accessToken: current.accessToken,
        email: current.email,
        accountId: current.accountId,
        expiresAt: current.expiresAt,
        authFile: current.authFile,
        stale: true
      };
    }
    return { ok: false, reason: "missing-refresh-token", source: current.source, authFile: current.authFile };
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
    // 回写 Switchyard 缓存；不修改 Claude Code Keychain/原文件
    const cacheFile = authFile || anthropicOAuthAuthPath(provider?.id || "");
    writeAnthropicOAuthFile(merged, cacheFile);
    return {
      ok: true,
      source: current.source?.startsWith("claude-code") ? "claude-code-refreshed" : "switchyard",
      accessToken: merged.accessToken,
      refreshToken: merged.refreshToken,
      email: merged.email,
      accountId: merged.accountId,
      expiresAt: merged.expiresAt,
      authFile: cacheFile,
      refreshed: true
    };
  } catch (err) {
    if (current.accessToken && !forceRefresh) {
      return {
        ok: true,
        source: current.source,
        accessToken: current.accessToken,
        refreshToken: current.refreshToken,
        email: current.email,
        accountId: current.accountId,
        expiresAt: current.expiresAt,
        authFile: current.authFile,
        refreshError: err?.message || String(err)
      };
    }
    return { ok: false, reason: err?.message || "refresh-failed", source: current.source, authFile: current.authFile };
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

const SOURCE_LABEL = {
  "claude-code-keychain": "Claude Code · Keychain",
  "claude-code-file": "Claude Code · ~/.claude/.credentials.json",
  "claude-code-refreshed": "Claude Code（已刷新缓存）",
  switchyard: "Switchyard 自管 OAuth",
  "switchyard-claude-shape": "Switchyard OAuth",
  memory: "内存"
};

export function anthropicOAuthStatus(provider = null) {
  const auth = resolveAnthropicOAuthAuth({ provider });
  if (!auth.ok) {
    return {
      ok: false,
      loggedIn: false,
      reason: auth.reason,
      authFile: auth.authFile || claudeCredentialsPath(),
      source: auth.source || "none",
      hint: "请先在本机完成 Claude Code 登录（终端执行 claude / 按提示登录），或使用下方高级选项浏览器授权。"
    };
  }
  return {
    ok: true,
    loggedIn: Boolean(auth.accessToken || auth.refreshToken),
    email: auth.email,
    expiresAt: auth.expiresAt,
    accountId: auth.accountId,
    subscriptionType: auth.subscriptionType || "",
    authFile: auth.authFile,
    source: auth.source,
    sourceLabel: SOURCE_LABEL[auth.source] || auth.source || "",
    hasAccessToken: Boolean(auth.accessToken),
    hasRefreshToken: Boolean(auth.refreshToken)
  };
}

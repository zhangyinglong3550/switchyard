// 本机 Codex / ChatGPT OAuth（~/.codex/auth.json）
// 有效登录 = 有可用 access_token（未过期）或 有可续期 refresh_token（必要时可换新 access）
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractCodexAccountId,
  extractEmailFromIdToken,
  refreshCodexTokens
} from "./account-pool/oauth-codex.mjs";

export const CODEX_AUTH_SKEW_MS = 5 * 60 * 1000;
const refreshInFlight = new Map();

export function codexAuthPath(home = os.homedir()) {
  return path.join(home, ".codex", "auth.json");
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

/** 从 JWT exp / 显式 expires 字段解析过期时间（ISO） */
export function resolveAccessExpiresAt({ accessToken = "", expiresAt = "", auth = null } = {}) {
  if (expiresAt) {
    const ms = Date.parse(String(expiresAt));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const fromAuth =
    auth?.tokens?.expires_at ||
    auth?.tokens?.expiresAt ||
    auth?.expires_at ||
    auth?.expiresAt ||
    "";
  if (fromAuth) {
    const ms = Date.parse(String(fromAuth));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const exp = decodeJwtPayload(accessToken)?.exp;
  if (exp && Number.isFinite(Number(exp))) {
    return new Date(Number(exp) * 1000).toISOString();
  }
  return "";
}

export function isAccessTokenUsable(accessToken, {
  expiresAt = "",
  skewMs = CODEX_AUTH_SKEW_MS,
  now = Date.now()
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) return false;
  const iso = resolveAccessExpiresAt({ accessToken: token, expiresAt });
  if (!iso) {
    // 无 exp 信息时，只要 token 非空就先视为可用（后续请求失败再刷新）
    // 账号池/单测可能是短占位 token，不能按长度硬砍
    return true;
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return true;
  return now + skewMs < ms;
}

/**
 * 解析 ~/.codex/auth.json（或兼容形态），不碰明文外泄：调用方勿把 token 打日志。
 */
export function parseCodexAuthJson(raw, { authFile = "", source = "codex-auth-json" } = {}) {
  let auth = raw;
  if (typeof raw === "string") {
    try {
      auth = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: `invalid-json: ${err?.message || err}`, authFile, source };
    }
  }
  if (!auth || typeof auth !== "object") {
    return { ok: false, reason: "invalid-auth-shape", authFile, source };
  }

  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {};
  const accessToken = String(
    tokens.access_token ||
    tokens.accessToken ||
    auth.access_token ||
    auth.accessToken ||
    auth.token ||
    auth.credentials?.access_token ||
    ""
  ).trim();
  const refreshToken = String(
    tokens.refresh_token ||
    tokens.refreshToken ||
    auth.refresh_token ||
    auth.refreshToken ||
    auth.credentials?.refresh_token ||
    ""
  ).trim();
  const idToken = String(
    tokens.id_token ||
    tokens.idToken ||
    auth.id_token ||
    auth.idToken ||
    ""
  ).trim();
  const sessionToken = String(
    tokens.session_token ||
    tokens.sessionToken ||
    auth.session_token ||
    auth.sessionToken ||
    ""
  ).trim();

  if (!accessToken && !refreshToken && !sessionToken) {
    return { ok: false, reason: "missing-tokens", authFile, source };
  }

  const expiresAt = resolveAccessExpiresAt({
    accessToken,
    expiresAt: tokens.expires_at || tokens.expiresAt || auth.expires_at || auth.expiresAt || "",
    auth
  });
  const accountId = String(
    tokens.account_id ||
    tokens.accountId ||
    auth.account_id ||
    auth.accountId ||
    extractCodexAccountId(idToken, accessToken) ||
    ""
  ).trim();
  const email = String(
    auth.email ||
    extractEmailFromIdToken(idToken) ||
    decodeJwtPayload(accessToken)?.email ||
    ""
  ).trim();
  const accessUsable = isAccessTokenUsable(accessToken, { expiresAt });
  const canRefresh = Boolean(refreshToken);
  const valid = accessUsable || canRefresh;

  return {
    ok: valid,
    reason: valid ? "" : (accessToken ? "access-expired-no-refresh" : "missing-usable-credentials"),
    source,
    authFile,
    authMode: String(auth.auth_mode || auth.authMode || "").trim(),
    accessToken,
    refreshToken,
    idToken,
    sessionToken,
    accountId,
    email,
    expiresAt,
    lastRefresh: String(auth.last_refresh || auth.lastRefresh || auth.updated_at || "").trim(),
    accessUsable,
    canRefresh,
    hasAccessToken: Boolean(accessToken),
    hasRefreshToken: Boolean(refreshToken),
    hasSessionToken: Boolean(sessionToken),
    // 原始对象仅内部写回用，不导出到 UI
    _raw: auth
  };
}

export function readCodexLocalAuth({
  authFile,
  provider = null,
  home
} = {}) {
  if (provider?._codexAccessToken) {
    const accessToken = String(provider._codexAccessToken).trim();
    const expiresAt = String(provider._codexExpiresAt || "").trim();
    const accessUsable = isAccessTokenUsable(accessToken, { expiresAt });
    const refreshToken = String(provider._codexRefreshToken || "").trim();
    const valid = accessUsable || Boolean(refreshToken);
    return {
      ok: valid,
      reason: valid ? "" : "memory-token-unusable",
      source: "memory",
      authFile: "(memory)",
      accessToken,
      refreshToken,
      idToken: String(provider._codexIdToken || "").trim(),
      sessionToken: "",
      accountId: String(provider._codexAccountId || provider.codexAccountId || provider.accountId || "").trim(),
      email: String(provider._codexEmail || "").trim(),
      expiresAt,
      lastRefresh: "",
      accessUsable,
      canRefresh: Boolean(refreshToken),
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken),
      hasSessionToken: false
    };
  }

  const file = authFile || codexAuthPath(home);
  try {
    if (!fs.existsSync(file)) {
      return {
        ok: false,
        reason: "missing-auth-file",
        source: "codex-auth-json",
        authFile: file,
        accessUsable: false,
        canRefresh: false,
        hasAccessToken: false,
        hasRefreshToken: false,
        hasSessionToken: false
      };
    }
    const raw = fs.readFileSync(file, "utf8");
    return parseCodexAuthJson(raw, { authFile: file, source: "codex-auth-json" });
  } catch (err) {
    return {
      ok: false,
      reason: err?.message || "read-failed",
      source: "codex-auth-json",
      authFile: file,
      accessUsable: false,
      canRefresh: false,
      hasAccessToken: false,
      hasRefreshToken: false,
      hasSessionToken: false
    };
  }
}

/**
 * 回写 ~/.codex/auth.json（保留未知字段，更新 tokens + last_refresh）
 */
export function writeCodexLocalAuth(tokens, {
  authFile = codexAuthPath(),
  previous = null
} = {}) {
  const dir = path.dirname(authFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  let base = previous && typeof previous === "object" ? { ...previous } : {};
  if (!previous && fs.existsSync(authFile)) {
    try {
      base = JSON.parse(fs.readFileSync(authFile, "utf8"));
    } catch {
      base = {};
    }
  }
  if (!base.tokens || typeof base.tokens !== "object") base.tokens = {};

  const accessToken = String(tokens.accessToken || tokens.access_token || base.tokens.access_token || "").trim();
  const refreshToken = String(tokens.refreshToken || tokens.refresh_token || base.tokens.refresh_token || "").trim();
  const idToken = String(tokens.idToken || tokens.id_token || base.tokens.id_token || "").trim();
  const accountId = String(
    tokens.accountId ||
    tokens.account_id ||
    base.tokens.account_id ||
    extractCodexAccountId(idToken, accessToken) ||
    ""
  ).trim();

  base.auth_mode = base.auth_mode || "chatgpt";
  base.tokens = {
    ...base.tokens,
    id_token: idToken,
    access_token: accessToken,
    refresh_token: refreshToken,
    account_id: accountId
  };
  base.last_refresh = new Date().toISOString();

  fs.writeFileSync(authFile, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(authFile, 0o600);
  } catch {}
  return {
    ok: true,
    authFile,
    accountId,
    email: String(tokens.email || extractEmailFromIdToken(idToken) || "").trim(),
    expiresAt: String(tokens.expiresAt || tokens.expires_at || "").trim(),
    lastRefresh: base.last_refresh
  };
}

/**
 * 确保有可用 access_token：未过期直接返回；过期且有 refresh 则刷新并回写 auth.json。
 */
export async function ensureCodexLocalAccessToken({
  provider = null,
  authFile,
  proxyUrl = "",
  fetchImpl,
  forceRefresh = false,
  home
} = {}) {
  const file = authFile || codexAuthPath(home);
  const current = readCodexLocalAuth({ authFile: file, provider, home });
  if (!current.ok && !current.hasAccessToken && !current.hasRefreshToken) return current;

  if (!forceRefresh && current.accessUsable && current.accessToken) {
    return {
      ok: true,
      source: current.source,
      accessToken: current.accessToken,
      refreshToken: current.refreshToken,
      idToken: current.idToken,
      accountId: current.accountId,
      email: current.email,
      expiresAt: current.expiresAt,
      authFile: current.authFile,
      refreshed: false
    };
  }

  if (!current.refreshToken) {
    if (current.accessToken && !forceRefresh) {
      return {
        ok: true,
        source: current.source,
        accessToken: current.accessToken,
        refreshToken: "",
        idToken: current.idToken,
        accountId: current.accountId,
        email: current.email,
        expiresAt: current.expiresAt,
        authFile: current.authFile,
        stale: true,
        refreshed: false
      };
    }
    return {
      ok: false,
      reason: current.reason || "missing-refresh-token",
      source: current.source,
      authFile: current.authFile
    };
  }

  const key = `${file}::${current.refreshToken}`;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);

  const task = (async () => {
    try {
      const refreshed = await refreshCodexTokens(current.refreshToken, {
        proxyUrl: proxyUrl || provider?.proxyUrl || "",
        fetchImpl
      });
      const written = writeCodexLocalAuth(refreshed, {
        authFile: file,
        previous: current._raw || null
      });
      return {
        ok: true,
        source: "codex-auth-json-refreshed",
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        idToken: refreshed.idToken,
        accountId: refreshed.accountId || current.accountId,
        email: refreshed.email || current.email,
        expiresAt: refreshed.expiresAt,
        authFile: written.authFile,
        refreshed: true
      };
    } catch (err) {
      if (current.accessToken && !forceRefresh) {
        return {
          ok: true,
          source: current.source,
          accessToken: current.accessToken,
          refreshToken: current.refreshToken,
          idToken: current.idToken,
          accountId: current.accountId,
          email: current.email,
          expiresAt: current.expiresAt,
          authFile: current.authFile,
          refreshError: err?.message || String(err),
          stale: true,
          refreshed: false
        };
      }
      return {
        ok: false,
        reason: err?.message || "refresh-failed",
        source: current.source,
        authFile: current.authFile
      };
    }
  })();

  refreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(key);
  }
}

const SOURCE_LABEL = {
  memory: "内存",
  "codex-auth-json": "~/.codex/auth.json",
  "codex-auth-json-refreshed": "~/.codex/auth.json（已刷新）"
};

/**
 * UI / IPC 用状态：loggedIn 仅在「access 仍可用」或「可 refresh 续期」时为 true。
 */
export function codexOAuthStatus(provider = null, { authFile, home } = {}) {
  const resolvedFile = authFile || codexAuthPath(home);
  const auth = readCodexLocalAuth({ provider, authFile: resolvedFile, home });
  if (!auth.ok) {
    let hint = "请先完成 Codex / ChatGPT 登录（点「登录 Codex」或终端执行 codex login）。";
    if (auth.reason === "missing-auth-file") {
      hint = "未找到 ~/.codex/auth.json。请点「登录 Codex」完成浏览器授权，或先在终端执行 codex login。";
    } else if (auth.reason === "access-expired-no-refresh") {
      hint = "access_token 已过期且没有 refresh_token，需要重新登录。";
    } else if (auth.reason === "missing-tokens" || auth.reason === "missing-usable-credentials") {
      hint = "auth.json 存在但没有可用凭证，请重新登录。";
    }
    return {
      ok: false,
      loggedIn: false,
      valid: false,
      reason: auth.reason,
      authFile: auth.authFile || resolvedFile,
      source: auth.source || "none",
      accessUsable: false,
      canRefresh: Boolean(auth.canRefresh),
      hasAccessToken: Boolean(auth.hasAccessToken),
      hasRefreshToken: Boolean(auth.hasRefreshToken),
      hint
    };
  }

  return {
    ok: true,
    loggedIn: true,
    valid: true,
    email: auth.email,
    accountId: auth.accountId,
    expiresAt: auth.expiresAt,
    lastRefresh: auth.lastRefresh,
    authFile: auth.authFile,
    source: auth.source,
    sourceLabel: SOURCE_LABEL[auth.source] || auth.source || "",
    accessUsable: Boolean(auth.accessUsable),
    canRefresh: Boolean(auth.canRefresh),
    hasAccessToken: Boolean(auth.hasAccessToken),
    hasRefreshToken: Boolean(auth.hasRefreshToken),
    needsRefresh: Boolean(auth.canRefresh && !auth.accessUsable),
    authMode: auth.authMode || "chatgpt"
  };
}

/**
 * 异步状态：必要时先尝试 refresh，再返回最终有效性。
 */
export async function codexOAuthStatusAsync(provider = null, {
  authFile,
  home,
  proxyUrl = "",
  fetchImpl,
  tryRefresh = true
} = {}) {
  const file = authFile || codexAuthPath(home);
  const sync = codexOAuthStatus(provider, { authFile: file, home });
  if (!tryRefresh) return sync;
  if (sync.loggedIn && sync.accessUsable) return sync;
  if (!sync.hasRefreshToken && !sync.canRefresh) return sync;

  const ensured = await ensureCodexLocalAccessToken({
    provider,
    authFile: file,
    proxyUrl,
    fetchImpl,
    home,
    forceRefresh: Boolean(sync.needsRefresh || !sync.accessUsable)
  });
  if (!ensured.ok) {
    return {
      ...sync,
      ok: false,
      loggedIn: false,
      valid: false,
      reason: ensured.reason || sync.reason,
      refreshError: ensured.reason,
      hint: ensured.reason?.includes("refresh")
        ? `自动续期失败：${ensured.reason}。请重新登录 Codex。`
        : sync.hint
    };
  }
  const after = codexOAuthStatus(provider, { authFile: file, home });
  return {
    ...after,
    refreshed: Boolean(ensured.refreshed),
    refreshError: ensured.refreshError || ""
  };
}

function resolveCodexBinary() {
  const fromEnv = String(process.env.CODEX_BIN || process.env.SWITCHYARD_CODEX_BIN || "").trim();
  if (fromEnv) return fromEnv;
  return "codex";
}

/**
 * 调起官方 `codex login`（浏览器 OAuth），轮询 auth.json 直到出现有效登录或超时。
 * 不自己实现 OpenAI 授权页抓取，避免与官方 client 漂移。
 */
export async function runCodexOAuthLogin({
  openUrl,
  authFile = codexAuthPath(),
  timeoutMs = 5 * 60 * 1000,
  pollMs = 1500,
  codexBin = resolveCodexBinary(),
  env = process.env,
  spawnImpl = spawn,
  // 测试可注入：跳过子进程，只轮询
  skipSpawn = false
} = {}) {
  const startedAt = Date.now();
  const beforeMtime = (() => {
    try {
      return fs.existsSync(authFile) ? fs.statSync(authFile).mtimeMs : 0;
    } catch {
      return 0;
    }
  })();

  let child = null;
  let spawnError = "";
  if (!skipSpawn) {
    try {
      child = spawnImpl(codexBin, ["login"], {
        env: { ...env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false
      });
      child.stdout?.on?.("data", () => {});
      child.stderr?.on?.("data", () => {});
      child.on("error", (err) => {
        spawnError = err?.message || String(err);
      });
    } catch (err) {
      return {
        ok: false,
        error: `无法启动 codex login：${err?.message || err}。请确认已安装 Codex CLI（codex）。`,
        authFile
      };
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (spawnError) {
        return {
          ok: false,
          error: `无法启动 codex login：${spawnError}。请确认 PATH 中有 codex，或设置 CODEX_BIN。`,
          authFile
        };
      }
      const st = codexOAuthStatus(null, { authFile });
      if (st.loggedIn && st.valid) {
        // 若文件在登录前已有效，仍算成功（用户可能刚登录过）
        // 若 mtime 更新则更明确
        let mtimeUpdated = false;
        try {
          mtimeUpdated = fs.existsSync(authFile) && fs.statSync(authFile).mtimeMs > beforeMtime;
        } catch {}
        return {
          ok: true,
          authFile: st.authFile,
          email: st.email,
          accountId: st.accountId,
          expiresAt: st.expiresAt,
          accessUsable: st.accessUsable,
          canRefresh: st.canRefresh,
          mtimeUpdated,
          source: st.source
        };
      }
      await sleep(pollMs);
    }
    return {
      ok: false,
      error: "登录超时（5 分钟内未检测到有效 ~/.codex/auth.json）。请确认浏览器已完成 ChatGPT 授权后重试。",
      authFile
    };
  } finally {
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
}

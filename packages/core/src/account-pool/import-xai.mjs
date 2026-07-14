// 解析 xAI / Grok 账号导入载荷（CPA xai-*.json、RT 列表、SSO 卡密、目录扫描）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizeAccount, upsertAccounts } from "./store.mjs";
import { convertSsoCookie, isWebSsoJwt, looksLikeJwt, normalizeSso } from "./sso-convert.mjs";

const DEFAULT_CPA_DIRS = [
  path.join(os.homedir(), ".cli-proxy-api-grok"),
  path.join(os.homedir(), ".cli-proxy-api")
];

export function parseXaiImportPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "import payload is empty", accounts: [] };

  if (looksLikeJson(text)) {
    try {
      const value = JSON.parse(text);
      const accounts = collectFromValue(value);
      if (accounts.length) return { ok: true, accounts, sourceFormat: "json" };
      return { ok: false, error: "JSON parsed but no xAI credentials found", accounts: [] };
    } catch {
      // fall through to NDJSON / lines
    }
    const ndjson = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !looksLikeJson(trimmed)) continue;
      try {
        ndjson.push(...collectFromValue(JSON.parse(trimmed)));
      } catch {}
    }
    if (ndjson.length) return { ok: true, accounts: ndjson, sourceFormat: "ndjson" };
  }

  const lines = parsePlainLines(text);
  if (!lines.length) {
    return { ok: false, error: "no refresh tokens, SSO tokens, or credential JSON found", accounts: [] };
  }
  const hasSso = lines.some((a) => a.ssoToken);
  const hasRt = lines.some((a) => a.refreshToken && !a.ssoToken);
  return {
    ok: true,
    accounts: lines,
    sourceFormat: hasSso && hasRt ? "mixed-sso-rt" : hasSso ? "sso-card-list" : "refresh-token-list"
  };
}

function looksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function collectFromValue(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, out);
    return out;
  }
  if (typeof value !== "object") return out;

  if (Array.isArray(value.accounts)) {
    for (const item of value.accounts) collectFromValue(item, out);
    return out;
  }

  if (isXaiCredentialObject(value)) {
    out.push(credentialFromObject(value, "cpa-xai-json"));
    return out;
  }

  if (value.credentials && typeof value.credentials === "object") {
    collectFromValue(value.credentials, out);
  }

  if ((value.refresh_token || value.refreshToken || value.access_token || value.accessToken) && looksLikeXaiContext(value)) {
    out.push(credentialFromObject(value, "generic-xai-object"));
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "credentials") continue;
    if (Array.isArray(child) || (child && typeof child === "object" && (child.type === "xai" || child.auth_kind === "oauth"))) {
      collectFromValue(child, out);
    }
  }
  return out;
}

function isXaiCredentialObject(value) {
  if (!value || typeof value !== "object") return false;
  const type = String(value.type || value.auth_kind || value.platform || "").toLowerCase();
  if (type === "xai" || type === "oauth" || type === "grok") {
    return Boolean(value.refresh_token || value.refreshToken || value.access_token || value.accessToken);
  }
  return Boolean(
    (value.refresh_token || value.refreshToken) &&
    (String(value.base_url || value.baseUrl || "").includes("x.ai") || String(value.token_endpoint || value.tokenEndpoint || "").includes("x.ai"))
  );
}

function looksLikeXaiContext(value) {
  const hay = [
    value.type,
    value.platform,
    value.base_url,
    value.baseUrl,
    value.token_endpoint,
    value.tokenEndpoint,
    value.email
  ].filter(Boolean).join(" ").toLowerCase();
  return hay.includes("xai") || hay.includes("x.ai") || hay.includes("grok");
}

function credentialFromObject(value, source) {
  const sso =
    value.sso_token || value.ssoToken || value.sso ||
    (isWebSsoJwt(value.access_token || value.accessToken || "") ? (value.access_token || value.accessToken) : "");
  return normalizeAccount({
    email: value.email || value.username || value.name || "",
    name: value.name || value.email || "",
    accessToken: sso ? "" : (value.access_token || value.accessToken || ""),
    refreshToken: value.refresh_token || value.refreshToken || "",
    ssoToken: sso || "",
    tokenType: value.token_type || value.tokenType || "Bearer",
    expiresAt: value.expired || value.expires_at || value.expiresAt || "",
    tokenEndpoint: value.token_endpoint || value.tokenEndpoint || "https://auth.x.ai/oauth2/token",
    sub: value.sub || "",
    source,
    enabled: value.disabled === true ? false : value.enabled !== false,
    weight: value.weight
  });
}

function parsePlainLines(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/[;；]+$/, "");
    if (!trimmed || trimmed.startsWith("#")) continue;

    // 卡密行：email----password----SSO / email|password|sso=eyJ...
    const card = parseCardLine(trimmed);
    if (card) {
      out.push(card);
      continue;
    }

    const bare = normalizeSso(trimmed);
    if (isWebSsoJwt(bare) || (looksLikeJwt(bare) && bare.length >= 80)) {
      out.push(normalizeAccount({
        ssoToken: bare,
        source: "sso-jwt-list"
      }));
      continue;
    }

    const token = extractRefreshToken(trimmed);
    if (!token) continue;
    out.push(normalizeAccount({
      refreshToken: token,
      source: "refresh-token-list"
    }));
  }
  return out;
}

function parseCardLine(line) {
  // 找嵌入的 SSO JWT（任意分隔符）
  const jwt = findJwtInText(line);
  if (!jwt) return null;
  if (!isWebSsoJwt(jwt) && !(looksLikeJwt(jwt) && jwt.length >= 80)) return null;

  const before = line.slice(0, line.indexOf(jwt)).trim()
    .replace(/sso\s*[=:：]?\s*$/i, "")
    .replace(/[-|]+$/, "")
    .trim();
  let email = "";
  let password = "";
  if (before) {
    const parts = before.split(/----|\||\t|,|，/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 1 && parts[0].includes("@")) email = parts[0];
    if (parts.length >= 2) password = parts[1];
  }
  return normalizeAccount({
    email,
    name: email || "SSO",
    ssoToken: jwt,
    source: email ? (password ? "card-email-password-sso" : "card-email-sso") : "sso-jwt-embedded",
    notes: password ? "card import (password not stored)" : undefined
  });
}

function findJwtInText(text) {
  const match = String(text || "").match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  return match ? match[0] : "";
}

function extractRefreshToken(line) {
  const bare = line.replace(/^sso=/i, "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (looksLikeRefreshToken(bare)) return bare;
  const parts = line.split(/----|\||\s+/).map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (looksLikeRefreshToken(parts[i])) return parts[i];
  }
  return "";
}

function looksLikeRefreshToken(token) {
  if (!token || token.length < 20) return false;
  if (token.split(".").length === 3 && token.startsWith("eyJ")) return false;
  return /^[A-Za-z0-9._~+/=-]+$/.test(token);
}

/**
 * 导入文本。若含 SSO，默认自动 Device Flow 转 OAuth。
 * options.convertSso !== false 时启用自动转换。
 */
export async function importXaiAccountsFromText(providerId, raw, options = {}) {
  const parsed = parseXaiImportPayload(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, added: 0, skipped: 0, accounts: [] };

  const convertSso = options.convertSso !== false;
  const ready = [];
  const convertErrors = [];
  let converted = 0;

  for (const account of parsed.accounts) {
    if (account.ssoToken && !account.refreshToken && convertSso) {
      try {
        const oauth = await convertSsoCookie(account.ssoToken, {
          emailHint: account.email,
          proxyUrl: options.proxyUrl,
          fetchImpl: options.fetchImpl,
          maxRetries: options.maxRetries
        });
        ready.push(normalizeAccount({
          ...account,
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
          tokenType: oauth.tokenType,
          email: oauth.email || account.email,
          ssoToken: account.ssoToken,
          source: `${account.source || "sso"}→oauth`,
          notes: `SSO→OAuth device-flow (${new Date().toISOString().slice(0, 16).replace("T", " ")})`
        }));
        converted += 1;
        if (options.gapMs) await new Promise((r) => setTimeout(r, options.gapMs));
      } catch (err) {
        convertErrors.push({
          email: account.email || "",
          error: err?.message || String(err)
        });
        // 仍可按未转换 SSO 存档（不可用，待重试）——默认跳过避免污染池
        if (options.keepFailedSso) {
          ready.push(normalizeAccount({
            ...account,
            health: "degraded",
            lastError: err?.message || String(err)
          }));
        }
      }
      continue;
    }
    ready.push(account);
  }

  if (!ready.length) {
    return {
      ok: false,
      error: convertErrors[0]?.error || "没有可导入的账号（SSO 转换可能全部失败）",
      added: 0,
      skipped: 0,
      converted,
      convertErrors,
      accounts: []
    };
  }

  const result = upsertAccounts(providerId, ready, {
    poolKind: options.poolKind || "xai_oauth",
    skipDuplicates: options.skipDuplicates !== false,
    home: options.home
  });
  return {
    ...result,
    converted,
    convertErrors,
    sourceFormat: parsed.sourceFormat
  };
}

/** 同步导入（不含 SSO 转换；SSO 行会被跳过除非已有 RT） */
export function importXaiAccountsFromTextSync(providerId, raw, options = {}) {
  const parsed = parseXaiImportPayload(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error, added: 0, skipped: 0, accounts: [] };
  const ready = parsed.accounts.filter((a) => a.refreshToken || a.accessToken);
  if (!ready.length) {
    return {
      ok: false,
      error: "载荷仅含 SSO，请使用异步 import（会自动转换）或先转为 OAuth",
      added: 0,
      skipped: 0,
      accounts: []
    };
  }
  return upsertAccounts(providerId, ready, {
    poolKind: options.poolKind || "xai_oauth",
    skipDuplicates: options.skipDuplicates !== false,
    home: options.home
  });
}

export function scanCpaXaiFiles(dirs = DEFAULT_CPA_DIRS) {
  const files = [];
  for (const dir of dirs) {
    const resolved = path.resolve(String(dir || "").replace(/^~(?=\/|$)/, os.homedir()));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    for (const name of fs.readdirSync(resolved)) {
      if (!name.endsWith(".json")) continue;
      files.push(path.join(resolved, name));
    }
  }
  return files;
}

export function importXaiAccountsFromCpaDirs(providerId, {
  dirs = DEFAULT_CPA_DIRS,
  skipDuplicates = true,
  home
} = {}) {
  const accounts = [];
  const errors = [];
  for (const file of scanCpaXaiFiles(dirs)) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const value = JSON.parse(raw);
      const found = collectFromValue(value);
      if (!found.length) continue;
      for (const account of found) {
        accounts.push({
          ...account,
          source: account.source || `cpa-file:${path.basename(file)}`
        });
      }
    } catch (err) {
      errors.push({ file, error: err?.message || String(err) });
    }
  }
  if (!accounts.length) {
    return {
      ok: false,
      error: "未在 CLIProxyAPI 目录找到可用的 xai-*.json 账号",
      added: 0,
      skipped: 0,
      errors
    };
  }
  const result = upsertAccounts(providerId, accounts, {
    poolKind: "xai_oauth",
    skipDuplicates,
    home
  });
  return { ...result, scanned: accounts.length, errors };
}

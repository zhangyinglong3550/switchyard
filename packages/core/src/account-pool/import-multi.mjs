// Antigravity / Codex 多账号导入（CPA json、auth.json、目录扫描）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizeAccount, upsertAccounts, loadPool } from "./store.mjs";

export function expandHome(p) {
  return String(p || "").replace(/^~(?=\/|$)/, os.homedir());
}

function collectJsonFiles(dirs, { prefix = "", nameIncludes = "" } = {}) {
  const files = [];
  for (const dir of dirs) {
    const resolved = expandHome(dir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    for (const name of fs.readdirSync(resolved)) {
      if (!name.endsWith(".json")) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      if (nameIncludes && !name.includes(nameIncludes)) continue;
      files.push(path.join(resolved, name));
    }
  }
  return files;
}

/** CPA antigravity-*.json → account */
export function accountFromAntigravityJson(raw, source = "cpa-antigravity") {
  return normalizeAccount({
    email: raw.email || "",
    name: raw.email || raw.project_id || "antigravity",
    accessToken: raw.access_token || raw.accessToken || "",
    refreshToken: raw.refresh_token || raw.refreshToken || "",
    tokenType: raw.token_type || raw.tokenType || "Bearer",
    expiresAt: raw.expired || raw.expires_at || raw.expiresAt || "",
    projectId: raw.project_id || raw.projectId || "",
    source,
    enabled: raw.disabled === true ? false : raw.enabled !== false,
    weight: raw.weight
  });
}

/** 是否像 Codex/ChatGPT OAuth 凭证（排除 antigravity/xai 等同目录其它类型） */
export function looksLikeCodexAuthJson(raw, fileName = "") {
  if (!raw || typeof raw !== "object") return false;
  const type = String(raw.type || "").toLowerCase();
  if (type && !["codex", "chatgpt", "openai"].includes(type)) return false;
  if (/^(xai|antigravity|gemini|claude)-/i.test(fileName || "")) return false;
  if (raw.tokens?.access_token || raw.tokens?.refresh_token) return true;
  if (raw.auth_mode === "chatgpt" || type === "codex" || type === "chatgpt") return true;
  // 顶层 access+refresh 仅在明确 openai/codex 来源时接受
  if (raw.access_token && raw.refresh_token) {
    return Boolean(
      raw.account_id ||
      raw.chatgpt_account_id ||
      raw.id_token ||
      type === "codex" ||
      type === "chatgpt" ||
      type === "openai" ||
      String(fileName || "").toLowerCase().includes("codex") ||
      String(fileName || "").toLowerCase() === "auth.json"
    );
  }
  return false;
}

/** ~/.codex/auth.json 或 CPA 扁平 type:codex JSON → account */
export function accountFromCodexAuthJson(raw, source = "codex-auth-json") {
  const tokens = raw.tokens && typeof raw.tokens === "object" ? raw.tokens : null;
  const access =
    tokens?.access_token ||
    tokens?.accessToken ||
    raw.access_token ||
    raw.accessToken ||
    "";
  const refresh =
    tokens?.refresh_token ||
    tokens?.refreshToken ||
    raw.refresh_token ||
    raw.refreshToken ||
    "";
  const sessionToken =
    raw.session_token ||
    raw.sessionToken ||
    tokens?.session_token ||
    tokens?.sessionToken ||
    "";
  const idToken = tokens?.id_token || tokens?.idToken || raw.id_token || raw.idToken || "";
  const accountId =
    tokens?.account_id ||
    tokens?.accountId ||
    raw.account_id ||
    raw.chatgpt_account_id ||
    raw.accountId ||
    "";
  let email = raw.email || raw.account?.email || "";
  if (!email && idToken) {
    try {
      const part = String(idToken).split(".")[1];
      if (part) {
        const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        email = String(payload.email || "").trim();
      }
    } catch {}
  }
  const name = raw.name || email || accountId || "codex";
  return normalizeAccount({
    email,
    name,
    accessToken: access,
    refreshToken: refresh,
    sessionToken,
    idToken,
    accountId,
    planType: raw.plan_type || raw.chatgpt_plan_type || raw.planType || "",
    tokenType: "Bearer",
    // normalizeAccount 会优先用 access JWT exp
    expiresAt: raw.expired || raw.expires_at || raw.expiresAt || "",
    source,
    enabled: raw.disabled === true ? false : true,
    weight: raw.weight
  });
}

function looksLikeJsonText(text) {
  const t = String(text || "").trim();
  return t.startsWith("{") || t.startsWith("[");
}

/**
 * 粘贴解析 Codex 批量凭证。支持：
 * - 单个 / 数组 / NDJSON 的 auth.json 形态（含 tokens）
 * - CPA 形态 { type:"codex", email, access_token, refresh_token, ... }
 * - 每行 refresh_token（仅 RT，access 会在请求时刷新）
 * - email----refresh_token 或 email|refresh_token
 */
export function parseCodexImportPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "import payload is empty", accounts: [] };

  const accounts = [];
  if (looksLikeJsonText(text)) {
    try {
      collectCodexFromValue(JSON.parse(text), accounts, "paste-json");
      if (accounts.length) {
        return { ok: true, accounts, sourceFormat: "json" };
      }
    } catch {
      // fall through to NDJSON
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !looksLikeJsonText(trimmed)) continue;
      try {
        collectCodexFromValue(JSON.parse(trimmed), accounts, "paste-ndjson");
      } catch {}
    }
    if (accounts.length) {
      return { ok: true, accounts, sourceFormat: "ndjson" };
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // email----refresh_token 或 email|refresh_token 或 email,refresh_token
    const sep = trimmed.includes("----")
      ? "----"
      : trimmed.includes("|")
      ? "|"
      : (trimmed.includes(",") && trimmed.includes("@") ? "," : null);
    if (sep) {
      const parts = trimmed.split(sep).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const email = parts[0].includes("@") ? parts[0] : "";
        const rt = parts.find((p) => p.length > 20 && !p.includes("@")) || parts[parts.length - 1];
        if (rt && rt.length >= 20) {
          accounts.push(normalizeAccount({
            email,
            name: email || "codex",
            refreshToken: rt,
            source: "paste-email-rt",
            enabled: true
          }));
          continue;
        }
      }
    }
    // 纯 refresh_token 行（较长）
    if (trimmed.length >= 24 && !trimmed.includes(" ") && !looksLikeJsonText(trimmed)) {
      accounts.push(normalizeAccount({
        email: "",
        name: `codex-${trimmed.slice(0, 8)}`,
        refreshToken: trimmed,
        source: "paste-refresh-token",
        enabled: true
      }));
    }
  }

  if (!accounts.length) {
    return {
      ok: false,
      error: "未识别到 Codex 凭证：请粘贴 auth.json / CPA codex JSON / 每行 refresh_token",
      accounts: []
    };
  }
  return {
    ok: true,
    accounts,
    sourceFormat: accounts.some((a) => a.accessToken) ? "mixed" : "refresh-token-list"
  };
}

function collectCodexFromValue(value, out, source) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectCodexFromValue(item, out, source);
    return;
  }
  if (typeof value !== "object") return;

  if (Array.isArray(value.accounts)) {
    for (const item of value.accounts) collectCodexFromValue(item, out, source);
    return;
  }

  // 粘贴场景放宽：有 tokens 或明确 codex/chatgpt 类型即可
  const type = String(value.type || "").toLowerCase();
  const hasTokensObj = Boolean(value.tokens?.access_token || value.tokens?.refresh_token);
  const hasTop =
    Boolean(value.access_token || value.refresh_token || value.accessToken || value.refreshToken);
  const isCodexish =
    hasTokensObj ||
    value.auth_mode === "chatgpt" ||
    ["codex", "chatgpt", "openai"].includes(type) ||
    (hasTop && (value.account_id || value.chatgpt_account_id || value.id_token || type));

  if (isCodexish || (hasTop && !type)) {
    // 排除明显的 antigravity/xai
    if (["antigravity", "xai", "grok", "gemini"].includes(type)) return;
    const acc = accountFromCodexAuthJson(value, source);
    // CPA 导出常只有 access + session_token，refresh 为空
    if (acc.accessToken || acc.refreshToken || acc.sessionToken) out.push(acc);
    return;
  }

  if (value.credentials && typeof value.credentials === "object") {
    collectCodexFromValue(value.credentials, out, source);
  }
}

/** 粘贴文本导入 Codex 多账号（不依赖 ~/.cli-proxy-api / 文件路径） */
export function importCodexAccountsFromText(providerId, raw, {
  skipDuplicates = true,
  home
} = {}) {
  const parsed = parseCodexImportPayload(raw);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, added: 0, skipped: 0, accounts: [] };
  }
  const ready = parsed.accounts.filter(
    (a) => a.refreshToken || a.accessToken || a.sessionToken
  );
  if (!ready.length) {
    return {
      ok: false,
      error: "没有可用的 access_token / refresh_token / session_token",
      added: 0,
      skipped: 0,
      accounts: []
    };
  }
  const result = upsertAccounts(providerId, ready, {
    poolKind: "codex_oauth",
    skipDuplicates,
    home
  });
  return { ...result, scanned: ready.length, sourceFormat: parsed.sourceFormat };
}

export function importAntigravityFromCpaDirs(providerId, {
  dirs = [path.join(os.homedir(), ".cli-proxy-api")],
  skipDuplicates = true,
  home,
  syncToCliproxy = true
} = {}) {
  const files = collectJsonFiles(dirs, { prefix: "antigravity-" });
  const extra = collectJsonFiles(dirs).filter((f) => !path.basename(f).startsWith("antigravity-"));
  const accounts = [];
  const errors = [];
  for (const file of [...files, ...extra]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (String(raw.type || "").toLowerCase() !== "antigravity" && !path.basename(file).startsWith("antigravity-")) {
        continue;
      }
      accounts.push(accountFromAntigravityJson(raw, `cpa-file:${path.basename(file)}`));
    } catch (err) {
      errors.push({ file, error: err?.message || String(err) });
    }
  }
  if (!accounts.length) {
    return {
      ok: false,
      error: "未在 CLIProxyAPI auth-dir 找到 antigravity-*.json",
      added: 0,
      skipped: 0,
      errors
    };
  }
  const result = upsertAccounts(providerId, accounts, {
    poolKind: "antigravity_oauth",
    skipDuplicates,
    home
  });
  let sync = null;
  if (syncToCliproxy) {
    sync = syncAntigravityPoolToCliproxyDir(providerId, {
      authDir: dirs[0] || path.join(os.homedir(), ".cli-proxy-api"),
      home
    });
  }
  return { ...result, scanned: accounts.length, errors, sync };
}

export function importCodexFromPaths(providerId, {
  paths = [path.join(os.homedir(), ".codex", "auth.json")],
  dirs = [],
  skipDuplicates = true,
  home
} = {}) {
  const accounts = [];
  const errors = [];
  const files = [
    ...paths.map(expandHome).filter((p) => fs.existsSync(p) && fs.statSync(p).isFile())
  ];
  for (const dir of dirs.map(expandHome)) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      // 排除 xai- / antigravity- 等 CPA 其它池文件
      if (/^(xai|antigravity|gemini|claude)-/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        if (looksLikeCodexAuthJson(raw, name)) files.push(full);
      } catch {}
    }
  }

  for (const file of [...new Set(files)]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!looksLikeCodexAuthJson(raw, path.basename(file))) continue;
      const acc = accountFromCodexAuthJson(raw, `file:${path.basename(file)}`);
      if (!acc.accessToken && !acc.refreshToken && !acc.sessionToken) continue;
      if (!acc.email) acc.email = path.basename(file, ".json");
      accounts.push(acc);
    } catch (err) {
      errors.push({ file, error: err?.message || String(err) });
    }
  }

  if (!accounts.length) {
    return {
      ok: false,
      error: "未找到可用的 Codex auth.json / tokens",
      added: 0,
      skipped: 0,
      errors
    };
  }
  const result = upsertAccounts(providerId, accounts, {
    poolKind: "codex_oauth",
    skipDuplicates,
    home
  });
  return { ...result, scanned: accounts.length, errors };
}

/**
 * 把 Switchyard antigravity 池账号同步回 CLIProxyAPI auth-dir，供 8317 多号轮询。
 * Antigravity 完整协议翻译仍由 CLIProxyAPI 完成。
 */
export function syncAntigravityPoolToCliproxyDir(providerId, {
  authDir = path.join(os.homedir(), ".cli-proxy-api"),
  home
} = {}) {
  const pool = loadPool(providerId, { poolKind: "antigravity_oauth", home });
  const dir = expandHome(authDir);
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const account of pool.accounts || []) {
    if (!account.refreshToken && !account.accessToken) continue;
    const email = account.email || account.id || `acct-${account.id}`;
    const safe = String(email).replace(/[^\w.@+-]+/g, "_");
    const file = path.join(dir, `antigravity-${safe}.json`);
    const payload = {
      type: "antigravity",
      email: account.email || "",
      access_token: account.accessToken || "",
      refresh_token: account.refreshToken || "",
      expired: account.expiresAt || "",
      expires_in: 3600,
      project_id: account.projectId || account.sub || "",
      disabled: account.enabled === false,
      timestamp: Date.now()
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
    written += 1;
  }
  return { ok: true, authDir: dir, written, total: (pool.accounts || []).length };
}

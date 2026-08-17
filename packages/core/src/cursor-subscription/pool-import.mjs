// Cursor 订阅号池批量导入解析器。
//
// 支持从 Cursor 号池/卡密导出粘贴多种形态，尽量宽松兼容：
//   - JSON：单对象 / 数组 / NDJSON，含 accessToken|access_token、email、sub、machineId
//   - 明文行：email----password----xxx----userId::JWT（`----` 分隔，`::` 前是账号描述，`::` 后是 access JWT）
//   - 简单行：email----JWT、email|JWT、纯 JWT
//
// 按用户确认，导入的 Cursor 账号统一复用调用方传入的本机 machine id；
// 只有 JSON 里显式携带 machineId 时才使用该值。
import { normalizeAccount, upsertAccounts } from "../account-pool/store.mjs";

const JWT_RE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/;

function looksLikeJson(text) {
  const t = String(text || "").trim();
  return t.startsWith("{") || t.startsWith("[");
}

export function jwtExpIso(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return null;
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp = Number(payload?.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return new Date(exp * 1000).toISOString();
  } catch {
    return null;
  }
}

function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function accountFromPlainLine(line, { machineId = "" } = {}) {
  const raw = String(line || "").trim();
  if (!raw) return null;

  // 优先提取 access JWT：`::` 后面一段，或行内任意 JWT。
  let accessToken = "";
  const jwtMatch = raw.match(JWT_RE);
  if (jwtMatch) {
    accessToken = jwtMatch[0];
  } else if (raw.includes("::")) {
    // 宽松兜底：`::` 后紧跟的、无空格的较长片段视为 token（不限定 eyJ 前缀）
    const after = raw.split("::").pop()?.trim() || "";
    if (after.length >= 24 && !/\s/.test(after) && !/^[,#]/.test(after)) accessToken = after;
  }
  if (!accessToken) return null;

  // 去掉 JWT 本体，剩下描述段（email / password / userId 等）。
  const description = raw.replace(JWT_RE, "").replace(/::/g, " ").replace(/[|,;\t]+/g, " ").trim();
  const pieces = description.split(/----+/).map((s) => s.trim()).filter(Boolean);
  if (!pieces.length) {
    return normalizeAccount({
      accessToken,
      machineId,
      name: `cursor-${accessToken.slice(0, 8)}`,
      source: "cursor-paste-plain",
      enabled: true
    });
  }

  // 已知导出形态：email----password----xxx----userId（userId 与 JWT sub 呼应）
  const email = pieces.find(looksLikeEmail) || "";
  const userId = pieces.find((p) => /^user_[A-Za-z0-9_-]{6,}$/.test(p)) || "";
  return normalizeAccount({
    email,
    sub: userId || "",
    name: email || userId || pieces[0] || `cursor-${accessToken.slice(0, 8)}`,
    accessToken,
    machineId,
    source: "cursor-paste-line",
    enabled: true
  });
}

function collectFromJsonValue(value, out, source, fallbackMachineId = "") {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectFromJsonValue(item, out, source, fallbackMachineId);
    return out;
  }
  if (typeof value !== "object") return out;

  if (Array.isArray(value.accounts)) {
    for (const item of value.accounts) collectFromJsonValue(item, out, source, fallbackMachineId);
    return out;
  }

  const accessToken = String(value.accessToken || value.access_token || value.token || "").trim();
  const isCursorish =
    accessToken &&
    (looksLikeEmail(String(value.email || "")) ||
      String(value.sub || "").startsWith("user_") ||
      String(value.userId || value.user_id || "").startsWith("user_") ||
      /cursor/i.test(String(value.platform || value.provider || value.type || value.source || "")));

  if (isCursorish || (accessToken && String(value.platform || value.type || "").toLowerCase() === "cursor")) {
    out.push(normalizeAccount({
      email: String(value.email || "").trim(),
      sub: String(value.sub || value.userId || value.user_id || "").trim(),
      name: String(value.name || value.email || "").trim() || `cursor-${accessToken.slice(0, 8)}`,
      accessToken,
      machineId: String(value.machineId || value.machine_id || fallbackMachineId || "").trim(),
      expiresAt: value.expired || value.expiresAt || value.expires_at || "",
      source,
      enabled: value.disabled === true ? false : value.enabled !== false
    }));
    return out;
  }

  if (value.credentials && typeof value.credentials === "object") {
    collectFromJsonValue(value.credentials, out, source, fallbackMachineId);
  }
  return out;
}

/**
 * 解析 Cursor 订阅号批量导入载荷，返回 normalizeAccount 列表。
 * @param {string} raw 粘贴文本
 * @param {{ machineId?: string }} options 本机 machine id（按用户确认统一复用）
 */
export function parseCursorSubscriptionImportPayload(raw, { machineId = "" } = {}) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "import payload is empty", accounts: [] };

  if (looksLikeJson(text)) {
    try {
      const value = JSON.parse(text);
      const accounts = collectFromJsonValue(value, [], "cursor-paste-json", machineId);
      if (accounts.length) return { ok: true, accounts, sourceFormat: "json" };
    } catch {
      // fall through to NDJSON
    }
    const ndjson = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || !looksLikeJson(trimmed)) continue;
      try {
        ndjson.push(...collectFromJsonValue(JSON.parse(trimmed), [], "cursor-paste-ndjson", machineId));
      } catch {}
    }
    if (ndjson.length) return { ok: true, accounts: ndjson, sourceFormat: "ndjson" };
  }

  const accounts = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const account = accountFromPlainLine(trimmed, { machineId });
    if (account) accounts.push(account);
  }

  if (!accounts.length) {
    return {
      ok: false,
      error: "未识别到 Cursor 订阅凭据：请粘贴 email----…----userId::eyJ… 行，或含 access_token 的 JSON",
      accounts: []
    };
  }
  return { ok: true, accounts, sourceFormat: "cursor-account-list" };
}

/** 粘贴文本导入 Cursor 订阅多号（复用本机 machine id）。 */
export function importCursorSubscriptionAccountsFromText(providerId, raw, {
  machineId = "",
  skipDuplicates = true,
  home
} = {}) {
  const parsed = parseCursorSubscriptionImportPayload(raw, { machineId });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, added: 0, skipped: 0, accounts: [] };
  }
  const ready = parsed.accounts.filter((a) => a.accessToken);
  if (!ready.length) {
    return {
      ok: false,
      error: "没有可用的 Cursor access token",
      added: 0,
      skipped: 0,
      accounts: []
    };
  }
  const result = upsertAccounts(providerId, ready, {
    poolKind: "cursor_subscription",
    skipDuplicates,
    home
  });
  return { ...result, scanned: ready.length, sourceFormat: parsed.sourceFormat };
}

export { jwtExpIso as cursorJwtExpIso };

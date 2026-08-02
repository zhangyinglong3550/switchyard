/**
 * 可选：完整请求体调试落盘（默认关闭）。
 * 文件写在 logs/request-bodies/，SQLite 只存 ref，避免撑爆请求日志库。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, ensureDir, logDir, nowIso } from "./utils.mjs";
import { normalizeSensitiveGuardConfig, redactSensitiveValue } from "./sensitive-guard.mjs";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 200;
const IMAGE_DATA_RE = /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi;
const SECRET_KEY_RE = /^(apiKey|accessToken|refreshToken|sessionToken|idToken|agentPrivateKey|authorization)$/i;

export function normalizeRequestBodyCaptureConfig(input = {}) {
  const maxBytes = Number(input?.maxBytes);
  const maxFiles = Number(input?.maxFiles);
  return {
    enabled: Boolean(input?.enabled),
    maxBytes: Number.isFinite(maxBytes)
      ? Math.min(20 * 1024 * 1024, Math.max(64 * 1024, Math.trunc(maxBytes)))
      : DEFAULT_MAX_BYTES,
    maxFiles: Number.isFinite(maxFiles)
      ? Math.min(5000, Math.max(10, Math.trunc(maxFiles)))
      : DEFAULT_MAX_FILES
  };
}

export function requestBodyCaptureDir(baseLogDir = logDir()) {
  return path.join(baseLogDir, "request-bodies");
}

export function requestBodyCapturePath(ref, baseLogDir = logDir()) {
  const id = String(ref || "").trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return "";
  return path.join(requestBodyCaptureDir(baseLogDir), `${id}.json`);
}

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
      .replace(IMAGE_DATA_RE, "[图片base64已省略]");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, val]) => [
      key,
      SECRET_KEY_RE.test(key) ? "[REDACTED]" : scrubSecrets(val)
    ])
  );
}

function shrinkOversizedStrings(value, state) {
  if (state.bytes <= state.maxBytes) return value;
  if (typeof value === "string") {
    if (value.length <= 400) return value;
    const keep = Math.max(120, Math.floor(value.length * 0.35));
    const next = `${value.slice(0, keep)}\n…[调试落盘体积超限，已再截断]…\n${value.slice(-keep)}`;
    state.bytes -= Buffer.byteLength(value, "utf8");
    state.bytes += Buffer.byteLength(next, "utf8");
    state.truncated = true;
    return next;
  }
  if (Array.isArray(value)) {
    return value.map((item) => shrinkOversizedStrings(item, state));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = shrinkOversizedStrings(val, state);
    }
    return out;
  }
  return value;
}

export function prepareRequestBodyForCapture(body, {
  maxBytes = DEFAULT_MAX_BYTES,
  sensitiveGuard = null
} = {}) {
  let cloned;
  try {
    cloned = body == null ? null : JSON.parse(JSON.stringify(body));
  } catch {
    cloned = { _switchyardCaptureError: "request body is not JSON-serializable" };
  }
  let prepared = scrubSecrets(cloned);
  if (sensitiveGuard) {
    try {
      const guard = normalizeSensitiveGuardConfig(sensitiveGuard);
      const redacted = redactSensitiveValue(prepared, { config: guard });
      prepared = redacted?.value ?? prepared;
    } catch {
      // 脱敏失败不阻断调试落盘
    }
  }
  let text = JSON.stringify(prepared);
  const originalBytes = Buffer.byteLength(text, "utf8");
  let truncated = false;
  if (originalBytes > maxBytes) {
    const state = { bytes: originalBytes, maxBytes, truncated: false };
    prepared = shrinkOversizedStrings(prepared, state);
    text = JSON.stringify(prepared);
    truncated = true;
    // 仍超限则硬截断 JSON 字符串（极端情况）
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      const slice = text.slice(0, Math.max(0, maxBytes - 64));
      prepared = {
        _switchyardCaptureTruncated: true,
        preview: slice,
        note: "请求体过大，已截断为文本预览"
      };
      text = JSON.stringify(prepared);
      truncated = true;
    }
  }
  return {
    body: prepared,
    truncated,
    originalBytes,
    storedBytes: Buffer.byteLength(text, "utf8")
  };
}

function pruneOldCaptures(dir, maxFiles) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const full = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return;
  }
  for (const item of entries.slice(Math.max(0, maxFiles))) {
    try { fs.rmSync(item.full, { force: true }); } catch {}
  }
}

export function captureRequestBody({
  body,
  meta = {},
  captureConfig = null,
  sensitiveGuard = null,
  baseLogDir = logDir()
} = {}) {
  const config = normalizeRequestBodyCaptureConfig(captureConfig || {});
  if (!config.enabled) return null;
  const prepared = prepareRequestBodyForCapture(body, {
    maxBytes: config.maxBytes,
    sensitiveGuard
  });
  const ref = crypto.randomUUID().replace(/-/g, "");
  const dir = requestBodyCaptureDir(baseLogDir);
  ensureDir(dir);
  const file = requestBodyCapturePath(ref, baseLogDir);
  const payload = {
    version: 1,
    ref,
    capturedAt: nowIso(),
    meta,
    truncated: prepared.truncated,
    originalBytes: prepared.originalBytes,
    storedBytes: prepared.storedBytes,
    note: "调试落盘：默认关闭；已做密钥/敏感串脱敏，图片 base64 已替换占位。",
    body: prepared.body
  };
  atomicWriteFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try { fs.chmodSync(file, 0o600); } catch {}
  pruneOldCaptures(dir, config.maxFiles);
  return {
    ref,
    path: file,
    truncated: prepared.truncated,
    originalBytes: prepared.originalBytes,
    storedBytes: prepared.storedBytes
  };
}

export function readCapturedRequestBody(ref, baseLogDir = logDir()) {
  const file = requestBodyCapturePath(ref, baseLogDir);
  if (!file || !fs.existsSync(file)) {
    return { ok: false, error: "未找到完整请求体（可能未开启落盘，或文件已被清理）" };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(file, "utf8"));
    return { ok: true, path: file, payload };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), path: file };
  }
}

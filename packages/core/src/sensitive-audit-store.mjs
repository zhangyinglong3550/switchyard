/**
 * 敏感信息发送审计：可记录完整命中原文（本机 0600 日志，高敏感）。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, logDir, nowIso } from "./utils.mjs";

const MAX_EVENTS = 2_000;
const MAX_VALUE_CHARS = 500;
const MAX_VALUES_PER_HIT = 20;

export function sensitiveAuditFile(homeLogDir = logDir()) {
  return path.join(homeLogDir, "sensitive-audit.jsonl");
}

function readAll(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && row.id);
  } catch {
    return [];
  }
}

function writeAll(file, rows) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function normalizeValues(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const item of values) {
    const text = String(item ?? "");
    if (!text) continue;
    const clipped = text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
    if (!out.includes(clipped)) out.push(clipped);
    if (out.length >= MAX_VALUES_PER_HIT) break;
  }
  return out;
}

/**
 * @param {object} input
 * @param {Array<{ruleId:string,type:string,label?:string,count:number,values?:string[]}>} input.hits
 * @param {boolean} [input.retainOriginal=true] 是否落盘完整命中原文
 */
export function recordSensitiveAudit(input = {}, { file = sensitiveAuditFile() } = {}) {
  const retainOriginal = input.retainOriginal !== false;
  const hits = Array.isArray(input.hits)
    ? input.hits
      .filter((hit) => hit && hit.ruleId && hit.count > 0)
      .map((hit) => ({
        ruleId: String(hit.ruleId),
        type: String(hit.type || hit.ruleId),
        label: String(hit.label || hit.type || hit.ruleId),
        count: Math.max(1, Number(hit.count) || 1),
        values: retainOriginal ? normalizeValues(hit.values) : []
      }))
    : [];
  const action = String(input.action || "redact");
  // 会话放行登记可无命中；发送审计仍要求至少一条命中。
  if (!hits.length && action !== "allow") return null;
  const originals = retainOriginal
    ? hits.flatMap((hit) => (hit.values || []).map((value) => ({
      type: hit.type,
      label: hit.label,
      value
    }))).slice(0, 50)
    : [];
  const previewInput = input.outboundPreview && typeof input.outboundPreview === "object"
    ? input.outboundPreview
    : null;
  const outboundPreview = previewInput
    ? {
      kind: String(previewInput.kind || (action === "redact" ? "redacted" : "plaintext")),
      label: String(previewInput.label || "").slice(0, 80),
      snippets: Array.isArray(previewInput.snippets)
        ? previewInput.snippets.map((item) => String(item || "").slice(0, 280)).filter(Boolean).slice(0, 8)
        : []
    }
    : null;
  const event = {
    id: String(input.id || randomUUID()),
    at: input.at || nowIso(),
    action,
    clientId: input.clientId ? String(input.clientId) : "",
    modelId: input.modelId ? String(input.modelId) : "",
    providerId: input.providerId ? String(input.providerId) : "",
    sessionKey: input.sessionKey ? String(input.sessionKey).slice(0, 200) : "",
    retainOriginal,
    hits,
    originals,
    outboundPreview,
    total: hits.reduce((sum, hit) => sum + hit.count, 0)
  };
  const rows = readAll(file);
  rows.push(event);
  writeAll(file, rows.slice(-MAX_EVENTS));
  return event;
}

export function listSensitiveAudits({
  limit = 100,
  file = sensitiveAuditFile()
} = {}) {
  const size = Math.min(500, Math.max(1, Number(limit) || 100));
  return readAll(file).slice(-size).reverse();
}

export function clearSensitiveAudits({ file = sensitiveAuditFile() } = {}) {
  writeAll(file, []);
  return { ok: true };
}

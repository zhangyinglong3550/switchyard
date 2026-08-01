import fs from "node:fs";
import path from "node:path";
import { logDir, ensureDir, nowIso } from "../../../packages/core/src/utils.mjs";
import { recordRequestEvent } from "./request-log-store.mjs";

const RING = [];
const RING_LIMIT = 500;
const DEFAULT_LOG_MAX_BYTES = 200 * 1024 * 1024;
const SUBSCRIBERS = new Set();
let writeStream = null;
function redactLogValue(value) {
  const secretKeys = /^(apiKey|accessToken|refreshToken|sessionToken|idToken|agentPrivateKey)$/i;
  const scrub = (item) => {
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, secretKeys.test(key) ? "[REDACTED]" : scrub(val)]));
    if (typeof item !== "string") return item;
    return item.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, "Bearer [REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]");
  };
  return scrub(value);
}

function configuredLogMaxBytes() {
  const value = Number(process.env.SWITCHYARD_LOG_MAX_BYTES || DEFAULT_LOG_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : DEFAULT_LOG_MAX_BYTES;
}

function streamUsable(stream) {
  return Boolean(stream) && !stream.destroyed && !stream.closed && stream.writable !== false;
}

/** 轮转/关闭写流时吞掉异步 error，避免 Electron 弹「Cannot call write after a stream was destroyed」。 */
function retireWriteStream(stream = writeStream) {
  if (!stream) return;
  if (writeStream === stream) writeStream = null;
  stream.removeAllListeners("error");
  stream.on("error", () => {});
  try {
    if (!stream.destroyed) stream.destroy();
  } catch {
    // ignore
  }
}

function dropOversizedLogFile(file) {
  const maxBytes = configuredLogMaxBytes();
  try {
    const stat = fs.statSync(file);
    if (stat.size < maxBytes) return;
    retireWriteStream();
    fs.rmSync(file, { force: true });
  } catch {
    // Missing or unreadable log files are handled by createWriteStream below.
  }
}

function ensureWriteStream() {
  const dir = logDir();
  ensureDir(dir);
  const file = path.join(dir, "gateway.log");
  dropOversizedLogFile(file);
  if (streamUsable(writeStream)) return writeStream;
  const stream = fs.createWriteStream(file, { flags: "a" });
  // write() 的 ERR_STREAM_DESTROYED 常以 error 事件抛出，try/catch 接不住。
  stream.on("error", () => {
    if (writeStream === stream) writeStream = null;
  });
  writeStream = stream;
  return writeStream;
}

function writeLogLine(line) {
  try {
    const stream = ensureWriteStream();
    if (!streamUsable(stream)) return;
    stream.write(line, (err) => {
      if (!err) return;
      if (writeStream === stream) writeStream = null;
    });
  } catch {
    writeStream = null;
  }
}

export function appendLog(entry) {
  const enriched = redactLogValue({ ts: nowIso(), ...entry });
  RING.push(enriched);
  if (RING.length > RING_LIMIT) RING.shift();
  writeLogLine(JSON.stringify(enriched) + "\n");
  try {
    if (enriched.requestLog) recordRequestEvent(enriched);
  } catch {
    // SQLite logging is best-effort and must never break gateway requests.
  }
  for (const sub of SUBSCRIBERS) {
    try { sub(enriched); } catch {}
  }
  return enriched;
}

export function snapshotLogs() {
  return RING.slice();
}

export function readLogTail({ maxBytes = 200 * 1024 } = {}) {
  const file = logFilePath();
  try {
    const stat = fs.statSync(file);
    const bytes = Math.max(1, Math.min(Number(maxBytes) || 200 * 1024, 2 * 1024 * 1024));
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return {
        file,
        truncated: start > 0,
        text: buffer.toString("utf8")
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { file, truncated: false, text: "" };
  }
}

export function subscribeLogs(handler) {
  SUBSCRIBERS.add(handler);
  return () => SUBSCRIBERS.delete(handler);
}

export function logFilePath() {
  return path.join(logDir(), "gateway.log");
}

export function closeLogStreamForTest() {
  if (!writeStream) return Promise.resolve();
  const stream = writeStream;
  writeStream = null;
  stream.removeAllListeners("error");
  stream.on("error", () => {});
  return new Promise((resolve) => {
    try {
      if (stream.destroyed || stream.closed) {
        resolve();
        return;
      }
      stream.end(() => resolve());
    } catch {
      resolve();
    }
  });
}

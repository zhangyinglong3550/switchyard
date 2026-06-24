import fs from "node:fs";
import path from "node:path";
import { logDir, ensureDir, nowIso } from "../../../packages/core/src/utils.mjs";
import { recordRequestEvent } from "./request-log-store.mjs";

const RING = [];
const RING_LIMIT = 500;
const SUBSCRIBERS = new Set();
let writeStream = null;

function ensureWriteStream() {
  if (writeStream && !writeStream.closed) return writeStream;
  const dir = logDir();
  ensureDir(dir);
  const file = path.join(dir, "gateway.log");
  writeStream = fs.createWriteStream(file, { flags: "a" });
  return writeStream;
}

export function appendLog(entry) {
  const enriched = { ts: nowIso(), ...entry };
  RING.push(enriched);
  if (RING.length > RING_LIMIT) RING.shift();
  try {
    ensureWriteStream().write(JSON.stringify(enriched) + "\n");
  } catch {
    // ignore log write failures; UI still has the ring
  }
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
  if (!writeStream || writeStream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    writeStream.end(() => {
      writeStream = null;
      resolve();
    });
  });
}

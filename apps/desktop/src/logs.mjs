import fs from "node:fs";
import path from "node:path";
import { logDir, ensureDir, nowIso } from "@switchyard/core";

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
  for (const sub of SUBSCRIBERS) {
    try { sub(enriched); } catch {}
  }
  return enriched;
}

export function snapshotLogs() {
  return RING.slice();
}

export function subscribeLogs(handler) {
  SUBSCRIBERS.add(handler);
  return () => SUBSCRIBERS.delete(handler);
}

export function logFilePath() {
  return path.join(logDir(), "gateway.log");
}

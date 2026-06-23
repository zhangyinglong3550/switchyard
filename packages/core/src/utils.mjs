// Shared utilities for the gateway core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOME = path.join(os.homedir(), ".switchyard");
export const DEFAULT_CONFIG_PATH = path.join(DEFAULT_HOME, "config.json");
export const DEFAULT_LOG_DIR = path.join(DEFAULT_HOME, "logs");
export const DEFAULT_BACKUP_DIR = path.join(DEFAULT_HOME, "backups");

export function configPath() {
  return process.env.SWITCHYARD_CONFIG || DEFAULT_CONFIG_PATH;
}

export function logDir() {
  return process.env.SWITCHYARD_LOG_DIR || DEFAULT_LOG_DIR;
}

export function backupDir() {
  return process.env.SWITCHYARD_BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text" || part.type === "input_text" || part.type === "output_text") return part.text || "";
        if (part.type === "tool_result") return contentToText(part.content);
        if ("content" in part) return contentToText(part.content);
        if ("text" in part) return String(part.text || "");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") {
    if ("text" in content) return String(content.text || "");
    if ("content" in content) return contentToText(content.content);
    return JSON.stringify(content);
  }
  return String(content);
}

export function localEndpoint(url) {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

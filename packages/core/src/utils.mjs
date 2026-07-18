// Shared utilities for the gateway core.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

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
  // 网络错误会带 status=0，直接 writeHead(0) 会让 Node 抛 ERR_HTTP_INVALID_STATUS_CODE
  // （表现为客户端收到 500 + "Invalid status code: 0"）。这里把非法状态统一收敛成 502。
  const code = Number.isFinite(Number(status)) && Number(status) >= 100 && Number(status) <= 999
    ? Number(status)
    : 502;
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

/**
 * 原子写入：先写临时文件再 rename，避免进程中途崩溃导致配置/账号池文件被截断损坏。
 * POSIX 同设备 rename 是原子的；Windows/跨设备 rename 失败时回退到直接写（非原子但可用）。
 * options 同 fs.writeFileSync，可选 mode 会在写后 chmod 到临时文件。
 */
export function atomicWriteFileSync(file, data, options = {}) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data, options);
  if (options.mode) {
    try { fs.chmodSync(tmp, options.mode); } catch {}
  }
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(file, data, options);
    if (options.mode) {
      try { fs.chmodSync(file, options.mode); } catch {}
    }
  }
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const rawBuffer = decodeRequestBody(Buffer.concat(chunks), req.headers?.["content-encoding"]);
        const raw = rawBuffer.toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function decodeRequestBody(buffer, contentEncoding = "") {
  let out = buffer || Buffer.alloc(0);
  const encodings = String(contentEncoding || "identity")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const encoding of encodings.reverse()) {
    if (encoding === "identity") continue;
    if (encoding === "gzip" || encoding === "x-gzip") out = zlib.gunzipSync(out);
    else if (encoding === "br") out = zlib.brotliDecompressSync(out);
    else if (encoding === "deflate") out = zlib.inflateSync(out);
    else if (encoding === "zstd") out = zstdDecompressSync(out);
    else {
      throw new Error(`Unsupported Content-Encoding: ${encoding}`);
    }
  }
  return out;
}

function zstdDecompressSync(buffer) {
  if (typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buffer);
  const nodeCandidates = [
    process.env.SWITCHYARD_ZSTD_NODE,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node"
  ].filter(Boolean);
  const script = "const fs=require('node:fs');const zlib=require('node:zlib');process.stdout.write(zlib.zstdDecompressSync(fs.readFileSync(0)));";
  for (const node of nodeCandidates) {
    if (!fs.existsSync(node)) continue;
    try {
      return execFileSync(node, ["-e", script], { input: buffer, maxBuffer: Math.max(buffer.length * 20, 64 * 1024 * 1024) });
    } catch {}
  }
  const zstdCandidates = [process.env.SWITCHYARD_ZSTD_BIN, "/opt/homebrew/bin/zstd", "/usr/local/bin/zstd", "/usr/bin/zstd"].filter(Boolean);
  for (const bin of zstdCandidates) {
    if (!fs.existsSync(bin)) continue;
    try {
      return execFileSync(bin, ["-d", "-c"], { input: buffer, maxBuffer: Math.max(buffer.length * 20, 64 * 1024 * 1024) });
    } catch {}
  }
  throw new Error("Content-Encoding zstd is not supported by this runtime and no zstd-capable helper was found");
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

// Native Mirror：把 Grok / Codex / Claude Code / OpenCode 的原生会话文件
// 增量镜像到 SQLite（Session-Core 的统一读视图）。
//
// 设计：
//  - scanAllSessions 已有 8s 缓存，这里再加一层「按 mtime 指纹」的增量判断，
//    会话文件没变就只 upsert 元数据，不重导消息。
//  - 消息解析全部复用各 runtime 已导出的纯函数（parseGrokChatHistory /
//    parseClaudeJsonl / parseCodexRollout / readOpenCodeDbMessages），
//    不拉起 ACP 进程，零副作用。
//  - OpenCode 会话列表走 runtime 的 localOpenCodeRows（storage 目录 / db）。

import fs from "node:fs";
import path from "node:path";
import { scanAllSessions, scanGrokSessions, scanClaudeSessions, scanCodexSessions } from "./local-session-scan.mjs";
import { parseGrokChatHistory } from "./grok-runtime.mjs";
import { parseClaudeJsonl } from "./claude-runtime.mjs";
import { parseCodexRollout } from "./codex-runtime.mjs";
import { readOpenCodeDbMessages } from "./opencode-runtime.mjs";
import { encodeMobileSessionId } from "./session-registry.mjs";

function readJsonlLines(filePath, maxBytes = 12 * 1024 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) return [];
    if (stat.size <= maxBytes) {
      return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    }
    // 大文件读尾部窗口（最近的消息在末尾）。
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, "r");
    try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
    const text = buffer.toString("utf8");
    const firstBreak = text.indexOf("\n");
    return text.slice(firstBreak + 1).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/** OpenCode 会话列表（runtime 内部逻辑，这里独立实现避免实例化 runtime）。 */
function openCodeSessionRows() {
  const rows = [];
  const storageRoot = path.join(process.env.HOME || "", ".local", "share", "opencode", "storage", "message");
  if (!fs.existsSync(storageRoot)) return rows;
  let dirs = [];
  try { dirs = fs.readdirSync(storageRoot, { withFileTypes: true }); } catch { return rows; }
  const byId = new Map();
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith("ses_")) continue;
    const dir = path.join(storageRoot, d.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { continue; }
    for (const name of files) {
      try {
        const msg = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
        const id = String(msg.sessionID || d.name);
        const created = Number(msg.time?.created || 0);
        const current = byId.get(id);
        if (!current || created > current.created) {
          byId.set(id, {
            source: "opencode",
            sessionId: id,
            filePath: dir,
            cwd: msg.path?.cwd || current?.cwd || "",
            mtimeMs: created,
            title: msg.summary?.title || current?.title || id.slice(0, 8),
            preview: "",
            sizeBytes: 0
          });
        }
      } catch {}
    }
  }
  for (const row of byId.values()) rows.push(row);
  return rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function messageRowsFor(session) {
  const source = String(session.source || "");
  const filePath = session.filePath || "";
  try {
    if (source === "grok") {
      const chat = path.join(filePath, "chat_history.jsonl");
      if (!fs.existsSync(chat)) return [];
      return parseGrokChatHistory(readJsonlLines(chat));
    }
    if (source === "claude") {
      return parseClaudeJsonl(readJsonlLines(filePath));
    }
    if (source === "codex") {
      return parseCodexRollout(readJsonlLines(filePath));
    }
    if (source === "opencode") {
      return readOpenCodeDbMessages(session.sessionId) || [];
    }
  } catch {
    return [];
  }
  return [];
}

export function createNativeMirror({
  mirror,
  intervalMs = 30_000,
  now = () => Date.now()
} = {}) {
  if (!mirror) throw new Error("native mirror 需要 sqlite mirror 实例");
  let timer = null;
  let running = false;
  let lastRunAt = 0;

  const scanOnce = async () => {
    if (running) return { skipped: true };
    running = true;
    lastRunAt = now();
    try {
      const scanned = [
        ...scanAllSessions({ limit: 400 }),
        ...openCodeSessionRows()
      ];
      let imported = 0;
      let updated = 0;
      let messageCount = 0;
      for (const session of scanned) {
        const agentId = String(session.source || "");
        const nativeId = String(session.sessionId || "");
        if (!agentId || !nativeId) continue;
        const mtimeMs = Number(session.mtimeMs) || 0;
        const mobileId = encodeMobileSessionId(agentId, nativeId);
        // 增量：mtime 未变则跳过消息重导（元数据仍更新）。
        const existing = mirror.sessionByMobileId(mobileId);
        const needsMessages = !existing || existing.mtime !== mtimeMs;
        const title = String(session.title || "").slice(0, 240);
        mirror.upsertSession({
          agentId, nativeId, mobileId,
          title,
          state: "completed",
          updatedAt: mtimeMs || now(),
          project: "",
          directory: String(session.cwd || ""),
          archived: false,
          lastMirrorAt: now(),
          mtime: mtimeMs
        });
        if (needsMessages) {
          const messages = messageRowsFor(session);
          mirror.replaceMessages(agentId, nativeId, messages);
          messageCount += messages.length;
          imported += 1;
        } else {
          updated += 1;
        }
      }
      return { scanned: scanned.length, imported, updated, messageCount };
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) return;
    timer = setInterval(() => { scanOnce().catch(() => {}); }, Math.max(5_000, Number(intervalMs) || 30_000));
    timer.unref?.();
    return scanOnce().catch(() => {});
  };

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
  };

  return { start, stop, scanOnce, lastRunAt: () => lastRunAt };
}

// 会话级思考缓存（WorkBuddy / CodeBuddy 专用）
//
// 背景：上游在严格思维链模式下要求「每轮 assistant 都把上一轮的真实思考回传」，
// 否则返回 11155 reasoning_content_missing。ZCode 这类客户端不回传思考，
// 于是网关替它回传：把上一轮产生的思考按会话记住，下一轮请求时按 assistant 文本匹配回填。
//
// 隐私与边界：
//   - 只存内存，不落盘；TTL 30 分钟；最多 200 个会话、每会话最多 20 轮。
//   - 匹配不上（内容被编辑、会话轮次错位）就不回填 —— 网关随后自动回落到「不思考」稳模式，
//     不会因为缓存缺失而导致请求失败。
import crypto from "node:crypto";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_TURNS_PER_SESSION = 20;
const HASH_PREFIX_CHARS = 200;

/** 指纹：assistant 文本「前 200 字 + 长度」，避免把整段回答留在内存里比对。 */
export function assistantFingerprint(text) {
  const value = String(text || "");
  if (!value.trim()) return "";
  const head = value.slice(0, HASH_PREFIX_CHARS);
  return crypto.createHash("sha1").update(`${value.length}:${head}`).digest("hex");
}

function firstUserText(messages = []) {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (String(message.role || "") !== "user") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
      if (text.trim()) return text;
    }
  }
  return "";
}

/**
 * 会话键：优先显式会话 id；否则用「客户端 + 首条 user 文本指纹」。
 * 取不到任何信息时返回空串（调用方跳过缓存）。
 */
export function resolveReasoningCacheKey(body = {}, { clientId = "", sessionKey = "" } = {}) {
  const explicit = [
    body?.conversation_id, body?.conversationId, body?.session_id,
    body?.sessionId, body?.thread_id, body?.threadId
  ].map((value) => String(value || "").trim()).find(Boolean);
  if (explicit) return `sid:${clientId}::${explicit}`;
  if (sessionKey) return `sess:${clientId}::${String(sessionKey).trim()}`;
  const firstUser = firstUserText(body?.messages);
  if (!firstUser) return "";
  const fingerprint = crypto.createHash("sha1").update(firstUser).digest("hex").slice(0, 16);
  return `msg:${clientId}::${fingerprint}`;
}

export function createReasoningCache({ ttlMs = DEFAULT_TTL_MS, maxSessions = MAX_SESSIONS } = {}) {
  const sessions = new Map();

  function prune(now) {
    for (const [key, entry] of sessions) {
      if (entry.expiresAt <= now) sessions.delete(key);
    }
    while (sessions.size > maxSessions) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
  }

  return {
    /** 记住某一轮 assistant 的思考（按 assistant 文本指纹索引）。 */
    remember(key, assistantText, reasoning) {
      const cacheKey = String(key || "").trim();
      const text = String(assistantText || "");
      const thought = String(reasoning || "");
      if (!cacheKey || !thought.trim() || !text.trim()) return false;
      const fingerprint = assistantFingerprint(text);
      if (!fingerprint) return false;
      const now = Date.now();
      const entry = sessions.get(cacheKey) || { turns: new Map(), updatedAt: now, expiresAt: now + ttlMs };
      entry.turns.set(fingerprint, thought);
      while (entry.turns.size > MAX_TURNS_PER_SESSION) {
        const oldestKey = entry.turns.keys().next().value;
        entry.turns.delete(oldestKey);
      }
      entry.updatedAt = now;
      entry.expiresAt = now + ttlMs;
      sessions.set(cacheKey, entry);
      prune(now);
      return true;
    },

    /** 按 assistant 文本匹配回填 reasoning_content；返回回填条数。 */
    apply(body, key) {
      const cacheKey = String(key || "").trim();
      if (!cacheKey) return 0;
      const now = Date.now();
      const entry = sessions.get(cacheKey);
      if (!entry || entry.expiresAt <= now) return 0;
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      let filled = 0;
      for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        if (String(message.role || "") !== "assistant") continue;
        if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) continue;
        if (typeof message.reasoning === "string" && message.reasoning.trim()) continue;
        const fingerprint = assistantFingerprint(message.content);
        if (!fingerprint) continue;
        const thought = entry.turns.get(fingerprint);
        if (!thought) continue;
        message.reasoning_content = thought;
        filled += 1;
      }
      if (filled) {
        entry.updatedAt = now;
        entry.expiresAt = now + ttlMs;
      }
      return filled;
    },

    size() {
      return sessions.size;
    },
    clear() {
      sessions.clear();
    }
  };
}

// 进程级单例：网关热路径使用；测试可自行 createReasoningCache() 隔离。
export const reasoningCache = createReasoningCache();

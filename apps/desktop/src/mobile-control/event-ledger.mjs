import fs from "node:fs";
import path from "node:path";
import { projectMobileEvent } from "./dto.mjs";

function readEvents(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try { return projectMobileEvent(JSON.parse(line)); } catch { return null; }
      })
      .filter((event) => event && event.id > 0);
  } catch {
    return [];
  }
}

function writeEvents(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, events.length ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

/** 高频流式 chunk：先通知订阅者，磁盘合并写，避免每个 token 全量重写。 */
const DEFERRED_TYPES = new Set(["message", "thinking"]);

export function createEventLedger({
  file,
  now = () => Date.now(),
  maxEvents = 10_000,
  flushDelayMs = 80
} = {}) {
  if (!file) throw new Error("event ledger file 不能为空");
  const resolved = path.resolve(file);
  let events = readEvents(resolved).sort((a, b) => a.id - b.id);
  let nextId = (events.at(-1)?.id || 0) + 1;
  const subscribers = new Set();
  let dirty = false;
  let flushTimer = null;
  const delay = Math.max(0, Number(flushDelayMs) || 0);

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!dirty) return;
    dirty = false;
    writeEvents(resolved, events);
  };

  const scheduleFlush = () => {
    dirty = true;
    if (delay <= 0) {
      flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(flush, delay);
    flushTimer.unref?.();
  };

  const append = (input = {}) => {
    const event = projectMobileEvent({
      ...input,
      id: nextId++,
      createdAt: input.createdAt || new Date(now()).toISOString()
    });
    events.push(event);
    const limit = Math.max(1, Number(maxEvents) || 1);
    if (events.length > limit) events = events.slice(-limit);
    // 用户消息 / 状态 / 错误 / 审批必须立刻落盘；assistant 流式 chunk 可合并写。
    const defer = DEFERRED_TYPES.has(event.type) && event.role !== "user";
    if (defer) scheduleFlush();
    else {
      dirty = true;
      flush();
    }
    for (const subscriber of subscribers) {
      try { subscriber({ ...event }); } catch {}
    }
    return { ...event };
  };

  const list = ({ after = 0, sessionId = "", limit = 500 } = {}) => {
    const cursor = Number(after) || 0;
    const session = String(sessionId || "");
    const size = Math.min(2000, Math.max(1, Number(limit) || 500));
    return events
      .filter((event) => event.id > cursor && (!session || event.sessionId === session))
      .slice(0, size)
      .map((event) => ({ ...event }));
  };

  return {
    file: resolved,
    append,
    list,
    flush,
    subscribe(handler) {
      if (typeof handler !== "function") throw new TypeError("event subscriber 必须是函数");
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    latestId: () => events.at(-1)?.id || 0,
    oldestId: () => events[0]?.id || 0
  };
}

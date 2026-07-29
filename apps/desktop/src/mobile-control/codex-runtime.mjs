import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { scanCodexSessions } from "./local-session-scan.mjs";
import { mergeTool, reasoningText, textValue, toolFrom, toolMessage } from "./message-parts.mjs";
import { materializeImageAttachments } from "./temp-attachments.mjs";
import { applyGoalTool, deriveGoalFromMessages } from "./goal-state.mjs";

const CAPABILITIES = Object.freeze({
  sendMessage: true,
  setModel: true,
  setEffort: true,
  cancel: true,
  rename: true,
  archive: true,
  unarchive: true,
  delete: true,
  fork: true,
  compact: true,
  approve: true
});


function archivedCodexSessionIds(home = os.homedir()) {
  const root = path.join(home, ".codex", "archived_sessions");
  const ids = new Set();
  if (!fs.existsSync(root)) return ids;
  const walk = (directory) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const match = entry.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (match) ids.add(match[1]);
      }
    }
  };
  walk(root);
  return ids;
}

function sandboxPolicy(permissionMode) {
  if (permissionMode === "read-only") {
    return { type: "readOnly", networkAccess: false };
  }
  if (permissionMode === "workspace-write") {
    return { type: "workspaceWrite", writableRoots: [], networkAccess: false };
  }
  if (permissionMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  return null;
}

function statusName(value) {
  const raw = typeof value === "string" ? value : value?.type || value?.status || "";
  const status = String(raw || "").toLowerCase();
  if (["running", "active", "in_progress", "inprogress"].includes(status)) return "running";
  if (status.includes("approval")) return "waiting_for_approval";
  if (["failed", "error"].includes(status)) return "failed";
  if (["cancelled", "canceled", "interrupted"].includes(status)) return "cancelled";
  if (["incomplete"].includes(status)) return "incomplete";
  if (["queued", "pending"].includes(status)) return "queued";
  return "completed";
}

function isoFromTimestamp(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number < 1e12 ? number * 1000 : number).toISOString();
}

function threadRows(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.threads)) return result.threads;
  return [];
}

function taggedNotificationTitle(value) {
  const source = String(value || "");
  const match = source.match(/^\s*<([a-z][a-z0-9_.-]*)>\s*([\s\S]+?)\s*$/i);
  if (!match) return "";
  let payload;
  try { payload = JSON.parse(match[2]); } catch { return ""; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const status = payload.status && typeof payload.status === "object" ? payload.status : null;
  const entry = status && (Object.entries(status).find(([key]) => /^(completed|complete|done|failed|error|running|pending)$/i.test(key)) || Object.entries(status)[0]);
  const text = typeof entry?.[1] === "string"
    ? entry[1]
    : [payload.message, payload.summary, payload.content, payload.output, payload.result, payload.text].find((item) => typeof item === "string" && item.trim()) || "";
  if (!text) return "";
  const first = String(text).replace(/[*`_#]/g, "").replace(/\s+/g, " ").trim().slice(0, 88);
  if (!first) return "";
  const prefix = String(match[1]).toLowerCase() === "subagent_notification" ? "子任务" : "Agent 通知";
  return `${prefix}：${first}`;
}

export function cleanCodexSessionTitle(value, fallback = "Codex 任务") {
  const tagged = taggedNotificationTitle(value);
  return tagged || String(value || "").trim() || fallback;
}

function normalizeThread(thread = {}) {
  const cwd = thread.cwd || thread.directory || "";
  return {
    id: String(thread.id || ""),
    agentId: "codex",
    name: cleanCodexSessionTitle(thread.name || thread.title || thread.id || "Codex 任务"),
    state: statusName(thread.status),
    updatedAt: isoFromTimestamp(thread.updatedAt || thread.updated_at || thread.createdAt || thread.created_at),
    model: String(thread.model || ""),
    directory: String(cwd || ""),
    project: cwd ? path.basename(cwd) : "",
    archived: Boolean(thread.archived),
    capabilities: { ...CAPABILITIES }
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    return item?.text || item?.content || "";
  }).filter(Boolean).join("\n");
}

function normalizeItem(item = {}) {
  const type = String(item.type || "");
  if (type === "userMessage" || type === "user_message") {
    return { role: "user", text: contentText(item.content), kind: type };
  }
  if (type === "agentMessage" || type === "agent_message") {
    return { role: "assistant", text: item.text || contentText(item.content), kind: type };
  }
  if (type.toLowerCase().includes("reasoning") || type.toLowerCase().includes("thought")) {
    return { role: "assistant", text: item.text || contentText(item.content), kind: "thinking" };
  }
  if (type === "function_call" || type === "custom_tool_call" || type.toLowerCase().includes("tool") || type.toLowerCase().includes("command")) {
    return toolMessage(item, item.title || item.name || item.command || "工具调用");
  }
  const text = item.text || contentText(item.content);
  return text ? { role: item.role || "assistant", text, kind: type || "message" } : null;
}

function normalizeMessages(thread = {}, { limit = 500 } = {}) {
  // Thread/read returns whole turns. Work backwards and stop once the phone's
  // bounded history window is full, instead of normalizing every item in a
  // months-long conversation before the registry can render its first screen.
  const messages = [];
  const max = Math.max(1, Number(limit) || 500);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let turnIndex = turns.length - 1; turnIndex >= 0 && messages.length < max; turnIndex -= 1) {
    const turn = turns[turnIndex] || {};
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (let itemIndex = items.length - 1; itemIndex >= 0 && messages.length < max; itemIndex -= 1) {
      const message = normalizeItem(items[itemIndex]);
      if (message?.text) messages.unshift({ ...message, turnId: turn.id || null });
    }
  }
  return messages;
}

function localThread(row = {}) {
  const cwd = String(row.cwd || "");
  return {
    id: String(row.sessionId || ""),
    agentId: "codex",
    name: cleanCodexSessionTitle(row.title || row.preview || row.sessionId || "Codex 任务"),
    state: "completed",
    updatedAt: Number(row.mtimeMs) ? new Date(row.mtimeMs).toISOString() : null,
    model: "",
    directory: cwd,
    project: cwd ? path.basename(cwd) : "",
    archived: false,
    capabilities: { ...CAPABILITIES }
  };
}

// Codex desktop/app wraps system-injected blocks (recommended_plugins,
// environment_context, instructions, AGENTS.md …) into user-role message parts.
// They must never render as user bubbles on the phone.
const CODEX_INJECTION_RE = /^\s*<\/?(recommended_plugins|environment_context|permissions[ _]?instructions|apps_instructions|user_instructions|agent_instructions|developer_instructions|collaboration_mode|skills_instructions|plugins_instructions|system-reminder|INSTRUCTIONS|AGENTS|app-context)[\s>]/i;

export function cleanCodexUserPart(value) {
  const text = String(value || "");
  if (!text.trim()) return "";
  if (CODEX_INJECTION_RE.test(text)) return "";
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").trim();
}

export function parseCodexRollout(lines, { limit = 500 } = {}) {
  const messages = [];
  const toolById = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "response_item") continue;
      const item = entry.payload || {};
      const type = String(item.type || "");
      if (type === "message") {
        const role = item.role === "user" ? "user" : item.role === "assistant" ? "assistant" : "";
        if (!role) continue;
        for (const part of Array.isArray(item.content) ? item.content : []) {
          const partType = String(part?.type || "text");
          const text = String(part?.text || part?.input_text || part?.output_text || "");
          if (!text) continue;
          if (role === "user" && !partType.includes("reasoning")) {
            const cleaned = cleanCodexUserPart(text);
            if (cleaned) messages.push({ role: "user", text: cleaned, kind: "text" });
            continue;
          }
          messages.push({ role: partType.includes("reasoning") ? "assistant" : role, text, kind: partType.includes("reasoning") ? "thinking" : "text" });
        }
      } else if (type.includes("reasoning")) {
        const text = reasoningText(item);
        if (text) messages.push({ role: "assistant", text, kind: "thinking" });
      } else if (type === "function_call_output" || type === "custom_tool_call_output" || type.endsWith("_output")) {
        const id = String(item.call_id || item.tool_call_id || item.id || "");
        const existing = toolById.get(id);
        const patch = toolFrom(item, "completed");
        if (existing) {
          existing.tool = mergeTool(existing.tool, patch);
          existing.text = existing.tool.title || existing.tool.name || existing.text;
        } else {
          const message = toolMessage(patch);
          messages.push(message);
          if (id) toolById.set(id, message);
        }
      } else if (type === "function_call" || type === "custom_tool_call" || type.includes("tool") || type.includes("command") || type === "web_search_call") {
        const message = toolMessage(toolFrom(item, item.status ? "completed" : "running"));
        messages.push(message);
        if (message.tool.id) toolById.set(message.tool.id, message);
      }
    } catch {}
  }
  return messages.slice(-Math.max(1, Number(limit) || 500));
}

const LOCAL_ROLLOUT_FULL_READ_MAX_BYTES = 8 * 1024 * 1024;
const LOCAL_ROLLOUT_TAIL_BYTES = 6 * 1024 * 1024;

function readRolloutLines(filePath, maxBytes = LOCAL_ROLLOUT_FULL_READ_MAX_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) return fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  // Large historical rollouts can make app-server thread/read expand for tens
  // of seconds. The phone only needs the recent window, so read a bounded tail
  // and discard the first partial JSONL record.
  const length = Math.min(LOCAL_ROLLOUT_TAIL_BYTES, stat.size);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, "r");
  try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
  const text = buffer.toString("utf8");
  const firstBreak = text.indexOf("\n");
  return text.slice(firstBreak < 0 ? text.length : firstBreak + 1).split(/\r?\n/).filter(Boolean);
}

function localMessages(row, { limit = 500 } = {}) {
  if (!row?.filePath) return [];
  try { return parseCodexRollout(readRolloutLines(row.filePath), { limit }); } catch { return []; }
}

function rolloutMessageText(payload = {}) {
  return (Array.isArray(payload.content) ? payload.content : [])
    .map((part) => part?.text || part?.output_text || "")
    .filter(Boolean)
    .join("\n");
}

// Desktop Codex writes its rollout JSONL while generating, but its separate
// app-server does not always forward those notifications to Switchyard. This
// normalizes just-appended rollout records into the same live event shape used
// by CLI-owned sessions so the phone can follow a Desktop-owned thread.
export function projectCodexRolloutLiveEntry(entry = {}) {
  const payload = entry?.payload || {};
  if (entry.type === "response_item") {
    const itemType = String(payload.type || "").toLowerCase();
    if (itemType === "message" && payload.role === "assistant") {
      const summary = rolloutMessageText(payload);
      return summary ? { type: "message", role: "assistant", summary, runtimeEvent: "codex/rollout-message" } : null;
    }
    if (itemType.includes("reasoning")) {
      const summary = reasoningText(payload);
      return summary ? { type: "thinking", role: "assistant", summary, runtimeEvent: "codex/rollout-reasoning" } : null;
    }
    if (itemType === "function_call" || itemType === "custom_tool_call" || itemType.includes("tool") || itemType.includes("command")) {
      const tool = toolFrom(payload, "running");
      return { type: "tool", role: "tool", summary: tool.title || tool.name || "工具调用", tool, runtimeEvent: "codex/rollout-tool" };
    }
    if (itemType.endsWith("_output")) {
      const tool = toolFrom(payload, "completed");
      return { type: "tool", role: "tool", summary: tool.title || tool.name || "工具调用", tool, runtimeEvent: "codex/rollout-tool-output" };
    }
  }
  if (entry.type === "event_msg") {
    if (payload.type === "agent_message" && payload.message) {
      return { type: "message", role: "assistant", summary: String(payload.message), runtimeEvent: "codex/rollout-agent-message" };
    }
    if (["turn_completed", "turn_failed", "turn_cancelled"].includes(String(payload.type || ""))) {
      const status = payload.type === "turn_failed" ? "failed" : payload.type === "turn_cancelled" ? "cancelled" : "completed";
      return { type: "status", summary: status, runtimeEvent: `codex/rollout-${payload.type}` };
    }
  }
  return null;
}

function splitLines(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += String(chunk);
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
    }
  };
}

function notificationItem(frame = {}) {
  const params = frame.params || {};
  return params.item || params.outputItem || null;
}

function notificationItemType(frame = {}) {
  return String(notificationItem(frame)?.type || "").toLowerCase();
}

function eventType(frame = {}) {
  const name = String(frame.method || "");
  const itemType = notificationItemType(frame);
  if (name.includes("requestApproval")) return "approval";
  // Desktop Codex commonly emits generic `item/updated` notifications. The
  // concrete item type — not the notification method — carries whether it is
  // streamed assistant text, reasoning, a tool call, or an execution plan.
  if (itemType === "agent_message" || itemType === "agentmessage" || itemType === "message") return "message";
  if (itemType.includes("reasoning") || itemType.includes("thought")) return "thinking";
  if (itemType === "function_call" || itemType === "custom_tool_call" || itemType.includes("tool") || itemType.includes("command")) return "tool";
  if (itemType === "error") return "error";
  if (name.toLowerCase().includes("reasoning") || name.toLowerCase().includes("thought")) return "thinking";
  if (name.includes("agentMessage") || name.includes("message")) return "message";
  if (name.includes("command") || name.includes("tool")) return "tool";
  if (name.includes("failed") || name.includes("error")) return "error";
  return "status";
}

function eventSummary(frame, type = eventType(frame)) {
  const params = frame.params || {};
  const method = String(frame.method || "");
  const item = notificationItem(frame);
  if (type === "thinking") return reasoningText(item || params);
  if (type === "message") {
    // Delta events carry only the newly generated text. Generic item updates
    // tend to carry the accumulated item text and are de-duplicated below.
    return textValue(params.delta?.text ?? params.delta ?? params.text ?? item?.delta ?? item?.text ?? item?.content ?? "");
  }
  if (type === "tool") return toolFrom(item || params, method.includes("completed") ? "completed" : "running").title || "工具调用";
  if (method.includes("completed")) return String(params.turn?.status || params.status || "completed");
  if (method.includes("failed")) return String(params.error?.message || params.error || "failed");
  if (method.includes("requestApproval")) return String(params.reason || params.command || "等待审批");
  return String(params.message || params.status || method);
}

function streamedItemDelta({ sessionId, type, frame, summary, snapshots }) {
  if (!summary || !["message", "thinking"].includes(type)) return summary;
  const method = String(frame.method || "").toLowerCase();
  if (method.includes("delta")) return summary;
  const item = notificationItem(frame);
  const itemId = String(item?.id || item?.item_id || "");
  if (!itemId) return summary;
  const key = `${sessionId}:${type}:${itemId}`;
  const previous = snapshots.get(key) || "";
  snapshots.set(key, summary);
  if (summary === previous) return "";
  if (previous && summary.startsWith(previous)) return summary.slice(previous.length);
  return summary;
}

export function createCodexRuntime({
  client,
  overlay,
  command = process.env.SWITCHYARD_CODEX_BINARY || "codex",
  env,
  spawnProcess = spawnChild,
  scanSessions = scanCodexSessions,
  scanArchived = archivedCodexSessionIds
} = {}) {
  if (!client?.request || !client?.subscribe) throw new Error("Codex runtime 需要已连接的 app-server client");
  const subscribers = new Set();
  const activeTurns = new Map();
  const activeNative = new Map();
  const selectedModels = new Map();
  const selectedEfforts = new Map();
  const selectedPermissions = new Map();
  const streamedItemSnapshots = new Map();
  const rolloutTails = new Map();
  const recentRolloutEvents = new Map();
  const liveGoals = new Map();
  let rolloutPollTimer = null;
  const mentionPaths = new Map();
  let mentionCache = { at: 0, cwd: "", rows: [] };

  const emit = (event, frame = null) => {
    const sessionId = String(event?.sessionId || "");
    let goal = event?.goal || null;
    if (sessionId && event?.tool) {
      goal = applyGoalTool(liveGoals.get(sessionId), event.tool);
      if (goal) liveGoals.set(sessionId, goal);
    }
    const projected = goal ? { ...event, goal } : event;
    for (const subscriber of subscribers) {
      try { subscriber(projected, frame); } catch {}
    }
  };
  const emitRolloutEvent = (sessionId, event) => {
    if (!event?.summary && event?.type !== "tool") return;
    const fingerprint = `${sessionId}:${event.type}:${event.tool?.id || ""}:${event.summary || ""}`;
    const seenAt = recentRolloutEvents.get(fingerprint) || 0;
    if (Date.now() - seenAt < 2_000) return;
    recentRolloutEvents.set(fingerprint, Date.now());
    if (recentRolloutEvents.size > 500) {
      for (const [key, at] of recentRolloutEvents) if (Date.now() - at > 10_000) recentRolloutEvents.delete(key);
    }
    emit({ sessionId, ...event });
  };
  const pollRolloutTails = () => {
    for (const [sessionId, tail] of rolloutTails) {
      let stat;
      try { stat = fs.statSync(tail.filePath); } catch { rolloutTails.delete(sessionId); continue; }
      if (stat.size < tail.offset) tail.offset = 0;
      if (stat.size === tail.offset) continue;
      let chunk = "";
      try {
        const length = stat.size - tail.offset;
        const fd = fs.openSync(tail.filePath, "r");
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, tail.offset);
        fs.closeSync(fd);
        chunk = `${tail.buffer}${buffer.toString("utf8")}`;
        tail.offset = stat.size;
        tail.buffer = "";
      } catch { continue; }
      const lines = chunk.split(/\r?\n/);
      tail.buffer = lines.pop() || "";
      for (const line of lines) {
        try {
          const event = projectCodexRolloutLiveEntry(JSON.parse(line));
          if (event) emitRolloutEvent(sessionId, event);
        } catch {}
      }
    }
  };
  const trackDesktopRollout = (sessionId, local) => {
    if (!local?.filePath || rolloutTails.has(sessionId)) return;
    let offset = 0;
    try { offset = fs.statSync(local.filePath).size; } catch { return; }
    rolloutTails.set(sessionId, { filePath: local.filePath, offset, buffer: "" });
    if (!rolloutPollTimer) rolloutPollTimer = setInterval(pollRolloutTails, 650);
  };
  // The app-server is the shared Codex thread authority. Disk rollout scanning
  // is only a compatibility fallback for older desktop threads or when the
  // app-server is temporarily unavailable. Do not route a thread to `codex
  // exec resume` merely because a rollout file happens to exist: that creates
  // a second session owner and is the source of “thread not found” on resume.
  const nativeSession = (sessionId) => scanSessions({ limit: 1000 })
    .find((row) => row.sessionId === String(sessionId));
  const readNativeFallback = (sessionId) => nativeSession(sessionId);
  const isDesktopOwned = (session) => String(session?.originator || "").trim().toLowerCase() === "codex desktop";
  const desktopUnavailable = (error) => new Error(
    `Codex Desktop 会话暂时不可连接：${error?.message || String(error)}`
  );
  const requireDesktopSync = async () => {
    // If the mobile service started while Codex Desktop was not ready, it may
    // be connected to a private app-server. Retry the shared daemon on each
    // Desktop-owned send so reopening a task in Codex recovers without
    // restarting Switchyard.
    if (client.usingProxy !== false) return false;
    if (typeof client.reconnect === "function") {
      try { await client.reconnect(); } catch {}
      if (client.usingProxy !== false) return true;
    }
    const error = new Error(
      "当前 Codex Desktop 没有提供可用的共享会话连接。消息已保留在手机待发送队列，避免只写入本地而桌面看不到。请在桌面 Codex 中重新打开该会话后，在手机点“继续发送”。"
    );
    error.code = "CODEX_DESKTOP_SYNC_UNAVAILABLE";
    error.retryable = true;
    throw error;
  };
  const resumeDesktopThread = async (sessionId) => {
    const resume = async () => {
      const result = await client.request("thread/resume", {
        threadId: String(sessionId),
        excludeTurns: true
      }, 30_000);
      if (!result?.thread?.id && !result?.id) throw new Error(`thread not found: ${sessionId}`);
      return result;
    };
    try {
      return await resume();
    } catch (firstError) {
      if (typeof client.reconnect !== "function") throw desktopUnavailable(firstError);
      try {
        await client.reconnect();
        return await resume();
      } catch (retryError) {
        throw desktopUnavailable(retryError);
      }
    }
  };

  client.subscribe((frame) => {
    const params = frame.params || {};
    const sessionId = String(params.threadId || params.thread?.id || "");
    const turnId = String(params.turnId || params.turn?.id || "");
    if (sessionId && turnId && !String(frame.method || "").includes("completed")) {
      activeTurns.set(sessionId, turnId);
    }
    if (sessionId && String(frame.method || "").match(/completed|failed|cancelled|canceled/)) {
      activeTurns.delete(sessionId);
    }
    const type = eventType(frame);
    const toolSource = notificationItem(frame) || params.command || params.toolCall || params.tool || params;
    const summary = streamedItemDelta({
      sessionId,
      type,
      frame,
      summary: eventSummary(frame, type),
      snapshots: streamedItemSnapshots
    });
    // An item/updated notification with no new text must not create an empty
    // phone bubble. Tool updates still flow so the existing card can refresh.
    if (!summary && ["message", "thinking"].includes(type)) return;
    const event = {
      sessionId,
      type,
      summary,
      runtimeEvent: frame.method,
      turnId: turnId || null,
      ...(type === "approval" && frame.kind === "request" ? {
        requestId: frame.id,
        request: { ...params, method: String(frame.method || "") }
      } : {}),
      ...(type === "tool" ? { tool: toolFrom(toolSource, String(frame.method || "").includes("completed") ? "completed" : "running") } : {})
    };
    emit(event, frame);
  });

  const listSessions = async ({ cursor, limit = 100, archived = false } = {}) => {
    // Codex Desktop owns a different app-server process, so its local rollouts
    // are intentionally merged even when this helper's app-server is offline.
    const rows = new Map();
    const archivedIds = scanArchived();
    try {
      const result = await client.request("thread/list", {
        cursor: cursor || null,
        limit,
        archived
      });
      for (const row of threadRows(result)) {
        const normalized = normalizeThread(row);
        if (archivedIds.has(normalized.id)) normalized.archived = true;
        if (normalized.archived === Boolean(archived)) rows.set(normalized.id, normalized);
      }
    } catch {
      // Local disk history is still a valid, resumable source of truth.
    }
    for (const row of scanSessions({ limit: 500 })) {
      const normalized = localThread(row);
      if (archivedIds.has(normalized.id)) normalized.archived = true;
      if (normalized.archived === Boolean(archived) && !rows.has(normalized.id)) rows.set(normalized.id, normalized);
    }
    return [...rows.values()];
  };

  const readSession = async (sessionId, { messageLimit = 500 } = {}) => {
    const sid = String(sessionId);
    const limit = Math.min(500, Math.max(1, Number(messageLimit) || 500));
    const local = readNativeFallback(sid);
    // Start tailing only after the phone opened the Desktop thread. This keeps
    // idle cost bounded while giving the active conversation live updates.
    if (isDesktopOwned(local)) trackDesktopRollout(sid, local);
    // Some Codex rollouts are tens or hundreds of megabytes. Asking app-server
    // to materialize those whole threads can block the mobile request until its
    // HTTP timeout. Serve the bounded local tail immediately; it is the same
    // durable transcript and is sufficient for the phone's recent-message view.
    if (local && Number(local.sizeBytes) > LOCAL_ROLLOUT_FULL_READ_MAX_BYTES) {
      const row = localThread(local);
      const messages = localMessages(local, { limit });
      return {
        ...row,
        model: selectedModels.get(sid) || row.model,
        messages,
        goal: (() => { const value = deriveGoalFromMessages(messages); if (value) liveGoals.set(sid, value); return value; })()
      };
    }
    let nativeError;
    // Always try the shared app-server first. This works for both threads
    // created on the phone and threads created in the desktop Codex UI.
    try {
      const result = await client.request("thread/read", { threadId: sid, includeTurns: true });
      const thread = result?.thread || result || {};
      if (thread.id || result?.thread) {
        return {
          ...normalizeThread(thread),
          model: selectedModels.get(sid) || thread.model || "",
          messages: normalizeMessages(thread, { limit }),
          goal: (() => { const value = deriveGoalFromMessages(normalizeMessages(thread, { limit: 500 })); if (value) liveGoals.set(sid, value); return value; })(),
          turns: Array.isArray(thread.turns) ? thread.turns.length : 0
        };
      }
    } catch (error) {
      nativeError = error;
    }
    if (local) {
      const row = localThread(local);
      return {
        ...row,
        model: selectedModels.get(sid) || row.model,
        messages: localMessages(local, { limit }),
        goal: (() => { const value = deriveGoalFromMessages(localMessages(local, { limit: 500 })); if (value) liveGoals.set(sid, value); return value; })()
      };
    }
    throw nativeError || new Error(`Codex 线程不存在：${sid}`);
  };

  const createSession = async ({ cwd, title, model, effort, permissionMode } = {}) => {
    const params = {
      cwd: String(cwd || ""),
      ...(model ? { model: String(model) } : {}),
      ...(effort ? { effort: String(effort) } : {}),
      ...(permissionMode ? { sandbox: String(permissionMode) } : {}),
      threadSource: "user"
    };
    const result = await client.request("thread/start", params, 60_000);
    const sessionId = String(result?.thread?.id || result?.id || "");
    if (!sessionId) throw new Error("Codex 未返回 thread id");
    if (String(title || "").trim()) {
      await client.request("thread/name/set", {
        threadId: sessionId,
        name: String(title).trim().slice(0, 200)
      });
    }
    if (model) selectedModels.set(sessionId, String(model));
    if (effort) selectedEfforts.set(sessionId, String(effort));
    if (permissionMode) selectedPermissions.set(sessionId, String(permissionMode));
    return { sessionId };
  };

  const listMentions = async ({ cwd = "" } = {}) => {
    const directory = String(cwd || "");
    if (mentionCache.cwd === directory && Date.now() - mentionCache.at < 60_000) {
      return mentionCache.rows.map((row) => ({ ...row }));
    }
    const result = await client.request("plugin/installed", {
      ...(directory ? { cwds: [directory] } : {})
    }, 30_000);
    const rows = [];
    const localPaths = new Map();
    const listed = spawnSync(command, ["plugin", "list", "--json"], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HOME: os.homedir(), ...(env || {}) }
    });
    try {
      const local = JSON.parse(listed.stdout || "{}");
      for (const plugin of local.installed || []) {
        const name = String(plugin?.name || plugin?.pluginId || "").split("@")[0];
        const pluginPath = String(plugin?.source?.path || "");
        if (name && pluginPath && plugin?.installed && plugin?.enabled !== false) localPaths.set(name, pluginPath);
      }
    } catch {}
    mentionPaths.clear();
    for (const marketplace of result?.marketplaces || []) {
      for (const plugin of marketplace?.plugins || []) {
        if (!plugin?.installed || plugin?.enabled === false) continue;
        const name = String(plugin.name || plugin.id || "").trim();
        const pluginPath = String(plugin?.source?.path || localPaths.get(name) || "").trim();
        if (!name || !pluginPath) continue;
        mentionPaths.set(name, pluginPath);
        rows.push({
          name,
          description: String(plugin?.interface?.shortDescription || plugin?.interface?.displayName || "Codex 插件")
        });
      }
    }
    mentionCache = { at: Date.now(), cwd: directory, rows };
    return rows.map((row) => ({ ...row }));
  };

  const mentionInputs = (text) => {
    const names = new Set();
    const matcher = /(^|\s)@([a-zA-Z0-9_.:-]+)/g;
    let match;
    while ((match = matcher.exec(String(text || "")))) names.add(match[2]);
    return [...names].map((name) => mentionPaths.has(name)
      ? { type: "mention", name, path: mentionPaths.get(name) }
      : null).filter(Boolean);
  };

  const sendMessage = async (sessionId, { text, attachments = [] } = {}) => {
    const sid = String(sessionId);
    const attachmentText = attachments.filter((attachment) => attachment.kind !== "image")
      .map((attachment) => `\n\n<attachment name="${attachment.name}">\n${attachment.text || `本地文件路径：${attachment.path || "不可用"}`}\n</attachment>`).join("");
    const promptText = `${String(text || "")}${attachmentText}`;
    const permission = selectedPermissions.get(sid);
    const turnParams = {
      threadId: sid,
      input: [
        ...(promptText ? [{ type: "text", text: promptText, text_elements: [] }] : []),
        ...mentionInputs(promptText),
        ...attachments.filter((attachment) => attachment.kind === "image").map((attachment) => ({
          type: "image",
          url: `data:${attachment.mimeType};base64,${attachment.data}`
        }))
      ],
      ...(selectedModels.get(sid) ? { model: selectedModels.get(sid) } : {}),
      ...(selectedEfforts.get(sid) ? { effort: selectedEfforts.get(sid) } : {}),
      ...(sandboxPolicy(permission) ? { sandboxPolicy: sandboxPolicy(permission) } : {})
    };
    const local = readNativeFallback(sid);
    if (isDesktopOwned(local)) {
      // Never resume or start a Desktop-owned thread through the private
      // fallback app-server: that would make the phone's turn invisible to
      // Codex Desktop. Establish the shared transport first.
      await requireDesktopSync();
      await resumeDesktopThread(sid);
      const result = await client.request("turn/start", turnParams, 60_000);
      const turnId = String(result?.turn?.id || result?.id || "");
      if (turnId) activeTurns.set(sid, turnId);
      return { accepted: true, turnId };
    }
    if (local) {
      // CLI-owned rollouts may not be registered in this app-server process.
      // Probe app-server first, then resume the exact CLI rollout only when
      // the app-server does not know it.
      try {
        const probe = await client.request("thread/read", { threadId: sid, includeTurns: false }, 15_000);
        if (!probe?.thread?.id && !probe?.id) return sendNativeMessage(sid, local, { text, attachments });
      } catch {
        return sendNativeMessage(sid, local, { text, attachments });
      }
    }
    // Keep the same native thread owner as Codex desktop. Some Codex builds
    // can read an old desktop thread through app-server but reject image input
    // on that historical thread. In that case use the native resume path,
    // which supports --image and preserves the original thread id.
    try {
      const result = await client.request("turn/start", turnParams, 60_000);
      const turnId = String(result?.turn?.id || result?.id || "");
      if (turnId) activeTurns.set(sid, turnId);
      return { accepted: true, turnId };
    } catch (error) {
      // A Switchyard/CLI rollout is durable on disk and can be resumed by the
      // native CLI even when the currently connected app-server does not own
      // that thread (for example after Desktop or its proxy restarted). Keep
      // the strict Desktop-owned branch above, but never strand a locally
      // owned Switchyard thread behind an app-server-only "thread not found".
      const missingThread = /thread not found|unknown thread|session not found/i.test(String(error?.message || error));
      if (local && (attachments.some((attachment) => attachment.kind === "image") || missingThread)) {
        return sendNativeMessage(sid, local, { text, attachments });
      }
      throw error;
    }
  };

  const sendNativeMessage = async (sessionId, local, { text, attachments = [] } = {}) => {
    const sid = String(sessionId);
    const materialized = materializeImageAttachments(attachments);
    try {
      const attachmentText = attachments.filter((attachment) => attachment.kind !== "image")
        .map((attachment) => `\n\n<attachment name="${attachment.name}">\n${attachment.text || `本地文件路径：${attachment.path || "不可用"}`}\n</attachment>`).join("");
      const args = ["exec", "resume", sid, "--json", "--skip-git-repo-check"];
      const model = selectedModels.get(sid);
      const effort = selectedEfforts.get(sid);
      const permission = selectedPermissions.get(sid);
      if (model) args.push("--model", model);
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      if (permission) args.push("-c", `sandbox_mode="${permission}"`);
      for (const image of materialized.files) args.push("--image", image.path);
      args.push(`${String(text || "")}${attachmentText}`);
      const child = spawnProcess(command, args, {
        cwd: local.cwd || process.cwd(),
        env: { ...process.env, HOME: os.homedir(), ...(env || {}) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      activeNative.set(sid, child);
      let stderr = "";
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.stdout?.on("data", splitLines((line) => {
        try {
          const frame = JSON.parse(line);
          const item = frame.item || {};
          if (String(frame.type || "").startsWith("item.")) {
            if (item.type === "agent_message" && item.text) emit({ sessionId: sid, type: "message", role: "assistant", summary: String(item.text), runtimeEvent: "codex/cli-agent-message" });
            else if (String(item.type || "").toLowerCase().includes("reasoning")) {
              const summary = reasoningText(item);
              if (summary) emit({ sessionId: sid, type: "thinking", role: "assistant", summary, runtimeEvent: "codex/cli-reasoning" });
            }
            else if (String(item.type || "").includes("command") || String(item.type || "").includes("tool")) {
              const tool = toolFrom(item, frame.type === "item.updated" ? "running" : "completed");
              emit({ sessionId: sid, type: "tool", role: "tool", summary: String(tool.title || tool.name || "工具调用"), tool, runtimeEvent: "codex/cli-tool" });
            }
            else if (item.type === "error") emit({ sessionId: sid, type: "error", summary: String(item.message || "Codex 执行失败"), runtimeEvent: "codex/cli-error" });
          } else if (frame.type === "turn.completed") emit({ sessionId: sid, type: "status", summary: "completed", runtimeEvent: "codex/cli-completed" });
        } catch {}
      }));
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          activeNative.delete(sid);
          code === 0 ? resolve() : reject(new Error(`Codex 恢复会话失败（${code}）：${stderr.trim().slice(-1000) || "无错误输出"}`));
        });
      });
      return { accepted: true };
    } finally {
      materialized.cleanup();
    }
  };

  const setModel = async (sessionId, modelId, effort) => {
    const sid = String(sessionId);
    selectedModels.set(sid, String(modelId));
    if (effort) selectedEfforts.set(sid, String(effort));
  };

  const cancel = async (sessionId) => {
    const id = String(sessionId);
    const native = activeNative.get(id);
    if (native) {
      native.kill("SIGTERM");
      return;
    }
    if (nativeSession(id)) throw new Error("该 Codex 会话没有运行中的任务");
    let turnId = activeTurns.get(id) || "";
    if (!turnId) {
      const detail = await client.request("thread/read", { threadId: id, includeTurns: true });
      const turns = detail?.thread?.turns || [];
      const active = [...turns].reverse().find((turn) => statusName(turn.status) === "running");
      turnId = String(active?.id || "");
    }
    if (!turnId) throw new Error("该 Codex 会话没有运行中的 turn");
    await client.request("turn/interrupt", { threadId: id, turnId });
    activeTurns.delete(id);
  };

  const localOverlay = (sessionId, action, payload) => {
    if (!nativeSession(sessionId)) return false;
    if (action === "rename" && overlay?.rename) {
      return overlay.rename(sessionId, payload);
    }
    if (action === "archive" && overlay?.archive) return overlay.archive(sessionId);
    if (action === "unarchive" && overlay?.unarchive) return overlay.unarchive(sessionId);
    return false;
  };

  return {
    id: "codex",
    label: "Codex",
    capabilities: { ...CAPABILITIES },
    listSessions,
    // Used by the registry to sanitize warm disk indexes before they are
    // returned. Codex keeps archived rollouts outside sessions/, so this is
    // intentionally a cheap local membership check rather than another RPC.
    isArchivedSession(sessionId) {
      return scanArchived().has(String(sessionId));
    },
    readSession,
    createSession,
    listMentions,
    sendMessage,
    setModel,
    async setSettings(sessionId, { effort, permissionMode } = {}) {
      const sid = String(sessionId);
      if (effort) selectedEfforts.set(sid, String(effort));
      if (permissionMode) selectedPermissions.set(sid, String(permissionMode));
    },
    getSettings(sessionId) {
      const sid = String(sessionId);
      return {
        effort: selectedEfforts.get(sid) || "medium",
        permissionMode: selectedPermissions.get(sid) || "workspace-write"
      };
    },
    settings: {
      effortOptions: ["low", "medium", "high", "xhigh"],
      permissionOptions: [
        { id: "read-only", name: "只读", description: "仅查看与分析文件" },
        { id: "workspace-write", name: "可写工作区", description: "允许在当前项目内修改文件" },
        { id: "danger-full-access", name: "完全访问", description: "允许访问本机资源；谨慎使用" }
      ]
    },
    cancel,
    rename: (sessionId, title) => localOverlay(String(sessionId), "rename", String(title || "").trim().slice(0, 200))
      || client.request("thread/name/set", {
        threadId: String(sessionId),
        name: String(title || "").trim().slice(0, 200)
      }),
    archive: (sessionId) => localOverlay(String(sessionId), "archive")
      || client.request("thread/archive", { threadId: String(sessionId) }),
    unarchive: (sessionId) => localOverlay(String(sessionId), "unarchive")
      || client.request("thread/unarchive", { threadId: String(sessionId) }),
    delete: (sessionId) => {
      if (nativeSession(String(sessionId))) {
        throw new Error("桌面 Codex 历史会话不能从手机删除；可先归档隐藏");
      }
      return client.request("thread/delete", { threadId: String(sessionId) });
    },
    fork: async (sessionId) => {
      if (nativeSession(String(sessionId))) {
        throw new Error("桌面 Codex 历史会话暂不支持从手机分支；请在桌面 Codex 中操作");
      }
      const result = await client.request("thread/fork", { threadId: String(sessionId) });
      return { sessionId: String(result?.thread?.id || result?.id || "") };
    },
    compact: (sessionId) => client.request("thread/compact/start", { threadId: String(sessionId) }),
    respond(requestId, result, error) {
      client.respond?.(requestId, result, error);
    },
    subscribe(handler) {
      if (typeof handler !== "function") throw new TypeError("subscriber 必须是函数");
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    close() {
      if (rolloutPollTimer) clearInterval(rolloutPollTimer);
      rolloutPollTimer = null;
      rolloutTails.clear();
      for (const child of activeNative.values()) child.kill("SIGTERM");
      activeNative.clear();
    }
  };
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as spawnChild, spawnSync } from "node:child_process";
import { scanCodexSessions } from "./local-session-scan.mjs";
import { mergeTool, textValue, toolFrom, toolMessage } from "./message-parts.mjs";
import { materializeImageAttachments } from "./temp-attachments.mjs";

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

function normalizeThread(thread = {}) {
  const cwd = thread.cwd || thread.directory || "";
  return {
    id: String(thread.id || ""),
    agentId: "codex",
    name: thread.name || thread.title || thread.id || "Codex 任务",
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

function normalizeMessages(thread = {}) {
  const messages = [];
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      const message = normalizeItem(item);
      if (message?.text) messages.push({ ...message, turnId: turn.id || null });
    }
  }
  return messages;
}

function localThread(row = {}) {
  const cwd = String(row.cwd || "");
  return {
    id: String(row.sessionId || ""),
    agentId: "codex",
    name: row.title || row.preview || row.sessionId || "Codex 任务",
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

export function parseCodexRollout(lines) {
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
        const text = textValue(item.text || item.summary || item.content);
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
  return messages.slice(-500);
}

function localMessages(row) {
  if (!row?.filePath) return [];
  let lines = [];
  try { lines = fs.readFileSync(row.filePath, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
  return parseCodexRollout(lines);
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

function eventSummary(frame) {
  const params = frame.params || {};
  const method = String(frame.method || "");
  if (method.includes("delta")) {
    return String(params.delta?.text || params.delta || params.text || "");
  }
  if (method.includes("completed")) return String(params.turn?.status || params.status || "completed");
  if (method.includes("failed")) return String(params.error?.message || params.error || "failed");
  if (method.includes("requestApproval")) return String(params.reason || params.command || "等待审批");
  return String(params.message || params.status || method);
}

function eventType(method) {
  const name = String(method || "");
  if (name.includes("requestApproval")) return "approval";
  if (name.toLowerCase().includes("reasoning") || name.toLowerCase().includes("thought")) return "thinking";
  if (name.includes("agentMessage") || name.includes("message")) return "message";
  if (name.includes("command") || name.includes("tool")) return "tool";
  if (name.includes("failed") || name.includes("error")) return "error";
  return "status";
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
  const mentionPaths = new Map();
  let mentionCache = { at: 0, cwd: "", rows: [] };

  const emit = (event) => {
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch {}
    }
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
    const type = eventType(frame.method);
    const toolSource = params.item || params.command || params.toolCall || params.tool || params;
    const event = {
      sessionId,
      type,
      summary: eventSummary(frame),
      runtimeEvent: frame.method,
      turnId: turnId || null,
      ...(type === "approval" && frame.kind === "request" ? {
        requestId: frame.id,
        request: { ...params, method: String(frame.method || "") }
      } : {}),
      ...(type === "tool" ? { tool: toolFrom(toolSource, String(frame.method || "").includes("completed") ? "completed" : "running") } : {})
    };
    for (const subscriber of subscribers) {
      try { subscriber(event, frame); } catch {}
    }
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

  const readSession = async (sessionId) => {
    const sid = String(sessionId);
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
          messages: normalizeMessages(thread),
          turns: Array.isArray(thread.turns) ? thread.turns.length : 0
        };
      }
    } catch (error) {
      nativeError = error;
    }
    const local = readNativeFallback(sid);
    if (local) {
      const row = localThread(local);
      return {
        ...row,
        model: selectedModels.get(sid) || row.model,
        messages: localMessages(local)
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
      if (local && attachments.some((attachment) => attachment.kind === "image")) {
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
          if (frame.type === "item.completed" || frame.type === "item.updated") {
            if (item.type === "agent_message" && item.text) emit({ sessionId: sid, type: "message", role: "assistant", summary: String(item.text), runtimeEvent: "codex/cli-agent-message" });
            else if (String(item.type || "").includes("reasoning") && (item.text || item.summary)) emit({ sessionId: sid, type: "thinking", role: "assistant", summary: String(item.text || item.summary), runtimeEvent: "codex/cli-reasoning" });
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
      for (const child of activeNative.values()) child.kill("SIGTERM");
      activeNative.clear();
    }
  };
}

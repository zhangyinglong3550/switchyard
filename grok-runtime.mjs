import { createAcpClient } from "./acp-client.mjs";
import { createAcpRuntime } from "./acp-runtime.mjs";
import { mergeTool, textValue, toolFrom, toolMessage } from "./message-parts.mjs";
import fs from "node:fs";
import path from "node:path";
import { scanGrokSessions } from "./local-session-scan.mjs";

function grokText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => String(part?.text || part?.content || "")).filter(Boolean).join("\n");
  return "";
}

/** Read Grok's local chat_history.jsonl directly, like AionUi's session browser
 * does: no ACP replay, no native process — disk is the source of truth for
 * history, ACP is only for continuing the conversation. */
/** Grok CLI folds <system-reminder> (skills/MCP noise) and <user_query>
 * wrappers into the user turn. Show only the human's actual text. */
export function cleanGrokUserText(value) {
  let text = String(value || "");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ");
  const query = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (query) text = query[1];
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, " ").replace(/\s+/g, " ").trim();
  // Grok CLI prepends an environment block (OS/Shell/Workspace/date) to the
  // first user turn. It is context, not something the human wrote.
  if (/^OS Version:\s*\S+/i.test(text) && /Workspace Path:/i.test(text)) return "";
  return text;
}

export function parseGrokChatHistory(lines) {
  const messages = [];
  const toolById = new Map();
  for (const line of lines) {
    let entry = null;
    try { entry = JSON.parse(line); } catch { continue; }
    const type = String(entry?.type || "");
    const raw = grokText(entry?.content);
    if (type === "user") { const text = cleanGrokUserText(raw); if (text) messages.push({ role: "user", text, kind: "text" }); continue; }
    if (type === "reasoning") {
      const text = textValue(entry.summary || raw).trim();
      if (text) messages.push({ role: "assistant", text, kind: "thinking" });
      continue;
    }
    if (type === "backend_tool_call") {
      const tool = toolFrom({ ...entry.kind, id: entry.kind?.id, name: entry.kind?.tool_type, input: entry.kind?.action, status: entry.kind?.status || "completed" });
      const message = toolMessage(tool, tool.name);
      messages.push(message);
      if (tool.id) toolById.set(tool.id, message);
      continue;
    }
    if (type === "tool_result") {
      const id = String(entry.tool_call_id || "");
      const existing = toolById.get(id);
      const patch = toolFrom({ id, output: entry.content, status: "completed" });
      if (existing) existing.tool = mergeTool(existing.tool, patch);
      else messages.push(toolMessage(patch, textValue(entry.content) || "工具结果"));
      continue;
    }
    const text = raw.trim();
    if (text && type === "assistant") messages.push({ role: "assistant", text, kind: "text" });
  }
  return messages.slice(-500);
}

function localGrokMessages(sessionId) {
  const row = scanGrokSessions({ limit: 1000 }).find((item) => item.sessionId === String(sessionId));
  const file = row?.filePath ? path.join(row.filePath, "chat_history.jsonl") : "";
  if (!file || !fs.existsSync(file)) return null;
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean); } catch { return null; }
  return { row, messages: parseGrokChatHistory(lines) };
}

function grokSessionRows() {
  return scanGrokSessions({ limit: 300 }).map((session) => ({
    sessionId: session.sessionId,
    title: session.title || session.preview || session.sessionId,
    cwd: session.cwd || "",
    updatedAt: new Date(session.mtimeMs).toISOString(),
    model: ""
  }));
}

function assistantPlainText(messages = []) {
  return messages
    .filter((message) => message?.role === "assistant" && message.kind !== "thinking" && !message.tool)
    .map((message) => String(message.text || ""))
    .join("");
}

function projectLiveTail(live = []) {
  const liveLastUser = [...live].map((message, index) => [message, index]).filter(([message]) => message.role === "user").at(-1)?.[1] ?? -1;
  return live.slice(liveLastUser + 1)
    .filter((message) => message.role === "assistant" || message.kind === "thinking" || message.kind === "tool" || message.tool)
    .map((message) => ({
      role: message.role || "assistant",
      text: String(message.text || ""),
      kind: message.kind === "thinking" ? "thinking" : message.tool || message.kind === "tool" ? "tool" : "text",
      ...(message.tool ? { tool: message.tool } : {})
    }))
    .filter((message) => message.text || message.tool);
}

function mergeGrokLiveTail(diskMessages = [], liveMessages = []) {
  const disk = Array.isArray(diskMessages) ? diskMessages : [];
  const live = Array.isArray(liveMessages) ? liveMessages : [];
  if (!live.length) return disk;
  const lastUser = [...disk].map((message, index) => [message, index]).filter(([message]) => message.role === "user").at(-1)?.[1] ?? -1;
  const diskTail = disk.slice(lastUser + 1);
  const diskAssistant = assistantPlainText(diskTail);
  const liveHasUser = live.some((message) => message.role === "user");
  const liveTail = projectLiveTail(live);
  if (!liveTail.length) return disk;
  // 无用户锚点时，live Map 可能残留多轮碎片；仅在磁盘本轮尚无助手正文时补上。
  if (!liveHasUser && diskAssistant) return disk;
  const liveAssistant = assistantPlainText(liveTail);
  // 磁盘还没有本轮助手正文：直接拼上 live。
  if (!diskAssistant) return disk.concat(liveTail);
  // Grok 偶发只落盘很短的半截回答；若 live 明显更长，用 live 替换本轮助手尾。
  if (liveAssistant.length > diskAssistant.length + 16) {
    const kept = diskTail.filter((message) => !(message.role === "assistant" && message.kind !== "thinking" && !message.tool));
    return disk.slice(0, lastUser + 1).concat(kept, liveTail);
  }
  return disk;
}

export function createGrokRuntime({ client, overlay, command, env } = {}) {
  const acp = client || createAcpClient({
    command: command || process.env.SWITCHYARD_GROK_BINARY || "grok",
    args: ["agent", "stdio"],
    env
  });
  const runtime = createAcpRuntime({
    id: "grok",
    label: "Grok Build",
    client: acp,
    overlay,
    listSessionsImpl: ({ cwd }) => {
      const rows = grokSessionRows();
      return {
        sessions: cwd
          ? rows.filter((row) => path.resolve(row.cwd || "") === path.resolve(cwd))
          : rows
      };
    }
  });
  return {
    ...runtime,
    // Grok ACP 的分叉对本机会话不可用（active_sessions 单实例锁 + 无原生
    // fork 落盘），统一隐藏手机端分叉入口。
    capabilities: { ...runtime.capabilities, fork: false },
    async readSession(sessionId) {
      const sid = String(sessionId);
      const local = localGrokMessages(sid);
      if (!local) return runtime.readSession(sid);
      const cwd = local.row.cwd || "";
      // Grok 在 session/prompt -32603 时经常不落盘 assistant；把 ACP 内存里的
      // 本轮流式内容拼回去，避免手机 openSession 刷新后回答消失。
      const messages = mergeGrokLiveTail(local.messages, runtime.liveMessages?.(sid) || []);
      const busy = Boolean(runtime.isBusy?.(sid));
      return {
        id: sid,
        agentId: "grok",
        name: local.row.title || local.row.preview || sid,
        state: busy ? "running" : "completed",
        updatedAt: local.row.mtimeMs ? new Date(local.row.mtimeMs).toISOString() : null,
        model: "",
        directory: cwd,
        project: cwd ? path.basename(cwd) : "",
        archived: false,
        capabilities: { ...runtime.capabilities, fork: false },
        messages
      };
    },
    isBusy(sessionId) {
      return Boolean(runtime.isBusy?.(sessionId));
    },
    // 会话行/详情的 capabilities 统一关闭 fork（ACP 内部仍暴露 fork:true，
    // 但 Grok 会话实际不能从手机分叉）。
    async listSessions(options = {}) {
      const rows = await runtime.listSessions(options);
      return rows.map((row) => ({ ...row, capabilities: { ...(row.capabilities || {}), fork: false } }));
    }
  };
}

export { mergeGrokLiveTail };

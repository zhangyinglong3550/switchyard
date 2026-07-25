import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn as spawnChild } from "node:child_process";
import { scanClaudeSessions } from "./local-session-scan.mjs";
import { mergeTool, toolFrom, toolMessage } from "./message-parts.mjs";

const CAPABILITIES = Object.freeze({ sendMessage: true, setModel: true, setEffort: true, cancel: true, rename: true, archive: true, unarchive: true, delete: false, fork: false, compact: false, approve: false });

function localRows(scanSessions = scanClaudeSessions) {
  return scanSessions({ limit: 500 }).map((session) => ({
    id: session.sessionId, agentId: "claude-code", name: session.title || session.preview || session.sessionId,
    state: "completed", updatedAt: new Date(session.mtimeMs).toISOString(), model: "", directory: session.cwd || "",
    project: session.cwd ? path.basename(session.cwd) : "", archived: false, capabilities: { ...CAPABILITIES }
  }));
}
function textOf(value) { if (typeof value === "string") return value; if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join("\n"); return String(value?.text || ""); }

/** Claude jsonl folds skill injections, slash-command output and system
 * reminders into "user" entries. Only the human's real text should render as a
 * user bubble; command noise is dropped, tool results render as tool cards. */
export function cleanClaudeUserText(value) {
  let text = String(value || "");
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ").trim();
  if (/<command-name>|<local-command-stdout>|^Base directory for this skill/im.test(text)) return "";
  return text.trim();
}

export function parseClaudeJsonl(lines) {
  const rows = [];
  const toolById = new Map();
  for (const line of lines) try {
    const item = JSON.parse(line);
    if (item.isMeta) continue;
    const role = item.type === "user" || item.message?.role === "user" ? "user" : item.type === "assistant" || item.message?.role === "assistant" ? "assistant" : "";
    if (!role) continue;
    const content = item.message?.content ?? item.content ?? item.text;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use") {
          const message = toolMessage(toolFrom({ ...block, status: "running" }), block.name || "工具调用");
          rows.push(message);
          if (message.tool.id) toolById.set(message.tool.id, message);
          continue;
        }
        if (block?.type === "tool_result") {
          const id = String(block.tool_use_id || "");
          const existing = toolById.get(id);
          const patch = toolFrom({ id, name: existing?.tool?.name || "工具调用", output: block.content ?? block.text, status: block.is_error ? "failed" : "completed" });
          if (existing) existing.tool = mergeTool(existing.tool, patch);
          else rows.push(toolMessage(patch, textOf(block.content ?? block.text) || "工具结果"));
          continue;
        }
        const text = textOf(block);
        if (!text.trim()) continue;
        if (block?.type === "thinking") rows.push({ role: "assistant", text, kind: "thinking" });
        else if (role === "user") { const cleaned = cleanClaudeUserText(text); if (cleaned) rows.push({ role: "user", text: cleaned, kind: "text" }); }
        else rows.push({ role: "assistant", text, kind: "text" });
      }
    } else if (typeof content === "string" && content.trim()) {
      if (role === "user") { const cleaned = cleanClaudeUserText(content); if (cleaned) rows.push({ role: "user", text: cleaned, kind: "text" }); }
      else rows.push({ role, text: content, kind: "text" });
    }
  } catch {}
  return rows.slice(-500);
}

function localMessages(sessionId, scanSessions = scanClaudeSessions) {
  const source = scanSessions({ limit: 1000 }).find((row) => row.sessionId === String(sessionId));
  if (!source?.filePath) return [];
  let lines = []; try { lines = fs.readFileSync(source.filePath, "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; }
  return parseClaudeJsonl(lines);
}
function splitLines(onLine) { let buffer = ""; return (chunk) => { buffer += String(chunk); let at; while ((at = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1); if (line) onLine(line); } }; }

/**
 * Mobile Claude uses the installed Claude CLI directly, not claude-agent-acp.
 * ACP is useful for IDE integration but can terminate while another Claude
 * process owns a desktop session; `claude --resume` is its durable native API.
 */
export function createClaudeRuntime({ overlay, command, env, spawnProcess = spawnChild, scanSessions = scanClaudeSessions } = {}) {
  const binary = command || process.env.SWITCHYARD_CLAUDE_BINARY || path.join(os.homedir(), "npm-global", "bin", "claude");
  const subscribers = new Set(); const sessions = new Map(); const selectedModels = new Map(); const selectedEfforts = new Map(); const selectedPermissions = new Map(); const active = new Map();
  const emit = (event) => { for (const handler of subscribers) try { handler(event); } catch {} };
  const remember = (row) => { sessions.set(String(row.id), row); return row; };
  const sessionFor = (id) => sessions.get(String(id)) || localRows(scanSessions).find((row) => row.id === String(id));
  const listSessions = async ({ cwd } = {}) => localRows(scanSessions).filter((row) => !cwd || row.directory === cwd).map(remember);

  const sendMessage = async (sessionId, { text, attachments = [] } = {}) => {
    const sid = String(sessionId); const row = sessionFor(sid); const cwd = row?.directory || process.cwd();
    const images = attachments.filter((item) => item.kind === "image");
    const textAttachments = attachments.filter((item) => item.kind !== "image");
    const useStdin = images.length > 0;
    const context = textAttachments
      .map((item) => `\n\n<attachment name="${item.name}">\n${item.text}\n</attachment>`).join("");
    const exists = Boolean(scanSessions({ limit: 1000 }).find((item) => item.sessionId === sid));
    const args = ["-p", "--verbose", exists ? "--resume" : "--session-id", sid, "--output-format", "stream-json", "--include-partial-messages"];
    const model = selectedModels.get(sid) || row?.model; const effort = selectedEfforts.get(sid); const permissionMode = selectedPermissions.get(sid);
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (permissionMode) args.push("--permission-mode", permissionMode);
    let stdinPayload = null;
    if (useStdin) {
      args.push("--input-format", "stream-json");
      const content = [];
      const prompt = `${String(text || "")}${context}`;
      if (prompt) content.push({ type: "text", text: prompt });
      for (const image of images) {
        content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
      }
      // Claude's stream-json input expects a complete SDK message envelope.
      // A bare { role, content } object is treated as deferred tool input.
      stdinPayload = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
    } else {
      args.push(`${String(text || "")}${context}`);
    }
    const child = spawnProcess(binary, args, { cwd, env: { ...process.env, HOME: os.homedir(), ...(env || {}) }, stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"] });
    if (stdinPayload) { child.stdin.write(stdinPayload); child.stdin.end(); }
    active.set(sid, child); let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.stdout?.on("data", splitLines((line) => { try {
      const frame = JSON.parse(line); const event = frame.event || {}; const delta = event.delta || {};
      const thinking = delta.thinking || ""; const answer = delta.text || "";
      if (thinking) emit({ sessionId: sid, type: "thinking", role: "assistant", summary: String(thinking), runtimeEvent: "claude/native-thinking" });
      if (answer) emit({ sessionId: sid, type: "message", role: "assistant", summary: String(answer), runtimeEvent: "claude/native-text" });
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        const tool = toolFrom({ ...event.content_block, status: "running" }, "running");
        emit({ sessionId: sid, type: "tool", role: "tool", summary: tool.name, tool, runtimeEvent: "claude/native-tool" });
      }
      if (event.type === "content_block_stop" && event.content_block?.type === "tool_use") {
        const tool = toolFrom({ ...event.content_block, status: "completed" });
        emit({ sessionId: sid, type: "tool", role: "tool", summary: tool.name, tool, runtimeEvent: "claude/native-tool" });
      }
      if (frame.type === "result") emit({ sessionId: sid, type: frame.is_error ? "error" : "status", summary: frame.is_error ? String(frame.result || "Claude Code 执行失败") : "completed", runtimeEvent: "claude/native-completed" });
    } catch {} }));
    await new Promise((resolve, reject) => child.once("error", reject).once("close", (code) => { active.delete(sid); code === 0 ? resolve() : reject(new Error(`Claude Code 执行失败（${code}）：${stderr.trim().slice(-1000) || "无错误输出"}`)); }));
    return { accepted: true };
  };
  return {
    id: "claude-code", label: "Claude Code", capabilities: { ...CAPABILITIES, rename: Boolean(overlay?.rename), archive: Boolean(overlay?.archive), unarchive: Boolean(overlay?.unarchive) }, capabilityModes: { setModel: "next_turn", setEffort: "next_turn", rename: overlay?.rename ? "overlay" : "unsupported", archive: overlay?.archive ? "overlay" : "unsupported" },
    listSessions,
    async readSession(sessionId) { const row = sessionFor(sessionId) || { id: String(sessionId), agentId: "claude-code", name: String(sessionId), state: "completed", updatedAt: null, model: "", directory: "", project: "", archived: false, capabilities: { ...CAPABILITIES } }; return { ...row, model: selectedModels.get(String(sessionId)) || row.model, messages: localMessages(sessionId, scanSessions) }; },
    async createSession({ cwd, model, effort, permissionMode, title } = {}) { const id = randomUUID(); remember({ id, agentId: "claude-code", name: String(title || "").trim().slice(0, 60) || id, state: "completed", updatedAt: new Date().toISOString(), model: model || "", directory: String(cwd || process.cwd()), project: path.basename(String(cwd || process.cwd())), archived: false, capabilities: { ...CAPABILITIES } }); if (model) selectedModels.set(id, String(model)); if (effort) selectedEfforts.set(id, String(effort)); if (permissionMode) selectedPermissions.set(id, String(permissionMode)); return { sessionId: id }; },
    sendMessage,
    async setModel(id, model, effort) { selectedModels.set(String(id), String(model)); if (effort) selectedEfforts.set(String(id), String(effort)); },
    async setSettings(id, { effort, permissionMode } = {}) { if (effort) selectedEfforts.set(String(id), String(effort)); if (permissionMode) selectedPermissions.set(String(id), String(permissionMode)); },
    getSettings(id) { return { effort: selectedEfforts.get(String(id)) || "medium", permissionMode: selectedPermissions.get(String(id)) || "manual" }; },
    settings: {
      effortOptions: ["low", "medium", "high", "xhigh", "max"],
      permissionOptions: [
        { id: "manual", name: "每次询问", description: "所有操作都需要确认" },
        { id: "acceptEdits", name: "允许编辑", description: "自动接受工作区编辑" },
        { id: "plan", name: "计划模式", description: "先分析和规划，不直接修改" },
        { id: "dontAsk", name: "不主动询问", description: "按当前策略自动继续；受环境限制" },
        { id: "bypassPermissions", name: "跳过权限", description: "高风险：跳过 Claude Code 权限确认" }
      ]
    },
    async cancel(id) { const child = active.get(String(id)); if (!child) throw new Error("该 Claude Code 会话没有运行中的任务"); child.kill("SIGTERM"); },
    rename: overlay?.rename ? (id, title) => overlay.rename(String(id), String(title || "").trim().slice(0, 200)) : undefined,
    archive: overlay?.archive ? (id) => overlay.archive(String(id)) : undefined, unarchive: overlay?.unarchive ? (id) => overlay.unarchive(String(id)) : undefined,
    subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    close() { for (const child of active.values()) child.kill("SIGTERM"); active.clear(); }
  };
}

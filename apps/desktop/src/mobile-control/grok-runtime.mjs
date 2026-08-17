import { createAcpClient } from "./acp-client.mjs";
import { createAcpRuntime } from "./acp-runtime.mjs";
import { mergeTool, textValue, toolFrom, toolMessage } from "./message-parts.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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

function findGrokChatHistory(sid) {
  const row = scanGrokSessions({ limit: 300 }).find((r) => String(r.sessionId) === String(sid));
  if (!row?.filePath) return null;
  return path.join(row.filePath, "chat_history.jsonl");
}

function statInfo(file) {
  try {
    const s = fs.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
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
    // Grok 的 ACP 是进程级单实例会话状态（active_sessions 锁）：长驻 ACP 进程
    // resume 一个被其他 grok CLI 持有的会话时，prompt 会被路由到错误会话或
    // 卡死。改用一次性 `grok --single --cwd <cwd> -r <session_id>` 进程发送：
    // 每个消息一个独立进程，直接 resume 目标会话，消息可靠落盘到目标会话文件。
    async sendMessage(sessionId, { text, messageId, attachments = [] } = {}) {
      const sid = String(sessionId);
      const row = grokSessionRows().find((r) => String(r.sessionId) === sid);
      const cwd = row?.cwd || (await runtime.readSession(sid).catch(() => null))?.directory || process.cwd();
      const binary = command || process.env.SWITCHYARD_GROK_BINARY || "grok";
      const promptText = [String(text || ""), ...attachments
        .filter((a) => a.kind !== "image")
        .map((a) => `\n\n<attachment name="${a.name}">\n${a.text || `本地文件路径：${a.path || "不可用"}`}\n</attachment>`)]
        .join("");
      const args = ["--single", promptText, "--cwd", cwd, "-r", sid];
      if (process.env.SWITCHYARD_GROK_DENY) args.push("--deny", process.env.SWITCHYARD_GROK_DENY);
      // 记录发送前目标会话 chat_history 的 mtime+size：close 后对比判断消息是否
      // 真正落盘。grok 的 active_sessions 单实例限制下，若目标会话正被电脑端
      // CLI 活跃持有，--single -r 会静默路由到错误会话——此时需要明确报错。
      const chatPath = findGrokChatHistory(sid);
      const before = chatPath ? statInfo(chatPath) : null;
      const child = spawn(binary, args, {
        cwd,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let output = "";
      child.stdout.on("data", (d) => { output += String(d); });
      child.stderr.on("data", (d) => { output += String(d); });
      child.on("error", (error) => {
        console.error(`[grok-send] 启动失败: ${error.message}`);
      });
      child.on("close", (code) => {
        // 等待文件写入（grok --single 退出前已 flush；加小延迟兜底）。
        setTimeout(() => {
          const after = chatPath ? statInfo(chatPath) : null;
          const landed = after && before
            ? (after.mtimeMs > before.mtimeMs || after.size > before.size)
            : false;
          console.error(`[grok-send] 完成 sid=${sid.slice(0, 8)} code=${code} landed=${landed} output=${output.slice(-120)}`);
          if (!landed) {
            console.error(`[grok-send] 警告：消息未写入目标会话（可能被电脑端活跃 CLI 持有）sid=${sid.slice(0, 8)}`);
          }
        }, 800);
      });
      return { accepted: true, state: "running" };
    },
    // 一次性进程方案不使用 ACP 长驻连接，setModel 直接 no-op（避免触发
    // acp-runtime 的 ensureConnected/loadSession 卡在 active_sessions 锁）。
    async setModel() {
      return { ok: true };
    },
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

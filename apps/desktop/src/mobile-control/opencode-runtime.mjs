import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAcpClient } from "./acp-client.mjs";
import { toolFrom, toolMessage } from "./message-parts.mjs";
import { materializeImageAttachments } from "./temp-attachments.mjs";

const STORAGE_ROOT = path.join(os.homedir(), ".local", "share", "opencode", "storage");

function localOpenCodeRows(root = path.join(STORAGE_ROOT, "message")) {
  if (!fs.existsSync(root)) return [];
  const rows = new Map();
  let sessionDirs = [];
  try { sessionDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory() || !sessionDir.name.startsWith("ses_")) continue;
    const directory = path.join(root, sessionDir.name);
    let files = [];
    try { files = fs.readdirSync(directory).filter((name) => name.endsWith(".json")); } catch { continue; }
    for (const name of files) {
      try {
        const message = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        const id = String(message.sessionID || sessionDir.name);
        const created = Number(message.time?.created || 0);
        const current = rows.get(id);
        if (!current || created > current.created) {
          rows.set(id, {
            sessionId: id,
            title: message.summary?.title || current?.title || id,
            cwd: message.path?.cwd || current?.cwd || "",
            updatedAt: created ? new Date(created).toISOString() : null,
            model: message.model?.modelID || message.modelID || current?.model || "",
            created
          });
        }
      } catch {}
    }
  }
  return [...rows.values()].sort((a, b) => b.created - a.created);
}

function safeJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * A few OpenCode Go providers place chain-of-thought in a text part wrapped in
 * <thinking> tags instead of emitting native reasoning parts. Keep that data
 * out of the answer bubble and represent it as the same rich thinking event
 * used by Codex and ACP agents.
 */
function splitThinkingText(value) {
  const text = String(value || "");
  const parts = [];
  let cursor = 0;
  const pattern = /<thinking>\s*([\s\S]*?)\s*<\/thinking>/gi;
  let match;
  while ((match = pattern.exec(text))) {
    const before = text.slice(cursor, match.index);
    if (before.trim()) parts.push({ kind: "text", text: before });
    if (match[1].trim()) parts.push({ kind: "thinking", text: match[1] });
    cursor = pattern.lastIndex;
  }
  const tail = text.slice(cursor);
  if (tail.trim() || !parts.length) parts.push({ kind: "text", text: tail });
  return parts.filter((part) => part.text);
}

function localOpenCodeMessages(sessionId, storageRoot = STORAGE_ROOT) {
  const messageRoot = path.join(storageRoot, "message", String(sessionId));
  const partRoot = path.join(storageRoot, "part");
  if (!fs.existsSync(messageRoot)) return [];
  let files = [];
  try { files = fs.readdirSync(messageRoot).filter((name) => name.endsWith(".json")); } catch { return []; }
  const messages = files.map((name) => safeJson(path.join(messageRoot, name))).filter(Boolean)
    .sort((a, b) => Number(a.time?.created || 0) - Number(b.time?.created || 0));
  const rows = [];
  for (const message of messages) {
    const partsDir = path.join(partRoot, String(message.id || ""));
    let partFiles = [];
    try { partFiles = fs.readdirSync(partsDir).filter((name) => name.endsWith(".json")); } catch { continue; }
    const parts = partFiles.map((name) => safeJson(path.join(partsDir, name))).filter(Boolean)
      .sort((a, b) => Number(a.time?.start || 0) - Number(b.time?.start || 0));
    for (const part of parts) {
      if (part.type === "text" && String(part.text || "").trim()) {
        for (const split of splitThinkingText(part.text)) {
          rows.push({
            role: split.kind === "thinking" ? "assistant" : message.role === "user" ? "user" : "assistant",
            text: split.text,
            kind: split.kind
          });
        }
      } else if (part.type === "reasoning" && String(part.text || "").trim()) {
        rows.push({ role: "assistant", text: String(part.text), kind: "thinking" });
      } else if (part.type === "tool") {
        const tool = toolFrom(part);
        rows.push(toolMessage(tool, tool.title || tool.name));
      }
    }
  }
  return rows.slice(-500);
}

function normalizeSession(row, capabilities) {
  const cwd = String(row.cwd || "");
  return {
    id: String(row.sessionId || ""),
    agentId: "opencode",
    name: row.title || row.sessionId || "OpenCode 任务",
    state: "completed",
    updatedAt: row.updatedAt || null,
    model: row.model || "",
    directory: cwd,
    project: cwd ? path.basename(cwd) : "",
    archived: false,
    capabilities: { ...capabilities }
  };
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

function runJson(binary, args, { cwd, env, spawnProcess }) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, HOME: os.homedir(), ...(env || {}) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`OpenCode 命令失败（${code}）：${stderr.trim().slice(-1000) || "无错误输出"}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("OpenCode 返回了无效的会话 JSON")); }
    });
  });
}

/**
 * OpenCode ACP 1.18 cannot reliably `session/load` historical sessions.
 * Use its native `opencode run --session` transport for restore/continuation,
 * while retaining ACP only for synchronous session allocation and forking.
 */
export function createOpenCodeRuntime({ client, overlay, command, env, spawnProcess = spawnChild, storageRoot = STORAGE_ROOT } = {}) {
  const binary = command || process.env.SWITCHYARD_OPENCODE_BINARY || "opencode";
  const acp = client || createAcpClient({ command: binary, args: ["acp", "--pure"], env });
  const capabilities = {
    sendMessage: true, setModel: true, setEffort: false, cancel: true,
    rename: Boolean(overlay?.rename), archive: Boolean(overlay?.archive), unarchive: Boolean(overlay?.unarchive),
    delete: true, fork: true, compact: false, approve: false
  };
  const subscribers = new Set();
  const sessions = new Map();
  const selectedModels = new Map();
  const active = new Map();

  const emit = (event) => {
    for (const listener of subscribers) {
      try { listener(event); } catch {}
    }
  };
  const remember = (row) => {
    const session = normalizeSession(row, capabilities);
    sessions.set(session.id, session);
    return session;
  };
  const listSessions = async ({ cwd } = {}) => {
    const local = localOpenCodeRows(path.join(storageRoot, "message"));
    // New OpenCode releases keep the active session index outside the historic
    // message folders. Ask its own CLI first, then merge old local history.
    let native = [];
    try {
      const rows = await runJson(binary, ["session", "list", "--format", "json"], { cwd, env, spawnProcess });
      native = Array.isArray(rows) ? rows.map((row) => ({
        sessionId: String(row.id || row.sessionId || ""),
        title: row.title || row.id || "OpenCode 任务",
        cwd: row.directory || row.cwd || "",
        updatedAt: Number(row.updated || 0) ? new Date(Number(row.updated)).toISOString() : null,
        model: row.model || "",
        created: Number(row.updated || row.created || 0)
      })).filter((row) => row.sessionId) : [];
    } catch {
      // Old history must remain accessible even if the CLI is temporarily unavailable.
    }
    const byId = new Map(local.map((row) => [row.sessionId, row]));
    for (const row of native) byId.set(row.sessionId, { ...byId.get(row.sessionId), ...row });
    return [...byId.values()]
      .filter((row) => !cwd || row.cwd === cwd)
      .sort((a, b) => Number(b.created || Date.parse(b.updatedAt || 0)) - Number(a.created || Date.parse(a.updatedAt || 0)))
      .map(remember);
  };
  const sessionFor = async (sessionId) => sessions.get(String(sessionId))
    || (await listSessions()).find((row) => row.id === String(sessionId));

  const readSession = async (sessionId) => {
    const sid = String(sessionId);
    const session = await sessionFor(sid) || {
      id: sid, agentId: "opencode", name: sid, state: "completed", updatedAt: null,
      model: "", directory: "", project: "", archived: false, capabilities: { ...capabilities }
    };
    const messages = localOpenCodeMessages(sid, storageRoot);
    // Recent OpenCode releases may persist completed turns asynchronously.
    // Keep a lightweight in-memory tail so the phone immediately reflects a
    // successfully finished native `run --session` turn.
    const ephemeral = runtimeMessages.get(sid) || [];
    return { ...session, messages: [...messages, ...ephemeral].slice(-500) };
  };

  const createSession = async ({ cwd, model } = {}) => {
    await acp.connect();
    const result = await acp.request("session/new", { cwd: String(cwd || process.cwd()), mcpServers: [] }, 60_000);
    const sessionId = String(result?.sessionId || "");
    if (!sessionId) throw new Error("OpenCode 未返回 session id");
    remember({ sessionId, cwd: String(cwd || process.cwd()), model: model || result?.models?.currentModelId || "" });
    if (model) selectedModels.set(sessionId, String(model));
    return { sessionId };
  };

  const sendMessage = async (sessionId, { text, attachments = [] } = {}) => {
    const sid = String(sessionId);
    if (active.has(sid)) throw new Error("该 OpenCode 会话正在执行");
    const session = await sessionFor(sid);
    const cwd = session?.directory || process.cwd();
    const selected = selectedModels.get(sid);
    // OpenCode CLI only knows its own provider namespace ("switchyard"); the
    // mobile UI passes Switchyard gateway model ids like "hus-claude/sonnet".
    const model = selected && !selected.includes("/") ? selected
      : selected && !selected.startsWith("switchyard/") ? `switchyard/${selected}`
      : selected;
    const materialized = materializeImageAttachments(attachments);
    try {
      const args = ["run", "--session", sid, "--dir", cwd, "--format", "json"];
      if (model) args.push("--model", model);
      const attachmentText = attachments.filter((attachment) => attachment.kind !== "image")
        .map((attachment) => `\n\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`).join("");
      // 消息文本必须在 --file 之前推入：yargs [array] 选项是贪婪的，
      // 若先推 --file 再推消息，消息会被当成另一个文件路径。
      args.push(`${String(text || "")}${attachmentText}`);
      for (const image of materialized.files) args.push("--file", image.path);
      const currentMessages = runtimeMessages.get(sid) || [];
      runtimeMessages.set(sid, [...currentMessages, { role: "user", text: String(text || ""), kind: "text" }].slice(-500));
      const child = spawnProcess(binary, args, {
        cwd,
        env: { ...process.env, HOME: os.homedir(), ...(env || {}) },
        stdio: ["ignore", "pipe", "pipe"]
      });
      active.set(sid, child);
      const stderr = [];
      child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
      child.stdout?.on("data", splitLines((line) => {
        try {
          const frame = JSON.parse(line);
          const part = frame.part || {};
          if ((frame.type === "reasoning" || part.type === "reasoning") && part.text) {
            const rows = runtimeMessages.get(sid) || [];
            const last = rows.at(-1);
            if (last?.kind === "thinking") last.text += String(part.text);
            else rows.push({ role: "assistant", text: String(part.text), kind: "thinking" });
            runtimeMessages.set(sid, rows.slice(-500));
            emit({ sessionId: sid, type: "thinking", role: "assistant", summary: String(part.text), runtimeEvent: "opencode/reasoning" });
          } else if (frame.type === "text" && part.text) {
            for (const split of splitThinkingText(part.text)) {
              const rows = runtimeMessages.get(sid) || [];
              const last = rows.at(-1);
              if (last?.role === "assistant" && last.kind === split.kind) last.text += split.text;
              else rows.push({ role: "assistant", text: split.text, kind: split.kind });
              runtimeMessages.set(sid, rows.slice(-500));
              emit({
                sessionId: sid,
                type: split.kind === "thinking" ? "thinking" : "message",
                role: "assistant",
                summary: split.text,
                runtimeEvent: split.kind === "thinking" ? "opencode/thinking-tag" : "opencode/text"
              });
            }
          } else if (frame.type === "tool" || part.type === "tool") {
            const tool = toolFrom(part, "running");
            emit({ sessionId: sid, type: "tool", role: "tool", summary: tool.title || tool.name || "工具调用", tool, runtimeEvent: "opencode/tool" });
          } else if (frame.type === "step_finish") {
            emit({ sessionId: sid, type: "status", summary: String(part.reason || "completed"), runtimeEvent: "opencode/step_finish" });
          } else if (frame.type === "error") {
            const message = frame.error?.data?.message || frame.error?.message || "OpenCode 执行失败";
            emit({ sessionId: sid, type: "error", summary: String(message), runtimeEvent: "opencode/error" });
          }
        } catch {}
      }));
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          active.delete(sid);
          if (code === 0) resolve();
          else reject(new Error(`OpenCode 执行失败（${code}）：${stderr.join("").trim().slice(-1000) || "无错误输出"}`));
        });
      });
      return { accepted: true };
    } finally {
      materialized.cleanup();
    }
  };

  const runtimeMessages = new Map();

  return {
    id: "opencode",
    label: "OpenCode",
    client: acp,
    capabilities,
    capabilityModes: { rename: overlay?.rename ? "overlay" : "unsupported", archive: overlay?.archive ? "overlay" : "unsupported", unarchive: overlay?.unarchive ? "overlay" : "unsupported", setModel: "next_turn", fork: "native", delete: "native" },
    listSessions,
    readSession,
    createSession,
    sendMessage,
    async setModel(sessionId, modelId) { selectedModels.set(String(sessionId), String(modelId)); },
    async cancel(sessionId) { active.get(String(sessionId))?.kill("SIGTERM"); },
    rename: overlay?.rename ? (id, title) => overlay.rename(String(id), String(title || "").trim().slice(0, 200)) : undefined,
    archive: overlay?.archive ? (id) => overlay.archive(String(id)) : undefined,
    unarchive: overlay?.unarchive ? (id) => overlay.unarchive(String(id)) : undefined,
    async fork(sessionId) {
      const session = await sessionFor(sessionId);
      await acp.connect();
      const result = await acp.request("session/fork", { sessionId: String(sessionId), cwd: session?.directory || process.cwd(), mcpServers: [] });
      return { sessionId: String(result?.sessionId || "") };
    },
    async delete(sessionId) {
      const sid = String(sessionId);
      await new Promise((resolve, reject) => {
        const child = spawnProcess(binary, ["session", "delete", sid], { env: { ...process.env, HOME: os.homedir(), ...(env || {}) }, stdio: ["ignore", "ignore", "pipe"] });
        let output = "";
        child.stderr?.on("data", (chunk) => { output += String(chunk); });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`删除 OpenCode 会话失败：${output.trim() || code}`)));
      });
      sessions.delete(sid);
      selectedModels.delete(sid);
    },
    subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    close() { for (const child of active.values()) child.kill("SIGTERM"); active.clear(); acp.close?.(); }
  };
}

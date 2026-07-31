import { spawn as spawnChild, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { createAcpClient } from "./acp-client.mjs";
import { toolFrom, toolMessage } from "./message-parts.mjs";
import { materializeImageAttachments } from "./temp-attachments.mjs";

const STORAGE_ROOT = path.join(os.homedir(), ".local", "share", "opencode", "storage");
const DEFAULT_DB_PATH = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

function openCodeCapabilityConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".switchyard", "config.json"), "utf8"));
    const models = {};
    for (const model of Array.isArray(config.models) ? config.models : Object.values(config.models || {})) {
      const id = String(model?.id || "").trim();
      if (!id) continue;
      const images = Boolean(model?.capabilities?.images || model?.capabilities?.multimodal || model?.visionFallbackModelId);
      models[id] = {
        attachment: images,
        modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] }
      };
    }
    return JSON.stringify({ provider: { switchyard: { models } } });
  } catch {
    return "";
  }
}

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

function projectOpenCodeParts(message, parts = []) {
  const rows = [];
  const role = message?.role === "user" ? "user" : "assistant";
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && String(part.text || "").trim()) {
      for (const split of splitThinkingText(part.text)) {
        rows.push({
          role: split.kind === "thinking" ? "assistant" : role,
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
  return rows;
}

function loadBetterSqlite() {
  try {
    return createRequire(import.meta.url)("better-sqlite3");
  } catch {
    return null;
  }
}

function queryOpenCodeDbViaCli(dbPath, sessionId) {
  const run = (sql) => {
    const result = spawnSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(result.stderr || "sqlite3 failed");
    const text = String(result.stdout || "").trim();
    return text ? JSON.parse(text) : [];
  };
  const sid = String(sessionId).replace(/'/g, "''");
  return {
    messages: run(`SELECT id, data, time_created AS created FROM message WHERE session_id='${sid}' ORDER BY time_created ASC, id ASC;`),
    parts: run(`SELECT message_id AS messageId, data, time_created AS created, id FROM part WHERE session_id='${sid}' ORDER BY time_created ASC, id ASC;`)
  };
}

function queryOpenCodeDb(dbPath, sessionId) {
  const BetterSqlite = loadBetterSqlite();
  if (BetterSqlite) {
    try {
      const db = new BetterSqlite(dbPath, { readonly: true, fileMustExist: true });
      try {
        const messages = db.prepare(`
          SELECT id, data, time_created AS created
          FROM message
          WHERE session_id = ?
          ORDER BY time_created ASC, id ASC
        `).all(String(sessionId));
        const parts = db.prepare(`
          SELECT message_id AS messageId, data, time_created AS created, id
          FROM part
          WHERE session_id = ?
          ORDER BY time_created ASC, id ASC
        `).all(String(sessionId));
        return { messages, parts };
      } finally {
        db.close();
      }
    } catch {
      // Electron ABI 与当前 Node 不一致时回退 CLI。
    }
  }
  return queryOpenCodeDbViaCli(dbPath, sessionId);
}

/** OpenCode 1.18+ 把消息落到 opencode.db；旧版仍用 storage/message JSON。 */
export function readOpenCodeDbMessages(sessionId, dbPath = DEFAULT_DB_PATH) {
  if (!sessionId || !fs.existsSync(dbPath)) return null;
  let rows;
  try { rows = queryOpenCodeDb(dbPath, sessionId); }
  catch { return null; }
  const messages = Array.isArray(rows?.messages) ? rows.messages : [];
  const parts = Array.isArray(rows?.parts) ? rows.parts : [];
  if (!messages.length) return [];
  const partsByMessage = new Map();
  for (const row of parts) {
    let data = row.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { continue; }
    }
    if (!data || typeof data !== "object") continue;
    const key = String(row.messageId || row.message_id || "");
    if (!key) continue;
    if (!partsByMessage.has(key)) partsByMessage.set(key, []);
    partsByMessage.get(key).push(data);
  }
  const projected = [];
  for (const row of messages) {
    let data = row.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch { continue; }
    }
    if (!data || typeof data !== "object") continue;
    projected.push(...projectOpenCodeParts(data, partsByMessage.get(String(row.id)) || []));
  }
  return projected.slice(-500);
}

function localOpenCodeMessagesFromJson(sessionId, storageRoot = STORAGE_ROOT) {
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
      .sort((a, b) => Number(a.time?.start || a.time?.created || 0) - Number(b.time?.start || b.time?.created || 0));
    rows.push(...projectOpenCodeParts(message, parts));
  }
  return rows.slice(-500);
}

function localOpenCodeMessages(sessionId, storageRoot = STORAGE_ROOT, dbPath = DEFAULT_DB_PATH) {
  const fromDb = readOpenCodeDbMessages(sessionId, dbPath);
  if (Array.isArray(fromDb) && fromDb.length) return fromDb;
  return localOpenCodeMessagesFromJson(sessionId, storageRoot);
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
export function createOpenCodeRuntime({ client, overlay, command, env, spawnProcess = spawnChild, storageRoot = STORAGE_ROOT, dbPath = DEFAULT_DB_PATH } = {}) {
  const binary = command || process.env.SWITCHYARD_OPENCODE_BINARY || "opencode";
  const runtimeEnv = () => {
    const capabilityConfig = openCodeCapabilityConfig();
    return {
      ...process.env,
      HOME: os.homedir(),
      ...(env || {}),
      ...(capabilityConfig ? { OPENCODE_CONFIG_CONTENT: capabilityConfig } : {})
    };
  };
  // Do not use `--pure`: OpenCode's pure ACP mode skips the normal plugin
  // environment, including Switchyard's generated model-capability bridge.
  // Without it ACP silently downgrades vision models and rewrites images into
  // "model does not support image input" text before the gateway sees them.
  const acp = client || createAcpClient({ command: binary, args: ["acp"], env: runtimeEnv() });
  const capabilities = {
    sendMessage: true, setModel: true, setEffort: false, cancel: true,
    rename: Boolean(overlay?.rename), archive: Boolean(overlay?.archive), unarchive: Boolean(overlay?.unarchive),
    delete: true, fork: true, compact: false, approve: false
  };
  const subscribers = new Set();
  const sessions = new Map();
  const selectedModels = new Map();
  const active = new Map();
  const nativeSessions = new Set();
  const nativeSessionIds = new Map();
  const acpSessions = new Map();
  const publicSessions = new Map();
  let dynamicCommands = [];

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
  const publicSessionId = (sessionId) => publicSessions.get(String(sessionId)) || String(sessionId);
  const contentText = (content) => typeof content === "string" ? content : String(content?.text || content?.content || "");

  acp.subscribe?.((frame) => {
    if (frame.kind !== "notification" || frame.method !== "session/update") return;
    const params = frame.params || {};
    const update = params.update || {};
    const sid = publicSessionId(params.sessionId);
    const kind = String(update.sessionUpdate || "");
    const text = contentText(update.content);
    if (kind === "available_commands_update") {
      const rows = update.availableCommands || update.commands || update.content?.commands || [];
      dynamicCommands = (Array.isArray(rows) ? rows : []).map((item) => typeof item === "string"
        ? { name: item.replace(/^\//, ""), description: "OpenCode 命令" }
        : { name: String(item?.name || item?.command || "").replace(/^\//, ""), description: item?.description || item?.title || "OpenCode 命令" })
        .filter((item) => item.name);
    } else if (kind === "agent_message_chunk" && text) {
      const rows = runtimeMessages.get(sid) || [];
      const last = rows.at(-1);
      if (last?.role === "assistant" && last.kind === "text") last.text += text;
      else rows.push({ role: "assistant", text, kind: "text" });
      runtimeMessages.set(sid, rows.slice(-500));
      emit({ sessionId: sid, type: "message", role: "assistant", summary: text, runtimeEvent: "opencode/acp-text" });
    } else if ((kind === "agent_thought_chunk" || kind === "agent_thought") && text) {
      const rows = runtimeMessages.get(sid) || [];
      const last = rows.at(-1);
      if (last?.kind === "thinking") last.text += text;
      else rows.push({ role: "assistant", text, kind: "thinking" });
      runtimeMessages.set(sid, rows.slice(-500));
      emit({ sessionId: sid, type: "thinking", role: "assistant", summary: text, runtimeEvent: "opencode/acp-thinking" });
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const tool = toolFrom({
        id: update.toolCallId,
        name: update.toolName || update.kind || update.title || "工具调用",
        title: update.title,
        input: update.rawInput,
        output: update.rawOutput,
        status: update.status || (kind === "tool_call" ? "running" : "completed")
      }, kind === "tool_call" ? "running" : "completed");
      emit({ sessionId: sid, type: "tool", role: "tool", summary: tool.title || tool.name, tool, runtimeEvent: "opencode/acp-tool" });
    }
  });
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
    nativeSessions.clear();
    // Local message folders can outlive OpenCode's resumable session index
    // (notably sessions created by older ACP builds). Keep those rows visible
    // as history, but only pass --session for IDs confirmed by the CLI.
    for (const row of native) nativeSessions.add(row.sessionId);
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
    // 新建会话的公开 id 是 mobile-opencode-*，真实落盘 id 是 ses_*。
    const nativeId = nativeSessionIds.get(sid) || sid;
    let messages = localOpenCodeMessages(nativeId, storageRoot, dbPath);
    if (!messages.length && nativeId !== sid) messages = localOpenCodeMessages(sid, storageRoot, dbPath);
    // Recent OpenCode releases may persist completed turns asynchronously.
    // Keep a lightweight in-memory tail so the phone immediately reflects a
    // successfully finished native `run --session` turn.
    const ephemeral = [
      ...(runtimeMessages.get(sid) || []),
      ...(nativeId !== sid ? (runtimeMessages.get(nativeId) || []) : [])
    ];
    // 磁盘已有完整历史时不再叠内存尾，避免重开出现重复气泡。
    const merged = messages.length ? messages : ephemeral;
    return { ...session, messages: merged.slice(-500) };
  };

  const createSession = async ({ cwd, model } = {}) => {
    // OpenCode 1.18 ACP stores a stale model capability snapshot and rejects
    // images before plugins or the gateway can see them. Allocate a stable
    // mobile id now; the first native `opencode run` creates and binds the real
    // OpenCode session id while preserving this public id in the phone UI.
    const sessionId = `mobile-opencode-${crypto.randomUUID()}`;
    remember({ sessionId, cwd: String(cwd || process.cwd()), model: model || "" });
    if (model) {
      selectedModels.set(sessionId, String(model));
    }
    return { sessionId };
  };

  const sendAcpMessage = async (sid, acpSessionId, { text, attachments }) => {
    const rows = runtimeMessages.get(sid) || [];
    rows.push({ role: "user", text: String(text || ""), kind: "text" });
    runtimeMessages.set(sid, rows.slice(-500));
    const request = acp.request("session/prompt", {
      sessionId: acpSessionId,
      prompt: [
        ...(text ? [{ type: "text", text: String(text) }] : []),
        ...attachments.map((attachment) => attachment.kind === "image"
          ? { type: "image", data: attachment.data, mimeType: attachment.mimeType }
          : { type: "resource", resource: { uri: `attachment://${encodeURIComponent(attachment.name)}`, mimeType: attachment.mimeType, text: attachment.text } })
      ]
    }, 24 * 60 * 60 * 1000);
    active.set(sid, { transport: "acp", sessionId: acpSessionId, request });
    request.then((result) => {
      active.delete(sid);
      emit({ sessionId: sid, type: "status", summary: String(result?.stopReason || "completed"), runtimeEvent: "opencode/acp-completed" });
    }).catch((error) => {
      active.delete(sid);
      emit({ sessionId: sid, type: "error", summary: error?.message || String(error), runtimeEvent: "opencode/acp-error" });
    });
    await Promise.resolve();
    return { accepted: true };
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
      const nativeSessionId = nativeSessionIds.get(sid) || (nativeSessions.has(sid) ? sid : "");
      const args = ["run"];
      if (nativeSessionId) args.push("--session", nativeSessionId);
      args.push("--dir", cwd, "--format", "json");
      if (model) args.push("--model", model);
      const attachmentText = attachments.filter((attachment) => attachment.kind !== "image")
        .map((attachment) => `\n\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`).join("");
      args.push(`${String(text || "")}${attachmentText}`);
      // --file is an array option in OpenCode. The equals form keeps yargs
      // from consuming the positional user message as another file path.
      for (const image of materialized.files) args.push(`--file=${image.path}`);
      const currentMessages = runtimeMessages.get(sid) || [];
      runtimeMessages.set(sid, [...currentMessages, { role: "user", text: String(text || ""), kind: "text" }].slice(-500));
      const child = spawnProcess(binary, args, {
        cwd,
        env: runtimeEnv(),
        stdio: ["ignore", "pipe", "pipe"]
      });
      active.set(sid, child);
      const stderr = [];
      child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
      child.stdout?.on("data", splitLines((line) => {
        try {
          const frame = JSON.parse(line);
          const discoveredSessionId = String(frame.sessionID || frame.part?.sessionID || "");
          if (!nativeSessionId && discoveredSessionId) {
            nativeSessionIds.set(sid, discoveredSessionId);
            nativeSessions.add(discoveredSessionId);
          }
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
    listCommands() { return dynamicCommands.map((item) => ({ ...item })); },
    async setModel(sessionId, modelId) {
      const sid = String(sessionId); const value = String(modelId);
      selectedModels.set(sid, value);
    },
    async cancel(sessionId) {
      const sid = String(sessionId); const running = active.get(sid);
      if (running?.transport === "acp") acp.notify("session/cancel", { sessionId: running.sessionId });
      else running?.kill?.("SIGTERM");
    },
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
      acpSessions.delete(sid);
      nativeSessionIds.delete(sid);
    },
    subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    close() { for (const child of active.values()) child.kill("SIGTERM"); active.clear(); acp.close?.(); }
  };
}

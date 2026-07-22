import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readAgentSession, resolveAgentResource } from "./agent-resources.mjs";
import { withCodexAppServer } from "./codex-app-server.mjs";

const MARKER = "switchyard-session-handoff-v1";
const DEFAULT_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

function switchyardHome(home) {
  return home || process.env.SWITCHYARD_AGENT_HOME || os.homedir();
}

function checkpointPath(home) {
  return path.join(switchyardHome(home), ".switchyard", "session-handoffs.json");
}

function readCheckpoint(home) {
  try {
    const value = JSON.parse(fs.readFileSync(checkpointPath(home), "utf8"));
    return value?.version === 1 && Array.isArray(value.handoffs) ? value : { version: 1, handoffs: [] };
  } catch {
    return { version: 1, handoffs: [] };
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}

function textParts(content) {
  const parts = Array.isArray(content) ? content : [content];
  const text = [];
  let ignored = 0;
  for (const part of parts) {
    if (typeof part === "string") text.push(part);
    else if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
    else if (part?.type === "input_text" && typeof part.text === "string") text.push(part.text);
    else ignored += 1;
  }
  return { text: text.join("\n").trim(), ignored };
}

function parseClaudeFile(file, maxSourceBytes) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Claude Code 会话文件不存在");
  if (stat.size > maxSourceBytes) throw new Error(`Claude Code 会话文件过大（上限 ${Math.floor(maxSourceBytes / 1024 / 1024) || maxSourceBytes} MB），为避免截断暂不接力`);
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  const messages = [];
  let ignoredCount = 0;
  let cwd = "";
  for (const record of records) {
    if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
    if (record.type !== "user" && record.type !== "assistant") {
      ignoredCount += 1;
      continue;
    }
    const role = record.message?.role || record.type;
    if (role !== "user" && role !== "assistant") {
      ignoredCount += 1;
      continue;
    }
    const parsed = textParts(record.message?.content);
    ignoredCount += parsed.ignored;
    if (!parsed.text) {
      ignoredCount += 1;
      continue;
    }
    messages.push({ role, content: parsed.text, source_id: record.uuid || undefined });
  }
  return { messages, ignoredCount, cwd, sourceSize: stat.size, sourceMtime: stat.mtime.toISOString() };
}

function validCwd(candidate, home) {
  try { if (candidate && fs.statSync(candidate).isDirectory()) return candidate; } catch {}
  try { if (fs.statSync(process.cwd()).isDirectory()) return process.cwd(); } catch {}
  return switchyardHome(home);
}

function fingerprint(memory) {
  return createHash("sha256").update(JSON.stringify({ schema: memory.schema, version: memory.version, messages: memory.messages })).digest("hex");
}

export function previewSessionHandoffToCodex(id, { maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES, home } = {}) {
  const resource = resolveAgentResource(id, "session");
  if (resource.agent.id !== "claude-code") throw new Error("当前仅支持 Claude Code 会话接力到 Codex");
  const parsed = parseClaudeFile(resource.target, maxSourceBytes);
  if (!parsed.messages.length) throw new Error("Claude Code 会话中没有可接力的用户或助手消息");
  const row = readAgentSession(id);
  const title = String(row.name || path.basename(resource.target, path.extname(resource.target)) || "Claude Code 会话").trim().slice(0, 200);
  const memory = {
    schema: "switchyard.session-handoff",
    version: 1,
    exported_at: new Date().toISOString(),
    title,
    source: { application: "claude-code", session_id: id, cwd: parsed.cwd || "" },
    messages: parsed.messages
  };
  const digest = fingerprint(memory);
  const existing = readCheckpoint(home).handoffs.find((item) => item.sourceSessionId === id && item.sourceFingerprint === digest) || null;
  return {
    sourceAgent: "claude-code",
    targetAgent: "codex",
    sourceSessionId: id,
    sourcePath: resource.target,
    title,
    cwd: validCwd(parsed.cwd, home),
    messageCount: parsed.messages.length,
    userCount: parsed.messages.filter((item) => item.role === "user").length,
    assistantCount: parsed.messages.filter((item) => item.role === "assistant").length,
    ignoredCount: parsed.ignoredCount,
    truncated: false,
    fingerprint: digest,
    alreadyImported: Boolean(existing),
    existingTargetThreadId: existing?.targetThreadId || "",
    memory
  };
}

function responseItems(messages) {
  return messages.map((message) => ({
    type: "message",
    role: message.role,
    content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }],
    internal_chat_message_metadata_passthrough: { turn_id: MARKER }
  }));
}

function assertManagedRollout(file, home) {
  const resolved = path.resolve(file);
  const root = path.resolve(switchyardHome(home), ".codex");
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Codex rollout 路径不在受管理目录中");
  if (!fs.statSync(resolved).isFile()) throw new Error("Codex 未创建可读取的 rollout 文件");
  return resolved;
}

export function repairCodexRolloutProjection(rolloutPath, memory, { home, replaceFile = fs.renameSync } = {}) {
  const file = assertManagedRollout(rolloutPath, home);
  const original = fs.readFileSync(file, "utf8");
  const records = original.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const first = records.find((record) => record.type === "session_meta");
  if (!first) throw new Error("Codex rollout 缺少 session_meta，已停止投影修复");
  const backupDir = path.join(switchyardHome(home), ".switchyard", "backups", "session-handoff", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(file));
  fs.writeFileSync(backup, original, { encoding: "utf8", mode: 0o600 });

  const output = [first];
  const cwd = memory.cwd || first.payload?.cwd || validCwd("", home);
  let activeTurn = "";
  let lastAssistant = "";
  let tick = 0;
  const base = Date.now();
  const timestamp = () => new Date(base + tick++ * 10).toISOString();
  const complete = () => {
    if (!activeTurn) return;
    output.push({ timestamp: timestamp(), type: "event_msg", payload: { type: "task_complete", turn_id: activeTurn, last_agent_message: lastAssistant, completed_at: Math.floor((base + tick * 10) / 1000), duration_ms: 0, time_to_first_token_ms: 0 } });
    activeTurn = "";
    lastAssistant = "";
  };
  const start = () => {
    activeTurn = `${MARKER}-${randomUUID()}`;
    output.push({ timestamp: timestamp(), type: "turn_context", payload: { turn_id: activeTurn, cwd, workspace_roots: [cwd], model: memory.model || "", source: MARKER, import_projection_version: 1 } });
    output.push({ timestamp: timestamp(), type: "event_msg", payload: { type: "task_started", turn_id: activeTurn, started_at: Math.floor((base + tick * 10) / 1000), model_context_window: 200000, collaboration_mode_kind: "default" } });
  };
  for (const message of memory.messages || []) {
    if (message.role === "user") { complete(); start(); }
    else if (!activeTurn) start();
    const id = `msg_${randomUUID().replace(/-/g, "")}`;
    const response = { timestamp: timestamp(), type: "response_item", payload: { type: "message", id, role: message.role, content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }], ...(message.role === "assistant" ? { phase: "final_answer" } : {}), internal_chat_message_metadata_passthrough: { turn_id: activeTurn } } };
    const event = { timestamp: timestamp(), type: "event_msg", payload: message.role === "assistant" ? { type: "agent_message", message: message.content, phase: "final_answer", memory_citation: null } : { type: "user_message", client_id: id, message: message.content, images: [], local_images: [], text_elements: [] } };
    if (message.role === "assistant") { output.push(event, response); lastAssistant = message.content; }
    else output.push(response, event);
  }
  complete();
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${output.map((item) => JSON.stringify(item)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try { replaceFile(temp, file); }
  catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch {}
    try {
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== original) fs.copyFileSync(backup, file);
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Codex rollout 替换与恢复均失败；备份位于 ${backup}`);
    }
    throw error;
  }
  return { backupPath: backup, rolloutPath: file };
}

export async function handoffSessionToCodex(id, { title, withAppServer: appServer = withCodexAppServer, home } = {}) {
  const preview = previewSessionHandoffToCodex(id, { home });
  if (preview.alreadyImported) throw new Error(`该版本已接力到 Codex：${preview.existingTargetThreadId}`);
  const threadName = String(title || preview.title).trim().slice(0, 200) || preview.title;
  const items = responseItems(preview.memory.messages);
  let createdThreadId = "";
  const imported = await appServer(async (client) => {
    try {
      const started = await client.call("thread/start", { cwd: preview.cwd, threadSource: "user" }, 60000);
      createdThreadId = String(started.thread?.id || "");
      if (!createdThreadId) throw new Error("Codex 未返回新 thread ID");
      for (let index = 0; index < items.length; index += 200) await client.call("thread/inject_items", { threadId: createdThreadId, items: items.slice(index, index + 200) }, 60000);
      await client.call("thread/name/set", { threadId: createdThreadId, name: threadName });
      const read = await client.call("thread/read", { threadId: createdThreadId, includeTurns: false });
      repairCodexRolloutProjection(String(read.thread?.path || ""), { ...preview.memory, cwd: preview.cwd, model: String(started.model || "") }, { home });
      return createdThreadId;
    } catch (error) {
      if (createdThreadId) {
        try { await client.call("thread/archive", { threadId: createdThreadId }); } catch {}
      }
      throw error;
    }
  });
  const state = readCheckpoint(home);
  state.handoffs.push({ sourceAgent: "claude-code", sourceSessionId: id, sourceFingerprint: preview.fingerprint, targetAgent: "codex", targetThreadId: imported, sourceMessageCount: preview.messageCount, importedAt: new Date().toISOString(), title: threadName });
  atomicWriteJson(checkpointPath(home), state);
  return { ok: true, sourceSessionId: id, targetThreadId: imported, title: threadName, messageCount: preview.messageCount };
}

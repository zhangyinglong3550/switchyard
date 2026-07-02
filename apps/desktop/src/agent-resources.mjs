import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const TEXT_MAX_BYTES = 512 * 1024;
const SESSION_EXTENSIONS = new Set([".jsonl", ".json", ".session", ".log"]);
const MAX_CONVERSATION_MESSAGES = 300;

function homeDir() {
  return process.env.SWITCHYARD_AGENT_HOME || os.homedir();
}

function expandHome(value) {
  return path.resolve(String(value || "").replace(/^~(?=$|\/|\\)/, homeDir()));
}

export function agentDefinitions() {
  const agents = [
    {
      id: "codex",
      label: "Codex",
      root: "~/.codex",
      sessionRoots: ["~/.codex/archived_sessions", "~/.codex/sessions"],
      skillRoots: ["~/.codex/skills", "~/.agents/skills"],
      coreFiles: ["AGENTS.md", "config.toml"]
    },
    {
      id: "claude-code",
      label: "Claude Code",
      root: "~/.claude",
      sessionRoots: ["~/.claude/projects"],
      skillRoots: ["~/.claude/skills"],
      coreFiles: ["CLAUDE.md", "settings.json"]
    },
    {
      id: "hermes",
      label: "Hermes",
      root: "~/.hermes",
      sessionRoots: ["~/.hermes/sessions", "~/.hermes/archived_sessions"],
      skillRoots: ["~/.hermes/skills"],
      coreFiles: [
        "AGENTS.md",
        "SOUL.md",
        "memories/USER.md",
        "memories/MEMORY.md",
        "config.json",
        "config.yaml",
        "hermes-agent/AGENTS.md",
        "hermes-office/AGENTS.md"
      ]
    }
  ].map((agent) => ({
    ...agent,
    root: expandHome(agent.root),
    sessionRoots: agent.sessionRoots.map(expandHome),
    skillRoots: agent.skillRoots.map(expandHome)
  }));
  for (const agent of agents) {
    if (agent.id !== "hermes") continue;
    agent.coreFiles = uniqueRelativePaths([
      ...(agent.coreFiles || []),
      ...discoverHermesMarkdownCoreFiles(agent.root)
    ]);
  }
  return agents;
}

function uniqueRelativePaths(paths) {
  return Array.from(new Set((paths || []).map((file) => path.normalize(file)).filter(Boolean)));
}

function discoverHermesMarkdownCoreFiles(root) {
  const out = [];
  for (const dir of [root, path.join(root, "memories")]) {
    if (!safeStat(dir)?.isDirectory()) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.md$/i.test(entry.name)) continue;
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
  return out;
}

function agentsById() {
  return new Map(agentDefinitions().map((agent) => [agent.id, agent]));
}

function sqlite3Cli() {
  return process.env.SWITCHYARD_SQLITE3 || "sqlite3";
}

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function safeLstat(file) {
  try { return fs.lstatSync(file); } catch { return null; }
}

function walkFiles(root, { maxDepth = 4, include } = {}) {
  const out = [];
  const resolvedRoot = path.resolve(root);
  if (!safeStat(resolvedRoot)?.isDirectory()) return out;
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(file, depth + 1);
      } else if (!include || include(file, entry)) {
        out.push(file);
      }
    }
  };
  visit(resolvedRoot, 0);
  return out;
}

function encodeResource(agentId, root, target) {
  return Buffer.from(JSON.stringify({ agentId, root: path.resolve(root), target: path.resolve(target) })).toString("base64url");
}

function encodeCoreFileResource(agentId, root, target) {
  return Buffer.from(JSON.stringify({
    agentId,
    root: path.resolve(root),
    target: path.resolve(target),
    source: "core-file"
  })).toString("base64url");
}

function encodeHermesDbResource(root, sessionId) {
  return Buffer.from(JSON.stringify({
    agentId: "hermes",
    root: path.resolve(root),
    target: path.resolve(path.join(root, "state.db")),
    source: "hermes-state-db",
    sessionId
  })).toString("base64url");
}

function decodeResource(id) {
  try {
    const parsed = JSON.parse(Buffer.from(String(id || ""), "base64url").toString("utf8"));
    return {
      agentId: String(parsed.agentId || ""),
      root: path.resolve(String(parsed.root || "")),
      target: path.resolve(String(parsed.target || "")),
      source: parsed.source ? String(parsed.source) : "",
      sessionId: parsed.sessionId ? String(parsed.sessionId) : ""
    };
  } catch {
    throw new Error("资源 ID 无效");
  }
}

function assertInsideRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error("资源路径越界");
  }
}

function allowedCoreFileSet(agent) {
  return new Set((agent.coreFiles || []).map((file) => path.normalize(file)));
}

function resolveAgentCoreFile(id) {
  const decoded = decodeResource(id);
  const agent = agentsById().get(decoded.agentId);
  if (!agent) throw new Error(`未知 Agent：${decoded.agentId}`);
  if (decoded.source !== "core-file") throw new Error("资源类型不匹配");
  if (path.resolve(decoded.root) !== path.resolve(agent.root)) throw new Error("Agent 根目录不受管理");
  assertInsideRoot(agent.root, decoded.target);
  const relativePath = path.normalize(path.relative(agent.root, decoded.target));
  if (!allowedCoreFileSet(agent).has(relativePath)) throw new Error("核心文件不在允许列表中");
  return { ...decoded, agent, relativePath };
}

export function resolveAgentResource(id, kind) {
  const decoded = decodeResource(id);
  const agent = agentsById().get(decoded.agentId);
  if (!agent) throw new Error(`未知 Agent：${decoded.agentId}`);
  if (decoded.source === "hermes-state-db") {
    const hermesRoot = expandHome("~/.hermes");
    if (agent.id !== "hermes" || kind !== "session") throw new Error("资源类型不匹配");
    if (decoded.root !== hermesRoot || decoded.target !== path.join(hermesRoot, "state.db")) throw new Error("Hermes 会话库路径不受管理");
    assertInsideRoot(decoded.root, decoded.target);
    return { ...decoded, agent };
  }
  const roots = kind === "skill" ? agent.skillRoots : agent.sessionRoots;
  if (!roots.some((root) => path.resolve(root) === decoded.root)) throw new Error("资源根目录不受管理");
  assertInsideRoot(decoded.root, decoded.target);
  return { ...decoded, agent };
}

function summarizeSession(agent, root, file) {
  const stat = safeStat(file);
  if (!stat?.isFile()) return null;
  const relativePath = path.relative(root, file);
  return {
    id: encodeResource(agent.id, root, file),
    agentId: agent.id,
    agentLabel: agent.label,
    name: path.basename(file),
    relativePath,
    path: file,
    root,
    size: stat.size,
    mtime: stat.mtime.toISOString()
  };
}

export function listAgentSessions({ agentId = "", source = "", includeAllSources = false } = {}) {
  const agents = agentDefinitions().filter((agent) => !agentId || agent.id === agentId);
  const sourceFilter = String(source || "").trim().toLowerCase();
  const rows = [];
  for (const agent of agents) {
    for (const root of agent.sessionRoots) {
      const files = walkFiles(root, {
        maxDepth: agent.id === "claude-code" ? 3 : 2,
        include: (file) => SESSION_EXTENSIONS.has(path.extname(file).toLowerCase())
      });
      for (const file of files) {
        const row = summarizeSession(agent, root, file);
        if (!row) continue;
        if (!includeAllSources && sourceFilter) {
          const rowSource = String(row.source || "").trim().toLowerCase();
          if (rowSource !== sourceFilter) continue;
        }
        rows.push(row);
      }
    }
    if (agent.id === "hermes") rows.push(...listHermesDbSessions());
  }
  rows.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return rows.slice(0, 500);
}

function runSqliteJson(db, sql) {
  const out = execFileSync(sqlite3Cli(), ["-json", db, sql], { encoding: "utf8", timeout: 5000, maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(out || "[]");
}

function runSqlite(db, sql) {
  return execFileSync(sqlite3Cli(), [db, sql], { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
}

function sqlValue(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function hermesStateDb() {
  return path.join(expandHome("~/.hermes"), "state.db");
}

function isoFromUnixSeconds(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

function listHermesDbSessions() {
  const root = expandHome("~/.hermes");
  const db = hermesStateDb();
  if (!safeStat(db)?.isFile()) return [];
  let rows = [];
  try {
    rows = runSqliteJson(db, `
      SELECT id, source, model, title, started_at, ended_at, message_count, tool_call_count, archived
      FROM sessions
      WHERE COALESCE(archived, 0) = 0
      ORDER BY started_at DESC
      LIMIT 500;
    `);
  } catch {
    return [];
  }
  return rows.map((row) => ({
    id: encodeHermesDbResource(root, row.id),
    agentId: "hermes",
    agentLabel: "Hermes",
    name: row.title || row.id,
    relativePath: `state.db#${row.id}`,
    path: db,
    root,
    source: "hermes-state-db",
    sessionId: row.id,
    model: row.model || "",
    size: Number(row.message_count || 0),
    messageCount: Number(row.message_count || 0),
    mtime: isoFromUnixSeconds(row.ended_at || row.started_at) || new Date(0).toISOString()
  }));
}

function readTextFile(file, maxBytes = TEXT_MAX_BYTES) {
  const stat = safeStat(file);
  if (!stat?.isFile()) throw new Error("文件不存在");
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return {
      text: buf.toString("utf8"),
      truncated: start > 0,
      size: stat.size,
      mtime: stat.mtime.toISOString()
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function readAgentSession(id) {
  const decoded = decodeResource(id);
  if (decoded.source === "hermes-state-db") return readHermesDbSession(id);
  const resource = resolveAgentResource(id, "session");
  const read = readTextFile(resource.target, 256 * 1024);
  return { ...resource, ...read, conversation: parseSessionConversation(read.text, resource.agent.id) };
}

function linesOf(text) {
  return String(text || "").split(/\r?\n/).filter((line) => line.trim());
}

function jsonLines(text) {
  const out = [];
  for (const line of linesOf(text)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function compactText(value) {
  const text = contentText(value).replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 8000 ? `${text.slice(0, 8000)}\n\n[内容过长，已截断]` : text;
}

function contentText(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
      try { return contentText(JSON.parse(trimmed)); } catch {}
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (typeof value !== "object") return String(value);
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (typeof value.input_text === "string") return value.input_text;
  if (typeof value.output_text === "string") return value.output_text;
  if (value.type === "image" || value.type === "image_url") return "[图片]";
  if (value.type === "input_image" || value.type === "output_image") return "[图片]";
  if (value.type === "tool_use") return `[工具调用] ${value.name || ""}`.trim();
  if (value.type === "tool_result") return `[工具结果]\n${contentText(value.content)}`;
  if (value.type === "thinking") return "";
  return "";
}

function pushMessage(messages, { role, text, timestamp, kind } = {}) {
  const clean = compactText(text);
  if (!clean) return;
  messages.push({
    role: normalizeRole(role),
    text: clean,
    timestamp: timestamp || null,
    kind: kind || null
  });
}

function normalizeRole(role) {
  const value = String(role || "").toLowerCase();
  if (value === "assistant" || value === "agent") return "assistant";
  if (value === "user" || value === "human") return "user";
  if (value === "system" || value === "developer") return "system";
  if (value === "tool" || value === "function") return "tool";
  return value || "event";
}

function parseCodexSession(records) {
  const messages = [];
  for (const record of records) {
    const payload = record.payload || record;
    const timestamp = record.timestamp || payload.timestamp || payload.started_at || null;
    if (payload.type === "message") {
      pushMessage(messages, {
        role: payload.role || payload.item?.role,
        text: payload.content || payload.item?.content,
        timestamp,
        kind: payload.type || record.type
      });
    } else if (record.type === "event_msg" && payload.type === "user_message") {
      pushMessage(messages, {
        role: "user",
        text: payload.message || payload.text || payload.text_elements,
        timestamp,
        kind: "user_message"
      });
    } else if (record.type === "response_item" && payload.type === "function_call") {
      pushMessage(messages, { role: "tool", text: `[工具调用] ${payload.name || ""}`, timestamp, kind: "function_call" });
    }
  }
  return messages;
}

function parseClaudeSession(records) {
  const messages = [];
  for (const record of records) {
    const timestamp = record.timestamp || null;
    if (record.message && (record.type === "user" || record.type === "assistant")) {
      pushMessage(messages, {
        role: record.message.role || record.type,
        text: record.message.content,
        timestamp,
        kind: record.type
      });
    } else if (record.type === "system" && record.content) {
      pushMessage(messages, { role: "system", text: record.content, timestamp, kind: "system" });
    } else if (record.type === "attachment") {
      pushMessage(messages, { role: "event", text: `[附件] ${contentText(record.attachment) || "attachment"}`, timestamp, kind: "attachment" });
    }
  }
  return messages;
}

function parseHermesDbMessages(records) {
  const messages = [];
  for (const record of records) {
    const role = record.role || "event";
    const timestamp = isoFromUnixSeconds(record.timestamp);
    if (role === "tool") {
      pushMessage(messages, {
        role: "tool",
        text: record.tool_name ? `[工具结果] ${record.tool_name}\n${record.content || ""}` : `[工具结果]\n${record.content || ""}`,
        timestamp,
        kind: "tool"
      });
      continue;
    }
    const visible = contentText(record.content);
    if (visible) {
      pushMessage(messages, { role, text: visible, timestamp, kind: "message" });
    } else if (record.tool_calls) {
      pushMessage(messages, { role: "tool", text: `[工具调用]\n${record.tool_calls}`, timestamp, kind: "tool_calls" });
    }
  }
  return messages;
}

export function parseSessionConversation(text, agentId = "") {
  const records = jsonLines(text);
  let messages = [];
  if (records.length) {
    if (agentId === "codex" || records.some((record) => record.type === "response_item" || record.type === "event_msg")) {
      messages = parseCodexSession(records);
    } else if (agentId === "claude-code" || records.some((record) => record.message && record.type)) {
      messages = parseClaudeSession(records);
    } else {
      for (const record of records) {
        pushMessage(messages, {
          role: record.role || record.type,
          text: record.content || record.message || record.text || record.output,
          timestamp: record.timestamp || record.ts,
          kind: record.type
        });
      }
    }
  }
  return {
    format: records.length ? "jsonl" : "text",
    count: messages.length,
    truncated: messages.length > MAX_CONVERSATION_MESSAGES,
    messages: messages.slice(-MAX_CONVERSATION_MESSAGES)
  };
}

function readHermesDbSession(id) {
  const resource = resolveAgentResource(id, "session");
  const db = resource.target;
  const sessionId = resource.sessionId;
  const sessionRows = runSqliteJson(db, `
    SELECT id, source, model, title, started_at, ended_at, message_count, tool_call_count, archived
    FROM sessions
    WHERE id = ${sqlValue(sessionId)}
    LIMIT 1;
  `);
  if (!sessionRows.length) throw new Error("Hermes 会话不存在");
  const messages = runSqliteJson(db, `
    SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning, reasoning_content, finish_reason
    FROM messages
    WHERE session_id = ${sqlValue(sessionId)} AND COALESCE(active, 1) = 1
    ORDER BY id ASC
    LIMIT 1200;
  `);
  const text = JSON.stringify({ session: sessionRows[0], messages }, null, 2);
  return {
    ...resource,
    text,
    truncated: false,
    size: text.length,
    mtime: isoFromUnixSeconds(sessionRows[0].ended_at || sessionRows[0].started_at),
    conversation: {
      format: "hermes-state-db",
      count: messages.length,
      truncated: messages.length > MAX_CONVERSATION_MESSAGES,
      messages: parseHermesDbMessages(messages).slice(-MAX_CONVERSATION_MESSAGES)
    }
  };
}

export function archiveAgentSession(id) {
  const resource = resolveAgentResource(id, "session");
  if (resource.source !== "hermes-state-db") return { ok: false, reason: "not-hermes-db" };
  runSqlite(resource.target, `
    UPDATE sessions
    SET archived = 1,
        ended_at = COALESCE(ended_at, CAST(strftime('%s','now') AS REAL)),
        end_reason = COALESCE(end_reason, 'archived_by_switchyard')
    WHERE id = ${sqlValue(resource.sessionId)};
  `);
  return { ok: true, archived: true, sessionId: resource.sessionId };
}

function skillContentPath(dir) {
  const active = path.join(dir, "SKILL.md");
  if (safeStat(active)?.isFile()) return { path: active, disabled: false };
  const disabled = path.join(dir, "SKILL.md.disabled");
  if (safeStat(disabled)?.isFile()) return { path: disabled, disabled: true };
  return null;
}

function summarizeSkill(agent, root, dir) {
  const content = skillContentPath(dir);
  if (!content) return null;
  const stat = safeStat(content.path);
  const linkStat = safeLstat(dir);
  return {
    id: encodeResource(agent.id, root, dir),
    agentId: agent.id,
    agentLabel: agent.label,
    name: path.basename(dir),
    relativePath: path.relative(root, dir),
    path: dir,
    root,
    disabled: content.disabled,
    linked: Boolean(linkStat?.isSymbolicLink?.()),
    size: stat?.size || 0,
    mtime: stat?.mtime?.toISOString?.() || null
  };
}

export function listAgentSkills({ agentId = "" } = {}) {
  const agents = agentDefinitions().filter((agent) => !agentId || agent.id === agentId);
  const rows = [];
  for (const agent of agents) {
    for (const root of agent.skillRoots) {
      if (!safeStat(root)?.isDirectory()) continue;
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const skillDir = path.join(root, entry.name);
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const row = summarizeSkill(agent, root, skillDir);
        if (row) rows.push(row);
      }
    }
  }
  rows.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.name.localeCompare(b.name));
  return rows;
}

export function listAgentCoreFiles({ agentId = "" } = {}) {
  const agents = agentDefinitions().filter((agent) => !agentId || agent.id === agentId);
  const rows = [];
  for (const agent of agents) {
    for (const relativePath of agent.coreFiles || []) {
      const target = path.join(agent.root, relativePath);
      const stat = safeStat(target);
      rows.push({
        id: encodeCoreFileResource(agent.id, agent.root, target),
        agentId: agent.id,
        agentLabel: agent.label,
        root: agent.root,
        relativePath,
        path: target,
        exists: Boolean(stat?.isFile()),
        size: stat?.isFile() ? stat.size : 0,
        mtime: stat?.mtime?.toISOString?.() || null
      });
    }
  }
  rows.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.relativePath.localeCompare(b.relativePath));
  return rows;
}

export function readAgentCoreFile(id) {
  const resource = resolveAgentCoreFile(id);
  if (!safeStat(resource.target)?.isFile()) {
    return {
      id,
      ...resource,
      text: "",
      exists: false,
      truncated: false,
      size: 0,
      mtime: null
    };
  }
  return { id, ...resource, exists: true, ...readTextFile(resource.target, 512 * 1024) };
}

export function saveAgentCoreFile(id, text) {
  const resource = resolveAgentCoreFile(id);
  fs.mkdirSync(path.dirname(resource.target), { recursive: true });
  fs.writeFileSync(resource.target, String(text ?? ""), "utf8");
  const stat = safeStat(resource.target);
  return {
    ok: true,
    path: resource.target,
    size: stat?.size || 0,
    mtime: stat?.mtime?.toISOString?.() || null
  };
}

export function readAgentSkill(id) {
  const resource = resolveAgentResource(id, "skill");
  const content = skillContentPath(resource.target);
  if (!content) throw new Error("Skill 文件不存在");
  return { ...resource, disabled: content.disabled, contentPath: content.path, ...readTextFile(content.path) };
}

export function saveAgentSkill(id, text) {
  const resource = resolveAgentResource(id, "skill");
  const content = skillContentPath(resource.target);
  if (!content) throw new Error("Skill 文件不存在");
  fs.writeFileSync(content.path, String(text ?? ""), "utf8");
  const stat = safeStat(content.path);
  return { ok: true, path: content.path, size: stat?.size || 0, mtime: stat?.mtime?.toISOString?.() || null };
}

export function setAgentSkillDisabled(id, disabled) {
  const resource = resolveAgentResource(id, "skill");
  const active = path.join(resource.target, "SKILL.md");
  const inactive = path.join(resource.target, "SKILL.md.disabled");
  if (disabled) {
    if (safeStat(inactive)?.isFile()) return { ok: true, disabled: true, path: inactive };
    if (!safeStat(active)?.isFile()) throw new Error("Skill 文件不存在");
    fs.renameSync(active, inactive);
    return { ok: true, disabled: true, path: inactive };
  }
  if (safeStat(active)?.isFile()) return { ok: true, disabled: false, path: active };
  if (!safeStat(inactive)?.isFile()) throw new Error("Skill 文件不存在");
  fs.renameSync(inactive, active);
  return { ok: true, disabled: false, path: active };
}

export function linkAgentSkill(id, { targetAgentId, skillName } = {}) {
  const resource = resolveAgentResource(id, "skill");
  if (!skillContentPath(resource.target)) throw new Error("源 Skill 文件不存在");
  const targetAgent = agentsById().get(String(targetAgentId || ""));
  if (!targetAgent) throw new Error(`未知目标 Agent：${targetAgentId}`);
  const targetRoot = targetAgent.skillRoots[0];
  ensureSkillRoot(targetRoot);
  const name = safeSkillName(skillName || path.basename(resource.target));
  const target = path.join(targetRoot, name);
  const existing = safeLstat(target);
  if (existing) {
    if (existing.isSymbolicLink?.()) {
      let current = "";
      let desired = "";
      try { current = fs.realpathSync(target); } catch {}
      try { desired = fs.realpathSync(resource.target); } catch {}
      if (current && desired && current === desired) {
        return {
          ok: true,
          source: resource.target,
          target,
          targetAgentId: targetAgent.id,
          skillName: name,
          link: true,
          alreadyExists: true
        };
      }
    }
    throw new Error(`目标 Skill 已存在：${name}`);
  }
  fs.symlinkSync(resource.target, target, "dir");
  return {
    ok: true,
    source: resource.target,
    target,
    targetAgentId: targetAgent.id,
    skillName: name,
    link: true
  };
}

export function installAgentSkillFromDirectory(sourceDir, { targetAgentId, skillName, overwrite = false } = {}) {
  const source = path.resolve(String(sourceDir || ""));
  if (!safeStat(path.join(source, "SKILL.md"))?.isFile()) throw new Error("下载包中没有 SKILL.md");
  const targetAgent = agentsById().get(String(targetAgentId || ""));
  if (!targetAgent) throw new Error(`未知目标 Agent：${targetAgentId}`);
  const targetRoot = targetAgent.skillRoots[0];
  ensureSkillRoot(targetRoot);
  const name = safeSkillName(skillName || path.basename(source));
  const target = path.join(targetRoot, name);
  if (safeLstat(target)) {
    if (!overwrite) throw new Error(`目标 Skill 已存在：${name}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.cpSync(source, target, { recursive: true, dereference: true });
  return {
    ok: true,
    source,
    target,
    targetAgentId: targetAgent.id,
    skillName: name,
    link: false
  };
}

function ensureSkillRoot(root) {
  fs.mkdirSync(root, { recursive: true });
}

function safeSkillName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Skill 名称无效");
  }
  return name;
}

// Session-Core SQLite 镜像存储（node:sqlite，零 native 依赖）
// 职责：作为「原生会话文件 ↔ 移动端/桌面端」之间的统一镜像层。
//  - sessions:  会话元数据（含最后镜像时间 last_mirror_at，用于增量导入）
//  - messages:  会话消息（来自原生文件导入 + 移动端写入）
//  - events:    事件账本镜像（与 events.jsonl 双写，后续可切换）
// 设计原则：SQLite 是「读视图 + 增量导入游标」，不是唯一真源；
//          现有 JSON store（state.json / events.jsonl）保持兼容不动。

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  agent_id       TEXT NOT NULL,
  native_id      TEXT NOT NULL,
  mobile_id      TEXT NOT NULL,
  title          TEXT DEFAULT '',
  state          TEXT DEFAULT 'completed',
  updated_at     INTEGER DEFAULT 0,
  project        TEXT DEFAULT '',
  directory      TEXT DEFAULT '',
  archived       INTEGER DEFAULT 0,
  last_mirror_at INTEGER DEFAULT 0,
  mtime          INTEGER DEFAULT 0,
  PRIMARY KEY (agent_id, native_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_mobile ON sessions(mobile_id);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   TEXT NOT NULL,
  native_id  TEXT NOT NULL,
  role       TEXT NOT NULL,
  kind       TEXT DEFAULT 'text',
  text       TEXT DEFAULT '',
  ts         INTEGER DEFAULT 0,
  turn       TEXT DEFAULT '',
  tool_json  TEXT DEFAULT '',
  seq        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(agent_id, native_id, seq);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  session_id TEXT DEFAULT '',
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER DEFAULT 0
);
`;

export function createSqliteMirror({ file, now = () => Date.now() } = {}) {
  if (!file) throw new Error("sqlite mirror file 不能为空");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const upsertSession = (row) => {
    const stmt = db.prepare(`
      INSERT INTO sessions (agent_id, native_id, mobile_id, title, state, updated_at, project, directory, archived, last_mirror_at, mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, native_id) DO UPDATE SET
        mobile_id = excluded.mobile_id,
        title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END,
        state = excluded.state,
        updated_at = excluded.updated_at,
        project = excluded.project,
        directory = excluded.directory,
        archived = excluded.archived,
        last_mirror_at = excluded.last_mirror_at,
        mtime = excluded.mtime
    `);
    stmt.run(
      row.agentId, row.nativeId, row.mobileId || "",
      row.title || "", row.state || "completed",
      Number(row.updatedAt) || 0, row.project || "", row.directory || "",
      row.archived ? 1 : 0, Number(row.lastMirrorAt) || now(), Number(row.mtime) || 0
    );
  };

  const replaceMessages = (agentId, nativeId, rows) => {
    const del = db.prepare("DELETE FROM messages WHERE agent_id = ? AND native_id = ?");
    del.run(agentId, nativeId);
    const ins = db.prepare(`
      INSERT INTO messages (agent_id, native_id, role, kind, text, ts, turn, tool_json, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let seq = 0;
    for (const row of rows) {
      ins.run(
        agentId, nativeId, row.role || "user", row.kind || "text",
        row.text || "", Number(row.ts) || 0, row.turn || "",
        typeof row.toolJson === "string" ? row.toolJson : JSON.stringify(row.toolJson || {}),
        seq++
      );
    }
  };

  const listSessions = ({ agentId = "", limit = 200 } = {}) => {
    const rows = agentId
      ? db.prepare("SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?").all(agentId, limit)
      : db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map((r) => ({
      agentId: r.agent_id, nativeId: r.native_id, mobileId: r.mobile_id,
      title: r.title, state: r.state, updatedAt: r.updated_at,
      project: r.project, directory: r.directory, archived: Boolean(r.archived),
      lastMirrorAt: r.last_mirror_at, mtime: r.mtime
    }));
  };

  const readMessages = (agentId, nativeId, { after = 0, limit = 2000 } = {}) => {
    const rows = db.prepare(
      "SELECT * FROM messages WHERE agent_id = ? AND native_id = ? AND seq > ? ORDER BY seq LIMIT ?"
    ).all(agentId, nativeId, Number(after) || 0, Number(limit) || 2000);
    return rows.map((r) => ({
      seq: r.seq, role: r.role, kind: r.kind, text: r.text,
      ts: r.ts, turn: r.turn, toolJson: r.tool_json ? JSON.parse(r.tool_json) : {}
    }));
  };

  const sessionByMobileId = (mobileId) => {
    const r = db.prepare("SELECT * FROM sessions WHERE mobile_id = ? LIMIT 1").get(mobileId);
    return r ? {
      agentId: r.agent_id, nativeId: r.native_id, mobileId: r.mobile_id,
      title: r.title, state: r.state, updatedAt: r.updated_at, archived: Boolean(r.archived)
    } : null;
  };

  const appendEvent = (event) => {
    const stmt = db.prepare(
      "INSERT OR REPLACE INTO events (id, session_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    stmt.run(
      Number(event.id) || 0, String(event.sessionId || ""), String(event.type || ""),
      JSON.stringify(event.payload || event), Number(event.createdAtMs) || 0
    );
  };

  const latestEventId = () => {
    const r = db.prepare("SELECT MAX(id) AS max_id FROM events").get();
    return r?.max_id || 0;
  };

  const close = () => {
    try { db.close(); } catch {}
  };

  return {
    file,
    upsertSession,
    replaceMessages,
    listSessions,
    readMessages,
    sessionByMobileId,
    appendEvent,
    latestEventId,
    close
  };
}

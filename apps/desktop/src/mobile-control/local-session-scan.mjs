/**
 * Scan Claude Code / Codex / Grok CLI session files on disk.
 * Paths (defaults under $HOME):
 *   Claude: ~/.claude/projects/<cwd-encoded>/<sessionId>.jsonl
 *   Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-...-<sessionId>.jsonl
 *   Grok:   ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * @typedef {Object} ExternalSession
 * @property {'claude'|'codex'|'grok'} source
 * @property {string} sessionId
 * @property {string} filePath
 * @property {string|null} cwd
 * @property {number} mtimeMs
 * @property {number} sizeBytes
 * @property {string|null} preview
 * @property {string|null} title
 * @property {string|null} originator
 * @property {boolean} fromAionUiHint
 */

function homeDir() {
  return process.env.HOME || os.homedir();
}

/** Decode Claude project folder name to a best-effort path display. */
export function decodeClaudeProjectDir(name) {
  if (!name || name === '.') return null;
  // Claude encodes absolute paths as -Users-foo-bar → /Users/foo/bar (lossy for hyphens in path)
  if (name.startsWith('-')) {
    return '/' + name.slice(1).replace(/-/g, '/');
  }
  return name.replace(/-/g, '/');
}

function readJsonlHeadTail(filePath, maxLines = 80) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  const head = lines.slice(0, Math.min(40, lines.length));
  const tail = lines.slice(Math.max(0, lines.length - maxLines));
  return { lines, head, tail };
}

function tryParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Extract a short human preview from Claude session jsonl.
 * @param {string} filePath
 * @returns {{ sessionId: string|null, preview: string|null, cwd: string|null, title: string|null }}
 */
export function summarizeClaudeFile(filePath) {
  const base = path.basename(filePath, '.jsonl');
  let sessionId = base;
  let preview = null;
  let title = null;
  const projectDir = path.basename(path.dirname(filePath));
  let cwd = decodeClaudeProjectDir(projectDir);

  try {
    const { head, tail } = readJsonlHeadTail(filePath, 120);
    for (const line of head) {
      const o = tryParse(line);
      if (!o) continue;
      if (o.sessionId && typeof o.sessionId === 'string') sessionId = o.sessionId;
      if (typeof o.cwd === 'string' && o.cwd.trim()) cwd = o.cwd;
      if (typeof o.message?.cwd === 'string' && o.message.cwd.trim()) cwd = o.message.cwd;
      if (o.type === 'last-prompt' && o.leafUuid) {
        // keep scanning for real text
      }
    }
    // Walk recent lines for user text
    for (const line of [...head, ...tail].reverse()) {
      const o = tryParse(line);
      if (!o) continue;
      if (o.type === 'user' || o.role === 'user') {
        const t =
          o.message?.content?.[0]?.text ||
          o.message?.content ||
          o.content ||
          o.text ||
          null;
        if (typeof t === 'string' && t.trim()) {
          preview = t.replace(/\s+/g, ' ').trim().slice(0, 160);
          break;
        }
      }
      // common Claude transcript shape
      if (o.message?.role === 'user') {
        const c = o.message.content;
        const t = Array.isArray(c)
          ? c.map((x) => x?.text || '').join(' ')
          : typeof c === 'string'
            ? c
            : '';
        if (t.trim()) {
          preview = t.replace(/\s+/g, ' ').trim().slice(0, 160);
          break;
        }
      }
    }
    if (preview) title = preview.slice(0, 48);
  } catch {
    // ignore corrupt files
  }

  return { sessionId, preview, cwd, title };
}

/**
 * @param {string} filePath
 */
export function summarizeCodexFile(filePath) {
  let sessionId = null;
  let cwd = null;
  let preview = null;
  let originator = null;
  let title = null;

  // filename: rollout-...-<uuid>.jsonl
  const m = path.basename(filePath).match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  if (m) sessionId = m[1];

  try {
    const { head, tail } = readJsonlHeadTail(filePath, 100);
    for (const line of head) {
      const o = tryParse(line);
      if (!o) continue;
      if (o.type === 'session_meta' && o.payload) {
        // Forked / resumed rollout files can contain the current session_meta
        // followed by an embedded parent session_meta. The filename and first
        // metadata record identify the resumable thread; never let a later
        // parent record overwrite that id.
        if (!sessionId) sessionId = o.payload.session_id || o.payload.id || sessionId;
        if (!cwd) cwd = o.payload.cwd || cwd;
        if (!originator) originator = o.payload.originator || originator;
      }
    }
    for (const line of [...head, ...tail].reverse()) {
      const o = tryParse(line);
      if (!o) continue;
      const p = o.payload;
      if (!p) continue;
      // user message variants
      if (p.type === 'message' && p.role === 'user') {
        const parts = p.content || [];
        const text = Array.isArray(parts)
          ? parts.map((x) => x.text || x.input_text || '').join(' ')
          : '';
        if (text.trim()) {
          preview = text.replace(/\s+/g, ' ').trim().slice(0, 160);
          break;
        }
      }
      if (p.role === 'user' && typeof p.content === 'string') {
        preview = p.content.replace(/\s+/g, ' ').trim().slice(0, 160);
        break;
      }
    }
    if (preview) title = preview.slice(0, 48);
  } catch {
    // ignore
  }

  return {
    sessionId,
    cwd,
    preview,
    originator,
    title,
    fromAionUiHint: String(originator || '').toLowerCase() === 'aionui',
  };
}

function walkFiles(root, predicate, out, maxFiles = 5000) {
  if (!fs.existsSync(root) || out.length >= maxFiles) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) break;
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      walkFiles(full, predicate, out, maxFiles);
    } else if (ent.isFile() && predicate(full, ent.name)) {
      out.push(full);
    }
  }
}

/**
 * @param {{ home?: string, limit?: number }} [opts]
 * @returns {ExternalSession[]}
 */
function scanClaudeSessionsImpl(opts = {}) {
  const home = opts.home || homeDir();
  const root = path.join(home, '.claude', 'projects');
  /** @type {string[]} */
  const files = [];
  walkFiles(root, (_p, name) => name.endsWith('.jsonl') && !name.includes('subagents'), files);
  const sessions = [];
  for (const filePath of files) {
    // skip agent subagent dirs already filtered; skip empty
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (st.size < 20) continue;
    const s = summarizeClaudeFile(filePath);
    if (!s.sessionId) continue;
    sessions.push({
      source: 'claude',
      sessionId: s.sessionId,
      filePath,
      cwd: s.cwd,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      preview: s.preview,
      title: s.title || s.sessionId.slice(0, 8),
      originator: null,
      fromAionUiHint: filePath.includes('AionUi') || filePath.includes('aionui'),
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof opts.limit === 'number' ? sessions.slice(0, opts.limit) : sessions;
}

/**
 * @param {{ home?: string, limit?: number }} [opts]
 * @returns {ExternalSession[]}
 */
function scanCodexSessionsImpl(opts = {}) {
  const home = opts.home || homeDir();
  const root = path.join(home, '.codex', 'sessions');
  /** @type {string[]} */
  const files = [];
  walkFiles(root, (_p, name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), files);
  const sessions = [];
  for (const filePath of files) {
    let st;
    try {
      st = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (st.size < 20) continue;
    const s = summarizeCodexFile(filePath);
    if (!s.sessionId) continue;
    sessions.push({
      source: 'codex',
      sessionId: s.sessionId,
      filePath,
      cwd: s.cwd,
      mtimeMs: st.mtimeMs,
      sizeBytes: st.size,
      preview: s.preview,
      title: s.title || s.sessionId.slice(0, 8),
      originator: s.originator,
      fromAionUiHint: s.fromAionUiHint,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof opts.limit === 'number' ? sessions.slice(0, opts.limit) : sessions;
}

/**
 * Decode Grok session parent dir (URL-encoded absolute path, e.g. %2FUsers%2F...).
 * @param {string} name
 */
export function decodeGrokCwdDir(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Summarize a Grok session directory.
 * @param {string} sessionDir absolute path .../sessions/<cwdEnc>/<sessionId>
 */
export function summarizeGrokSessionDir(sessionDir) {
  const sessionId = path.basename(sessionDir);
  const cwdEnc = path.basename(path.dirname(sessionDir));
  let cwd = decodeGrokCwdDir(cwdEnc);
  let title = null;
  let preview = null;
  let mtimeMs = 0;
  let sizeBytes = 0;
  let fromAionUiHint = cwd.includes('.aionui') || cwd.includes('AionUi');

  const summaryPath = path.join(sessionDir, 'summary.json');
  if (fs.existsSync(summaryPath)) {
    try {
      const st = fs.statSync(summaryPath);
      mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      sizeBytes += st.size;
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      if (s.info?.cwd) cwd = s.info.cwd;
      if (s.info?.id) {
        /* keep folder name as id */
      }
      title = s.generated_title || s.session_summary || null;
      if (s.updated_at) {
        const t = Date.parse(s.updated_at);
        if (!Number.isNaN(t)) mtimeMs = Math.max(mtimeMs, t);
      }
      if (s.last_active_at) {
        const t = Date.parse(s.last_active_at);
        if (!Number.isNaN(t)) mtimeMs = Math.max(mtimeMs, t);
      }
    } catch {
      /* ignore */
    }
  }

  const chatPath = path.join(sessionDir, 'chat_history.jsonl');
  if (fs.existsSync(chatPath)) {
    try {
      const st = fs.statSync(chatPath);
      mtimeMs = Math.max(mtimeMs, st.mtimeMs);
      sizeBytes += st.size;
      const { tail } = readJsonlHeadTail(chatPath, 80);
      for (const line of tail.reverse()) {
        const o = tryParse(line);
        if (!o) continue;
        // user turns often store raw <user_query> text in content
        if (o.type === 'user' || o.role === 'user') {
          let c = o.content || o.text || '';
          if (Array.isArray(c)) {
            c = c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
          }
          if (typeof c === 'string' && c.trim()) {
            const m = c.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
            const text = (m ? m[1] : c).replace(/\s+/g, ' ').trim();
            if (text) {
              preview = text.slice(0, 160);
              break;
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (!mtimeMs) {
    try {
      mtimeMs = fs.statSync(sessionDir).mtimeMs;
    } catch {
      mtimeMs = Date.now();
    }
  }

  return {
    sessionId,
    cwd,
    preview,
    title: title || (preview ? preview.slice(0, 48) : sessionId.slice(0, 8)),
    mtimeMs,
    sizeBytes,
    fromAionUiHint,
  };
}

/**
 * @param {{ home?: string, limit?: number }} [opts]
 * @returns {ExternalSession[]}
 */
function scanGrokSessionsImpl(opts = {}) {
  const home = opts.home || homeDir();
  const root = path.join(home, '.grok', 'sessions');
  if (!fs.existsSync(root)) return [];

  /** @type {ExternalSession[]} */
  const sessions = [];
  let cwdDirs;
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const ent of cwdDirs) {
    if (!ent.isDirectory()) continue;
    if (ent.name === 'session_search.sqlite' || ent.name.endsWith('.sqlite')) continue;
    const cwdPath = path.join(root, ent.name);
    let sidDirs;
    try {
      sidDirs = fs.readdirSync(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sidEnt of sidDirs) {
      if (!sidEnt.isDirectory()) continue;
      // session ids look like UUIDs
      if (!/^[0-9a-f-]{20,}$/i.test(sidEnt.name)) continue;
      const sessionDir = path.join(cwdPath, sidEnt.name);
      // must look like a session (has chat or summary)
      if (
        !fs.existsSync(path.join(sessionDir, 'summary.json')) &&
        !fs.existsSync(path.join(sessionDir, 'chat_history.jsonl'))
      ) {
        continue;
      }
      const s = summarizeGrokSessionDir(sessionDir);
      sessions.push({
        source: 'grok',
        sessionId: s.sessionId,
        filePath: sessionDir,
        cwd: s.cwd,
        mtimeMs: s.mtimeMs,
        sizeBytes: s.sizeBytes,
        preview: s.preview,
        title: s.title,
        originator: null,
        fromAionUiHint: s.fromAionUiHint,
      });
    }
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof opts.limit === 'number' ? sessions.slice(0, opts.limit) : sessions;
}


/**
 * Full-tree scans of CLI session storage cost seconds on large home dirs, and
 * the mobile server used to rescan for every list AND every detail request.
 * Cache results briefly; session lists changing within a few seconds is fine.
 */
const SCAN_CACHE_TTL_MS = 8_000;
const scanCache = new Map();
function cachedScan(key, fn, opts) {
  const cacheKey = `${key}|${opts.home || ""}|${opts.limit ?? ""}`;
  const hit = scanCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return hit.rows;
  const rows = fn(opts);
  scanCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}
export function scanClaudeSessions(opts = {}) { return cachedScan("claude", scanClaudeSessionsImpl, opts); }
export function scanCodexSessions(opts = {}) { return cachedScan("codex", scanCodexSessionsImpl, opts); }
export function scanGrokSessions(opts = {}) { return cachedScan("grok", scanGrokSessionsImpl, opts); }

/**
 * @param {{ home?: string, limit?: number, source?: 'all'|'claude'|'codex'|'grok' }} [opts]
 */
export function scanAllSessions(opts = {}) {
  const source = opts.source || 'all';
  /** @type {ExternalSession[]} */
  let all = [];
  if (source === 'all' || source === 'claude') {
    all = all.concat(scanClaudeSessions({ home: opts.home }));
  }
  if (source === 'all' || source === 'codex') {
    all = all.concat(scanCodexSessions({ home: opts.home }));
  }
  if (source === 'all' || source === 'grok') {
    all = all.concat(scanGrokSessions({ home: opts.home }));
  }
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (typeof opts.limit === 'number') all = all.slice(0, opts.limit);
  return all;
}

/**
 * Build shell resume command for a session.
 * @param {ExternalSession} s
 */
export function resumeCommand(s) {
  const cwdPart = s.cwd ? `cd ${shellQuote(s.cwd)} && ` : '';
  if (s.source === 'claude') {
    return `${cwdPart}claude --resume ${shellQuote(s.sessionId)}`;
  }
  if (s.source === 'grok') {
    return `${cwdPart}grok --resume ${shellQuote(s.sessionId)}`;
  }
  return `${cwdPart}codex resume ${shellQuote(s.sessionId)}`;
}

function shellQuote(s) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

import { listModelsForClient } from "../../../../packages/core/src/config.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectMobileEvent, projectMobileSession } from "./dto.mjs";
import { classifyMobileApproval } from "./approval-policy.mjs";
import { createMobileCommandCatalog } from "./command-catalog.mjs";

export function encodeMobileSessionId(agentId, nativeId) {
  const payload = Buffer.from(JSON.stringify({
    agentId: String(agentId || ""),
    nativeId: String(nativeId || "")
  })).toString("base64url");
  return `ms_${payload}`;
}

export function decodeMobileSessionId(value) {
  const text = String(value || "");
  if (!text.startsWith("ms_")) throw new Error("移动会话 ID 无效");
  try {
    const parsed = JSON.parse(Buffer.from(text.slice(3), "base64url").toString("utf8"));
    const agentId = String(parsed.agentId || "");
    const nativeId = String(parsed.nativeId || "");
    if (!agentId || !nativeId) throw new Error();
    return { agentId, nativeId };
  } catch {
    throw new Error("移动会话 ID 无效");
  }
}

function visibleModels(config, agentId) {
  const providers = new Map((config.providers || []).map((provider) => [provider.id, provider]));
  return listModelsForClient(config, agentId)
    .filter((model) => model.enabled !== false)
    .map((model) => ({
      id: model.id,
      name: model.displayName || model.name || model.id,
      provider: providers.get(model.providerId)?.name || model.providerId || "",
      contextWindow: Number(model.contextWindow || model.context_window || 0) || null,
      capabilities: { ...(model.capabilities || {}) }
    }));
}

function enrichToolFiles(tool, { store, sessionId, workspaceRoot } = {}) {
  if (!tool || typeof tool !== "object") return tool;
  const files = [];
  for (const item of Array.isArray(tool.files) ? tool.files : []) {
    try {
      const filePath = path.resolve(String(workspaceRoot || ""), String(item?.path || ""));
      files.push(store.registerWorkspaceFile({
        sessionId,
        workspaceRoot,
        filePath,
        activity: item?.activity || tool.activity || "other"
      }));
    } catch {}
  }
  return { ...tool, ...(files.length ? { files } : {}) };
}

function projectMessages(messages = [], {
  store,
  sessionId = "",
  workspaceRoot = "",
  mobileMessages = []
} = {}) {
  const rows = messages.slice(-500).map((message) => ({
    id: message.id ? String(message.id).slice(0, 240) : null,
    role: ["user", "assistant", "tool", "system"].includes(message.role) ? message.role : "assistant",
    text: String(message.text || "").slice(0, 20_000),
    kind: String(message.kind || "message"),
    timestamp: message.timestamp || null,
    ...(Array.isArray(message.attachments) ? {
      attachments: projectMobileEvent({ type: "message", attachments: message.attachments }).attachments
    } : {}),
    tool: projectMobileEvent({
      type: "tool",
      tool: enrichToolFiles(message.tool, { store, sessionId, workspaceRoot })
    }).tool
  }));
  let cursor = 0;
  for (const mobile of mobileMessages) {
    const text = String(mobile.text || "");
    let index = rows.findIndex((row, rowIndex) => rowIndex >= cursor
      && row.role === "user"
      && !row.attachments?.length
      && (!text || row.text === text || row.text.startsWith(text)));
    if (index < 0) {
      index = rows.findIndex((row, rowIndex) => rowIndex >= cursor && row.role === "user" && !row.attachments?.length);
    }
    if (index < 0) continue;
    rows[index] = {
      ...rows[index],
      ...(mobile.messageId ? { id: String(mobile.messageId).slice(0, 240) } : {}),
      attachments: projectMobileEvent({ type: "message", attachments: mobile.attachments }).attachments
    };
    cursor = index + 1;
  }
  return rows;
}

function normalizeAttachments(value) {
  const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const allowedTextTypes = new Set(["text/plain", "text/markdown", "text/x-markdown", "application/json", "application/yaml", "text/yaml", "text/x-python", "text/javascript", "application/javascript", "text/typescript"]);
  const rows = Array.isArray(value) ? value.slice(0, 4) : [];
  let total = 0;
  return rows.map((item) => {
    const name = String(item?.name || "附件").replace(/[\\/\0]/g, "_").slice(0, 160);
    const mimeType = String(item?.mimeType || "application/octet-stream").toLowerCase();
    const data = String(item?.data || "");
    if (!data || data.length > 8 * 1024 * 1024) throw new Error("附件内容无效或过大");
    const byteLength = Buffer.byteLength(data, "base64");
    total += byteLength;
    if (total > 8 * 1024 * 1024) throw new Error("附件总大小不能超过 8MB");
    if (allowedImageTypes.has(mimeType)) return { name, mimeType, data, kind: "image", byteLength };
    if (allowedTextTypes.has(mimeType) || /\.(md|txt|json|ya?ml|js|jsx|ts|tsx|py|go|rs|java|c|cc|cpp|h|html|css|sql|sh)$/i.test(name)) {
      const text = Buffer.from(data, "base64").toString("utf8");
      return { name, mimeType, data, text: text.slice(0, 200_000), kind: "text", byteLength };
    }
    return { name, mimeType, data, kind: "file", byteLength };
  });
}

export function createSessionRegistry({
  runtimes = [],
  store,
  ledger,
  readConfig,
  leaseTtlMs = 10 * 60 * 1000
} = {}) {
  if (!store || !ledger || typeof readConfig !== "function") {
    throw new Error("session registry 参数不完整");
  }
  const runtimeMap = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
  const runtimeErrors = new Map();
  const pendingApprovals = new Map();
  const sessionDirectories = new Map();
  const commandCatalog = createMobileCommandCatalog();
  // Listing sessions scans each Agent's local history and (for Codex) talks to
  // its app-server. Doing that serially on every request made the phone UI wait
  // seconds per tap, so scan in parallel, bound each runtime, and cache briefly.
  const LIST_TIMEOUT_MS = 8_000;
  const SESSIONS_CACHE_TTL_MS = 15_000;
  const WORKSPACE_CACHE_TTL_MS = 60_000;
  const sessionsCache = new Map();
  let workspacesCache = { at: 0, rows: [] };
  let rootsCache = { at: 0, roots: null };
  const indexFile = path.join(
    store?.file ? path.dirname(store.file) : path.join(os.homedir(), ".switchyard", "mobile-control"),
    "session-index.json"
  );
  const INDEX_TTL_MS = 30_000;
  let diskIndex = null;
  let forceFreshSessions = false;
  const loadDiskIndex = () => {
    if (diskIndex && Date.now() - diskIndex.at < INDEX_TTL_MS) return diskIndex.payload;
    try {
      const payload = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      diskIndex = { at: Date.now(), payload };
      return payload;
    } catch {
      diskIndex = { at: Date.now(), payload: { updatedAt: 0, rows: [] } };
      return diskIndex.payload;
    }
  };
  const saveDiskIndex = (rows) => {
    const payload = { updatedAt: Date.now(), rows };
    diskIndex = { at: Date.now(), payload };
    try {
      fs.mkdirSync(path.dirname(indexFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(indexFile, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    } catch {}
  };
  const withTimeout = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 响应超时`)), ms))
  ]);

  const isArchivedRow = (runtime, row, expectedArchived) => {
    // Warm indexes can predate archive metadata and therefore contain
    // archived Codex rows marked as active. Let the runtime re-check the
    // native id before exposing those rows to the phone.
    if (runtime?.isArchivedSession && row?.id) {
      try {
        const nativeId = decodeMobileSessionId(row.id).nativeId;
        return Boolean(runtime.isArchivedSession(nativeId)) === Boolean(expectedArchived);
      } catch {}
    }
    return Boolean(row?.archived) === Boolean(expectedArchived);
  };

  const filterVisibleRows = (rows, expectedArchived) => rows.filter((row) => {
    try {
      const { agentId } = decodeMobileSessionId(row.id);
      return isArchivedRow(runtimeMap.get(agentId), row, expectedArchived);
    } catch {
      return Boolean(row?.archived) === Boolean(expectedArchived);
    }
  });

  for (const runtime of runtimes) {
    runtime.subscribe?.((event) => {
      if (!event?.sessionId) return;
      const mobileSessionId = encodeMobileSessionId(runtime.id, event.sessionId);
      if (event.type === "approval" && event.requestId !== undefined) {
        const policy = classifyMobileApproval(event.request || {});
        const id = `approval_${randomUUID()}`;
        pendingApprovals.set(id, {
          id,
          runtime,
          requestId: event.requestId,
          sessionId: mobileSessionId,
          createdAt: new Date().toISOString(),
          ...policy
        });
        ledger.append({
          sessionId: mobileSessionId,
          type: "approval",
          summary: policy.mobileAllowed ? "等待手机端一次性审批" : "等待桌面端审批"
        });
        return;
      }
      ledger.append(projectMobileEvent({
        sessionId: mobileSessionId,
        type: event.type,
        summary: event.summary,
        role: event.role,
        attachments: event.attachments,
        tool: enrichToolFiles(event.tool, {
          store,
          sessionId: mobileSessionId,
          workspaceRoot: sessionDirectories.get(mobileSessionId) || ""
        })
      }));
      if (["completed", "failed", "cancelled", "canceled"].includes(String(event.summary || "").toLowerCase())) {
        // 租约自然过期是兜底；运行时明确终态时不强行猜测 owner。
      }
    });
  }

  const runtimeFor = (mobileSessionId) => {
    const decoded = decodeMobileSessionId(mobileSessionId);
    const runtime = runtimeMap.get(decoded.agentId);
    if (!runtime) throw new Error(`Agent runtime 不可用：${decoded.agentId}`);
    return { runtime, ...decoded };
  };

  const discoveredRuntimes = new Set();
  const listSessions = async ({ agent = "", archived = false } = {}) => {
    const key = `${agent || "all"}|${archived ? "1" : "0"}`;
    const cached = sessionsCache.get(key);
    const needsDiscovery = runtimes.some((runtime) => !discoveredRuntimes.has(runtime.id));
    if (cached && Date.now() - cached.at < SESSIONS_CACHE_TTL_MS && !needsDiscovery) {
      const visibleCachedRows = filterVisibleRows(cached.rows, archived);
      if (visibleCachedRows.length !== cached.rows.length) sessionsCache.set(key, { at: Date.now(), rows: visibleCachedRows });
      return visibleCachedRows;
    }

    // Stale-while-revalidate only after every runtime has been scanned at least
    // once; otherwise Agent availability / errors would stay unknown forever.
    if (!agent && !archived && !needsDiscovery && !forceFreshSessions) {
      const warm = loadDiskIndex();
      if (Array.isArray(warm.rows) && warm.rows.length && Date.now() - Number(warm.updatedAt || 0) < 5 * 60_000) {
        void Promise.resolve().then(async () => {
          try {
            const fresh = await listSessionsFresh({ agent, archived });
            sessionsCache.set(key, { at: Date.now(), rows: fresh });
            saveDiskIndex(fresh);
          } catch {}
        });
        // The on-disk index may have been written by an older build before
        // archive filtering was enforced. Never leak archived rows through the
        // stale-while-revalidate fast path.
        const visibleWarmRows = filterVisibleRows(warm.rows, archived);
        sessionsCache.set(key, { at: Date.now(), rows: visibleWarmRows });
        return visibleWarmRows;
      }
    }
    return listSessionsFresh({ agent, archived });
  };

  const listSessionsFresh = async ({ agent = "", archived = false } = {}) => {
    const key = `${agent || "all"}|${archived ? "1" : "0"}`;
    const targets = runtimes.filter((runtime) => !agent || runtime.id === agent);
    const results = await Promise.allSettled(targets.map((runtime) => withTimeout(
      Promise.resolve().then(() => runtime.listSessions({ archived })),
      LIST_TIMEOUT_MS,
      `${runtime.label || runtime.id} 会话扫描`
    )));
    const rows = [];
    results.forEach((result, index) => {
      const runtime = targets[index];
      discoveredRuntimes.add(runtime.id);
      if (result.status !== "fulfilled") {
        runtimeErrors.set(runtime.id, result.reason?.message || String(result.reason));
        return;
      }
      runtimeErrors.delete(runtime.id);
      for (const row of result.value) {
        const id = encodeMobileSessionId(runtime.id, row.id);
        const overlay = store.getOverlay(id);
        const projected = projectMobileSession({
          ...row,
          id,
          agentId: runtime.id,
          model: overlay.model || defaultModelFor(runtime.id) || row.model,
          capabilities: row.capabilities || runtime.capabilities
        }, overlay);
        const directory = String(row.directory || row.cwd || "");
        if (directory) sessionDirectories.set(id, directory);
        if (overlay?.hidden) continue;
        if (projected.archived === Boolean(archived)) rows.push(projected);
      }
    });
    rows.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
    sessionsCache.set(key, { at: Date.now(), rows });
    if (!agent && !archived) {
      saveDiskIndex(rows);
      forceFreshSessions = false;
    }
    return rows;
  };

  const detailCache = new Map();
  const DETAIL_CACHE_TTL_MS = 5_000;
  const readSession = async (mobileSessionId) => {
    const cached = detailCache.get(mobileSessionId);
    if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) return cached.detail;
    const { runtime, nativeId } = runtimeFor(mobileSessionId);
    const detail = await runtime.readSession(nativeId);
    const workspaceRoot = String(detail.directory || detail.cwd || "");
    if (workspaceRoot) sessionDirectories.set(mobileSessionId, workspaceRoot);
    const projected = {
      ...projectMobileSession({
        ...detail,
        id: mobileSessionId,
        agentId: runtime.id,
        model: store.getOverlay(mobileSessionId).model || defaultModelFor(runtime.id) || detail.model,
        capabilities: detail.capabilities || runtime.capabilities
      }, store.getOverlay(mobileSessionId)),
      messages: projectMessages(detail.messages || [], {
        store,
        sessionId: mobileSessionId,
        workspaceRoot,
        mobileMessages: store.listMobileMessages?.(mobileSessionId) || []
      }),
      settings: runtime.getSettings?.(nativeId) || null
    };
    // Running turns must always be fresh; finished conversations are stable on
    // disk, so repeat opens (back & forth between sessions) skip the rescan.
    if (projected.state === "completed") detailCache.set(mobileSessionId, { at: Date.now(), detail: projected });
    return projected;
  };

  const modelsCache = new Map();
  const availableModels = (agentId) => {
    const key = String(agentId || "");
    const cached = modelsCache.get(key);
    if (cached && Date.now() - cached.at < WORKSPACE_CACHE_TTL_MS) return cached.rows;
    const rows = visibleModels(readConfig(), key);
    modelsCache.set(key, { at: Date.now(), rows });
    return rows;
  };

  const listCommands = async (agentId, { cwd = "", sessionId = "" } = {}) => {
    const key = String(agentId || "");
    const runtime = runtimeMap.get(key);
    if (!runtime) return [];
    let directory = "";
    if (sessionId) {
      const resolved = runtimeFor(String(sessionId));
      if (resolved.runtime.id !== key) throw new Error("会话与 Agent 不匹配");
      const detail = await resolved.runtime.readSession(resolved.nativeId);
      directory = String(detail.directory || detail.cwd || "");
    } else if (cwd) {
      directory = await assertWorkspacePath(cwd);
    }
    const mentions = key === "codex" ? await runtime.listMentions?.({ cwd: directory }) || [] : [];
    return commandCatalog.list(key, runtime.listCommands?.() || [], { mentions });
  };

  const defaultModelFor = (agentId) => {
    const models = availableModels(agentId);
    const config = readConfig() || {};
    const preferred = String(config.clients?.[agentId]?.defaultModel || config.defaultModel || "").trim();
    if (preferred && models.some((model) => model.id === preferred)) return preferred;
    return models[0]?.id || "";
  };

  const isWithin = (candidate, root) => {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };

  const workspaceRoots = async () => {
    if (rootsCache.roots && Date.now() - rootsCache.at < WORKSPACE_CACHE_TTL_MS) return rootsCache.roots;
    const roots = new Set([os.homedir()]);
    const results = await Promise.allSettled(runtimes.map((runtime) => withTimeout(
      Promise.resolve().then(() => runtime.listSessions({ archived: false })),
      LIST_TIMEOUT_MS,
      `${runtime.label || runtime.id} 工作区扫描`
    )));
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const session of result.value) {
        const directory = String(session.directory || session.cwd || "").trim();
        if (directory && fs.existsSync(directory)) roots.add(path.resolve(directory));
      }
    }
    rootsCache = { at: Date.now(), roots: [...roots] };
    return rootsCache.roots;
  };

  const assertWorkspacePath = async (value, roots) => {
    const directory = path.resolve(String(value || ""));
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      throw new Error("工作目录不存在或不可访问");
    }
    const allowed = roots || await workspaceRoots();
    if (!allowed.some((root) => isWithin(directory, root))) {
      throw new Error("只能浏览当前用户目录或已有项目目录");
    }
    return directory;
  };

  const browseWorkspaces = async (value = "") => {
    const roots = await workspaceRoots();
    const directory = await assertWorkspacePath(value || os.homedir(), roots);
    const children = [];
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        children.push({ path: path.join(directory, entry.name), name: entry.name });
      }
    } catch {
      throw new Error("无法读取该目录");
    }
    children.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    const parent = path.dirname(directory);
    return {
      path: directory,
      name: path.basename(directory) || directory,
      parent: roots.some((root) => path.resolve(root) === directory) ? null : parent,
      directories: children.slice(0, 200)
    };
  };

  const deleteWorkspaceDirectory = async (value, { force = false } = {}) => {
    const directory = await assertWorkspacePath(value);
    // Recent workspaces are also browsing roots. They must still be removable;
    // treating every allowed root as protected made the exact directories shown
    // on the phone impossible to delete. Only the user's home and filesystem
    // root remain protected.
    if (path.resolve(directory) === path.resolve(os.homedir()) || path.parse(directory).root === path.resolve(directory)) {
      throw new Error("不能删除用户主目录或文件系统根目录");
    }
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    if (!force && entries.length) {
      const error = new Error("文件夹不为空。若确认删除，请使用强制删除");
      error.code = "DIRECTORY_NOT_EMPTY";
      error.entryCount = entries.length;
      throw error;
    }
    fs.rmSync(directory, { recursive: Boolean(force), force: Boolean(force) });
    workspacesCache = { at: 0, rows: [] };
    rootsCache = { at: 0, roots: null };
    return { ok: true, path: directory, forced: Boolean(force) };
  };

  const renameWorkspaceDirectory = async (value, name) => {
    const directory = await assertWorkspacePath(value);
    if (path.resolve(directory) === path.resolve(os.homedir()) || path.parse(directory).root === path.resolve(directory)) {
      throw new Error("不能重命名用户主目录或文件系统根目录");
    }
    const folder = String(name || "").trim();
    if (!folder || folder === "." || folder === ".." || /[\\/\0]/.test(folder)) {
      throw new Error("文件夹名称无效");
    }
    const parent = path.dirname(directory);
    const target = path.join(parent, folder);
    if (!isWithin(target, parent)) throw new Error("文件夹名称无效");
    if (fs.existsSync(target)) throw new Error("同名文件夹已存在");
    fs.renameSync(directory, target);
    // Keep recent workspace cache from pointing at the old path.
    workspacesCache = { at: 0, rows: [] };
    rootsCache = { at: 0, roots: null };
    return { path: target, name: folder };
  };

  const createWorkspaceDirectory = async (parent, name) => {
    const base = await assertWorkspacePath(parent || os.homedir());
    const folder = String(name || "").trim();
    if (!folder || folder === "." || folder === ".." || /[\\/\0]/.test(folder)) {
      throw new Error("文件夹名称无效");
    }
    const target = path.join(base, folder);
    if (!isWithin(target, base)) throw new Error("文件夹名称无效");
    if (fs.existsSync(target)) throw new Error("同名文件夹已存在");
    fs.mkdirSync(target, { recursive: false, mode: 0o755 });
    return { path: target, name: folder };
  };

  const recentWorkspaces = async () => {
    if (workspacesCache.rows.length && Date.now() - workspacesCache.at < WORKSPACE_CACHE_TTL_MS) return workspacesCache.rows;
    const seen = new Map();
    const results = await Promise.allSettled(runtimes.map((runtime) => withTimeout(
      Promise.resolve().then(() => runtime.listSessions({ archived: false })),
      LIST_TIMEOUT_MS,
      `${runtime.label || runtime.id} 工作区扫描`
    )));
    results.forEach((result, index) => {
      const runtime = runtimes[index];
      if (result.status !== "fulfilled") {
        runtimeErrors.set(runtime.id, result.reason?.message || String(result.reason));
        return;
      }
      runtimeErrors.delete(runtime.id);
      for (const session of result.value) {
        const cwd = String(session.directory || session.cwd || "").trim();
        if (!cwd || seen.has(cwd)) continue;
        seen.set(cwd, {
          id: cwd,
          path: cwd,
          name: cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd,
          agent: runtime.id,
          updatedAt: session.updatedAt || null
        });
      }
    });
    const rows = [...seen.values()].sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 12);
    workspacesCache = { at: Date.now(), rows };
    return rows;
  };

  const assertModelAvailable = (agentId, modelId) => {
    const model = availableModels(agentId).find((item) => item.id === modelId);
    if (!model) {
      const error = new Error("该模型对当前 Agent 不可用");
      error.code = "MODEL_UNAVAILABLE";
      throw error;
    }
    return model;
  };

  const acquire = (sessionId, ownerId) => store.acquireLease({
    sessionId,
    ownerId,
    ttlMs: leaseTtlMs
  });

  const setSessionModel = async (mobileSessionId, modelId, effort, ownerId) => {
    const { runtime, agentId, nativeId } = runtimeFor(mobileSessionId);
    assertModelAvailable(agentId, modelId);
    acquire(mobileSessionId, ownerId);
    await runtime.setModel(nativeId, modelId, effort);
    store.patchOverlay(mobileSessionId, { model: modelId });
    sessionsCache.clear();
    detailCache.delete(mobileSessionId);
    ledger.append({
      sessionId: mobileSessionId,
      type: "model",
      summary: `${modelId}${effort ? ` · ${effort}` : ""}（下一轮生效）`
    });
    return { ok: true, effectiveFrom: "next_turn" };
  };

  const setSessionSettings = async (mobileSessionId, payload = {}, ownerId) => {
    const { runtime, nativeId } = runtimeFor(mobileSessionId);
    if (typeof runtime.setSettings !== "function") {
      throw new Error("当前 Agent 不支持从手机调整权限或思考程度");
    }
    const effort = String(payload.effort || "").trim();
    const permissionMode = String(payload.permissionMode || "").trim();
    const settings = runtime.settings || {};
    if (effort && !settings.effortOptions?.includes(effort)) throw new Error("思考程度无效");
    if (permissionMode && !settings.permissionOptions?.some((item) => item.id === permissionMode)) throw new Error("权限模式无效");
    if (!effort && !permissionMode) throw new Error("请选择需要调整的设置");
    acquire(mobileSessionId, ownerId);
    await runtime.setSettings(nativeId, { ...(effort ? { effort } : {}), ...(permissionMode ? { permissionMode } : {}) });
    ledger.append({
      sessionId: mobileSessionId,
      type: "status",
      summary: "对话设置将在下一轮生效"
    });
    return { ok: true, effectiveFrom: "next_turn", settings: runtime.getSettings?.(nativeId) || null };
  };

  const perform = async (mobileSessionId, action, payload = {}, ownerId) => {
    const { runtime, nativeId } = runtimeFor(mobileSessionId);
    if (action === "sendMessage") {
      const text = String(payload.text || "").trim();
      const attachments = normalizeAttachments(payload.attachments);
      if (!text && !attachments.length) throw new Error("消息或附件不能为空");
      const remembered = store.rememberMessage({
        sessionId: mobileSessionId,
        messageId: payload.messageId
      });
      if (remembered.duplicate) return { accepted: true, duplicate: true };
      const storedAttachments = attachments.map((attachment, index) => store.putAttachment({
        sessionId: mobileSessionId,
        messageId: payload.messageId,
        index,
        name: attachment.name,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        data: attachment.data
      }));
      const runtimeAttachments = attachments.map((attachment, index) => ({
        ...attachment,
        path: store.resolveAsset(storedAttachments[index].id)?.path || ""
      }));
      store.rememberMobileMessage({
        sessionId: mobileSessionId,
        messageId: payload.messageId,
        text,
        attachments: storedAttachments
      });
      acquire(mobileSessionId, ownerId);
      const effectiveModel = store.getOverlay(mobileSessionId).model || defaultModelFor(runtime.id);
      if (effectiveModel && typeof runtime.setModel === "function") {
        await runtime.setModel(nativeId, effectiveModel);
      }
      // HTTP 只确认已受理。Agent 的连接、首个 turn/start 或 ACP 初始化可能较慢，
      // 它们不能阻塞手机端的输入反馈。
      detailCache.delete(mobileSessionId);
      ledger.append({
        sessionId: mobileSessionId,
        type: "message",
        role: "user",
        summary: text,
        ...(storedAttachments.length ? { attachments: storedAttachments } : {})
      });
      ledger.append({ sessionId: mobileSessionId, type: "status", summary: "running" });
      void Promise.resolve()
        .then(() => runtime.sendMessage(nativeId, {
          text,
          ...(runtimeAttachments.length ? { attachments: runtimeAttachments } : {}),
          messageId: payload.messageId
        }))
        .catch((error) => {
          ledger.append({
            sessionId: mobileSessionId,
            type: "error",
            summary: error?.message || String(error)
          });
        });
      return { accepted: true, duplicate: false, state: "running" };
    }

    acquire(mobileSessionId, ownerId);
    if (action === "rename") {
      if (typeof runtime.rename === "function") await runtime.rename(nativeId, payload.title);
      store.patchOverlay(mobileSessionId, { title: payload.title });
      sessionsCache.clear();
      detailCache.delete(mobileSessionId);
      return { ok: true };
    }
    if (action === "archive") {
      if (typeof runtime.archive === "function") await runtime.archive(nativeId);
      store.patchOverlay(mobileSessionId, { archived: true });
      sessionsCache.clear();
      detailCache.delete(mobileSessionId);
      return { ok: true };
    }
    if (action === "unarchive") {
      if (typeof runtime.unarchive === "function") await runtime.unarchive(nativeId);
      store.patchOverlay(mobileSessionId, { archived: false });
      sessionsCache.clear();
      detailCache.delete(mobileSessionId);
      return { ok: true };
    }
    if (action === "pin") {
      store.patchOverlay(mobileSessionId, { pinned: Boolean(payload.pinned) });
      return { ok: true };
    }
    if (action === "cancel" && typeof runtime.cancel === "function") {
      await runtime.cancel(nativeId);
      return { ok: true };
    }
    if (action === "delete") {
      let hiddenOnly = false;
      if (typeof runtime.delete === "function") {
        try {
          await runtime.delete(nativeId);
        } catch (error) {
          // Some Agent histories (notably Codex desktop rollouts) cannot be
          // physically removed from mobile. Fall back to local hide/archive so
          // the phone UI still lets users clean up their list.
          hiddenOnly = true;
          store.patchOverlay(mobileSessionId, { archived: true, hidden: true });
          ledger.append({
            sessionId: mobileSessionId,
            type: "status",
            summary: `会话已从手机列表移除（${error?.message || "原生删除不可用"}）`
          });
        }
      } else {
        hiddenOnly = true;
        store.patchOverlay(mobileSessionId, { archived: true, hidden: true });
      }
      sessionsCache.clear();
      // The warm disk index is also read by the next phone refresh. Remove the
      // deleted row immediately so a stale-while-revalidate response cannot
      // resurrect it for up to the index TTL.
      if (hiddenOnly) {
        const index = loadDiskIndex();
        saveDiskIndex((index.rows || []).filter((row) => row.id !== mobileSessionId));
      }
      detailCache.delete(mobileSessionId);
      return { ok: true, hiddenOnly };
    }
    if (action === "fork" && typeof runtime.fork === "function") {
      const result = await runtime.fork(nativeId);
      return { sessionId: encodeMobileSessionId(runtime.id, result.sessionId) };
    }
    if (action === "compact" && typeof runtime.compact === "function") {
      await runtime.compact(nativeId);
      return { ok: true };
    }
    throw new Error(`当前 Agent 不支持操作：${action}`);
  };

  const createSession = async (agentId, payload = {}, ownerId) => {
    const runtime = runtimeMap.get(String(agentId || ""));
    if (!runtime) throw new Error(`Agent runtime 不可用：${agentId}`);
    const model = String(payload.model || defaultModelFor(runtime.id) || "").trim();
    if (model) assertModelAvailable(runtime.id, model);
    // Name the session after the first task so it never shows a raw id/UUID.
    const promptText = String(payload.prompt || "").replace(/\s+/g, " ").trim();
    const title = String(payload.title || "").trim() || promptText.slice(0, 24) || "新会话";
    const result = await runtime.createSession({ ...payload, ...(model ? { model } : {}), title });
    const id = encodeMobileSessionId(runtime.id, result.sessionId);
    if (payload.cwd) sessionDirectories.set(id, String(payload.cwd));
    acquire(id, ownerId);
    store.patchOverlay(id, { title, ...(model ? { model } : {}) });
    // A newly created native thread must be visible immediately instead of
    // being hidden behind the warm on-disk session index for up to 15 seconds.
    sessionsCache.clear();
    detailCache.delete(id);
    forceFreshSessions = true;
    return { sessionId: id };
  };

  const listApprovals = () => [...pendingApprovals.values()]
    .map((approval) => ({
      id: approval.id,
      sessionId: approval.sessionId,
      title: approval.mobileAllowed ? "操作审批" : "需要桌面审批",
      summary: approval.summary,
      risk: approval.risk,
      requiresDesktop: approval.requiresDesktop,
      actions: [...approval.actions],
      createdAt: approval.createdAt
    }));

  const resolveApproval = async (approvalId, decision) => {
    const approval = pendingApprovals.get(String(approvalId || ""));
    if (!approval || !approval.mobileAllowed) throw new Error("审批不存在或必须在桌面处理");
    if (approval.protocol === "codex") {
      const codexDecision = decision === "allow_once"
        ? "accept"
        : decision === "deny_once"
          ? "decline"
          : "";
      if (!codexDecision) throw new Error("审批决定无效");
      approval.runtime.respond?.(approval.requestId, { decision: codexDecision });
    } else {
      const optionId = decision === "allow_once"
        ? approval.allowOptionId
        : decision === "deny_once"
          ? approval.rejectOptionId
          : null;
      if (!optionId) throw new Error("审批决定无效");
      approval.runtime.respond?.(approval.requestId, {
        outcome: { outcome: "selected", optionId }
      });
    }
    pendingApprovals.delete(approval.id);
    ledger.append({
      sessionId: approval.sessionId,
      type: "approval",
      summary: decision === "allow_once" ? "手机端已允许一次" : "手机端已拒绝一次"
    });
    return { ok: true };
  };

  return {
    listSessions,
    readSession,
    createSession,
    availableModels,
    listCommands,
    recentWorkspaces,
    browseWorkspaces,
    createWorkspaceDirectory,
    deleteWorkspaceDirectory,
    renameWorkspaceDirectory,
    setSessionModel,
    setSessionSettings,
    perform,
    listApprovals,
    resolveApproval,
    resolveAsset: (assetId) => store.resolveAsset?.(assetId) || null,
    listEvents: (filters) => ledger.list(filters),
    subscribeEvents: (handler) => ledger.subscribe(handler),
    agents: () => runtimes.map((runtime) => ({
      id: runtime.id,
      name: runtime.label || runtime.id,
      defaultModelId: defaultModelFor(runtime.id) || null,
      // Discovery failures must not make an installed Agent disappear from the
      // phone. Users still need to start a fresh session or see the recovery hint.
      available: true,
      sessionDiscoveryAvailable: !runtimeErrors.has(runtime.id),
      error: runtimeErrors.get(runtime.id) || null,
      capabilities: { ...(runtime.capabilities || {}) },
      capabilityModes: { ...(runtime.capabilityModes || {}) },
      settings: runtime.settings
        ? {
            effortOptions: [...(runtime.settings.effortOptions || [])],
            permissionOptions: (runtime.settings.permissionOptions || []).map((item) => ({ ...item }))
          }
        : null
    }))
  };
}

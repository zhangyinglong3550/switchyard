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
    ...(message.turnId ? { turnId: String(message.turnId).slice(0, 240) } : {}),
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
  const activeSessions = new Set();
  const isQueuePaused = (sessionId) => store.isQueuePaused?.(sessionId) || false;
  const setQueuePaused = (sessionId, paused) => store.setQueuePaused?.(sessionId, paused);
  const commandCatalog = createMobileCommandCatalog();
  // Listing sessions scans each Agent's local history and (for Codex) talks to
  // its app-server. Doing that serially on every request made the phone UI wait
  // seconds per tap, so scan in parallel, bound each runtime, and cache briefly.
  const LIST_TIMEOUT_MS = 8_000;
  const SESSIONS_CACHE_TTL_MS = 15_000;
  const WORKSPACE_CACHE_TTL_MS = 60_000;
  const sessionsCache = new Map();
  const sessionRefreshes = new Map();
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

  // Never consult a runtime while displaying the persisted index. In
  // particular, checking Codex archive membership can walk its history tree;
  // doing that once per row turned the supposed cold-start fast path back into
  // a multi-second synchronous scan. A background refresh corrects stale
  // archive metadata immediately after the first paint.
  const filterVisibleRows = (rows, expectedArchived) => rows.filter((row) =>
    Boolean(row?.archived) === Boolean(expectedArchived)
  );

  for (const runtime of runtimes) {
    runtime.subscribe?.((event) => {
      if (!event?.sessionId) return;
      const mobileSessionId = encodeMobileSessionId(runtime.id, event.sessionId);
      if (event.type === "approval" && event.requestId !== undefined) {
        const policy = classifyMobileApproval(event.request || {});
        const overlay = store.getOverlay(mobileSessionId) || {};
        // 会话内自动允许：只在本机 Switchyard overlay 生效，不向 Agent 申请永久授权。
        if (policy.mobileAllowed && overlay.autoApproveSession) {
          if (policy.protocol === "codex") {
            runtime.respond?.(event.requestId, { decision: "accept" });
          } else if (policy.allowOptionId) {
            runtime.respond?.(event.requestId, { outcome: { outcome: "selected", optionId: policy.allowOptionId } });
          }
          detailCache.delete(mobileSessionId);
          ledger.append({
            sessionId: mobileSessionId,
            type: "approval",
            summary: "会话内已自动允许"
          });
          return;
        }
        const id = `approval_${randomUUID()}`;
        pendingApprovals.set(id, {
          id,
          runtime,
          requestId: event.requestId,
          sessionId: mobileSessionId,
          createdAt: new Date().toISOString(),
          ...policy
        });
        detailCache.delete(mobileSessionId);
        sessionsCache.clear();
        ledger.append({
          sessionId: mobileSessionId,
          type: "approval",
          summary: policy.mobileAllowed ? "等待手机端一次性审批" : "等待审批",
          approval: {
            id,
            requiresDesktop: policy.requiresDesktop,
            summary: policy.summary
          }
        });
        ledger.append({
          sessionId: mobileSessionId,
          type: "status",
          summary: "waiting_for_approval"
        });
        return;
      }
      let delivery = null;
      if (event.type === "file_delivery" && event.delivery?.path) {
        try {
          delivery = store.registerWorkspaceFile({
            sessionId: mobileSessionId,
            workspaceRoot: sessionDirectories.get(mobileSessionId) || "",
            filePath: path.resolve(sessionDirectories.get(mobileSessionId) || "", String(event.delivery.path)),
            activity: "edit", source: "delivery", deliveryAt: new Date().toISOString()
          });
        } catch {}
      }
      ledger.append(projectMobileEvent({
        sessionId: mobileSessionId,
        type: event.type,
        summary: event.summary,
        role: event.role,
        attachments: event.attachments,
        route: event.route,
        ...(delivery ? { delivery } : {}),
        tool: enrichToolFiles(event.tool, {
          store,
          sessionId: mobileSessionId,
          workspaceRoot: sessionDirectories.get(mobileSessionId) || ""
        })
      }));
      const terminalState = String(event.summary || "").toLowerCase();
      const ended = ["completed", "failed", "cancelled", "canceled", "incomplete", "end_turn", "stop", "max_tokens", "length"].includes(terminalState) || event.type === "error";
      if (ended) {
        activeSessions.delete(mobileSessionId);
        detailCache.delete(mobileSessionId);
        sessionsCache.clear();
        if (["completed", "end_turn", "stop", "max_tokens", "length"].includes(terminalState)) void dispatchNext(mobileSessionId);
      }
    });
  }

  // Keep a small, redacted diagnostic queue for Codex calls that did not carry
  // a trusted task id. This deliberately never guesses a destination session.
  const unmatchedGatewayRequests = [];
  const recordUnmatchedGatewayRequest = (entry = {}) => {
    if (String(entry.clientId || "") !== "codex" || String(entry.correlationThreadId || "").trim()) return;
    if (!entry.providerId && !entry.modelId && !entry.requestedModel) return;
    if (!entry.requestLog && !entry.traceLog) return;
    const response = entry.responseSummary && typeof entry.responseSummary === "object" ? entry.responseSummary : {};
    const terminal = response.streamTerminal && typeof response.streamTerminal === "object" ? response.streamTerminal : {};
    const item = {
      createdAt: entry.ts || new Date().toISOString(),
      requestedModel: String(entry.requestedModel || ""), modelId: String(entry.modelId || ""),
      providerId: String(entry.providerId || ""), upstreamModel: String(entry.upstreamModel || ""),
      apiFormat: String(entry.apiFormat || ""), status: Number(entry.status) || 0,
      state: terminal.state || (entry.requestLog ? ((Number(entry.status) || 0) >= 400 ? "failed" : "completed") : "running"),
      reason: "missing_thread_correlation"
    };
    const key = `${item.createdAt}|${item.requestedModel}|${item.providerId}|${item.status}|${item.state}`;
    if (unmatchedGatewayRequests.some((row) => row._key === key)) return;
    unmatchedGatewayRequests.push({ ...item, _key: key });
    if (unmatchedGatewayRequests.length > 100) unmatchedGatewayRequests.splice(0, unmatchedGatewayRequests.length - 100);
  };
  const listUnmatchedGatewayRequests = () => unmatchedGatewayRequests.slice().reverse().map(({ _key, ...item }) => item);

  // Gateway request logs use the trusted Codex parent-thread header as their
  // correlation key. Do not attempt prompt/timestamp matching: a wrong route is
  // worse than no route, especially when several Codex tasks run concurrently.
  const recordGatewayRequest = (entry = {}) => {
    recordUnmatchedGatewayRequest(entry);
    const nativeId = String(entry.correlationThreadId || "").trim();
    if (String(entry.clientId || "") !== "codex" || !nativeId) return null;
    const sessionId = encodeMobileSessionId("codex", nativeId);
    const response = entry.responseSummary && typeof entry.responseSummary === "object"
      ? entry.responseSummary
      : {};
    const streamTerminal = response.streamTerminal && typeof response.streamTerminal === "object"
      ? response.streamTerminal
      : {};
    const status = Number(entry.status) || 0;
    const terminalState = streamTerminal.state || (entry.requestLog
      ? (status >= 400 || !status ? "failed" : "completed")
      : "");
    const terminalReason = streamTerminal.reason || (entry.requestLog
      ? (status >= 400 || !status ? "upstream_error" : "protocol_terminal")
      : "");
    const route = {
      requestedModel: entry.requestedModel || "",
      modelId: entry.modelId || "",
      providerId: entry.providerId || "",
      upstreamModel: entry.upstreamModel || "",
      apiFormat: entry.apiFormat || "",
      account: entry.accountEmail || entry.accountId || "",
      terminalState,
      terminalReason
    };
    const hasRoute = Object.values(route).some(Boolean);
    if (!hasRoute) return null;
    const isFinal = Boolean(entry.requestLog);
    const summary = isFinal
      ? (terminalState || (status >= 400 ? "failed" : "completed"))
      : "running";
    ledger.append({
      sessionId,
      type: "status",
      summary,
      route
    });
    if (isFinal) {
      activeSessions.delete(sessionId);
      detailCache.delete(sessionId);
      sessionsCache.clear();
    } else {
      activeSessions.add(sessionId);
    }
    return sessionId;
  };

  const runtimeFor = (mobileSessionId) => {
    const decoded = decodeMobileSessionId(mobileSessionId);
    const runtime = runtimeMap.get(decoded.agentId);
    if (!runtime) throw new Error(`Agent runtime 不可用：${decoded.agentId}`);
    return { runtime, ...decoded };
  };

  const discoveredRuntimes = new Set();
  const queueSessionRefresh = ({ agent = "", archived = false } = {}) => {
    const key = `${agent || "all"}|${archived ? "1" : "0"}`;
    if (sessionRefreshes.has(key)) return sessionRefreshes.get(key);
    // Start on a later task so HTTP can flush the warm index to the phone before
    // any synchronous local-history scanner gets a chance to block this process.
    // Do not begin an expensive synchronous history scan while the WebView is
    // still loading the initial HTML/CSS/JS bundle. On large histories that
    // scan can monopolize the desktop process and make the phone appear stuck.
    const refresh = new Promise((resolve) => setTimeout(resolve, 2_500)).then(async () => {
      const fresh = await listSessionsFresh({ agent, archived });
      sessionsCache.set(key, { at: Date.now(), rows: fresh });
      if (!agent && !archived) saveDiskIndex(fresh);
      return fresh;
    }).catch(() => null).finally(() => sessionRefreshes.delete(key));
    sessionRefreshes.set(key, refresh);
    return refresh;
  };
  const listSessions = async ({ agent = "", archived = false } = {}) => {
    const key = `${agent || "all"}|${archived ? "1" : "0"}`;
    const cached = sessionsCache.get(key);
    if (cached && Date.now() - cached.at < SESSIONS_CACHE_TTL_MS) {
      const visibleCachedRows = filterVisibleRows(cached.rows, archived);
      if (visibleCachedRows.length !== cached.rows.length) sessionsCache.set(key, { at: Date.now(), rows: visibleCachedRows });
      return visibleCachedRows;
    }

    // A phone must never wait for every local Agent history scan before it can
    // draw the list. The persisted index is safe, path-free metadata, so show it
    // immediately even on a cold desktop start and refresh it in the background.
    if (!agent && !archived && !forceFreshSessions) {
      const warm = loadDiskIndex();
      if (Array.isArray(warm.rows) && warm.rows.length && Date.now() - Number(warm.updatedAt || 0) < 24 * 60 * 60_000) {
        const visibleWarmRows = filterVisibleRows(warm.rows, archived);
        sessionsCache.set(key, { at: Date.now(), rows: visibleWarmRows });
        void queueSessionRefresh({ agent, archived });
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
        let projected;
        try {
          projected = projectMobileSession({
            ...row,
            id,
            agentId: runtime.id,
            model: overlay.model || defaultModelFor(runtime.id) || row.model,
            capabilities: row.capabilities || runtime.capabilities
          }, overlay);
        } catch (error) {
          console.error(`[registry:${runtime.id}] 投影失败 id=${String(id).slice(0, 30)}: ${error.message}`);
          continue;
        }
        const directory = String(row.directory || row.cwd || "");
        if (directory) sessionDirectories.set(id, directory);
        if (["running", "queued", "waiting_for_approval", "waiting_for_desktop_approval"].includes(String(projected.state))) activeSessions.add(id);
        else activeSessions.delete(id);
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
      // Warm only a few recent settled conversations after the list has already
      // been returned. Most taps then hit memory rather than a local transcript scan.
      setTimeout(() => void Promise.allSettled(
        rows.filter((row) => !["running", "queued", "waiting_for_approval", "waiting_for_desktop_approval"].includes(row.state))
          .slice(0, 3)
          .map((row) => readSession(row.id, { messageLimit: 120 }))
      ), 2_500);
    }
    return rows;
  };

  const detailCache = new Map();
  const detailRequests = new Map();
  // Agent runtimes may need to rescan large local transcripts. Keep completed
  // conversations warm longer; runtime events and every write invalidate this cache.
  const DETAIL_CACHE_TTL_MS = 10 * 60_000;
  const MAX_MOBILE_DETAIL_MESSAGES = 500;
  const isLiveState = (state) => ["running", "queued", "waiting_for_approval", "waiting_for_desktop_approval"].includes(String(state));
  const requestedMessageLimit = (value) => Math.min(
    MAX_MOBILE_DETAIL_MESSAGES,
    Math.max(1, Number(value) || MAX_MOBILE_DETAIL_MESSAGES)
  );
  const detailWindow = (entry, messageLimit) => {
    const limit = requestedMessageLimit(messageLimit);
    const messages = projectMessages((entry.sourceMessages || []).slice(-limit), {
      store,
      sessionId: entry.base.id,
      workspaceRoot: entry.workspaceRoot,
      mobileMessages: store.listMobileMessages?.(entry.base.id) || []
    });
    const total = Number(entry.messagesTotal || messages.length);
    return { ...entry.base, messages, messagesTotal: total, hasMoreMessages: total > messages.length };
  };
  const readSessionFresh = async (mobileSessionId) => {
    const { runtime, nativeId } = runtimeFor(mobileSessionId);
    const detail = await runtime.readSession(nativeId, { messageLimit: MAX_MOBILE_DETAIL_MESSAGES });
    const workspaceRoot = String(detail.directory || detail.cwd || "");
    const allMessages = Array.isArray(detail.messages) ? detail.messages : [];
    if (workspaceRoot) sessionDirectories.set(mobileSessionId, workspaceRoot);
    const base = {
      ...projectMobileSession({
        ...detail,
        id: mobileSessionId,
        agentId: runtime.id,
        nativeId,
        directory: workspaceRoot || detail.directory || detail.cwd || "",
        model: store.getOverlay(mobileSessionId).model || defaultModelFor(runtime.id) || detail.model,
        capabilities: detail.capabilities || runtime.capabilities
      }, store.getOverlay(mobileSessionId)),
      settings: runtime.getSettings?.(nativeId) || null,
      queue: store.listQueue?.(mobileSessionId) || [],
      queuePaused: isQueuePaused(mobileSessionId),
      goal: detail.goal || null,
      ...(activeSessions.has(mobileSessionId) ? { state: "running" } : {})
    };
    if (isLiveState(base.state)) activeSessions.add(mobileSessionId);
    else activeSessions.delete(mobileSessionId);
    // Keep the raw tail, rather than eagerly projecting 500 messages. The
    // initial phone paint only transforms its 120-row window; loading older
    // messages still reuses this same runtime read rather than rescanning disk.
    const entry = {
      at: Date.now(),
      base,
      workspaceRoot,
      sourceMessages: allMessages.slice(-MAX_MOBILE_DETAIL_MESSAGES),
      messagesTotal: allMessages.length
    };
    if (!isLiveState(base.state)) detailCache.set(mobileSessionId, entry);
    return entry;
  };
  const readSession = async (mobileSessionId, { messageLimit = MAX_MOBILE_DETAIL_MESSAGES } = {}) => {
    const cached = detailCache.get(mobileSessionId);
    if (cached && Date.now() - cached.at < DETAIL_CACHE_TTL_MS) return detailWindow(cached, messageLimit);
    let pending = detailRequests.get(mobileSessionId);
    if (!pending) {
      pending = readSessionFresh(mobileSessionId).finally(() => detailRequests.delete(mobileSessionId));
      detailRequests.set(mobileSessionId, pending);
    }
    return detailWindow(await pending, messageLimit);
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

  const runtimeAttachmentsFor = (assets = []) => assets.map((asset) => {
    const resolved = store.resolveAsset(asset.id);
    if (!resolved) throw new Error(`排队附件不可读取：${asset.name || "文件"}`);
    const attachment = { ...resolved, path: resolved.path };
    if (attachment.kind === "text") {
      try { attachment.text = fs.readFileSync(attachment.path, "utf8").slice(0, 200_000); } catch {}
    }
    return attachment;
  });

  const startQueuedMessage = async (mobileSessionId, item) => {
    const { runtime, nativeId } = runtimeFor(mobileSessionId);
    // Mark active before awaiting a model switch so a rapid second mobile tap
    // cannot start a parallel turn instead of joining this session's queue.
    activeSessions.add(mobileSessionId);
    try {
      const attachments = runtimeAttachmentsFor(item.attachments || []);
      const effectiveModel = store.getOverlay(mobileSessionId).model || defaultModelFor(runtime.id);
      if (effectiveModel && typeof runtime.setModel === "function") await runtime.setModel(nativeId, effectiveModel);
      const remembered = store.rememberMobileMessage({ sessionId: mobileSessionId, messageId: item.messageId, text: item.text, attachments: item.attachments || [] });
      detailCache.delete(mobileSessionId);
      if (!remembered.duplicate) {
        ledger.append({ sessionId: mobileSessionId, type: "message", role: "user", summary: item.text, messageId: item.messageId, ...(item.attachments?.length ? { attachments: item.attachments } : {}) });
      }
      ledger.append({ sessionId: mobileSessionId, type: "status", summary: "running" });
      void Promise.resolve().then(() => runtime.sendMessage(nativeId, {
        text: item.text,
        ...(attachments.length ? { attachments } : {}),
        messageId: item.messageId
      })).catch((error) => {
        activeSessions.delete(mobileSessionId);
        detailCache.delete(mobileSessionId);
        if (error?.code === "CODEX_DESKTOP_SYNC_UNAVAILABLE") {
          store.prependQueueItem?.({ sessionId: mobileSessionId, ...item });
          setQueuePaused(mobileSessionId, true);
          // 用户气泡已乐观写入手机账本，但原生 turn 未开始——明确标成未送达，避免以为桌面已收到。
          ledger.append({
            sessionId: mobileSessionId,
            type: "status",
            summary: "未送达桌面 Codex：共享连接不可用，消息已退回待发送队列。请先在桌面打开该会话，再点「继续发送」。"
          });
          ledger.append({ sessionId: mobileSessionId, type: "status", summary: "queued" });
          return;
        }
        ledger.append({ sessionId: mobileSessionId, type: "error", summary: error?.message || String(error) });
      });
    } catch (error) {
      activeSessions.delete(mobileSessionId);
      throw error;
    }
  };

  const dispatchNext = async (mobileSessionId) => {
    if (activeSessions.has(mobileSessionId) || isQueuePaused(mobileSessionId)) return { dispatched: false };
    const next = store.shiftQueueItem?.(mobileSessionId);
    if (!next) return { dispatched: false };
    try {
      await startQueuedMessage(mobileSessionId, next);
      ledger.append({ sessionId: mobileSessionId, type: "status", summary: "已开始下一条排队指令" });
      return { dispatched: true, itemId: next.id };
    } catch (error) {
      // Put the item back at the front without changing its original intent.
      store.prependQueueItem?.({ sessionId: mobileSessionId, ...next });
      setQueuePaused(mobileSessionId, true);
      ledger.append({ sessionId: mobileSessionId, type: "error", summary: `排队指令未启动：${error?.message || String(error)}` });
      return { dispatched: false };
    }
  };

  const queueMessage = async (mobileSessionId, payload, ownerId) => {
    const text = String(payload.text || "").trim();
    const attachments = normalizeAttachments(payload.attachments);
    if (!text && !attachments.length) throw new Error("消息或附件不能为空");
    const deliveryMode = String(payload.deliveryMode || "").trim();
    if (deliveryMode && !["guide", "queue"].includes(deliveryMode)) throw new Error("消息发送方式无效");
    const messageId = String(payload.messageId || "").trim() || randomUUID();
    const remembered = store.rememberMessage({ sessionId: mobileSessionId, messageId });
    if (remembered.duplicate) return { accepted: true, duplicate: true };
    const storedAttachments = attachments.map((attachment, index) => store.putAttachment({ sessionId: mobileSessionId, messageId, index, name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind, data: attachment.data }));
    const item = { id: `queue_${randomUUID()}`, messageId, text, attachments: storedAttachments };
    acquire(mobileSessionId, ownerId);
    let busy = activeSessions.has(mobileSessionId);
    // After a desktop restart, the in-memory active set is empty while a native
    // turn may still be running. Ask the runtime before deciding to start a
    // parallel turn; a read failure falls back to the responsive send path.
    if (!busy) {
      try {
        const { runtime, nativeId } = runtimeFor(mobileSessionId);
        const detail = await runtime.readSession(nativeId, { messageLimit: MAX_MOBILE_DETAIL_MESSAGES });
        busy = ["running", "queued", "waiting_for_approval", "waiting_for_desktop_approval"].includes(String(detail?.state || ""));
        if (busy) activeSessions.add(mobileSessionId);
      } catch {}
    }
    if (busy || isQueuePaused(mobileSessionId)) {
      const guided = deliveryMode === "guide";
      const queued = guided
        ? store.prependQueueItem({ sessionId: mobileSessionId, ...item })
        : store.enqueueQueueItem({ sessionId: mobileSessionId, ...item });
      const queue = store.listQueue?.(mobileSessionId) || [];
      detailCache.delete(mobileSessionId);
      ledger.append({
        sessionId: mobileSessionId,
        type: "status",
        summary: guided
          ? (isQueuePaused(mobileSessionId) ? "已加入保留队列的优先引导，需手动继续执行" : "已添加引导，将在当前步骤完成后优先执行")
          : `已排队第 ${queue.length} 条后续指令`
      });
      return { accepted: true, duplicate: false, queued: true, deliveryMode: guided ? "guide" : "queue", position: guided ? 1 : queue.length, item: queued, state: "queued" };
    }
    void startQueuedMessage(mobileSessionId, item).catch((error) => {
      activeSessions.delete(mobileSessionId);
      ledger.append({ sessionId: mobileSessionId, type: "error", summary: error?.message || String(error) });
    });
    return { accepted: true, duplicate: false, state: "running" };
  };

  const perform = async (mobileSessionId, action, payload = {}, ownerId) => {
    const { runtime, nativeId } = runtimeFor(mobileSessionId);
    if (action === "sendMessage") return queueMessage(mobileSessionId, payload, ownerId);

    acquire(mobileSessionId, ownerId);
    if (action === "rename") {
      if (typeof runtime.rename === "function") await runtime.rename(nativeId, payload.title);
      store.patchOverlay(mobileSessionId, { title: payload.title }); sessionsCache.clear(); detailCache.delete(mobileSessionId); return { ok: true };
    }
    if (action === "archive") { if (typeof runtime.archive === "function") await runtime.archive(nativeId); store.patchOverlay(mobileSessionId, { archived: true }); sessionsCache.clear(); detailCache.delete(mobileSessionId); return { ok: true }; }
    if (action === "unarchive") { if (typeof runtime.unarchive === "function") await runtime.unarchive(nativeId); store.patchOverlay(mobileSessionId, { archived: false }); sessionsCache.clear(); detailCache.delete(mobileSessionId); return { ok: true }; }
    if (action === "pin") { store.patchOverlay(mobileSessionId, { pinned: Boolean(payload.pinned) }); return { ok: true }; }
    if (action === "autoApprove") {
      store.patchOverlay(mobileSessionId, { autoApproveSession: Boolean(payload.enabled) });
      detailCache.delete(mobileSessionId);
      return { ok: true, autoApproveSession: Boolean(payload.enabled) };
    }
    if (action === "cancel" && typeof runtime.cancel === "function") {
      const clearQueue = payload.clearQueue !== false;
      await runtime.cancel(nativeId);
      activeSessions.delete(mobileSessionId);
      if (clearQueue) { const result = store.clearQueue?.(mobileSessionId) || { cleared: 0 }; setQueuePaused(mobileSessionId, false); ledger.append({ sessionId: mobileSessionId, type: "status", summary: `会话已停止，已清空 ${result.cleared} 条排队指令` }); return { ok: true, cleared: result.cleared, queuePaused: false }; }
      setQueuePaused(mobileSessionId, true); ledger.append({ sessionId: mobileSessionId, type: "status", summary: "会话已停止，排队指令已保留" }); return { ok: true, cleared: 0, queuePaused: true };
    }
    if (action === "delete") {
      let hiddenOnly = false;
      if (typeof runtime.delete === "function") { try { await runtime.delete(nativeId); } catch (error) { hiddenOnly = true; store.patchOverlay(mobileSessionId, { archived: true, hidden: true }); ledger.append({ sessionId: mobileSessionId, type: "status", summary: `会话已从手机列表移除（${error?.message || "原生删除不可用"}）` }); } }
      else { hiddenOnly = true; store.patchOverlay(mobileSessionId, { archived: true, hidden: true }); }
      store.clearQueue?.(mobileSessionId); setQueuePaused(mobileSessionId, false); activeSessions.delete(mobileSessionId); sessionsCache.clear(); if (hiddenOnly) { const index = loadDiskIndex(); saveDiskIndex((index.rows || []).filter((row) => row.id !== mobileSessionId)); } detailCache.delete(mobileSessionId); return { ok: true, hiddenOnly };
    }
    if (action === "fork" && typeof runtime.fork === "function") { const result = await runtime.fork(nativeId); return { sessionId: encodeMobileSessionId(runtime.id, result.sessionId) }; }
    if (action === "compact" && typeof runtime.compact === "function") { await runtime.compact(nativeId); return { ok: true }; }
    throw new Error(`当前 Agent 不支持操作：${action}`);
  };

  const updateQueueItem = async (mobileSessionId, itemId, payload = {}, ownerId) => {
    acquire(mobileSessionId, ownerId);
    const text = payload.text === undefined ? undefined : String(payload.text || "").trim();
    const attachments = payload.attachments === undefined ? undefined : normalizeAttachments(payload.attachments);
    let storedAttachments;
    if (attachments !== undefined) {
      const item = (store.listQueue?.(mobileSessionId) || []).find((row) => row.id === String(itemId));
      if (!item) throw new Error("排队指令不存在");
      storedAttachments = attachments.map((attachment, index) => store.putAttachment({ sessionId: mobileSessionId, messageId: item.messageId, index, name: attachment.name, mimeType: attachment.mimeType, kind: attachment.kind, data: attachment.data }));
    }
    const item = store.updateQueueItem?.({ sessionId: mobileSessionId, itemId, text, ...(storedAttachments !== undefined ? { attachments: storedAttachments } : {}) });
    detailCache.delete(mobileSessionId); ledger.append({ sessionId: mobileSessionId, type: "status", summary: "已编辑排队指令" }); return item;
  };

  const removeQueueItem = async (mobileSessionId, itemId, ownerId) => {
    acquire(mobileSessionId, ownerId); const item = store.removeQueueItem?.({ sessionId: mobileSessionId, itemId }); detailCache.delete(mobileSessionId); ledger.append({ sessionId: mobileSessionId, type: "status", summary: "已取消排队指令" }); return { ok: true, item };
  };

  const resumeQueue = async (mobileSessionId, ownerId) => {
    acquire(mobileSessionId, ownerId); setQueuePaused(mobileSessionId, false); const result = await dispatchNext(mobileSessionId); detailCache.delete(mobileSessionId); return { ok: true, ...result };
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
      title: "操作审批",
      summary: approval.summary,
      detail: approval.detail ? {
        label: String(approval.detail.label || "请求内容").slice(0, 120),
        content: String(approval.detail.content || "").slice(0, 1600)
      } : null,
      risk: approval.risk,
      requiresDesktop: approval.requiresDesktop,
      actions: [...approval.actions],
      createdAt: approval.createdAt
    }));

  const resolveApproval = async (approvalId, decision) => {
    const approval = pendingApprovals.get(String(approvalId || ""));
    if (!approval || !approval.mobileAllowed) throw new Error("审批不存在或当前 Agent 未提供可执行的审批选项");
    const allowLike = decision === "allow_once" || decision === "allow_session";
    if (decision === "allow_session") {
      store.patchOverlay(approval.sessionId, { autoApproveSession: true });
      detailCache.delete(approval.sessionId);
    }
    if (approval.protocol === "codex") {
      const codexDecision = allowLike
        ? "accept"
        : decision === "deny_once"
          ? "decline"
          : "";
      if (!codexDecision) throw new Error("审批决定无效");
      approval.runtime.respond?.(approval.requestId, { decision: codexDecision });
    } else {
      const optionId = allowLike
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
    const summary = decision === "allow_session"
      ? "手机端已允许，并开启本会话自动审批"
      : decision === "allow_once"
        ? "手机端已允许一次"
        : "手机端已拒绝一次";
    ledger.append({
      sessionId: approval.sessionId,
      type: "approval",
      summary
    });
    return { ok: true };
  };

  // Full-text search over the mobile event ledger (sanitized message summaries).
  // Session metadata comes from the disk index so a search never triggers a
  // fresh Agent history scan.
  const searchSessionContents = async (query = "") => {
    const needle = String(query || "").trim().toLowerCase();
    if (needle.length < 2) return [];
    const batches = [];
    let cursor = 0;
    while (batches.length < 20_000) {
      const batch = ledger.list({ after: cursor, limit: 2000 });
      if (!batch.length) break;
      batches.push(...batch);
      cursor = batch.at(-1).id;
      if (batch.length < 2000) break;
    }
    const index = loadDiskIndex();
    const meta = new Map((index.rows || []).map((row) => [String(row.id || ""), row]));
    const hits = new Map();
    for (const event of batches) {
      if (event.type !== "message" || !event.summary) continue;
      const haystack = String(event.summary);
      const at = haystack.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const sessionId = String(event.sessionId || "");
      if (!sessionId) continue;
      const start = Math.max(0, at - 48);
      const end = Math.min(haystack.length, at + needle.length + 72);
      const snippet = `${start > 0 ? "…" : ""}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${end < haystack.length ? "…" : ""}`;
      const entry = hits.get(sessionId) || { sessionId, matchCount: 0, lastEventId: 0, snippet: "", role: "assistant" };
      entry.matchCount += 1;
      if (event.id >= entry.lastEventId) {
        entry.lastEventId = event.id;
        entry.snippet = snippet;
        entry.role = event.role || "assistant";
        entry.createdAt = event.createdAt || null;
      }
      hits.set(sessionId, entry);
    }
    return [...hits.values()]
      .sort((a, b) => b.lastEventId - a.lastEventId)
      .slice(0, 20)
      .map((hit) => {
        const row = meta.get(hit.sessionId) || {};
        return {
          id: hit.sessionId,
          title: row.title || hit.sessionId,
          agent: row.agent || "",
          project: row.project || "",
          snippet: hit.snippet,
          role: hit.role,
          matchCount: hit.matchCount,
          updatedAt: row.updatedAt || hit.createdAt || null
        };
      });
  };

  return {
    listSessions,
    readSession,
    searchSessionContents,
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
    updateQueueItem,
    removeQueueItem,
    resumeQueue,
    listApprovals,
    resolveApproval,
    resolveAsset: (assetId) => store.resolveAsset?.(assetId) || null,
    listEvents: (filters) => ledger.list(filters),
    subscribeEvents: (handler) => ledger.subscribe(handler),
    recordGatewayRequest,
    listUnmatchedGatewayRequests,
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

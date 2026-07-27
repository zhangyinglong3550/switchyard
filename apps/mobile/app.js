const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "switchyard_mobile_token";
const CURSOR_KEY = "switchyard_mobile_event_cursor";
const PREFERENCES_KEY = "switchyard_mobile_preferences";
function hasNativeTokenStore() {
  try { return typeof window.SwitchyardNative?.getToken === "function"; } catch { return false; }
}
function nativePairingEditAvailable() {
  try { return typeof window.SwitchyardNative?.editPairingLink === "function"; } catch { return false; }
}
function nativeToken() {
  try { return String(window.SwitchyardNative?.getToken?.() || ""); } catch { return ""; }
}
function persistToken(value) {
  token = String(value || "");
  if (hasNativeTokenStore()) {
    // Android uses Keystore-backed storage. Never duplicate its device token in WebView storage.
    localStorage.removeItem(TOKEN_KEY);
    try { window.SwitchyardNative.saveToken(token); } catch {}
    return;
  }
  if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
}
let token = hasNativeTokenStore() ? nativeToken() : (localStorage.getItem(TOKEN_KEY) || "");
let eventCursor = Number(localStorage.getItem(CURSOR_KEY) || 0);
let current = null;
let agents = [];
let sessions = [];
let allSessions = [];
let sessionDisplayLimit = 120;
const SESSION_PAGE_SIZE = 120;
let workspaces = [];
let selectedAgent = "";
let selectedWorkspace = "";
let browsedWorkspace = null;
let selectedFilter = "all";
let pendingApprovals = [];
let archivedView = false;
const collapsedGroups = new Set();
let eventLoopStopped = false;
let refreshTimer = null;
let activeAttachments = [];
let newAttachments = [];
const assetObjectUrls = new Map();
let viewerObjectUrl = "";
let attachmentViewerHistoryOpen = false;
let lastDetailFingerprint = "";
const sessionDetailCache = new Map();
const SESSION_DETAIL_CACHE_TTL_MS = 5 * 60_000;
const INITIAL_MESSAGE_LIMIT = 120;
const commandCache = new Map();
let commandPickerState = null;
let commandRequestSeq = 0;
let preferences = { conversationSendMode: "ask", sync: true };

function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function agentKey(agent) { return String(agent || "").toLowerCase(); }
function agentLabel(agent) { return agents.find((item) => item.id === agent)?.name || ({ codex: "Codex", "claude-code": "Claude Code", grok: "Grok Build", opencode: "OpenCode" })[agent] || agent; }
function agentInitial(agent) { return ({ codex: "C", "claude-code": "CL", grok: "G", opencode: "OC" })[agentKey(agent)] || String(agent || "A").slice(0, 2).toUpperCase(); }
function agentClass(agent) { return ({ "claude-code": "avatar-claude", grok: "avatar-grok", opencode: "avatar-opencode" })[agentKey(agent)] || ""; }
function agentSettings(agent) { return agents.find((item) => item.id === agent)?.settings || null; }
function conversationSendModeLabel(mode = preferences.conversationSendMode) { return ({ ask: "每次询问", guide: "默认引导", queue: "默认排队" })[mode] || "每次询问"; }
function isSessionRunning() { return Boolean(current && ["running", "queued", "waiting_for_approval"].includes(current.state)); }
function hasComposerContent() { return Boolean($("#message")?.value.trim() || activeAttachments.length); }
function stateLabel(state) { return ({ queued: "正在排队", running: "正在生成", waiting_for_approval: "等待审批", completed: "已完成", failed: "已失败", cancelled: "已停止", incomplete: "未完成" })[state] || ""; }
function avatar(agent) { return `<span class="agent-avatar ${agentClass(agent)}">${escapeHtml(agentInitial(agent))}</span>`; }
function icon(name) { return name === "folder" ? '<svg viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>'; }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("toast-show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("toast-show"), 2900); }

// Android System WebView can lag behind Chrome and may not expose crypto.randomUUID().
// A client message id is only used for local optimistic rendering/idempotency, so use
// getRandomValues when available and retain a collision-resistant last-resort fallback.
function createClientMessageId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function commandAgentFor(input) { return input?.id === "message" ? current?.agent || "" : selectedAgent; }
function commandTrigger(input, agent) {
  const cursor = Number(input?.selectionStart ?? input?.value?.length ?? 0);
  const before = String(input?.value || "").slice(0, cursor);
  const match = before.match(/(^|\s)([/$@])([^\s]*)$/);
  if (!match || (["$", "@"].includes(match[2]) && agent !== "codex")) return null;
  return { prefix: match[2], query: match[3].toLowerCase(), start: cursor - match[2].length - match[3].length, end: cursor };
}
function commandContext(input, agent) {
  if (agent !== "codex") return "";
  if (input?.id === "message" && current?.id) return `session=${encodeURIComponent(current.id)}`;
  if (input?.id === "prompt" && selectedWorkspace) return `cwd=${encodeURIComponent(selectedWorkspace)}`;
  return "";
}
async function commandsFor(agent, input) {
  if (!agent) return [];
  const context = commandContext(input, agent);
  const cacheKey = `${agent}:${context}`;
  const cached = commandCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60_000) return cached.rows;
  const rows = await api(`/mobile/v1/commands?agent=${encodeURIComponent(agent)}${context ? `&${context}` : ""}`);
  commandCache.set(cacheKey, { at: Date.now(), rows: Array.isArray(rows) ? rows : [] });
  return Array.isArray(rows) ? rows : [];
}
function hideCommandPicker() { const picker = $("#command-picker"); picker.hidden = true; picker.innerHTML = ""; commandPickerState = null; }
function positionCommandPicker(input) {
  const picker = $("#command-picker"); const rect = input.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
  picker.style.width = `${width}px`;
  picker.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
  const estimated = Math.min(picker.scrollHeight || 320, 360);
  picker.style.top = `${Math.max(10, rect.top - estimated - 8)}px`;
}
function renderCommandPicker() {
  const state = commandPickerState; const picker = $("#command-picker");
  if (!state) return hideCommandPicker();
  const groups = [
    ["command", "命令", state.rows.filter((item) => item.kind === "command")],
    ["skill", "Skills", state.rows.filter((item) => item.kind === "skill")],
    ["mention", "插件与 App", state.rows.filter((item) => item.kind === "mention")]
  ].filter(([, , rows]) => rows.length);
  if (!groups.length) { picker.innerHTML = '<div class="command-empty">没有匹配的命令或 Skill</div>'; picker.hidden = false; positionCommandPicker(state.input); return; }
  let itemIndex = 0;
  picker.innerHTML = groups.map(([, label, rows]) => `<section class="command-group"><h3>${label}</h3>${rows.map((item) => { const index = itemIndex++; const glyph = item.kind === "skill" ? "S" : item.kind === "mention" ? "@" : "/"; return `<button type="button" role="option" class="command-option${index === state.selected ? " selected" : ""}" data-command-index="${index}"><span class="command-glyph">${glyph}</span><span><b>${escapeHtml(item.insertText.trim())}</b><small>${escapeHtml(item.description || "")}</small></span></button>`; }).join("")}</section>`).join("");
  picker.hidden = false; positionCommandPicker(state.input);
}
async function updateCommandPicker(input) {
  const agent = commandAgentFor(input); const trigger = commandTrigger(input, agent);
  if (!trigger) return hideCommandPicker();
  const seq = ++commandRequestSeq;
  try {
    const all = await commandsFor(agent, input); if (seq !== commandRequestSeq || document.activeElement !== input) return;
    const allowedKind = (item) => trigger.prefix === "$" ? item.kind === "skill"
      : trigger.prefix === "@" ? item.kind === "mention"
        : agent === "codex" ? item.kind === "command" : ["command", "skill"].includes(item.kind);
    const rows = all.filter((item) => allowedKind(item) && (!trigger.query || `${item.name} ${item.description || ""}`.toLowerCase().includes(trigger.query))).slice(0, 80);
    commandPickerState = { input, agent, trigger, rows, selected: 0 };
    renderCommandPicker();
  } catch { hideCommandPicker(); }
}
function chooseCommand(index = commandPickerState?.selected || 0) {
  const state = commandPickerState; const item = state?.rows?.[index]; if (!state || !item) return;
  const input = state.input; const value = input.value;
  input.value = `${value.slice(0, state.trigger.start)}${item.insertText}${value.slice(state.trigger.end)}`;
  const cursor = state.trigger.start + item.insertText.length;
  hideCommandPicker(); input.focus(); input.setSelectionRange(cursor, cursor); input.dispatchEvent(new Event("input", { bubbles: true }));
}
function commandPickerKeydown(event) {
  if (!commandPickerState || commandPickerState.input !== event.currentTarget) return;
  if (event.key === "Escape") { event.preventDefault(); hideCommandPicker(); return; }
  if (!["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === "Enter" || event.key === "Tab") return chooseCommand();
  const count = commandPickerState.rows.length; if (!count) return;
  commandPickerState.selected = (commandPickerState.selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
  renderCommandPicker(); $("#command-picker .command-option.selected")?.scrollIntoView({ block: "nearest" });
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.status = response.status; error.code = body.error || "";
    throw error;
  }
  $("#connection").textContent = "已安全连接";
  $("#connection-detail").textContent = "已连接";
  return body;
}

function page(name) {
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.dataset.page === name));
  document.querySelectorAll("[data-tab]").forEach((element) => element.classList.toggle("active", element.dataset.tab === name));
  $("#session-menu").hidden = true;
  hideModelSheet();
  hideStopSessionSheet();
  hideMessageModeSheet();
  hideConversationBehaviorSheet();
  closeSessionSwitcher();
  workspaceSheet(false);
  hideCommandPicker();
  // The list and settings pages share the document scroller with the chat.
  // Resetting it here prevents a just-opened list from inheriting the old
  // conversation's bottom scroll position.
  if (name !== "detail") window.scrollTo(0, 0);
}

function hideModelSheet() {
  const sheet = $("#model-sheet");
  sheet.hidden = true;
  sheet.setAttribute("aria-hidden", "true");
  sheet.style.display = "none";
}

function showModelSheet() {
  const sheet = $("#model-sheet");
  sheet.hidden = false;
  sheet.setAttribute("aria-hidden", "false");
  sheet.style.display = "flex";
}

function hideStopSessionSheet() {
  const sheet = $("#stop-session-sheet");
  sheet.hidden = true;
  sheet.setAttribute("aria-hidden", "true");
  sheet.style.display = "none";
}

function showStopSessionSheet() {
  const sheet = $("#stop-session-sheet");
  sheet.hidden = false;
  sheet.setAttribute("aria-hidden", "false");
  sheet.style.display = "flex";
}

function setSheetVisible(id, visible) {
  const sheet = $(id); if (!sheet) return;
  sheet.hidden = !visible;
  sheet.setAttribute("aria-hidden", String(!visible));
  sheet.style.display = visible ? "flex" : "none";
}
function hideMessageModeSheet() { setSheetVisible("#message-mode-sheet", false); }
function showMessageModeSheet() { setSheetVisible("#message-mode-sheet", true); }
function hideConversationBehaviorSheet() { setSheetVisible("#conversation-behavior-sheet", false); }
function showConversationBehaviorSheet() { renderConversationBehaviorSheet(); setSheetVisible("#conversation-behavior-sheet", true); }
function renderConversationBehavior() {
  const target = $("#conversation-send-mode");
  if (target) target.textContent = conversationSendModeLabel();
}
function renderConversationBehaviorSheet() {
  document.querySelectorAll("[data-conversation-send-mode]").forEach((button) => button.classList.toggle("selected", button.dataset.conversationSendMode === preferences.conversationSendMode));
}
function localPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFERENCES_KEY) || "{}");
    return ["ask", "guide", "queue"].includes(saved.conversationSendMode) ? saved : {};
  } catch { return {}; }
}
function saveLocalPreferences(next) {
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ conversationSendMode: next.conversationSendMode }));
}
function isPreferencesEndpointUnavailable(error) { return error?.status === 404 || error?.code === "not_found"; }
async function loadPreferences() {
  const fallback = localPreferences();
  try {
    preferences = { ...preferences, ...fallback, ...(await api("/mobile/v1/preferences")), sync: true };
    saveLocalPreferences(preferences);
  } catch (error) {
    if (!isPreferencesEndpointUnavailable(error)) throw error;
    preferences = { ...preferences, ...fallback, sync: false };
  }
  renderConversationBehavior();
}
async function saveConversationSendMode(conversationSendMode) {
  const next = { ...preferences, conversationSendMode };
  saveLocalPreferences(next);
  try {
    preferences = { ...(await api("/mobile/v1/preferences", { method: "POST", body: JSON.stringify({ conversationSendMode }) })), sync: true };
  } catch (error) {
    if (!isPreferencesEndpointUnavailable(error)) throw error;
    preferences = { ...next, sync: false };
  }
  renderConversationBehavior(); renderConversationBehaviorSheet();
  return { synced: preferences.sync };
}

function renderFilters() {
  const visible = agents;
  $("#agent-filter").innerHTML = [{ id: "all", name: "全部" }, ...visible].map((agent) => `<button class="filter-pill ${selectedFilter === agent.id ? "selected" : ""}" type="button" data-filter="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</button>`).join("");
}

function renderAgentNotices() {
  const notices = agents.filter((agent) => agent.error).map((agent) => `<div class="agent-notice">${escapeHtml(agent.name)} 暂时无法读取部分历史会话，仍可创建新对话。${escapeHtml(agent.error)}</div>`);
  $("#agent-notices").innerHTML = notices.join("");
}

function formatSessionTime(value) {
  const time = value ? new Date(value) : null;
  if (!time || Number.isNaN(time.getTime())) return "";
  const now = new Date(); const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86400000);
  if (days <= 0) return `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  if (days === 1) return "昨天";
  return `${time.getMonth() + 1}/${time.getDate()}`;
}

function closeAllSwipe() {
  document.querySelectorAll(".swipe-item.open").forEach((item) => item.classList.remove("open"));
}

function sessionRowHtml(session) {
  const running = ["running", "queued"].includes(session.state);
  const waiting = session.state === "waiting_for_approval";
  const tag = running ? '<span class="tag tag-run">RUNNING</span>' : waiting ? '<span class="tag tag-wait">待审批</span>' : `<span class="tag tag-agent">${escapeHtml(agentLabel(session.agent).replace(" Build", "").replace(" Code", "").toUpperCase())}</span>`;
  return `<div class="swipe-item" data-swipe-id="${escapeHtml(session.id)}"><div class="swipe-actions"><button type="button" class="swipe-btn rename" data-session-action="rename" data-id="${escapeHtml(session.id)}">重命名</button><button type="button" class="swipe-btn archive" data-session-action="archive" data-id="${escapeHtml(session.id)}">${archivedView ? "取消归档" : "归档"}</button><button type="button" class="swipe-btn danger" data-session-action="delete" data-id="${escapeHtml(session.id)}">删除</button></div><button class="session-row swipe-content" data-state="${escapeHtml(session.state)}" data-id="${escapeHtml(session.id)}" type="button"><span class="session-copy"><span class="session-title">${escapeHtml(session.title)}</span><span class="session-subtitle">${escapeHtml(agentLabel(session.agent))}${session.model ? ` · ${escapeHtml(session.model)}` : ""}</span></span><span class="session-meta"><time>${formatSessionTime(session.updatedAt)}</time>${tag}</span></button></div>`;
}

function activeSessionRows() { return allSessions.filter((session) => ["running", "queued", "waiting_for_approval"].includes(session.state)); }
function sessionSwitcherRowHtml(session) {
  const active = current?.id === session.id;
  const running = ["running", "queued", "waiting_for_approval"].includes(session.state);
  return `<button class="switcher-session-row${active ? " active" : ""}" data-switch-session="${escapeHtml(session.id)}" type="button"><span class="switcher-session-copy"><strong>${escapeHtml(session.title)}</strong><small>${escapeHtml(agentLabel(session.agent))}${session.model ? ` · ${escapeHtml(session.model)}` : ""}</small></span><span class="switcher-session-state">${running ? '<i></i>进行中' : formatSessionTime(session.updatedAt)}</span></button>`;
}
function renderSessionSwitcher() {
  const currentButton = $("#continue-current-session");
  const canContinue = Boolean(current);
  currentButton.hidden = !canContinue;
  if (canContinue) {
    $("#continue-current-title").textContent = current.title || "继续当前对话";
    $("#continue-current-meta").textContent = `${agentLabel(current.agent)} · ${stateLabel(current.state) || "可继续查看"}`;
  }
  const query = $("#session-switcher-search").value.trim().toLowerCase();
  const rows = allSessions.filter((session) => !query || `${session.title} ${session.agent} ${session.project || ""}`.toLowerCase().includes(query)).slice(0, sessionDisplayLimit);
  const active = rows.filter((session) => ["running", "queued", "waiting_for_approval"].includes(session.state));
  const rest = rows.filter((session) => !active.some((entry) => entry.id === session.id));
  $("#session-switcher-list").innerHTML = `${active.length ? `<section><h3>正在进行</h3>${active.map(sessionSwitcherRowHtml).join("")}</section>` : ""}<section><h3>${active.length ? "最近会话" : "会话"}</h3>${rest.map(sessionSwitcherRowHtml).join("") || '<div class="empty">没有匹配的会话。</div>'}</section>`;
}
function setSessionSwitcherVisible(visible) {
  const sheet = $("#session-switcher"); sheet.hidden = !visible; sheet.setAttribute("aria-hidden", String(!visible)); sheet.style.display = visible ? "flex" : "none";
  if (visible) { $("#session-switcher-search").value = ""; renderSessionSwitcher(); }
}
function openSessionSwitcher() { setSessionSwitcherVisible(true); }
function closeSessionSwitcher() { setSessionSwitcherVisible(false); }
async function refreshSessionsInBackground() {
  try { await loadSessions({ background: true }); } catch {}
}

function renderSessionList() {
  if (!$("#session-switcher").hidden) renderSessionSwitcher();
  const query = $("#search").value.trim().toLowerCase();
  const matchingRows = allSessions.filter((session) => (selectedFilter === "all" || session.agent === selectedFilter) && (!query || `${session.title} ${session.agent} ${session.project || ""}`.toLowerCase().includes(query)));
  const rows = matchingRows.slice(0, sessionDisplayLimit);
  if (!rows.length) {
    $("#session-list").innerHTML = '<div class="empty">这里还没有会话。<br>从下方按钮开始一个新任务。</div>';
    renderStatusSummary();
    return;
  }
  // 搜索时打平显示；否则像 Codex 桌面端一样按工作区分组。
  if (query) {
    $("#session-list").innerHTML = rows.map(sessionRowHtml).join("");
  } else {
    const groups = new Map();
    for (const session of rows) {
      const key = session.project || "未分组";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    const sorted = [...groups.entries()].sort((a, b) => {
      const latest = (items) => Math.max(...items.map((item) => Date.parse(item.updatedAt || 0) || 0));
      return latest(b[1]) - latest(a[1]);
    });
    $("#session-list").innerHTML = sorted.map(([name, items]) => {
      const collapsed = collapsedGroups.has(name);
      const hasRunning = items.some((item) => ["running", "queued"].includes(item.state));
      const workspace = workspaces.find((item) => item.name === name);
      const path = workspace?.path || workspace?.id || "";
      const actions = path ? `<div class="group-menu-wrap"><button type="button" class="group-more" data-workspace-menu aria-label="管理工作目录">··</button><div class="group-menu" hidden><button type="button" data-workspace-rename="${escapeHtml(path)}" data-workspace-name="${escapeHtml(name)}">重命名</button><button type="button" class="danger-text" data-workspace-delete="${escapeHtml(path)}">删除</button></div></div>` : "";
      return `<div class="workspace-group${collapsed ? " collapsed" : ""}"><div class="group-title-row"><button class="group-head" type="button" data-group="${escapeHtml(name)}">${icon("folder")}<span class="group-name">${escapeHtml(name)}</span>${hasRunning ? '<i class="group-live"></i>' : ""}<span class="group-count">${items.length}</span><svg class="group-chevron" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button>${actions}</div><div class="group-items">${items.map(sessionRowHtml).join("")}</div></div>`;
    }).join("");
  }
  const hasMore = matchingRows.length > rows.length;
  if (hasMore) {
    $("#session-list").insertAdjacentHTML("beforeend", `<button id="load-more-sessions" class="load-more-sessions" type="button">显示更多会话（已显示 ${rows.length}/${matchingRows.length}）</button>`);
  }
  renderStatusSummary();
}

function renderStatusSummary() {
  const strip = $("#status-strip");
  const running = allSessions.filter((session) => ["running", "queued"].includes(session.state)).length;
  const waiting = pendingApprovals.length;
  if (!running && !waiting) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = `${running ? '<span class="spin"></span>' : ""}${running ? `${running} 个任务正在运行` : ""}${running && waiting ? " · " : ""}${waiting ? `<b>${waiting} 个等待你审批</b>` : ""}`;
}

function approvalCardHtml(approval, { sessionScoped = false } = {}) {
  const session = allSessions.find((item) => item.id === approval.sessionId);
  const title = sessionScoped ? "等待你的授权" : session?.title || approval.title || "待审批任务";
  const actions = `<div class="approval-actions"><button data-approval="${escapeHtml(approval.id)}" data-decision="deny_once" type="button">拒绝</button><button class="allow" data-approval="${escapeHtml(approval.id)}" data-decision="allow_once" type="button">允许一次</button></div>`;
  return `<article class="approval-card" data-approval-card="${escapeHtml(approval.id)}"><div class="r1"><i></i>${escapeHtml(title)}</div><div class="r2">${escapeHtml(approval.summary || "Agent 正在等待你的决定")}</div>${actions}</article>`;
}
function renderApprovalInbox() {
  $("#approval-inbox").innerHTML = pendingApprovals.map((approval) => approvalCardHtml(approval)).join("");
  const sessionInbox = $("#session-approval-inbox");
  if (!sessionInbox) return;
  const currentApprovals = current ? pendingApprovals.filter((approval) => approval.sessionId === current.id) : [];
  sessionInbox.innerHTML = currentApprovals.map((approval) => approvalCardHtml(approval, { sessionScoped: true })).join("");
  sessionInbox.hidden = !currentApprovals.length;
}

function renderAgentPicker() {
  $("#agent-picker").innerHTML = agents.map((agent) => `<button class="agent-choice ${selectedAgent === agent.id ? "selected" : ""}" data-agent="${escapeHtml(agent.id)}" type="button">${avatar(agent.id)}<span>${escapeHtml(agent.name.replace(" Build", "").replace(" Code", ""))}</span></button>`).join("");
  renderNewAgentSettings();
}

function optionRows(options, selected) {
  return options.map((option) => `<option value="${escapeHtml(typeof option === "string" ? option : option.id)}"${(typeof option === "string" ? option : option.id) === selected ? " selected" : ""}>${escapeHtml(typeof option === "string" ? option : option.name)}</option>`).join("");
}

function optionName(options, value) {
  const selected = options?.find((option) => (typeof option === "string" ? option : option.id) === value);
  return typeof selected === "string" ? selected : selected?.name || value || "";
}

function renderRuntimeShortcut() {
  const summary = $("#composer-runtime-summary");
  if (!summary) return;
  const settings = agentSettings(current?.agent);
  const values = [];
  if (current?.model) values.push(current.model);
  if (settings?.effortOptions?.length) values.push(`思考 ${optionName(settings.effortOptions, current?.settings?.effort || "medium")}`);
  if (settings?.permissionOptions?.length) values.push(`权限 ${optionName(settings.permissionOptions, current?.settings?.permissionMode || settings.permissionOptions[0]?.id || "")}`);
  summary.textContent = values.join(" · ") || "点击切换模型与对话设置";
}

function renderNewAgentSettings() {
  const settings = agentSettings(selectedAgent);
  const host = $("#new-agent-settings");
  if (!settings?.effortOptions?.length && !settings?.permissionOptions?.length) {
    host.hidden = true; host.innerHTML = ""; return;
  }
  host.hidden = false;
  host.innerHTML = `<label>本次任务设置</label>${settings.effortOptions?.length ? `<label class="setting-select"><span>思考程度</span><select id="effort">${optionRows(settings.effortOptions, "medium")}</select></label>` : ""}${settings.permissionOptions?.length ? `<label class="setting-select"><span>权限范围</span><select id="new-permission">${optionRows(settings.permissionOptions, settings.permissionOptions[0]?.id || "")}</select></label>` : ""}`;
}

function renderSessionSettings() {
  const host = $("#session-runtime-settings");
  const settings = agentSettings(current?.agent);
  if (!settings?.effortOptions?.length && !settings?.permissionOptions?.length) {
    host.hidden = true; host.innerHTML = ""; return;
  }
  const currentSettings = current?.settings || {};
  host.hidden = false;
  host.innerHTML = `${settings.effortOptions?.length ? `<label class="setting-select"><span>思考程度</span><select id="session-effort">${optionRows(settings.effortOptions, currentSettings.effort || "medium")}</select></label>` : ""}${settings.permissionOptions?.length ? `<label class="setting-select"><span>权限范围</span><select id="session-permission">${optionRows(settings.permissionOptions, currentSettings.permissionMode || settings.permissionOptions[0]?.id || "")}</select></label>` : ""}<button id="save-session-settings" class="settings-save" type="button">保存下轮设置</button>`;
}

function renderWorkspaces() {
  const rows = workspaces.slice(0, 4);
  $("#workspace-list").innerHTML = rows.map((workspace, index) => {
    const selected = selectedWorkspace === workspace.id || (!selectedWorkspace && index === 0);
    const path = workspace.path || workspace.id;
    return `<button class="workspace-choice ${selected ? "selected" : ""}" type="button" data-workspace="${escapeHtml(workspace.id)}">${icon("folder")}<span><strong>${escapeHtml(workspace.name)}</strong><small>${escapeHtml(agentLabel(workspace.agent))}</small></span><span class="check">${selected ? "✓" : ""}</span></button>`;
  }).join("") || '<div class="empty">没有最近项目。你可以浏览本机文件夹后直接选择。</div>';
  if (!selectedWorkspace && rows[0]) selectedWorkspace = rows[0].id;
}
function workspaceSheet(show) { const sheet = $("#workspace-sheet"); sheet.hidden = !show; sheet.setAttribute("aria-hidden", String(!show)); sheet.style.display = show ? "flex" : "none"; }
function renderWorkspaceBrowser() {
  const browser = browsedWorkspace; if (!browser) return;
  $("#workspace-path").textContent = browser.path;
  $("#workspace-parent").disabled = !browser.parent;
  $("#workspace-choose").textContent = `在“${browser.name || browser.path}”开始`;
  $("#workspace-browser-list").innerHTML = (browser.directories || []).map((directory) => `<button class="workspace-choice workspace-dir-open" type="button" data-workspace-directory="${escapeHtml(directory.path)}">${icon("folder")}<span><strong>${escapeHtml(directory.name)}</strong><small>文件夹</small></span>${icon("arrow")}</button>`).join("") || '<div class="empty">此文件夹中没有可见的子文件夹。</div>';
}
async function browseWorkspace(path = "") {
  workspaceSheet(true);
  $("#workspace-path").textContent = path || "正在读取…";
  $("#workspace-parent").disabled = true;
  $("#workspace-browser-list").innerHTML = '<div class="sheet-loading">正在读取文件夹…</div>';
  browsedWorkspace = await api(`/mobile/v1/workspaces/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  renderWorkspaceBrowser();
}

function safeUrl(url) { try { const parsed = new URL(url); return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : ""; } catch { return ""; } }
function inlineMarkdown(value) {
  let text = escapeHtml(value);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_all, label, href) => { const safe = safeUrl(href); return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${label}</a>` : label; });
  return text;
}
const richTextCache = new Map();
const streamingRenderTimers = new WeakMap();
function markdownTableCells(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !trimmed.includes("|")) return null;
  const body = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells = body.split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every(Boolean) ? cells : null;
}
function markdownTableAlignments(line, count) {
  const cells = markdownTableCells(line);
  if (!cells || cells.length !== count) return null;
  const alignments = cells.map((cell) => {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
  return alignments.every(Boolean) ? alignments : null;
}
function renderMarkdownTable(headers, alignments, rows) {
  const align = (index) => alignments[index] === "left" ? "" : ` style="text-align:${alignments[index]}"`;
  return `<div class="markdown-table-wrap"><table class="markdown-table"><thead><tr>${headers.map((cell, index) => `<th${align(index)}>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td${align(index)}>${inlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function renderRichText(value) {
  const cacheKey = String(value || "");
  const cachedHtml = richTextCache.get(cacheKey);
  if (cachedHtml !== undefined) return cachedHtml;
  const source = cacheKey.replace(/\r/g, ""); const chunks = source.split(/```([^\n]*)\n?([\s\S]*?)```/g); const output = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const prose = chunks[i] || "";
    const lines = prose.split("\n"); let list = []; let ordered = false;
    const flush = () => {
      if (!list.length) return;
      const tag = ordered ? "ol" : "ul";
      output.push(`<${tag}>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${tag}>`);
      list = []; ordered = false;
    };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line.trim()) { flush(); continue; }
      const tableHeaders = markdownTableCells(line);
      const tableAlignments = tableHeaders && markdownTableAlignments(lines[lineIndex + 1], tableHeaders.length);
      if (tableHeaders && tableAlignments) {
        flush(); const rows = []; lineIndex += 2;
        while (lineIndex < lines.length) {
          const row = markdownTableCells(lines[lineIndex]);
          if (!row || row.length !== tableHeaders.length) { lineIndex -= 1; break; }
          rows.push(row); lineIndex += 1;
        }
        output.push(renderMarkdownTable(tableHeaders, tableAlignments, rows));
        continue;
      }
      const unordered = line.match(/^[-*+]\s+(.+)/);
      const numbered = line.match(/^\d+[.)]\s+(.+)/);
      if (unordered || numbered) {
        const wantsOrdered = Boolean(numbered);
        if (list.length && ordered !== wantsOrdered) flush();
        ordered = wantsOrdered; list.push((unordered || numbered)[1]); continue;
      }
      flush(); const heading = line.match(/^(#{1,3})\s+(.+)/); if (heading) output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
      else if (/^>\s?/.test(line)) output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
      else if (/^([-*_])\1\1+$/.test(line.trim())) output.push("<hr>");
      else output.push(`<p>${inlineMarkdown(line)}</p>`);
    } flush();
    if (i + 2 < chunks.length) output.push(`<pre><div class="code-head"><span>${escapeHtml(chunks[i + 1] || "code")}</span><button type="button" data-copy-code="${escapeHtml(encodeURIComponent(chunks[i + 2]))}">复制</button></div><code>${escapeHtml(chunks[i + 2])}</code></pre>`);
  }
  const html = output.join("") || "<p></p>";
  if (richTextCache.size > 300) richTextCache.delete(richTextCache.keys().next().value);
  richTextCache.set(cacheKey, html);
  return html;
}
function renderStreamingRichText(node, selector) {
  const body = node?.querySelector(selector);
  if (!body || !node.dataset.raw) return;
  body.innerHTML = renderRichText(node.dataset.raw);
}
function scheduleStreamingRichText(node, selector) {
  if (streamingRenderTimers.has(node)) return;
  streamingRenderTimers.set(node, setTimeout(() => {
    streamingRenderTimers.delete(node);
    if (node.isConnected) renderStreamingRichText(node, selector);
  }, 100));
}
function finalizeStreamingNode(node, selector) {
  const pending = streamingRenderTimers.get(node);
  if (pending) clearTimeout(pending);
  streamingRenderTimers.delete(node);
  renderStreamingRichText(node, selector);
}
function messageKey(message, index = 0) { return message.id || `${message.role || "assistant"}:${message.kind || "message"}:${index}`; }
function firstLine(value) { return String(value || "").split(/\n/).map((line) => line.trim()).filter(Boolean)[0] || ""; }
function toolStatusLabel(status) { return ({ pending: "等待中", running: "执行中", waiting_for_approval: "待审批", completed: "已完成", failed: "失败", cancelled: "已取消" })[status] || "已完成"; }
function toolDetailBlock(label, value, className = "") { const text = String(value || "").trim(); return text ? `<section class="tool-section ${className}"><b>${label}</b><pre>${escapeHtml(text)}</pre></section>` : ""; }
function assetUrl(assetId) { return `/mobile/v1/assets/${encodeURIComponent(assetId)}`; }
function nativeAssetActionAvailable(action) {
  try { return typeof window.SwitchyardNative?.[action] === "function"; } catch { return false; }
}
function runNativeAssetAction(action, asset) {
  if (!asset?.id || !nativeAssetActionAvailable(action)) return false;
  try {
    window.SwitchyardNative[action](String(asset.id), String(asset.name || "文件"), String(asset.mimeType || "application/octet-stream"));
    return true;
  } catch { return false; }
}
function attachmentIcon(asset) {
  const extension = String(asset?.name || "").split(".").pop().slice(0, 5).toUpperCase();
  return extension && extension !== String(asset?.name || "").toUpperCase() ? extension : "FILE";
}
function renderMessageAttachments(attachments = []) {
  if (!attachments.length) return "";
  return `<div class="message-attachments">${attachments.map((asset) => {
    const image = asset.kind === "image" || String(asset.mimeType || "").startsWith("image/");
    const open = asset.id ? `data-attachment-open="${escapeHtml(asset.id)}"` : asset.preview ? `data-attachment-preview="${escapeHtml(asset.preview)}"` : "";
    const metadata = `data-asset-name="${escapeHtml(asset.name || "文件")}" data-asset-mime="${escapeHtml(asset.mimeType || "application/octet-stream")}" data-asset-kind="${escapeHtml(asset.kind || "file")}"`;
    return image
      ? `<button type="button" class="message-attachment image" ${open} ${metadata}><img ${asset.preview ? `src="${escapeHtml(asset.preview)}"` : ""} data-asset-image="${escapeHtml(asset.id || "")}" alt="${escapeHtml(asset.name || "图片")}"><span>${escapeHtml(asset.name || "图片")}</span></button>`
      : `<button type="button" class="message-attachment file" ${open} ${metadata}><i>${escapeHtml(attachmentIcon(asset))}</i><span><strong>${escapeHtml(asset.name || "文件")}</strong><small>${asset.byteLength ? `${Math.ceil(asset.byteLength / 1024)} KB` : "点击打开"}</small></span></button>`;
  }).join("")}</div>`;
}
async function fetchAssetObjectUrl(assetId) {
  if (!assetId) return "";
  if (assetObjectUrls.has(assetId)) return assetObjectUrls.get(assetId);
  const promise = fetch(assetUrl(assetId), { headers: { authorization: `Bearer ${token}` } }).then(async (response) => {
    if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
    return URL.createObjectURL(await response.blob());
  }).catch((error) => { assetObjectUrls.delete(assetId); throw error; });
  assetObjectUrls.set(assetId, promise);
  return promise;
}
async function hydrateAttachmentPreviews(root = document) {
  const images = [...root.querySelectorAll("img[data-asset-image]:not([src])")];
  await Promise.all(images.map(async (image) => {
    const id = image.dataset.assetImage;
    if (!id) return;
    try { image.src = await fetchAssetObjectUrl(id); } catch { image.closest(".message-attachment")?.classList.add("asset-error"); }
  }));
}
async function openAttachmentViewer(asset) {
  const viewer = $("#attachment-viewer"); const content = $("#attachment-viewer-content");
  $("#attachment-viewer-title").textContent = asset.name || "文件预览";
  content.innerHTML = '<div class="viewer-loading">正在读取文件…</div>';
  viewer.hidden = false; viewer.setAttribute("aria-hidden", "false");
  if (!attachmentViewerHistoryOpen) {
    history.pushState({ ...(history.state || {}), switchyardAttachmentViewer: true }, "", location.href);
    attachmentViewerHistoryOpen = true;
  }
  $("#close-attachment-viewer").focus();
  try {
    const url = asset.preview || await fetchAssetObjectUrl(asset.id);
    viewerObjectUrl = asset.preview ? "" : url;
    const image = asset.kind === "image" || String(asset.mimeType || "").startsWith("image/");
    const pdf = asset.mimeType === "application/pdf";
    const text = asset.kind === "text" || String(asset.mimeType || "").startsWith("text/") || /\.(md|json|ya?ml|js|ts|py|go|rs|java|c|cpp|h|css|html|sql|sh)$/i.test(asset.name || "");
    if (image) content.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(asset.name || "图片")}">`;
    else if (pdf) content.innerHTML = `<iframe src="${escapeHtml(url)}" title="${escapeHtml(asset.name || "PDF")}"></iframe>`;
    else if (text) content.innerHTML = `<pre>${escapeHtml(await (await fetch(url)).text())}</pre>`;
    else content.innerHTML = `<div class="viewer-file"><i>${escapeHtml(attachmentIcon(asset))}</i><strong>${escapeHtml(asset.name || "文件")}</strong><span>此文件类型不支持在线预览，可以下载后打开。</span></div>`;
    const download = $("#attachment-viewer-download");
    const open = $("#attachment-viewer-open");
    const nativeDownload = Boolean(asset.id && nativeAssetActionAvailable("downloadAsset"));
    const nativeOpen = Boolean(asset.id && nativeAssetActionAvailable("openAsset"));
    download.href = url; download.download = asset.name || "file"; download.dataset.assetId = asset.id || "";
    download.dataset.assetName = asset.name || "文件"; download.dataset.assetMime = asset.mimeType || "application/octet-stream";
    download.textContent = nativeDownload ? "保存到下载" : "下载文件";
    download.hidden = false;
    open.hidden = !nativeOpen;
    open.dataset.assetId = asset.id || ""; open.dataset.assetName = asset.name || "文件"; open.dataset.assetMime = asset.mimeType || "application/octet-stream";
  } catch (error) {
    content.innerHTML = `<div class="viewer-error">${escapeHtml(error.message)}</div>`;
    $("#attachment-viewer-download").hidden = true; $("#attachment-viewer-open").hidden = true;
  }
}
function closeAttachmentViewer({ fromHistory = false } = {}) {
  const viewer = $("#attachment-viewer");
  if (viewer.hidden) return;
  viewer.hidden = true; viewer.setAttribute("aria-hidden", "true");
  $("#attachment-viewer-content").innerHTML = "";
  if (viewerObjectUrl) URL.revokeObjectURL(viewerObjectUrl);
  viewerObjectUrl = "";
  const shouldPopHistory = attachmentViewerHistoryOpen && !fromHistory;
  attachmentViewerHistoryOpen = false;
  if (shouldPopHistory) history.back();
}
function renderToolFiles(files = []) {
  if (!files.length) return "";
  return `<section class="tool-section tool-files"><b>相关文件</b><div>${files.map((file) => `<button type="button" data-file-open="${escapeHtml(file.id)}" data-asset-name="${escapeHtml(file.name || "文件")}" data-asset-mime="${escapeHtml(file.mimeType || "application/octet-stream")}" data-asset-kind="${escapeHtml(file.kind || "workspace_file")}"><i>${escapeHtml(attachmentIcon(file))}</i><span>${escapeHtml(file.name || "文件")}</span><em>打开</em></button>`).join("")}</div></section>`;
}
function renderProducedFiles(messages = []) {
  // Only files touched by a write/edit tool are conversation outputs. Read and
  // search references remain inside details so they do not look downloadable results.
  const files = []; const seen = new Set();
  for (const message of messages) {
    const tool = message?.tool || {};
    if (tool.activity !== "edit") continue;
    for (const file of tool.files || []) {
      if (!file?.id || seen.has(file.id)) continue;
      seen.add(file.id); files.push(file);
    }
  }
  if (!files.length) return "";
  return `<section class="produced-files" aria-label="本轮产物"><div class="produced-files-head"><span>本轮产物</span><small>${files.length} 个文件</small></div><div class="message-attachments">${files.map((file) => {
    const metadata = `data-asset-name="${escapeHtml(file.name || "文件")}" data-asset-mime="${escapeHtml(file.mimeType || "application/octet-stream")}" data-asset-kind="${escapeHtml(file.kind || "workspace_file")}"`;
    return `<button type="button" class="message-attachment file produced-file" data-file-open="${escapeHtml(file.id)}" ${metadata}><i>${escapeHtml(attachmentIcon(file))}</i><span><strong>${escapeHtml(file.name || "文件")}</strong><small>点击预览或下载</small></span></button>`;
  }).join("")}</div></section>`;
}
function isToolMessage(message) { return message?.role === "tool" || message?.kind === "tool"; }
function toolActivity(message) {
  const tool = message?.tool || {};
  if (["read", "search", "edit", "command", "other"].includes(tool.activity)) return tool.activity;
  const value = `${tool.name || ""} ${tool.title || ""} ${tool.command || ""} ${tool.arguments || ""} ${message?.text || ""}`.toLowerCase();
  if (/\b(read|readfile|cat|head|tail|sed)\b|读取|查看文件/.test(value)) return "read";
  if (/\b(grep|rg|glob|find|search|websearch|web_search)\b|搜索|检索|查找/.test(value)) return "search";
  if (/\b(edit|write|apply_patch|notebookedit|str_replace)\b|编辑|写入|修改文件/.test(value)) return "edit";
  if (/\b(bash|shell|terminal|exec|run_command|execute)\b|执行命令|运行命令/.test(value)) return "command";
  return "other";
}
function toolActivitySummary(messages = []) {
  const counts = { read: 0, search: 0, edit: 0, command: 0, other: 0 };
  for (const message of messages) counts[toolActivity(message)] += 1;
  const parts = [];
  if (counts.read) parts.push(`检查 ${counts.read} 个文件`);
  if (counts.search) parts.push(`${counts.search} 次搜索`);
  if (counts.edit) parts.push(`修改 ${counts.edit} 个文件`);
  if (counts.command) parts.push(`运行 ${counts.command} 个命令`);
  if (counts.other) parts.push(`完成 ${counts.other} 项操作`);
  return `已${parts.join("，") || "完成工具调用"}`;
}
function renderToolItem(message, key, position = "") {
  const tool = message.tool || {}; const status = tool.status || "completed";
  const title = tool.title || tool.name || firstLine(message.text) || "工具调用";
  const command = tool.command || "";
  const argumentsText = tool.arguments && tool.arguments !== command ? tool.arguments : "";
  const details = [toolDetailBlock("命令", command, "tool-command"), toolDetailBlock("参数", argumentsText), toolDetailBlock("输出", tool.output, "tool-output"), toolDetailBlock("错误", tool.error, "tool-error"), renderToolFiles(tool.files)].join("");
  return `<details class="tool-item status-${escapeHtml(status)}" data-message-key="${escapeHtml(key)}" data-tool-id="${escapeHtml(tool.id || "")}" data-tool-status="${escapeHtml(status)}" data-tool-activity="${escapeHtml(toolActivity(message))}"><summary><span class="tool-index">${escapeHtml(position)}</span><span class="tool-item-head"><b>${escapeHtml(title)}</b><small>${escapeHtml(tool.name && tool.name !== title ? tool.name : command || "未提供命令摘要")}</small></span><span class="tool-item-state">${escapeHtml(toolStatusLabel(status))}</span><span class="tool-item-chevron">›</span></summary><div class="tool-item-detail">${details || '<div class="tool-empty">Agent 未提供命令或参数详情</div>'}</div></details>`;
}
function aggregateToolStatus(messages = []) {
  const statuses = messages.map((message) => message.tool?.status || "completed");
  return ["failed", "waiting_for_approval", "running", "pending", "cancelled"].find((status) => statuses.includes(status)) || "completed";
}
function toolGroupSubtitle(messages = []) {
  const running = messages.filter((message) => ["running", "pending"].includes(message.tool?.status)).length;
  const failed = messages.filter((message) => message.tool?.status === "failed").length;
  if (failed) return `${failed} 个失败，点击查看详情`;
  if (running) return `${running} 个执行中，点击查看详情`;
  return "点击展开调用详情";
}
function renderToolGroup(messages, startIndex = 0) {
  const status = aggregateToolStatus(messages);
  const open = status === "failed" || status === "waiting_for_approval";
  const items = messages.map((message, offset) => renderToolItem(message, messageKey(message, startIndex + offset), offset + 1)).join("");
  return `<div class="tool-group-wrap"><details class="tool status-${escapeHtml(status)} tool-group" data-tool-count="${messages.length}"${open ? " open" : ""}><summary><span class="ic">‹/›</span><span class="tool-head"><b>${escapeHtml(toolActivitySummary(messages))}</b><small>${escapeHtml(toolGroupSubtitle(messages))}</small></span><span class="tool-state">${escapeHtml(toolStatusLabel(status))}</span><span class="chevron">›</span></summary><div class="tool-detail"><div class="tool-group-items">${items}</div></div></details>${renderProducedFiles(messages)}</div>`;
}
function renderMessage(message, extraClass = "", index = 0) {
  const kind = message.kind || "message"; const key = messageKey(message, index); const text = String(message.text || "");
  if (kind === "thinking") return `<details class="think" data-message-key="${escapeHtml(key)}" data-raw="${escapeHtml(text)}"><summary><i></i><b>思考摘要</b><span class="preview">${escapeHtml(firstLine(text)).slice(0, 120)}</span><span class="fold">展开</span><span class="chevron">⌄</span></summary><div class="think-body">${renderRichText(text)}</div></details>`;
  if (isToolMessage(message)) return renderToolGroup([message], index);
  if (message.role === "user") return `<div class="me ${extraClass}" data-message-key="${escapeHtml(key)}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}${extraClass.includes("failed") ? ` data-retry-text="${escapeHtml(text)}"` : ""}><div class="msg-body">${escapeHtml(text)}</div>${renderMessageAttachments(message.attachments)}${extraClass.includes("failed") ? '<button type="button" class="retry-send" data-retry>重试</button>' : ""}</div>`;
  const who = `${escapeHtml(agentLabel(current?.agent || ""))}${current?.model ? ` · ${escapeHtml(current.model)}` : ""}`;
  return `<div class="ai ${extraClass}" data-message-key="${escapeHtml(key)}" data-raw="${escapeHtml(text)}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}><div class="who">${who}</div><div class="msg-body">${renderRichText(text)}</div>${renderMessageAttachments(message.attachments)}</div>`;
}
function messageFingerprint(rows = []) { return rows.map((message) => `${message.role || ""}|${message.kind || ""}|${message.text || ""}|${JSON.stringify(message.tool || null)}|${JSON.stringify(message.attachments || null)}`).join("\u001f"); }
function renderSessionQueue() {
  const host = $("#session-queue");
  const queue = Array.isArray(current?.queue) ? current.queue : [];
  if (!current || (!queue.length && !current.queuePaused)) { host.hidden = true; host.innerHTML = ""; return; }
  const items = queue.map((item, index) => `<article class="queue-item" data-queue-id="${escapeHtml(item.id)}"><div class="queue-item-head"><span class="queue-order">${index + 1}</span><div class="queue-copy"><p>${escapeHtml(item.text || "（仅附件）")}</p><small>${item.attachments?.length ? `含 ${item.attachments.length} 个附件 · ` : ""}等待当前轮结束后执行</small></div></div><div class="queue-actions"><button type="button" data-queue-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="queue-cancel" data-queue-cancel="${escapeHtml(item.id)}">取消</button></div></article>`).join("");
  host.hidden = false;
  host.innerHTML = `<details open><summary><b>排队指令（${queue.length}）</b><small>${current.queuePaused ? "已暂停" : "依次执行"}</small></summary>${current.queuePaused ? '<div class="queue-paused">已停止当前会话，排队指令尚未执行。</div><button type="button" class="queue-resume" data-queue-resume>继续执行队列</button>' : ""}<div class="queue-items">${items || '<div class="queue-paused">队列为空</div>'}</div></details>`;
}
function updateComposerQueueState() {
  const queueing = isSessionRunning(); const stopping = queueing && !hasComposerContent();
  const send = $("#send"); const composer = $("#composer");
  send.classList.toggle("is-queue", queueing && !stopping); send.classList.toggle("is-stop", stopping); composer.dataset.queueing = String(queueing);
  const label = stopping ? "停止会话" : queueing ? "发送后续消息" : "发送";
  send.setAttribute("aria-label", label); send.title = label;
}

function renderMessages(rows = [], { hasMore = false, total = rows.length } = {}) {
  const html = [];
  if (hasMore) html.push(`<button id="load-earlier-messages" class="load-earlier-messages" type="button">加载更早记录（共 ${Number(total) || rows.length} 条）</button>`);
  for (let index = 0; index < rows.length;) {
    if (!isToolMessage(rows[index])) { html.push(renderMessage(rows[index], "", index)); index += 1; continue; }
    let end = index + 1;
    while (end < rows.length && isToolMessage(rows[end])) end += 1;
    html.push(renderToolGroup(rows.slice(index, end), index));
    index = end;
  }
  $("#messages").innerHTML = html.join(""); lastDetailFingerprint = messageFingerprint(rows); renderSessionQueue(); updateComposerQueueState(); void hydrateAttachmentPreviews($("#messages"));
}
function syncMessages(rows = [], options = {}) {
  const fingerprint = messageFingerprint(rows);
  if (fingerprint === lastDetailFingerprint) return false;
  const follow = shouldFollowConversation(); renderMessages(rows, options); if (follow) scrollMessages({ force: true, instant: true }); return true;
}
function isDetailVisible() { return document.querySelector('.page[data-page="detail"]')?.classList.contains("active"); }
function shouldFollowConversation() {
  if (!isDetailVisible()) return false;
  const viewportBottom = window.scrollY + window.innerHeight;
  return document.documentElement.scrollHeight - viewportBottom < 180;
}
function scrollMessages({ force = false, instant = false } = {}) {
  if (!force && !shouldFollowConversation()) return;
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: instant ? "auto" : "smooth" }));
}

async function pair() {
  const challenge = new URLSearchParams(location.search).get("challenge");
  if (!challenge || token) return;
  const paired = await api("/mobile/pair/complete", { method: "POST", body: JSON.stringify({ challenge, name: "我的手机" }) });
  persistToken(paired.token); history.replaceState({}, document.title, "/");
}

async function loadAgents() {
  agents = await api("/mobile/v1/agents");
  if (!selectedAgent || !agents.some((agent) => agent.id === selectedAgent)) selectedAgent = agents[0]?.id || "";
  renderFilters(); renderAgentPicker(); renderAgentNotices(); await loadModels();
}

async function loadModels() {
  if (!selectedAgent) return;
  const models = await api(`/mobile/v1/models?agent=${encodeURIComponent(selectedAgent)}`);
  $("#model-select").innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join("") || '<option value="">暂无可用模型</option>';
  const preferred = agents.find((agent) => agent.id === selectedAgent)?.defaultModelId;
  if (preferred && models.some((model) => model.id === preferred)) $("#model-select").value = preferred;
}

async function loadSessions({ background = false } = {}) {
  const rows = await api(`/mobile/v1/sessions${archivedView ? "?archived=true" : ""}`);
  // Keep the full lightweight metadata list for search/switching, but only
  // create DOM for one page. Rendering 1,000+ WeChat-style rows at once can
  // freeze Android WebView long enough to look like the app never entered.
  allSessions = (Array.isArray(rows) ? rows : []).filter((session) => Boolean(session?.archived) === archivedView);
  sessions = allSessions.slice(0, sessionDisplayLimit);
  renderSessionList(); renderSessionSwitcher(); renderAgentNotices();
  // Once the list is on screen, warm the most likely next tap in idle time.
  // This overlaps the local transcript read with the user's reading time.
  if (!background) scheduleDetailPreload(sessions);
  return sessions;
}
async function loadWorkspaces() { workspaces = await api("/mobile/v1/workspaces"); renderWorkspaces(); renderSessionList(); }
async function loadApprovals() { pendingApprovals = await api("/mobile/v1/approvals"); renderApprovalInbox(); renderStatusSummary(); }

function cacheSessionDetail(detail) {
  if (!detail?.id) return;
  sessionDetailCache.set(detail.id, { at: Date.now(), detail });
}
function scheduleDetailPreload(rows = []) {
  const candidates = rows.filter((session) => session.id !== current?.id && !["running", "queued", "waiting_for_approval"].includes(session.state)).slice(0, 2);
  const preload = () => candidates.forEach((session) => {
    const cached = sessionDetailCache.get(session.id);
    if (!cached || Date.now() - cached.at >= SESSION_DETAIL_CACHE_TTL_MS) {
      fetchSessionDetail(session.id).catch(() => {});
    }
  });
  if (typeof requestIdleCallback === "function") requestIdleCallback(preload, { timeout: 1200 });
  else setTimeout(preload, 1_500);
}
function applySessionDetail(detail, { activate = true, instant = false } = {}) {
  current = detail;
  $("#detail-title").textContent = current.title;
  $("#detail-meta").textContent = `${agentLabel(current.agent)}${current.model ? ` · ${current.model}` : ""}`;
  $("#chat-state-dot").className = current.state || "";
  renderRuntimeShortcut(); renderApprovalInbox(); renderSessionQueue(); updateComposerQueueState();
  const options = { hasMore: Boolean(current.hasMoreMessages), total: current.messagesTotal };
  if (activate) { renderMessages(current.messages || [], options); page("detail"); scrollMessages({ force: true, instant }); }
  else syncMessages(current.messages || [], options);
}
async function fetchSessionDetail(id, { messageLimit = INITIAL_MESSAGE_LIMIT } = {}) {
  const detail = await api(`/mobile/v1/sessions/${encodeURIComponent(id)}?messages=${encodeURIComponent(messageLimit)}`);
  cacheSessionDetail(detail);
  return detail;
}
let openSessionSeq = 0;
async function openSession(id, { activate = true, messageLimit = INITIAL_MESSAGE_LIMIT } = {}) {
  const seq = ++openSessionSeq;
  const cached = sessionDetailCache.get(id);
  const cacheFresh = cached && Date.now() - cached.at < SESSION_DETAIL_CACHE_TTL_MS;
  if (activate) {
    page("detail");
    if (cacheFresh) applySessionDetail(cached.detail, { activate: true, instant: true });
    else {
      $("#detail-title").textContent = "载入中…";
      $("#detail-meta").textContent = "";
      $("#messages").innerHTML = '<div class="empty">正在载入会话…</div>';
    }
  }
  const detail = await fetchSessionDetail(id, { messageLimit });
  if (seq !== openSessionSeq) return;
  applySessionDetail(detail, { activate, instant: true });
  // Approval data is independent: never delay the first message paint on it.
  void loadApprovals().catch(() => {});
}
async function loadEarlierMessages() {
  if (!current?.id || !current.hasMoreMessages) return;
  const button = $("#load-earlier-messages"); if (button) { button.disabled = true; button.textContent = "正在加载更早记录…"; }
  await openSession(current.id, { messageLimit: 500 });
}

async function openModelSheet() {
  if (!current) return;
  const sheet = $("#model-sheet");
  const list = $("#session-model-list");
  // Open first so a slow model query never leaves the user wondering whether
  // the tap was accepted; the list itself has its own scroll container.
  list.innerHTML = '<div class="sheet-loading">正在加载可用模型…</div>';
  renderSessionSettings();
  showModelSheet();
  try {
    const models = await api(`/mobile/v1/models?agent=${encodeURIComponent(current.agent)}`);
    list.innerHTML = models.map((model) => `<button class="model-option ${model.id === current.model ? "selected" : ""}" data-model="${escapeHtml(model.id)}" type="button"><span><strong>${escapeHtml(model.name)}</strong><small>${escapeHtml(model.provider || "可用于当前 Agent")}</small></span><span class="model-check">${model.id === current.model ? "✓" : ""}</span></button>`).join("") || '<div class="empty">当前 Agent 没有可切换模型。</div>';
  } catch (error) {
    list.innerHTML = `<div class="sheet-error"><strong>模型列表加载失败</strong><span>${escapeHtml(error.message || "请稍后重试")}</span><button id="retry-model-sheet" type="button">重新加载</button></div>`;
  }
}

function appendEvent(event) {
  if (!current || event.sessionId !== current.id) return;
  sessionDetailCache.delete(current.id);
  if (event.type === "message" && event.summary) {
    const role = event.role || "assistant"; const last = $("#messages").lastElementChild;
    if (role === "user" && last?.classList.contains("me") && last.querySelector(".msg-body")?.textContent === event.summary) return;
    if (role === "assistant" && last?.classList.contains("ai")) {
      const body = last.querySelector(".msg-body"); const raw = last.dataset.raw || body.textContent || "";
      last.dataset.raw = `${raw}${event.summary}`;
      // Debounce rather than repainting for every token: Markdown becomes rich
      // during the stream without bringing back Grok's full-message flicker.
      scheduleStreamingRichText(last, ".msg-body");
    } else { $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role, text: event.summary, attachments: event.attachments || [] })); void hydrateAttachmentPreviews($("#messages")); }
    scrollMessages();
  }
  if (event.type === "thinking" && event.summary) { const last = $("#messages").lastElementChild; if (last?.classList.contains("think")) { const body = last.querySelector(".think-body"); const raw = last.dataset.raw || body.textContent || ""; last.dataset.raw = `${raw}${event.summary}`; scheduleStreamingRichText(last, ".think-body"); } else $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", kind: "thinking", text: event.summary })); scrollMessages(); }
  if (event.type === "status") {
    const status = String(event.summary || "");
    const knownStates = new Set(["queued", "running", "waiting_for_approval", "completed", "failed", "cancelled", "canceled", "incomplete"]);
    if (knownStates.has(status)) {
      current.state = status;
      updateComposerQueueState();
      $("#connection").textContent = stateLabel(status) || "已安全连接";
      $("#chat-state-dot").className = status;
    }
  }
  if (event.type === "error") { $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", text: `发送失败：${event.summary}` }, "failed")); toast("消息没有发送成功，请重试"); }
  if (event.type === "tool") {
    const selector = event.tool?.id ? `.tool-item[data-tool-id="${CSS.escape(event.tool.id)}"]` : "";
    const existing = selector ? $("#messages").querySelector(selector) : null;
    const message = { id: event.id, role: "tool", kind: "tool", text: event.summary || "正在使用工具", tool: event.tool || null };
    if (existing) {
      const group = existing.closest(".tool-group");
      existing.outerHTML = renderToolItem(message, messageKey(message));
      refreshToolGroup(group);
    } else {
      const last = $("#messages").lastElementChild;
      if (last?.classList.contains("tool-group")) {
        last.querySelector(".tool-group-items")?.insertAdjacentHTML("beforeend", renderToolItem(message, messageKey(message)));
        refreshToolGroup(last);
      } else $("#messages").insertAdjacentHTML("beforeend", renderToolGroup([message]));
    }
    scrollMessages();
  }
}

function refreshToolGroup(group) {
  if (!group) return;
  const items = [...group.querySelectorAll(":scope .tool-item")];
  const messages = items.map((item) => ({ tool: { status: item.dataset.toolStatus || "completed" }, activity: item.dataset.toolActivity || "other" }));
  const status = aggregateToolStatus(messages);
  group.dataset.toolCount = String(items.length);
  for (const name of ["failed", "waiting_for_approval", "running", "pending", "cancelled", "completed"]) group.classList.toggle(`status-${name}`, name === status);
  const counts = { read: 0, search: 0, edit: 0, command: 0, other: 0 };
  for (const item of items) counts[item.dataset.toolActivity || "other"] += 1;
  const parts = [];
  if (counts.read) parts.push(`检查 ${counts.read} 个文件`);
  if (counts.search) parts.push(`${counts.search} 次搜索`);
  if (counts.edit) parts.push(`修改 ${counts.edit} 个文件`);
  if (counts.command) parts.push(`运行 ${counts.command} 个命令`);
  if (counts.other) parts.push(`完成 ${counts.other} 项操作`);
  group.querySelector("summary .tool-head b").textContent = `已${parts.join("，") || "完成工具调用"}`;
  group.querySelector("summary .tool-head small").textContent = toolGroupSubtitle(messages);
  group.querySelector("summary .tool-state").textContent = toolStatusLabel(status);
  items.forEach((item, index) => { const marker = item.querySelector(".tool-index"); if (marker) marker.textContent = String(index + 1); });
  if (["failed", "waiting_for_approval"].includes(status)) group.open = true;
}

function finalizeStreamingMessages() {
  document.querySelectorAll("#messages .ai[data-raw]").forEach((node) => {
    finalizeStreamingNode(node, ".msg-body");
  });
  document.querySelectorAll("#messages .think[data-raw]").forEach((node) => {
    finalizeStreamingNode(node, ".think-body");
  });
}

function scheduleFinalReconcile(event) {
  const status = String(event?.summary || "").toLowerCase();
  const terminal = new Set(["completed", "failed", "cancelled", "canceled", "incomplete", "end_turn", "stop", "max_tokens", "length"]);
  const queueChanged = /排队|下一条|停止.*会话|清空.*排队|保留.*排队|编辑.*排队|取消.*排队/.test(status);
  if (event?.type !== "status" || (!terminal.has(status) && !queueChanged)) return;
  if (!current || !isDetailVisible()) return;
  if (terminal.has(status)) finalizeStreamingMessages();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => openSession(current.id, { activate: false }).catch(() => {}), queueChanged ? 150 : 900);
}
async function handleEvent(event) {
  if (event.id > eventCursor) { eventCursor = event.id; localStorage.setItem(CURSOR_KEY, String(eventCursor)); }
  if (event.type === "approval") {
    // Approval events may arrive while a detail response is cached. Await the
    // refresh so the fixed current-session card is rendered before the user sees a failure state.
    await loadApprovals().catch(() => {});
    if (current?.id === event.sessionId) {
      const currentApproval = pendingApprovals.find((approval) => approval.sessionId === event.sessionId);
      current.state = "waiting_for_approval";
      updateComposerQueueState();
      $("#chat-state-dot").className = current.state;
      $("#connection").textContent = stateLabel(current.state);
      toast("有操作等待你的授权");
    }
  }
  appendEvent(event);
  scheduleFinalReconcile(event);
}
async function readEventStream(response) { if (!response.ok || !response.body) throw new Error(`事件流 HTTP ${response.status}`); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let boundary; while ((boundary = buffer.indexOf("\n\n")) >= 0) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"); if (data) await handleEvent(JSON.parse(data)); } } }
async function connectEvents() { while (token && !eventLoopStopped) { const controller = new AbortController(); const reconnect = setTimeout(() => controller.abort(), 20_000); try { await readEventStream(await fetch(`/mobile/v1/events?after=${eventCursor}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal })); } catch (error) { if (error.name !== "AbortError") $("#connection").textContent = "正在重连"; } finally { clearTimeout(reconnect); } await new Promise((resolve) => setTimeout(resolve, 800)); } }

function closeWorkspaceMenus(except = null) {
  document.querySelectorAll(".group-menu:not([hidden])").forEach((menu) => { if (menu !== except) menu.hidden = true; });
}

document.addEventListener("click", async (event) => {
  try {
    const commandOption = event.target.closest("[data-command-index]");
    if (commandOption) { chooseCommand(Number(commandOption.dataset.commandIndex)); return; }
    if (!event.target.closest("#command-picker") && !event.target.matches("#message,#prompt")) hideCommandPicker();
    const workspaceMenuButton = event.target.closest("[data-workspace-menu]");
    if (workspaceMenuButton) {
      const menu = workspaceMenuButton.parentElement?.querySelector(".group-menu");
      const opening = Boolean(menu?.hidden);
      closeWorkspaceMenus(menu);
      if (menu) menu.hidden = !opening;
      return;
    }
    if (!event.target.closest(".group-menu")) closeWorkspaceMenus();
    const nav = event.target.closest("[data-nav]"); if (nav) {
      if (nav.dataset.nav === "sessions" && current) { openSessionSwitcher(); refreshSessionsInBackground(); void loadApprovals().catch(() => {}); return; }
      page(nav.dataset.nav);
      if (nav.dataset.nav === "sessions") { renderSessionList(); refreshSessionsInBackground(); void loadApprovals().catch(() => {}); }
      if (nav.dataset.nav === "new") { await loadWorkspaces(); renderAgentPicker(); }
      return;
    }
    if (event.target.closest("#open-session-switcher")) { openSessionSwitcher(); refreshSessionsInBackground(); return; }
    if (event.target.closest("#close-session-switcher") || event.target === $("#session-switcher")) { closeSessionSwitcher(); return; }
    if (event.target.closest("#continue-current-session")) { closeSessionSwitcher(); page("detail"); scrollMessages({ force: true }); return; }
    if (event.target.closest("#load-earlier-messages")) { await loadEarlierMessages(); return; }
    if (event.target.closest("#load-more-sessions")) { sessionDisplayLimit += SESSION_PAGE_SIZE; renderSessionList(); return; }
    const switchSession = event.target.closest("[data-switch-session]");
    if (switchSession) { closeSessionSwitcher(); await openSession(switchSession.dataset.switchSession); return; }
    const filter = event.target.closest("[data-filter]"); if (filter) { selectedFilter = filter.dataset.filter; sessionDisplayLimit = SESSION_PAGE_SIZE; renderFilters(); renderSessionList(); return; }
    const group = event.target.closest("[data-group]"); if (group) { const name = group.dataset.group; collapsedGroups.has(name) ? collapsedGroups.delete(name) : collapsedGroups.add(name); renderSessionList(); return; }
    const agent = event.target.closest("[data-agent]"); if (agent) { selectedAgent = agent.dataset.agent; renderAgentPicker(); await loadModels(); if (document.activeElement === $("#prompt")) await updateCommandPicker($("#prompt")); return; }
    const workspaceManage = event.target.closest("[data-workspace-manage]"); if (workspaceManage) {
      const item = workspaceManage.closest(".swipe-item");
      const opening = !item?.classList.contains("open");
      closeAllSwipe();
      if (opening) item?.classList.add("open");
      return;
    }
    const workspace = event.target.closest("[data-workspace]"); if (workspace) { selectedWorkspace = workspace.dataset.workspace; renderWorkspaces(); return; }
    const directory = event.target.closest("[data-workspace-directory]"); if (directory) return browseWorkspace(directory.dataset.workspaceDirectory);
    if (event.target.closest("#workspace-other")) return browseWorkspace();
    if (event.target.closest("#close-workspace-sheet") || event.target === $("#workspace-sheet")) { workspaceSheet(false); return; }
    if (event.target.closest("#workspace-parent") && browsedWorkspace?.parent) return browseWorkspace(browsedWorkspace.parent);
    if (event.target.closest("#workspace-choose") && browsedWorkspace?.path) { selectedWorkspace = browsedWorkspace.path; renderWorkspaces(); workspaceSheet(false); toast("已选择工作目录"); return; }
    const workspaceDelete = event.target.closest("[data-workspace-delete]"); if (workspaceDelete) {
      closeAllSwipe();
      const target = workspaceDelete.dataset.workspaceDelete;
      const name = target.split("/").pop();
      if (!confirm(`确认删除文件夹「${name}」？\n\n如果里面有文件，会继续询问是否强制删除。`)) return;
      try {
        await api(`/mobile/v1/workspaces/directories?path=${encodeURIComponent(target)}`, { method: "DELETE" });
      } catch (error) {
        if (!/不为空|NOT_EMPTY|force/i.test(error.message || "")) throw error;
        if (!confirm(`「${name}」不是空文件夹。\n\n是否强制删除其中全部内容？此操作不可恢复。`)) return;
        await api(`/mobile/v1/workspaces/directories?path=${encodeURIComponent(target)}&force=1`, { method: "DELETE" });
      }
      if (selectedWorkspace === target) selectedWorkspace = browsedWorkspace?.path || "";
      if (workspaceDelete.closest("#workspace-browser-list") && browsedWorkspace?.path) await browseWorkspace(browsedWorkspace.path);
      else await Promise.all([loadWorkspaces(), loadSessions()]);
      renderWorkspaces();
      toast("目录已删除");
      return;
    }
    if (event.target.closest("#workspace-create") && browsedWorkspace?.path) { const name = prompt("新建文件夹名称"); if (!name?.trim()) return; const created = await api("/mobile/v1/workspaces/directories", { method: "POST", body: JSON.stringify({ parent: browsedWorkspace.path, name }) }); selectedWorkspace = created.path; await browseWorkspace(browsedWorkspace.path); renderWorkspaces(); toast("文件夹已创建并选中"); return; }
    const sessionAction = event.target.closest("[data-session-action]");
    if (sessionAction) {
      const id = sessionAction.dataset.id;
      const action = sessionAction.dataset.sessionAction;
      closeAllSwipe();
      if (action === "rename") {
        const session = allSessions.find((item) => item.id === id);
        const title = prompt("会话名称", session?.title || "");
        if (!title?.trim()) return;
        await api(`/mobile/v1/sessions/${encodeURIComponent(id)}/rename`, { method: "POST", body: JSON.stringify({ title: title.trim() }) });
        toast("已重命名");
        return loadSessions();
      }
      if (action === "archive") {
        await api(`/mobile/v1/sessions/${encodeURIComponent(id)}/${archivedView ? "unarchive" : "archive"}`, { method: "POST", body: JSON.stringify({}) });
        toast(archivedView ? "已取消归档" : "已归档");
        return loadSessions();
      }
      if (action === "delete") {
        if (!confirm("确认删除这个会话？\n\n部分 Agent 的桌面历史不能物理删除，会从手机列表隐藏。")) return;
        const result = await api(`/mobile/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (current?.id === id) { current = null; page("sessions"); }
        toast(result?.hiddenOnly ? "已从手机列表移除" : "已删除");
        return loadSessions();
      }
    }
    const workspaceRename = event.target.closest("[data-workspace-rename]");
    if (workspaceRename) {
      closeAllSwipe();
      const oldPath = workspaceRename.dataset.workspaceRename;
      const oldName = workspaceRename.dataset.workspaceName || oldPath.split("/").pop();
      const name = prompt("文件夹新名称", oldName);
      if (!name?.trim() || name.trim() === oldName) return;
      const result = await api("/mobile/v1/workspaces/directories/rename", { method: "POST", body: JSON.stringify({ path: oldPath, name: name.trim() }) });
      if (selectedWorkspace === oldPath) selectedWorkspace = result.path;
      if (workspaceRename.closest("#workspace-browser-list") && browsedWorkspace?.path) await browseWorkspace(browsedWorkspace.path);
      else await Promise.all([loadWorkspaces(), loadSessions()]);
      renderWorkspaces();
      toast("已重命名");
      return;
    }
    const queueEdit = event.target.closest("[data-queue-edit]");
    if (queueEdit && current) {
      const item = (current.queue || []).find((row) => row.id === queueEdit.dataset.queueEdit);
      const text = prompt("编辑排队指令", item?.text || "");
      if (text === null || (!text.trim() && !item?.attachments?.length)) return;
      await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/queue/${encodeURIComponent(queueEdit.dataset.queueEdit)}`, { method: "POST", body: JSON.stringify({ text: text.trim() }) });
      await openSession(current.id, { activate: false }); toast("已更新排队指令"); return;
    }
    const queueCancel = event.target.closest("[data-queue-cancel]");
    if (queueCancel && current) {
      await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/queue/${encodeURIComponent(queueCancel.dataset.queueCancel)}`, { method: "DELETE" });
      await openSession(current.id, { activate: false }); toast("已取消排队指令"); return;
    }
    if (event.target.closest("[data-queue-resume]") && current) {
      await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/queue/resume`, { method: "POST", body: JSON.stringify({}) });
      await openSession(current.id, { activate: false }); toast("已继续执行队列"); return;
    }
    if (event.target.closest("[data-retry]")) {
      const host = event.target.closest("[data-retry-text]");
      const text = host?.dataset.retryText || "";
      if (!text || !current) return;
      host.remove();
      $("#message").value = text;
      $("#composer").requestSubmit();
      return;
    }
    const card = event.target.closest(".session-row[data-id]"); if (card) { closeAllSwipe(); return openSession(card.dataset.id); }
    if (event.target.closest("#more")) { $("#session-menu").hidden = !$("#session-menu").hidden; return; }
    if (event.target.closest("#open-model-sheet") || event.target.closest("#retry-model-sheet")) return openModelSheet();
    if (event.target.closest("#close-model-sheet") || event.target === $("#model-sheet")) { hideModelSheet(); return; }
    if (event.target.closest("#save-session-settings") && current) {
      const effort = $("#session-effort")?.value || "";
      const permissionMode = $("#session-permission")?.value || "";
      const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/settings`, { method: "POST", body: JSON.stringify({ effort, permissionMode }) });
      current.settings = result.settings || { effort, permissionMode };
      renderRuntimeShortcut();
      toast("权限和思考程度将在下一轮生效");
      return;
    }
    const model = event.target.closest("[data-model]"); if (model && current) { await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/model`, { method: "POST", body: JSON.stringify({ model: model.dataset.model }) }); current.model = model.dataset.model; $("#detail-meta").textContent = `${agentLabel(current.agent)} · ${current.model}`; renderRuntimeShortcut(); hideModelSheet(); toast("模型将在下一轮生效"); return; }
    const approval = event.target.closest("[data-approval]"); if (approval) {
      await api(`/mobile/v1/approvals/${encodeURIComponent(approval.dataset.approval)}/resolve`, { method: "POST", body: JSON.stringify({ decision: approval.dataset.decision }) });
      await loadApprovals(); if (current) await openSession(current.id, { activate: false });
      toast(approval.dataset.decision === "allow_once" ? "已允许一次，正在继续执行" : "已拒绝本次操作"); return;
    }
    const nativeOpen = event.target.closest("#attachment-viewer-open");
    if (nativeOpen && runNativeAssetAction("openAsset", { id: nativeOpen.dataset.assetId, name: nativeOpen.dataset.assetName, mimeType: nativeOpen.dataset.assetMime })) { toast("正在打开文件…"); return; }
    const nativeDownload = event.target.closest("#attachment-viewer-download");
    if (nativeDownload && runNativeAssetAction("downloadAsset", { id: nativeDownload.dataset.assetId, name: nativeDownload.dataset.assetName, mimeType: nativeDownload.dataset.assetMime })) { event.preventDefault(); toast("正在保存到系统下载目录…"); return; }
    const copy = event.target.closest("[data-copy-code]"); if (copy) { await navigator.clipboard?.writeText(decodeURIComponent(copy.dataset.copyCode)); toast("代码已复制"); return; }
    const assetOpen = event.target.closest("[data-attachment-open],[data-attachment-preview],[data-file-open]");
    if (assetOpen) { await openAttachmentViewer({ id: assetOpen.dataset.attachmentOpen || assetOpen.dataset.fileOpen, preview: assetOpen.dataset.attachmentPreview || "", name: assetOpen.dataset.assetName, mimeType: assetOpen.dataset.assetMime, kind: assetOpen.dataset.assetKind }); return; }
    if (event.target.closest("#close-attachment-viewer") || event.target.closest("#attachment-viewer-done") || event.target === $("#attachment-viewer")) { closeAttachmentViewer(); return; }
    if (event.target.closest("#new-attach-control")) { $("#new-attachment-input").click(); return; }
    if (event.target.closest("#attach-control")) { $("#attachment-input").click(); return; }
    const removeAttachment = event.target.closest("[data-remove-attachment]"); if (removeAttachment) { const targetName = removeAttachment.dataset.attachmentTarget || "active"; const target = targetName === "new" ? newAttachments : activeAttachments; const [removed] = target.splice(Number(removeAttachment.dataset.removeAttachment), 1); if (removed?.preview) URL.revokeObjectURL(removed.preview); renderComposerAttachments(target, targetName === "new" ? $("#new-attachment-preview") : $("#attachment-preview"), targetName); if (targetName === "active") updateComposerQueueState(); return; }
    if (event.target.closest("#conversation-behavior") || event.target.closest("#close-conversation-behavior-sheet") || event.target === $("#conversation-behavior-sheet")) { event.target.closest("#conversation-behavior") ? showConversationBehaviorSheet() : hideConversationBehaviorSheet(); return; }
    const behaviorMode = event.target.closest("[data-conversation-send-mode]");
    if (behaviorMode) { const result = await saveConversationSendMode(behaviorMode.dataset.conversationSendMode); hideConversationBehaviorSheet(); toast(result.synced ? `已设为${conversationSendModeLabel()}` : `已设为${conversationSendModeLabel()}（待桌面端升级后同步）`); return; }
    if (event.target.closest("#close-message-mode-sheet") || event.target === $("#message-mode-sheet") || event.target.closest('[data-message-mode="dismiss"]')) { hideMessageModeSheet(); return; }
    const messageMode = event.target.closest("[data-message-mode]");
    if (messageMode) { hideMessageModeSheet(); await submitComposerMessage(messageMode.dataset.messageMode); return; }
    if (event.target.closest("#close-stop-session-sheet") || event.target === $("#stop-session-sheet") || event.target.closest('[data-stop-session="dismiss"]')) { hideStopSessionSheet(); return; }
    const stopSession = event.target.closest("[data-stop-session]");
    if (stopSession && current) {
      const clearQueue = stopSession.dataset.stopSession === "clear";
      hideStopSessionSheet();
      await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/cancel`, { method: "POST", body: JSON.stringify({ clearQueue }) });
      await openSession(current.id, { activate: false });
      toast(clearQueue ? "已停止会话并清空队列" : "已停止会话，队列已保留");
      return;
    }
    const action = event.target.dataset.action; if (!action || !current) return;
    if (action === "cancel") { showStopSessionSheet(); return; }
    let body = {}; if (action === "rename") body.title = prompt("会话名称", current.title) || current.title; if (action === "delete" && !confirm("确认删除这个会话？\n\n部分 Agent 的桌面历史不能物理删除，会从手机列表隐藏。")) return;
    const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST", body: action === "delete" ? undefined : JSON.stringify(body) });
    if (["archive", "delete"].includes(action)) { current = null; page("sessions"); toast(action === "delete" && result?.hiddenOnly ? "已从手机列表移除" : action === "delete" ? "已删除" : "已归档"); return loadSessions(); } if (action === "fork" && result.sessionId) return openSession(result.sessionId); await openSession(current.id);
  } catch (error) { toast(error.message); }
});

$("#refresh").addEventListener("click", () => Promise.all([loadSessions(), loadApprovals()]).catch((error) => toast(error.message)));
$("#show-archive").addEventListener("click", async () => { archivedView = !archivedView; sessionDisplayLimit = SESSION_PAGE_SIZE; $("#show-archive").textContent = archivedView ? "最近" : "归档"; await loadSessions().catch((error) => toast(error.message)); });
$("#search").addEventListener("input", renderSessionList);
$("#session-switcher-search").addEventListener("input", renderSessionSwitcher);
for (const input of [$("#message"), $("#prompt")]) {
  input.addEventListener("input", () => { updateCommandPicker(input); if (input.id === "message") updateComposerQueueState(); });
  input.addEventListener("click", () => updateCommandPicker(input));
  input.addEventListener("keydown", commandPickerKeydown);
  input.addEventListener("blur", () => setTimeout(() => { if (!$("#command-picker").matches(":hover")) hideCommandPicker(); }, 120));
}
// Mobile browsers dispatch blur before click; retain focus until selection has
// inserted the command or Skill into the textarea.
$("#command-picker").addEventListener("pointerdown", (event) => event.preventDefault());
window.addEventListener("resize", () => { if (commandPickerState) positionCommandPicker(commandPickerState.input); });
window.addEventListener("popstate", () => {
  if (!$("#attachment-viewer").hidden) closeAttachmentViewer({ fromHistory: true });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#attachment-viewer").hidden) { event.preventDefault(); closeAttachmentViewer(); }
});
$("#back").addEventListener("click", async () => { current = null; page("sessions"); await loadSessions(); });
function renderComposerAttachments(items, preview, target = "active") {
  preview.hidden = !items.length;
  preview.innerHTML = items.map((file, index) => `<div class="attachment-chip">${file.kind === "image" ? `<img src="${escapeHtml(file.preview)}" alt="">` : `<span>${escapeHtml(attachmentIcon(file))}</span>`}<strong>${escapeHtml(file.name)}</strong><button type="button" data-remove-attachment="${index}" data-attachment-target="${target}" aria-label="移除附件">×</button></div>`).join("");
}
function renderAttachments() { renderComposerAttachments(activeAttachments, $("#attachment-preview")); }
async function selectAttachments(files, target = activeAttachments, preview = $("#attachment-preview"), targetName = "active") {
  const next = Array.from(files || []).slice(0, 8 - target.length);
  for (const file of next) {
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10MB 限制`);
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",").at(-1)); reader.onerror = reject; reader.readAsDataURL(file); });
    const image = file.type.startsWith("image/"); const text = file.type.startsWith("text/") || /\.(txt|md|json|ya?ml|js|ts|py|go|rs|java|c|cpp|h|css|html|sql|sh)$/i.test(file.name);
    target.push({ name: file.name, mimeType: file.type || "application/octet-stream", data, kind: image ? "image" : text ? "text" : "file", preview: image ? URL.createObjectURL(file) : "" });
  }
  renderComposerAttachments(target, preview, targetName);
  if (targetName === "active") updateComposerQueueState();
}
$("#attachment-input").addEventListener("change", async (event) => { try { await selectAttachments(event.target.files); } catch (error) { toast(error.message); } finally { event.target.value = ""; } });
$("#new-attachment-input").addEventListener("change", async (event) => { try { await selectAttachments(event.target.files, newAttachments, $("#new-attachment-preview"), "new"); } catch (error) { toast(error.message); } finally { event.target.value = ""; } });
$("#new-session").addEventListener("submit", async (event) => {
  event.preventDefault(); const submit = $("#new-submit"); submit.disabled = true;
  try {
    const cwd = selectedWorkspace; const promptText = $("#prompt").value.trim();
    if (!selectedAgent) throw new Error("请选择 Agent"); if (!cwd) throw new Error("请选择或输入工作区"); if (!promptText && !newAttachments.length) throw new Error("请输入任务或添加附件");
    const sent = newAttachments;
    const result = await api("/mobile/v1/sessions", { method: "POST", body: JSON.stringify({ agent: selectedAgent, cwd, model: $("#model-select").value, effort: $("#effort")?.value || "", permissionMode: $("#new-permission")?.value || "", prompt: promptText, attachments: sent.map(({ name, mimeType, data }) => ({ name, mimeType, data })), messageId: createClientMessageId() }) });
    newAttachments = []; renderComposerAttachments(newAttachments, $("#new-attachment-preview"), "new"); $("#prompt").value = ""; sent.forEach((file) => file.preview && URL.revokeObjectURL(file.preview)); await openSession(result.sessionId);
  } catch (error) { toast(error.message); } finally { submit.disabled = false; }
});
async function submitComposerMessage(deliveryMode = "") {
  const input = $("#message"); const text = input.value.trim(); if ((!text && !activeAttachments.length) || !current) return;
  const id = createClientMessageId(); const sentAttachments = activeAttachments; input.value = ""; activeAttachments = []; renderAttachments(); $("#send").disabled = true;
  $("#messages").insertAdjacentHTML("beforeend", renderMessage({ id, role: "user", text, attachments: sentAttachments })); $("#connection").textContent = "正在发送"; scrollMessages();
  try {
    const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/messages`, { method: "POST", body: JSON.stringify({ text, attachments: sentAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })), messageId: id, ...(deliveryMode ? { deliveryMode } : {}) }) });
    if (result.queued) { toast(result.deliveryMode === "guide" ? "已添加引导，当前步骤结束后优先执行" : "已加入排队指令"); await openSession(current.id, { activate: false }); }
    else $("#connection").textContent = "正在生成";
    input.blur();
  } catch (error) { document.querySelector(`[data-message-id="${id}"]`)?.classList.add("failed"); input.value = text; activeAttachments = sentAttachments; renderAttachments(); toast(error.message); }
  finally { $("#send").disabled = false; updateComposerQueueState(); }
}
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault(); if (!current) return;
  if (isSessionRunning() && !hasComposerContent()) { showStopSessionSheet(); return; }
  if (!hasComposerContent()) return;
  if (isSessionRunning() && preferences.conversationSendMode === "ask") { showMessageModeSheet(); return; }
  await submitComposerMessage(isSessionRunning() ? preferences.conversationSendMode : "");
});
$("#edit-pairing-link").addEventListener("click", async () => {
  if (!nativePairingEditAvailable()) {
    toast("请在 Android App 内使用此功能；浏览器版可撤销设备后重新打开新的配对链接");
    return;
  }
  if (!confirm("更换配对链接会清除本机授权，并回到配对输入页。继续吗？")) return;
  eventLoopStopped = true;
  try { await api("/mobile/v1/devices/self/revoke", { method: "POST" }); } catch {}
  persistToken("");
  localStorage.removeItem(CURSOR_KEY);
  window.SwitchyardNative.editPairingLink();
});
$("#revoke").addEventListener("click", async () => { if (!confirm("确定撤销这台手机的访问权限？")) return; await api("/mobile/v1/devices/self/revoke", { method: "POST" }); eventLoopStopped = true; persistToken(""); localStorage.removeItem(CURSOR_KEY); location.reload(); });

function bindSwipe() {
  let startX = 0; let startY = 0; let item = null; let locked = false;
  document.addEventListener("touchstart", (event) => {
    const target = event.target.closest(".swipe-item");
    if (!target) return;
    item = target; startX = event.touches[0].clientX; startY = event.touches[0].clientY; locked = false;
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (!item) return;
    const dx = event.touches[0].clientX - startX;
    const dy = event.touches[0].clientY - startY;
    if (!locked) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { item = null; return; }
      locked = true;
    }
    if (dx < -36) {
      document.querySelectorAll(".swipe-item.open").forEach((node) => { if (node !== item) node.classList.remove("open"); });
      item.classList.add("open");
    } else if (dx > 24) {
      item.classList.remove("open");
    }
  }, { passive: true });
  document.addEventListener("touchend", () => { item = null; locked = false; }, { passive: true });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".swipe-item")) closeAllSwipe();
  });
}

async function boot() {
  try {
    hideModelSheet(); bindSwipe(); await pair();
    if (!token) { $("#connection").textContent = "等待配对"; return; }
    // Sessions are the landing screen. Do not make their first paint wait for
    // workspaces, models, preferences, or the approval inbox.
    await loadSessions();
    void Promise.all([loadAgents(), loadWorkspaces(), loadApprovals(), loadPreferences()]).catch((error) => {
      $("#connection").textContent = "部分数据加载失败";
      console.warn("mobile background bootstrap failed", error);
    });
    connectEvents();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  } catch (error) { $("#connection").textContent = "连接失败"; toast(error.message); }
}
boot();

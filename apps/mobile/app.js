import { notificationStateLabel, parseStructuredNotification } from "./structured-notification.mjs?v=68";

const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "switchyard_mobile_token";
const CURSOR_KEY = "switchyard_mobile_event_cursor";
const PREFERENCES_KEY = "switchyard_mobile_preferences";
const GROUP_STATE_KEY = "switchyard_mobile_group_states";
const PINNED_PROJECTS_KEY = "switchyard_mobile_pinned_projects";
function hasNativeTokenStore() {
  try { return typeof window.SwitchyardNative?.getToken === "function"; } catch { return false; }
}
function nativeOpenExternalUrlAvailable() {
  try { return typeof window.SwitchyardNative?.openExternalUrl === "function"; } catch { return false; }
}
function openConversationLink(anchor) {
  const href = safeUrl(anchor?.href || "");
  if (!href) { toast("链接无效"); return; }
  if (nativeOpenExternalUrlAvailable()) {
    try { window.SwitchyardNative.openExternalUrl(href); return; } catch {}
  }
  window.open(href, "_blank", "noopener,noreferrer");
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
let sessionSelectionMode = false;
const selectedSessionIds = new Set();
let pendingDeleteSessionIds = [];
let mobileRefreshInProgress = false;
let pullRefreshStartY = null;
let pullRefreshStartX = null;
let pullRefreshDistance = 0;
function localStringSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || "[]").filter((value) => typeof value === "string")); } catch { return new Set(); }
}
function localGroupStates() {
  try { const value = JSON.parse(localStorage.getItem(GROUP_STATE_KEY) || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
}
let groupStates = localGroupStates();
const pinnedProjects = localStringSet(PINNED_PROJECTS_KEY);
function isGroupCollapsed(name) { return groupStates[name] === true; }
function setGroupCollapsed(name, collapsed) { groupStates[name] = Boolean(collapsed); localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groupStates)); }
function setProjectPinned(name, pinned) { if (pinned) pinnedProjects.add(name); else pinnedProjects.delete(name); localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...pinnedProjects])); }
function renameProjectPreferences(oldName, newName) {
  if (oldName === newName) return;
  if (Object.hasOwn(groupStates, oldName)) { groupStates[newName] = groupStates[oldName]; delete groupStates[oldName]; localStorage.setItem(GROUP_STATE_KEY, JSON.stringify(groupStates)); }
  if (pinnedProjects.delete(oldName)) { pinnedProjects.add(newName); localStorage.setItem(PINNED_PROJECTS_KEY, JSON.stringify([...pinnedProjects])); }
}
let eventLoopStopped = false;
let eventLoopRevoked = false;
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
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const commandCache = new Map();
let commandPickerState = null;
let commandRequestSeq = 0;
let preferences = { conversationSendMode: "ask", sync: true };
const LAST_TASK_KEY = "switchyard_mobile_last_task";
const THEME_KEY = "switchyard_mobile_theme";
const DENSITY_KEY = "switchyard_mobile_density";
const DENSITY_ORDER = ["comfortable", "compact"];
let unseenMessageCount = 0;
let activeApprovalId = "";
const THEME_ORDER = ["system", "light", "dark"];
function currentTheme() { const value = localStorage.getItem(THEME_KEY) || "system"; return THEME_ORDER.includes(value) ? value : "system"; }
function themeLabel(theme = currentTheme()) { return ({ system: "跟随系统", light: "浅色", dark: "深色" })[theme]; }
function currentDensity() { const value = localStorage.getItem(DENSITY_KEY) || "comfortable"; return DENSITY_ORDER.includes(value) ? value : "comfortable"; }
function densityLabel(value = currentDensity()) { return value === "compact" ? "紧凑" : "舒适"; }
function applyDensity() {
  document.documentElement.dataset.density = currentDensity();
  const label = $("#density-label"); if (label) label.textContent = densityLabel();
}
function applyTheme() {
  const theme = currentTheme();
  const resolved = theme === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolved === "dark" ? "#1b1915" : "#f7f4ef";
  const label = $("#theme-label"); if (label) label.textContent = themeLabel();
}
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (currentTheme() === "system") applyTheme(); });
function lastTaskPrefs() { try { return JSON.parse(localStorage.getItem(LAST_TASK_KEY) || "{}") || {}; } catch { return {}; } }
function rememberLastTask() {
  try { localStorage.setItem(LAST_TASK_KEY, JSON.stringify({ agent: selectedAgent, workspace: selectedWorkspace, model: $("#model-select")?.value || "" })); } catch {}
}

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
function setConnectionStatus(text, ok = true) {
  const el = $("#connection"); if (el) el.textContent = text;
  const detail = $("#detail-conn");
  if (detail) {
    const show = Boolean(text) && text !== "已安全连接";
    detail.hidden = !show;
    detail.textContent = show ? `· ${text}` : "";
    detail.classList.toggle("off", !ok);
  }
}
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
  // Without a timeout a slow desktop (large session reads) leaves the detail
  // page on skeletons forever; fail loudly so the user can retry instead.
  const timeoutMs = Number(options.timeoutMs) || 25_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("请求超时：桌面端可能正忙，请稍后重试");
      timeoutError.status = 0; timeoutError.code = "timeout";
      throw timeoutError;
    }
    const networkError = new Error("网络异常：与桌面端的连接被中断");
    networkError.status = 0; networkError.code = "network";
    throw networkError;
  } finally {
    clearTimeout(timer);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || body.error || `HTTP ${response.status}`);
    error.status = response.status; error.code = body.error || "";
    throw error;
  }
  setConnectionStatus("已安全连接");
  $("#connection-detail").textContent = "已连接";
  return body;
}

function page(name) {
  document.querySelector(".app-shell").dataset.page = name;
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.dataset.page === name));
  document.querySelectorAll("[data-tab]").forEach((element) => element.classList.toggle("active", element.dataset.tab === name));
  $("#session-menu").hidden = true;
  hideModelSheet();
  hideStopSessionSheet();
  hideMessageModeSheet();
  hideConversationBehaviorSheet();
  hideSessionDeleteSheet();
  closeInputSheet(null);
  if (name !== "sessions") { sessionSelectionMode = false; selectedSessionIds.clear(); }
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

function stopSessionQueueCount() { return Array.isArray(current?.queue) ? current.queue.length : 0; }
function renderStopSessionSheet() {
  const queueCount = stopSessionQueueCount();
  const queueNote = $("#stop-session-queue-note");
  const sessionName = current?.title || "此会话";
  $("#stop-session-name").textContent = sessionName;
  $("#stop-session-copy").textContent = queueCount
    ? "停止会中断正在执行的操作；你可以选择是否清空后续的排队指令。"
    : "停止后，正在执行的当前轮无法继续完成。";
  $("#stop-session-clear-label").textContent = queueCount ? `停止并清空 ${queueCount} 条队列` : "停止当前任务";
  $("#stop-session-clear-hint").textContent = queueCount ? "当前操作与排队指令都会被移除" : "中断正在执行的操作";
  queueNote.hidden = !queueCount;
  if (queueCount) $("#stop-session-queue-copy").textContent = `有 ${queueCount} 条排队指令等待执行。保留队列后，可稍后回到此会话继续。`;
  $(".stop-session-keep").hidden = !queueCount;
}
function showStopSessionSheet() {
  const sheet = $("#stop-session-sheet");
  renderStopSessionSheet();
  sheet.hidden = false;
  sheet.setAttribute("aria-hidden", "false");
  sheet.style.display = "flex";
}

let inputSheetResolver = null;
function showInputSheet({ title = "输入", description = "", value = "", confirmLabel = "确定", mode = "input", danger = false } = {}) {
  return new Promise((resolve) => {
    inputSheetResolver = resolve;
    $("#input-sheet-title").textContent = title;
    $("#input-sheet-description").textContent = description;
    const sheet = $("#input-sheet");
    sheet.classList.toggle("danger", danger);
    $("#confirm-input-sheet").textContent = confirmLabel;
    const text = $("#input-sheet-text");
    text.hidden = mode !== "input";
    text.value = value;
    setSheetVisible("#input-sheet", true);
    if (mode === "input") setTimeout(() => { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }, 60);
  });
}
function closeInputSheet(result) {
  if (!inputSheetResolver) { setSheetVisible("#input-sheet", false); return; }
  const resolve = inputSheetResolver; inputSheetResolver = null;
  setSheetVisible("#input-sheet", false);
  resolve(result);
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
  const selected = selectedSessionIds.has(session.id);
  const tag = running ? '<span class="tag tag-run">运行中</span>' : waiting ? '<span class="tag tag-wait">待审批</span>' : session.state === "failed" ? '<span class="tag tag-fail">已失败</span>' : `<span class="tag tag-agent">${escapeHtml(agentLabel(session.agent).replace(" Build", "").replace(" Code", "").toUpperCase())}</span>`;
  const pinned = session.pinned ? '<span class="session-pinned" aria-label="已置顶">⌖</span>' : "";
  const row = `<button class="session-row${sessionSelectionMode ? " selection-mode" : ""} swipe-content" data-state="${escapeHtml(session.state)}" data-id="${escapeHtml(session.id)}" type="button">${sessionSelectionMode ? `<span class="session-select-indicator${selected ? " selected" : ""}" data-session-select="${escapeHtml(session.id)}" aria-label="${selected ? "取消选择" : "选择"}">${selected ? "✓" : ""}</span>` : ""}<span class="session-copy"><span class="session-title">${escapeHtml(session.title)}</span><span class="session-subtitle">${escapeHtml(agentLabel(session.agent))}${session.model ? ` · ${escapeHtml(session.model)}` : ""}</span></span><span class="session-meta">${pinned}<time>${formatSessionTime(session.updatedAt)}</time>${tag}</span></button>`;
  if (sessionSelectionMode) return `<div class="session-select-item">${row}</div>`;
  return `<div class="swipe-item" data-swipe-id="${escapeHtml(session.id)}"><div class="swipe-actions"><button type="button" class="swipe-btn pin" data-session-action="pin" data-pinned="${session.pinned ? "true" : "false"}" data-id="${escapeHtml(session.id)}">${session.pinned ? "取消置顶" : "置顶"}</button><button type="button" class="swipe-btn rename" data-session-action="rename" data-id="${escapeHtml(session.id)}">重命名</button><button type="button" class="swipe-btn archive" data-session-action="archive" data-id="${escapeHtml(session.id)}">${archivedView ? "取消归档" : "归档"}</button><button type="button" class="swipe-btn danger" data-session-action="delete" data-id="${escapeHtml(session.id)}">删除</button></div>${row}</div>`;
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

function renderSessionSelectionControls() {
  const toggle = $("#session-select-toggle");
  const bar = $("#session-selection-bar");
  const count = $("#session-selection-count");
  const remove = $("#session-selection-delete");
  if (!toggle || !bar || !count || !remove) return;
  toggle.textContent = sessionSelectionMode ? "取消" : "选择";
  toggle.classList.toggle("active", sessionSelectionMode);
  bar.hidden = !sessionSelectionMode;
  count.textContent = `已选 ${selectedSessionIds.size} 个`;
  remove.disabled = selectedSessionIds.size === 0;
}

function setSessionSelectionMode(active) {
  sessionSelectionMode = active;
  if (!active) selectedSessionIds.clear();
  closeAllSwipe();
  renderSessionList();
}

function toggleSessionSelection(id) {
  if (selectedSessionIds.has(id)) selectedSessionIds.delete(id); else selectedSessionIds.add(id);
  renderSessionList();
}

function escapeRegExp(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
let contentSearchSeq = 0;
let contentSearchTimer = null;
function scheduleContentSearch(query) {
  clearTimeout(contentSearchTimer);
  contentSearchSeq += 1;
  document.querySelector(".content-search")?.remove();
  if (query.length >= 2) contentSearchTimer = setTimeout(() => renderContentHits(query), 300);
}
async function renderContentHits(query) {
  const seq = ++contentSearchSeq;
  let hits = [];
  try { hits = await api(`/mobile/v1/sessions/search?q=${encodeURIComponent(query)}`); } catch { return; }
  if (seq !== contentSearchSeq) return;
  document.querySelector(".content-search")?.remove();
  if (!Array.isArray(hits) || !hits.length) return;
  const pattern = new RegExp(`(${escapeRegExp(escapeHtml(query))})`, "gi");
  const rows = hits.map((hit) => {
    const snippet = escapeHtml(hit.snippet || "");
    return `<button type="button" class="content-hit" data-open-session="${escapeHtml(hit.id)}"><span class="ch-title">${escapeHtml(hit.title || "会话")}</span><span class="ch-snippet">${snippet.replace(pattern, "<em>$1</em>")}</span><span class="ch-meta">${escapeHtml(agentLabel(hit.agent))}${hit.project ? ` · ${escapeHtml(hit.project)}` : ""}${hit.matchCount > 1 ? ` · ${hit.matchCount} 处匹配` : ""}</span></button>`;
  }).join("");
  $("#session-list").insertAdjacentHTML("beforeend", `<div class="content-search"><div class="content-search-head">消息内容匹配</div>${rows}</div>`);
}
function renderSessionList() {
  const knownIds = new Set(allSessions.map((session) => session.id));
  for (const id of selectedSessionIds) if (!knownIds.has(id)) selectedSessionIds.delete(id);
  renderSessionSelectionControls();
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
      if (pinnedProjects.has(a[0]) !== pinnedProjects.has(b[0])) return pinnedProjects.has(a[0]) ? -1 : 1;
      const latest = (items) => Math.max(...items.map((item) => Date.parse(item.updatedAt || 0) || 0));
      return latest(b[1]) - latest(a[1]);
    });
    $("#session-list").innerHTML = sorted.map(([name, items]) => {
      const collapsed = isGroupCollapsed(name);
      const hasRunning = items.some((item) => ["running", "queued"].includes(item.state));
      const workspace = workspaces.find((item) => item.name === name);
      const path = workspace?.path || workspace?.id || "";
      const projectPinned = pinnedProjects.has(name);
      const actions = `<div class="group-menu-wrap"><button type="button" class="group-more" data-workspace-menu aria-label="管理项目">··</button><div class="group-menu" hidden><button type="button" data-project-pin="${escapeHtml(name)}" data-pinned="${projectPinned ? "true" : "false"}">${projectPinned ? "取消置顶项目" : "置顶项目"}</button>${path ? `<button type="button" data-workspace-rename="${escapeHtml(path)}" data-workspace-name="${escapeHtml(name)}">重命名</button><button type="button" class="danger-text" data-workspace-delete="${escapeHtml(path)}">删除</button>` : ""}</div></div>`;
      return `<div class="workspace-group${collapsed ? " collapsed" : ""}${projectPinned ? " pinned-project" : ""}"><div class="group-title-row"><button class="group-head" type="button" data-group="${escapeHtml(name)}">${icon("folder")}<span class="group-name">${projectPinned ? '<span class="project-pinned" aria-label="项目已置顶">⌖</span>' : ""}${escapeHtml(name)}</span>${hasRunning ? '<i class="group-live"></i>' : ""}<span class="group-count">${items.length}</span><svg class="group-chevron" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></button>${actions}</div><div class="group-items">${items.map(sessionRowHtml).join("")}</div></div>`;
    }).join("");
  }
  const hasMore = matchingRows.length > rows.length;
  if (hasMore) {
    $("#session-list").insertAdjacentHTML("beforeend", `<button id="load-more-sessions" class="load-more-sessions" type="button">显示更多会话（已显示 ${rows.length}/${matchingRows.length}）</button>`);
  }
  scheduleContentSearch(query);
  renderStatusSummary();
}

function renderStatusSummary() {
  const strip = $("#status-strip");
  const running = allSessions.filter((session) => ["running", "queued"].includes(session.state)).length;
  const waiting = pendingApprovals.length;
  if (!running && !waiting) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = `${running ? `<button type="button" class="status-strip-action" data-open-active-sessions><span class="spin"></span><span>${running} 个任务正在运行</span><span class="status-strip-arrow">›</span></button>` : ""}${running && waiting ? '<span class="status-strip-divider">·</span>' : ""}${waiting ? `<button type="button" class="status-strip-action status-strip-approvals" data-open-approvals><b>${waiting} 个等待你审批</b><span class="status-strip-arrow">›</span></button>` : ""}`;
}

function requestSessionDeletion(ids) {
  const uniqueIds = [...new Set(ids || [])].filter(Boolean);
  if (!uniqueIds.length) return;
  pendingDeleteSessionIds = uniqueIds;
  const count = uniqueIds.length;
  $("#session-delete-title").textContent = count === 1 ? "删除会话" : `删除 ${count} 个会话`;
  $("#session-delete-description").textContent = count === 1
    ? "部分 Agent 的桌面历史无法物理删除，仍会从手机列表移除。"
    : "将逐个删除所选会话。部分 Agent 的桌面历史无法物理删除，仍会从手机列表移除。";
  $("#confirm-session-delete").textContent = count === 1 ? "删除会话" : `删除 ${count} 个会话`;
  setSheetVisible("#session-delete-sheet", true);
}

function hideSessionDeleteSheet() {
  pendingDeleteSessionIds = [];
  setSheetVisible("#session-delete-sheet", false);
}

async function confirmSessionDeletion() {
  const ids = [...pendingDeleteSessionIds];
  if (!ids.length) return;
  const confirmButton = $("#confirm-session-delete");
  confirmButton.disabled = true;
  confirmButton.textContent = "正在删除…";
  try {
    const results = await Promise.allSettled(ids.map(async (id) => ({ id, result: await api(`/mobile/v1/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }) })));
    const successful = results.filter((entry) => entry.status === "fulfilled");
    const hiddenOnly = successful.filter((entry) => entry.value.result?.hiddenOnly).length;
    const failed = results.length - successful.length;
    for (const id of ids) selectedSessionIds.delete(id);
    if (current && successful.some((entry) => entry.value.id === current.id)) { current = null; page("sessions"); }
    hideSessionDeleteSheet();
    await loadSessions();
    if (successful.length) toast(failed ? `已处理 ${successful.length} 个会话，${failed} 个删除失败` : hiddenOnly === successful.length ? `已从手机列表移除 ${successful.length} 个会话` : `已删除 ${successful.length} 个会话`);
    else toast("删除失败，请稍后重试");
  } finally {
    confirmButton.disabled = false;
    confirmButton.textContent = ids.length === 1 ? "删除会话" : `删除 ${ids.length} 个会话`;
  }
}

async function refreshMobileData({ feedback = true, refreshCurrent = true } = {}) {
  if (mobileRefreshInProgress) return;
  mobileRefreshInProgress = true;
  const button = $("#refresh");
  button?.classList.add("is-refreshing");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
  try {
    await Promise.all([loadSessions(), loadApprovals()]);
    if (refreshCurrent && current) await openSession(current.id, { activate: false });
    if (feedback) toast("已刷新");
  } catch (error) {
    toast(error.message);
  } finally {
    mobileRefreshInProgress = false;
    button?.classList.remove("is-refreshing");
    if (button) { button.disabled = false; button.removeAttribute("aria-busy"); }
  }
}

function setPullRefreshState(distance = 0, refreshing = false) {
  const target = $("#pull-to-refresh");
  if (!target) return;
  target.classList.toggle("visible", distance > 0 || refreshing);
  target.classList.toggle("ready", distance >= 72 && !refreshing);
  target.classList.toggle("refreshing", refreshing);
  target.querySelector("span:last-child").textContent = refreshing ? "正在刷新…" : distance >= 72 ? "松开即可刷新" : "下拉刷新";
}

function setupPullToRefresh() {
  document.addEventListener("touchstart", (event) => {
    if (!$(".page[data-page=\"sessions\"]")?.classList.contains("active") || window.scrollY > 0 || event.touches.length !== 1) return;
    pullRefreshStartY = event.touches[0].clientY;
    pullRefreshStartX = event.touches[0].clientX;
    pullRefreshDistance = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (event) => {
    if (pullRefreshStartY === null) return;
    const dy = event.touches[0].clientY - pullRefreshStartY;
    // Horizontal-dominant gestures belong to swipe actions, not pull-to-refresh.
    if (Math.abs(event.touches[0].clientX - pullRefreshStartX) > Math.abs(dy)) { pullRefreshStartY = null; setPullRefreshState(); return; }
    pullRefreshDistance = Math.max(0, Math.min(96, dy));
    setPullRefreshState(pullRefreshDistance);
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (pullRefreshStartY === null) return;
    const shouldRefresh = pullRefreshDistance >= 72;
    pullRefreshStartY = null;
    pullRefreshDistance = 0;
    if (!shouldRefresh) return setPullRefreshState();
    setPullRefreshState(0, true);
    refreshMobileData().finally(() => setPullRefreshState());
  }, { passive: true });
}

function approvalCardHtml(approval, { sessionScoped = false } = {}) {
  const session = allSessions.find((item) => item.id === approval.sessionId);
  const title = sessionScoped ? "需要授权才能继续" : session?.title || approval.title || "待审批任务";
  const summary = approval.summary || "Agent 正在等待你的决定";
  return `<article class="approval-card" data-approval-card="${escapeHtml(approval.id)}"><button type="button" class="approval-strip" data-approval-open="${escapeHtml(approval.id)}"><span class="approval-mark" aria-hidden="true">!</span><span><b>${escapeHtml(title)}</b><small>${escapeHtml(summary)}</small></span><em>查看</em></button></article>`;
}
function approvalById(id) { return pendingApprovals.find((approval) => approval.id === id) || null; }
function renderApprovalSheet() {
  const approval = approvalById(activeApprovalId); const host = $("#approval-sheet-content");
  if (!host) return;
  if (!approval) { host.innerHTML = '<div class="empty">此授权请求已处理。</div>'; return; }
  const session = allSessions.find((item) => item.id === approval.sessionId);
  const title = session?.title || approval.title || "待审批操作";
  const detail = approval.detail?.content ? `<section class="approval-detail"><span>${escapeHtml(approval.detail.label || "请求内容")}</span><pre>${escapeHtml(approval.detail.content)}</pre></section>` : "";
  host.innerHTML = `<section class="approval-sheet-copy"><span class="approval-kicker">需要你的确认</span><strong>${escapeHtml(title)}</strong><p>${escapeHtml(approval.summary || "Agent 正在等待你的决定")}</p>${detail}</section><div class="approval-sheet-actions"><button type="button" data-approval="${escapeHtml(approval.id)}" data-decision="deny_once">拒绝</button><button type="button" class="allow" data-approval="${escapeHtml(approval.id)}" data-decision="allow_once">允许一次</button></div>`;
}
function showApprovalSheet(id) { activeApprovalId = id; renderApprovalSheet(); setSheetVisible("#approval-sheet", true); }
function hideApprovalSheet() { activeApprovalId = ""; setSheetVisible("#approval-sheet", false); }
function renderApprovalInbox() {
  $("#approval-inbox").innerHTML = pendingApprovals.map((approval) => approvalCardHtml(approval)).join("");
  const sessionInbox = $("#session-approval-inbox");
  if (!sessionInbox) return;
  const currentApprovals = current ? pendingApprovals.filter((approval) => approval.sessionId === current.id) : [];
  sessionInbox.innerHTML = currentApprovals.map((approval) => approvalCardHtml(approval, { sessionScoped: true })).join("");
  sessionInbox.hidden = !currentApprovals.length;
  if (activeApprovalId && !approvalById(activeApprovalId)) hideApprovalSheet();
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
  if (!selectedWorkspace) {
    const last = lastTaskPrefs();
    if (last.workspace && workspaces.some((item) => item.id === last.workspace || item.path === last.workspace)) selectedWorkspace = last.workspace;
    else if (rows[0]) selectedWorkspace = rows[0].id;
  }
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
// Codex desktop emits `::name{...}` lines as client-side UI directives. They are not
// user-facing content, so clients that do not support them must omit them rather than
// rendering the raw protocol (or the redacted `[LOCAL_PATH]` placeholder).
const INTERNAL_UI_DIRECTIVE = /^::[a-z][a-z0-9-]*\{[^\r\n]*\}\s*$/i;
function stripInternalUiDirectives(value) {
  return String(value || "").split(/\r?\n/)
    .filter((line) => !INTERNAL_UI_DIRECTIVE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
function renderRichText(value) {
  const cacheKey = String(value || "");
  const cachedHtml = richTextCache.get(cacheKey);
  if (cachedHtml !== undefined) return cachedHtml;
  const source = cacheKey.replace(/\r/g, ""); const chunks = source.split(/```([^\n]*)\n?([\s\S]*?)```/g); const output = [];
  for (let i = 0; i < chunks.length; i += 3) {
    const prose = stripInternalUiDirectives(chunks[i] || "");
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
function formatDuration(durationMs) {
  const ms = Number(durationMs || 0); if (!Number.isFinite(ms) || ms <= 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}
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
function assetSourceLabel(asset = {}) {
  if (asset.source === "delivery") return "本轮交付";
  if (asset.source === "upload") return "手机上传";
  if (asset.activity === "edit") return "Agent 修改";
  return "相关文件";
}
function assetMetadataLabel(asset = {}) {
  const size = asset.byteLength ? `${Math.ceil(asset.byteLength / 1024)} KB` : "";
  const source = assetSourceLabel(asset);
  return [source, size].filter(Boolean).join(" · ") || "点击打开";
}
function renderAttachment(asset = {}, { delivered = false } = {}) {
  const image = asset.kind === "image" || String(asset.mimeType || "").startsWith("image/");
  const open = asset.id ? `data-attachment-open="${escapeHtml(asset.id)}"` : asset.preview ? `data-attachment-preview="${escapeHtml(asset.preview)}"` : "";
  const metadata = `data-asset-name="${escapeHtml(asset.name || "文件")}" data-asset-mime="${escapeHtml(asset.mimeType || "application/octet-stream")}" data-asset-kind="${escapeHtml(asset.kind || "file")}" data-asset-source="${escapeHtml(asset.source || "")}"`;
  const deliveryClass = delivered ? " delivered-file" : "";
  return image
    ? `<button type="button" class="message-attachment image${deliveryClass}" ${open} ${metadata}><img ${asset.preview ? `src="${escapeHtml(asset.preview)}"` : ""} data-asset-image="${escapeHtml(asset.id || "")}" alt="${escapeHtml(asset.name || "图片")}"><span>${escapeHtml(asset.name || "图片")}</span></button>`
    : `<button type="button" class="message-attachment file${deliveryClass}" ${open} ${metadata}><i>${escapeHtml(attachmentIcon(asset))}</i><span><strong>${escapeHtml(asset.name || "文件")}</strong><small>${escapeHtml(assetMetadataLabel(asset))}</small></span></button>`;
}
function renderMessageAttachments(attachments = []) {
  if (!attachments.length) return "";
  return `<div class="message-attachments">${attachments.map((asset) => renderAttachment(asset)).join("")}</div>`;
}
function renderDeliveredFile(delivery) {
  if (!delivery?.id) return "";
  const timestamp = delivery.deliveryAt || delivery.createdAt;
  const at = timestamp ? new Date(timestamp).toLocaleString() : "刚刚";
  return `<section class="delivered-file" aria-label="本轮交付"><div class="produced-files-head"><span>本轮交付</span><small>${escapeHtml(at)}</small></div><div class="message-attachments">${renderAttachment(delivery, { delivered: true })}</div></section>`;
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
const TOOL_ROW_ICONS = { read: "读", search: "⌕", edit: "✎", command: "›_", other: "⚙" };

function isPlanToolMessage(message) {
  const name = String(message?.tool?.name || "");
  return /^update[_-]?plan$/i.test(name);
}

function parsePlanArguments(tool) {
  try {
    const parsed = JSON.parse(String(tool?.arguments || ""));
    const plan = parsed?.plan || parsed?.steps;
    if (!Array.isArray(plan) || !plan.length) return null;
    const items = plan.map((item) => ({
      step: String(item?.step || item?.title || item?.task || "").trim(),
      status: String(item?.status || "pending").toLowerCase()
    })).filter((item) => item.step);
    return items.length ? items : null;
  } catch { return null; }
}

function planItemState(status) {
  if (["completed", "done", "complete"].includes(status)) return "done";
  if (["in_progress", "running", "doing", "active"].includes(status)) return "doing";
  return "todo";
}
function planProgress(plan = []) {
  const done = plan.filter((item) => planItemState(item.status) === "done").length;
  const activeIndex = plan.findIndex((item) => planItemState(item.status) === "doing");
  const currentIndex = activeIndex >= 0 ? activeIndex : Math.min(plan.length - 1, Math.max(0, done));
  return { done, activeIndex, currentIndex, current: plan[currentIndex] || plan[0] };
}
function patchStats(messages = []) {
  const files = new Set(); let adds = 0; let dels = 0;
  for (const message of messages) {
    const tool = message?.tool || {};
    for (const file of tool.files || []) {
      const id = file?.id || file?.path || file?.name;
      if (id) files.add(id);
    }
    const patch = parseEditPatch(tool.arguments) || parseEditPatch(tool.output) || tool.patchStats;
    if (patch) { adds += patch.adds || 0; dels += patch.dels || 0; }
  }
  return { files: files.size, adds, dels };
}
function executionState(plan, tools = []) {
  if (tools.some((message) => message.tool?.status === "failed")) return "failed";
  if (tools.some((message) => ["running", "pending", "waiting_for_approval"].includes(message.tool?.status))) return "running";
  if (plan.some((item) => planItemState(item.status) === "doing")) return "running";
  return plan.length && plan.every((item) => planItemState(item.status) === "done") ? "completed" : "idle";
}
function renderExecutionCard(message, tools = [], key = "") {
  const plan = parsePlanArguments(message?.tool);
  if (!plan) return renderToolItem(message, key);
  const progress = planProgress(plan); const stats = patchStats(tools); const state = executionState(plan, tools);
  const changes = [
    stats.files ? `${stats.files} 个文件已更改` : "",
    stats.adds ? `+${stats.adds}` : "",
    stats.dels ? `−${stats.dels}` : ""
  ].filter(Boolean).join(" · ");
  const activity = tools.length ? toolActivitySummary(tools) : "正在规划下一步";
  const items = plan.map((item, index) => {
    const cls = planItemState(item.status);
    return `<div class="execution-plan-item ${cls}"><span>${cls === "done" ? "✓" : cls === "doing" ? "" : String(index + 1)}</span><b>${escapeHtml(item.step)}</b></div>`;
  }).join("");
  const rawPlan = encodeURIComponent(String(message?.tool?.arguments || ""));
  const label = state === "failed" ? "执行遇到问题" : state === "completed" ? "计划已完成" : "正在执行";
  return `<details class="execution-card ${state}" data-message-key="${escapeHtml(key)}" data-tool-id="${escapeHtml(message?.tool?.id || "")}" data-plan-raw="${escapeHtml(rawPlan)}"${state === "running" ? " open" : ""}><summary><span class="execution-icon">${state === "failed" ? "!" : state === "completed" ? "✓" : "○"}</span><span class="execution-copy"><b>${escapeHtml(label)}</b><strong>${escapeHtml(progress.current?.step || "正在准备下一步")}</strong><small>${escapeHtml(activity)}</small></span><span class="execution-progress">${progress.currentIndex + 1}/${plan.length}<i>⌄</i></span></summary>${changes ? `<div class="execution-stats"><span>第 ${progress.currentIndex + 1} / ${plan.length} 步</span><b>${escapeHtml(changes)}</b></div>` : ""}<div class="execution-plan">${items}</div></details>`;
}
function renderPlanCard(message, key) {
  return renderExecutionCard(message, [], key);
}
function refreshLiveExecutionCard(work) {
  const card = work?.querySelector(".execution-card[data-plan-raw]");
  if (!card) return;
  try {
    const argumentsText = decodeURIComponent(card.dataset.planRaw || "");
    const tools = [...work.querySelectorAll(".tl")].map((item) => ({
      tool: { activity: item.dataset.toolActivity || "other", status: item.dataset.toolStatus || "completed", title: item.dataset.toolTitle || "", name: item.dataset.toolTitle || "", files: Array.from({ length: Number(item.dataset.toolFiles || 0) }), patchStats: { adds: Number(item.dataset.toolAdds || 0), dels: Number(item.dataset.toolDels || 0) } }
    }));
    const message = { tool: { id: card.dataset.toolId || "", name: "update_plan", arguments: argumentsText } };
    card.outerHTML = renderExecutionCard(message, tools, card.dataset.messageKey || "live-plan");
  } catch {}
}

// Parse Codex apply_patch blocks and standard unified diffs into row models
// for the diff card. Returns null when the source is not a recognizable patch.
function parseEditPatch(source) {
  const text = String(source || "");
  if (!text) return null;
  if (text.includes("*** Begin Patch")) {
    const fileMatch = text.match(/\*\*\* (?:Update File|Add File|Delete File): (.+)/);
    const fileCount = (text.match(/\*\*\* (?:Update File|Add File|Delete File): /g) || []).length;
    let adds = 0; let dels = 0; const rows = [];
    for (const line of text.split("\n")) {
      if (line.startsWith("***")) continue;
      if (line.startsWith("@@")) { rows.push({ type: "hunk", text: line }); continue; }
      if (line.startsWith("+")) { adds += 1; rows.push({ type: "add", text: line.slice(1) }); }
      else if (line.startsWith("-")) { dels += 1; rows.push({ type: "del", text: line.slice(1) }); }
      else if (line.startsWith(" ")) rows.push({ type: "ctx", text: line.slice(1) });
    }
    if (!adds && !dels && !rows.length) return null;
    return { fileName: (fileMatch?.[1] || "修改内容").trim() + (fileCount > 1 ? ` 等 ${fileCount} 个文件` : ""), adds, dels, rows: rows.slice(0, 240) };
  }
  if (/^--- /m.test(text) && /^\+\+\+ /m.test(text)) {
    let adds = 0; let dels = 0; const rows = []; let fileName = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("+++ ")) { fileName = line.slice(4).replace(/^[ab]\//, "").trim(); continue; }
      if (line.startsWith("--- ") || line.startsWith("index ")) continue;
      if (line.startsWith("@@")) { rows.push({ type: "hunk", text: line }); continue; }
      if (line.startsWith("+")) { adds += 1; rows.push({ type: "add", text: line.slice(1) }); }
      else if (line.startsWith("-")) { dels += 1; rows.push({ type: "del", text: line.slice(1) }); }
      else if (line.startsWith(" ")) rows.push({ type: "ctx", text: line.slice(1) });
    }
    if (!adds && !dels) return null;
    return { fileName: fileName || "修改内容", adds, dels, rows: rows.slice(0, 240) };
  }
  return null;
}

function renderDiffCard(patch) {
  const rows = patch.rows.map((row) => {
    if (row.type === "hunk") return `<tr class="hunk"><td colspan="2">${escapeHtml(row.text)}</td></tr>`;
    const ln = row.type === "add" ? "+" : row.type === "del" ? "−" : " ";
    return `<tr class="${row.type}"><td class="ln">${ln}</td><td>${escapeHtml(row.text)}</td></tr>`;
  }).join("");
  const stat = `${patch.adds ? `<span class="plus">+${patch.adds}</span>` : ""}${patch.dels ? ` <span class="minus">−${patch.dels}</span>` : ""}`;
  return `<div class="diff" data-diff><div class="diff-head"><span class="fname">${escapeHtml(patch.fileName || "修改内容")}</span><span class="stat">${stat}</span></div><div class="diff-controls"><button type="button" data-diff-filter="all" class="selected">全部</button><button type="button" data-diff-filter="changes">仅变更</button><button type="button" data-diff-context-toggle>折叠未变内容</button></div><div class="diff-table-wrap"><table>${rows}</table></div></div>`;
}

function toolRowSubtitle(tool, activity) {
  const status = tool.status || "completed";
  if (status === "running" || status === "pending") return "正在执行…";
  if (status === "waiting_for_approval") return "等待你的授权";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return firstLine(tool.error).slice(0, 90) || "执行失败";
  const files = Array.isArray(tool.files) ? tool.files : [];
  const pathOf = (file) => file?.path || file?.name || "";
  if (activity === "edit" && files.length) return pathOf(files[0]) ? String(pathOf(files[0])).split("/").pop() : "已修改";
  if (activity === "read" && files.length > 1) return `${files.length} 个文件`;
  if (activity === "read" && files.length === 1) return String(pathOf(files[0])).split("/").pop() || "已读取";
  const outputLine = firstLine(tool.output).slice(0, 90);
  return outputLine || "已完成";
}

function renderToolDetail(message, activity, patch) {
  const tool = message.tool || {};
  const assetFiles = (Array.isArray(tool.files) ? tool.files : []).filter((file) => file?.id);
  const filesHtml = assetFiles.length ? renderToolFiles(assetFiles) : "";
  if (activity === "command") {
    const command = String(tool.command || "").trim();
    const output = String(tool.output || "").trim();
    const error = String(tool.error || "").trim();
    if (!command && !output && !error) return '<div class="pv"><pre>Agent 未提供命令或输出详情</pre></div>';
    const duration = formatDuration(tool.durationMs);
    const exit = Number.isFinite(Number(tool.exitCode)) ? `退出码 ${tool.exitCode}` : "";
    const copyCommand = command ? `<button type="button" data-copy-value="${encodeURIComponent(command)}">复制命令</button>` : "";
    const copyOutput = (output || error) ? `<button type="button" data-copy-value="${encodeURIComponent(error || output)}">复制${error ? "错误" : "输出"}</button>` : "";
    const text = error || output;
    const preview = text.length > 2200 ? `${text.slice(0, 1500)}
…（已折叠 ${text.length - 2000} 字）…
${text.slice(-500)}` : text;
    return `<div class="term">${command ? `<div class="term-cmd"><span class="ps">$</span><span>${escapeHtml(command)}</span></div>` : ""}${text ? `<pre class="term-out">${error ? `<span class="err">${escapeHtml(preview)}</span>` : escapeHtml(preview)}</pre>` : ""}<div class="term-foot"><span>${escapeHtml([toolStatusLabel(tool.status), duration, exit].filter(Boolean).join(" · "))}</span><span class="term-actions">${copyCommand}${copyOutput}</span></div></div>`;
  }
  if (activity === "edit" && patch) return renderDiffCard(patch) + filesHtml;
  const blocks = [];
  const head = activity === "read" ? "读取内容" : activity === "search" ? "搜索结果" : activity === "edit" ? "修改内容" : "详情";
  const text = String(tool.output || "").trim() || String(tool.error || "").trim() || String(tool.arguments || "").trim() || String(tool.command || "").trim();
  if (text) blocks.push(`<div class="pv"><div class="pv-head">${escapeHtml(head)}</div><pre>${escapeHtml(text.slice(0, 5000))}</pre></div>`);
  blocks.push(filesHtml);
  return blocks.join("") || '<div class="pv"><pre>Agent 未提供命令或参数详情</pre></div>';
}

function renderToolItem(message, key, position = "") {
  const tool = message.tool || {}; const status = tool.status || "completed";
  const activity = toolActivity(message);
  const title = tool.title || tool.name || firstLine(message.text) || "工具调用";
  const patch = activity === "edit" ? parseEditPatch(tool.arguments) : null;
  const duration = formatDuration(tool.durationMs);
  const stateHtml = (status === "running" || status === "pending") ? '<span class="spin"></span>'
    : status === "failed" ? '<span class="no">✕</span>'
    : status === "waiting_for_approval" ? '<span class="wait">!</span>'
    : patch && (patch.adds || patch.dels) ? `${patch.adds ? `<span class="badge">+${patch.adds}</span>` : ""}${patch.dels ? `<span class="badge minus">−${patch.dels}</span>` : ""}`
    : '<span class="ok">✓</span>';
  const rowClass = `tl${status === "failed" ? " failed" : ""}${status === "running" || status === "pending" ? " running" : ""}${status === "failed" ? " open" : ""}`;
  return `<div class="${rowClass}" data-message-key="${escapeHtml(key)}" data-tool-id="${escapeHtml(tool.id || "")}" data-tool-status="${escapeHtml(status)}" data-tool-activity="${escapeHtml(activity)}" data-tool-title="${escapeHtml(title)}" data-tool-files="${Number(tool.files?.length || 0)}" data-tool-adds="${Number(patch?.adds || 0)}" data-tool-dels="${Number(patch?.dels || 0)}"><div class="tl-row"><span class="tl-ic ${escapeHtml(activity)}">${escapeHtml(TOOL_ROW_ICONS[activity] || TOOL_ROW_ICONS.other)}</span><span class="tl-main"><span class="tl-title${activity === "command" ? " mono" : ""}">${escapeHtml(title)}</span><span class="tl-sub">${escapeHtml(toolRowSubtitle(tool, activity))}</span></span><span class="tl-state">${duration ? `<span class="dur">${escapeHtml(duration)}</span>` : ""}${stateHtml}</span></div><div class="tl-detail">${renderToolDetail(message, activity, patch)}</div></div>`;
}
function aggregateToolStatus(messages = []) {
  const statuses = messages.map((message) => message.tool?.status || "completed");
  return ["failed", "waiting_for_approval", "running", "pending", "cancelled"].find((status) => statuses.includes(status)) || "completed";
}
function workPhase(message) {
  const activity = toolActivity(message);
  if (["read", "search"].includes(activity)) return { id: "explore", label: "探索" };
  if (activity === "edit") return { id: "modify", label: "修改" };
  if (activity === "command") return { id: "verify", label: "验证" };
  return { id: "execute", label: "执行" };
}
function summarizeWork(messages = []) {
  const tools = messages.filter(isToolMessage); const counts = { read: 0, search: 0, edit: 0, command: 0, other: 0 };
  tools.forEach((message) => { counts[toolActivity(message)] += 1; });
  const changedFiles = new Set(tools.filter((message) => toolActivity(message) === "edit").flatMap((message) => (message.tool?.files || []).map((file) => file.id || file.path || file.name).filter(Boolean))).size;
  const failed = tools.filter((message) => message.tool?.status === "failed").length;
  const running = tools.some((message) => ["running", "pending", "waiting_for_approval"].includes(message.tool?.status));
  const tested = counts.command;
  const duration = tools.reduce((total, message) => total + Math.max(0, Number(message.tool?.durationMs || 0)), 0);
  const parts = [];
  if (changedFiles || counts.edit) parts.push(`修改 ${changedFiles || counts.edit} 个文件`);
  if (tested) parts.push(`验证 ${tested} 项`);
  if (!parts.length && tools.length) parts.push(`完成 ${tools.length} 项操作`);
  if (duration) parts.push(`耗时 ${formatDuration(duration)}`);
  if (failed) return { state: "failed", text: `验证未通过 · ${failed} 个操作失败`, detail: parts.join(" · ") };
  if (running) return { state: "running", text: "正在处理", detail: parts.join(" · ") || toolActivitySummary(tools).replace(/^已/, "") };
  return { state: "completed", text: "执行完成", detail: parts.join(" · ") || toolActivitySummary(tools).replace(/^已/, "") };
}
function workHeadHtml(messages, status = aggregateToolStatus(messages), phase = null) {
  const count = messages.length; const summary = summarizeWork(messages);
  const runningItem = messages.find((message) => ["running", "pending"].includes(message.tool?.status));
  const failedCount = messages.filter((message) => message.tool?.status === "failed").length;
  let iconHtml; let title; let sub;
  if (status === "running" || status === "pending") { iconHtml = '<span class="spin"></span>'; title = `${phase?.label || "正在工作"} · ${count} 项`; sub = runningItem?.tool?.title || runningItem?.tool?.name || "执行中"; }
  else if (status === "failed") { iconHtml = "✕"; title = `${phase?.label || "执行"} · ${failedCount} 项失败`; sub = "点击展开定位失败项"; }
  else if (status === "waiting_for_approval") { iconHtml = "!"; title = "等待你的授权"; sub = "点击查看待审批操作"; }
  else { iconHtml = "✓"; title = `${phase?.label || "工作过程"} · 已完成 ${count} 项`; sub = summary.detail || toolActivitySummary(messages).replace(/^已/, ""); }
  return `<button class="work-head" type="button"><span class="work-ic">${iconHtml}</span><span class="work-title"><b>${escapeHtml(title)}</b><small>${escapeHtml(sub || "")}</small></span><span class="work-meta"><span>${status === "failed" ? "失败" : count}</span><span class="chev">⌄</span></span></button>`;
}
function renderToolGroup(messages, startIndex = 0, phase = null) {
  const status = aggregateToolStatus(messages);
  const open = ["failed", "waiting_for_approval", "running", "pending"].includes(status);
  const items = messages.map((message, offset) => renderToolItem(message, messageKey(message, startIndex + offset), offset + 1)).join("");
  const phaseAttr = phase ? ` data-work-phase="${escapeHtml(phase.id)}"` : "";
  return `<div class="work-group-wrap"${phaseAttr}><div class="work-group status-${escapeHtml(status)}${open ? " open" : ""}" data-message-key="${escapeHtml(messageKey(messages[0], startIndex))}-group" data-tool-count="${messages.length}">${workHeadHtml(messages, status, phase)}<div class="work-items">${items}</div></div>${renderProducedFiles(messages)}</div>`;
}

function renderMessage(message, extraClass = "", index = 0) {
  try {
    return renderMessageInner(message, extraClass, index);
  } catch (error) {
    console.warn("renderMessage fallback", error);
    return `<div class="ai ${extraClass}"><div class="msg-body">${escapeHtml(String(message?.text || "（此条消息无法渲染）")).slice(0, 2000)}</div></div>`;
  }
}
function renderMessageInner(message, extraClass = "", index = 0) {
  const kind = message.kind || "message"; const key = messageKey(message, index); const text = String(message.text || "");
  if (kind === "thinking") return `<details class="think" data-message-key="${escapeHtml(key)}" data-raw="${escapeHtml(text)}"><summary><i></i><b>思考摘要</b><span class="preview">${escapeHtml(firstLine(text)).slice(0, 120)}</span><span class="fold">展开</span><span class="chevron">⌄</span></summary><div class="think-body">${renderRichText(text)}</div></details>`;
  if (isToolMessage(message)) return renderToolGroup([message], index);
  if (message.role === "user") return `<div class="me ${extraClass}" data-message-key="${escapeHtml(key)}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}${extraClass.includes("failed") ? ` data-retry-text="${escapeHtml(text)}"` : ""}><div class="msg-body">${escapeHtml(text)}</div>${renderMessageAttachments(message.attachments)}${extraClass.includes("failed") ? '<button type="button" class="retry-send" data-retry>重试</button>' : ""}</div>`;
  const notification = parseStructuredNotification(text);
  if (notification) {
    const state = notificationStateLabel(notification.state);
    const stateClass = String(notification.state || "notice").replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "notice";
    return `<details class="structured-notification ${escapeHtml(stateClass)}" data-message-key="${escapeHtml(key)}"><summary><span class="structured-notification-icon">${state === "失败" ? "!" : state === "已完成" ? "✓" : "◎"}</span><span class="structured-notification-copy"><b>${escapeHtml(notification.label)}</b><strong>${escapeHtml(state)}</strong><small>${escapeHtml(firstLine(notification.text)).slice(0, 120)}</small></span><span class="structured-notification-fold">⌄</span></summary><div class="structured-notification-body">${renderRichText(notification.text)}</div></details>`;
  }
  const who = `${escapeHtml(agentLabel(current?.agent || ""))}${current?.model ? ` · ${escapeHtml(current.model)}` : ""}`;
  return `<div class="ai ${extraClass}" data-message-key="${escapeHtml(key)}" data-raw="${escapeHtml(text)}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}><div class="who">${who}</div><div class="msg-body">${renderRichText(text)}</div>${renderMessageAttachments(message.attachments)}</div>`;
}
function messageFingerprint(rows = []) { return rows.map((message) => `${message.role || ""}|${message.kind || ""}|${message.text || ""}|${JSON.stringify(message.tool || null)}|${JSON.stringify(message.attachments || null)}|${JSON.stringify(message.delivery || null)}`).join("\u001f"); }
function goalStatusLabel(status) { return ({ in_progress: "进行中", complete: "已完成", blocked: "需要处理" })[status] || "进行中"; }
function goalStepClass(status) {
  const value = String(status || "").toLowerCase();
  if (["completed", "complete", "done"].includes(value)) return "done";
  if (["in_progress", "running", "doing", "active"].includes(value)) return "doing";
  return "todo";
}
function renderGoalPanel() {
  const host = $("#goal-panel"); const goal = current?.goal;
  if (!host) return;
  if (!goal?.objective && !goal?.plan?.length) { host.hidden = true; host.innerHTML = ""; return; }
  const plan = Array.isArray(goal.plan) ? goal.plan : [];
  const done = plan.filter((item) => goalStepClass(item.status) === "done").length;
  const activeIndex = plan.findIndex((item) => goalStepClass(item.status) === "doing");
  const step = plan.length ? (activeIndex >= 0 ? activeIndex + 1 : Math.min(plan.length, Math.max(1, done + (goal.status === "complete" ? 0 : 1)))) : 0;
  const percent = plan.length ? Math.round((done / plan.length) * 100) : 0;
  const collapsed = goal.status === "complete";
  const steps = plan.map((item, index) => {
    const cls = goalStepClass(item.status);
    const mark = cls === "done" ? "✓" : cls === "todo" ? String(index + 1) : "";
    return `<li class="goal-step ${cls}"><span>${mark}</span><b>${escapeHtml(item.step)}</b></li>`;
  }).join("");
  const blocked = goal.status === "blocked" && goal.blockedReason ? `<p class="goal-blocked">${escapeHtml(goal.blockedReason)}</p>` : "";
  const budget = Number.isFinite(goal.tokenUsage) && Number.isFinite(goal.tokenBudget) ? `<small>${goal.tokenUsage} / ${goal.tokenBudget} tokens</small>` : "";
  host.hidden = false;
  host.innerHTML = `<details class="goal-card ${escapeHtml(goal.status || "in_progress")}"${collapsed ? "" : " open"}><summary><span class="goal-icon">${goal.status === "complete" ? "✓" : goal.status === "blocked" ? "!" : "◎"}</span><span class="goal-copy"><b>目标模式</b><strong>${escapeHtml(goal.objective)}</strong></span><span class="goal-state">${escapeHtml(goalStatusLabel(goal.status))}<i>⌄</i></span></summary><div class="goal-body">${plan.length ? `<div class="goal-progress"><span>第 <b>${step}</b> / ${plan.length} 步</span><em>${percent}%</em></div><div class="goal-track"><i style="width:${percent}%"></i></div><ol>${steps}</ol>` : ""}${blocked}<footer><span>${goal.status === "complete" ? "目标已完成" : `已完成 ${done} 项`}</span>${budget}</footer></div></details>`;
}

function renderSessionQueue() {
  const host = $("#session-queue");
  const queue = Array.isArray(current?.queue) ? current.queue : [];
  if (!current || (!queue.length && !current.queuePaused)) { host.hidden = true; host.innerHTML = ""; return; }
  const items = queue.map((item, index) => `<article class="queue-item" data-queue-id="${escapeHtml(item.id)}"><div class="queue-item-head"><span class="queue-order">${index + 1}</span><div class="queue-copy"><p>${escapeHtml(item.text || "（仅附件）")}</p><small>${item.attachments?.length ? `含 ${item.attachments.length} 个附件 · ` : ""}等待当前轮结束后执行</small></div></div><div class="queue-actions"><button type="button" data-queue-edit="${escapeHtml(item.id)}">编辑</button><button type="button" class="queue-cancel" data-queue-cancel="${escapeHtml(item.id)}">取消</button></div></article>`).join("");
  host.hidden = false;
  const next = queue[0];
  const headline = current.queuePaused ? "已暂停" : next ? `下一条：${String(next.text || "含附件的指令").replace(/\s+/g, " ").slice(0, 44)}` : "等待新指令";
  host.innerHTML = `<details${current.queuePaused ? " open" : ""}><summary><span class="queue-summary-icon" aria-hidden="true">≡</span><span><b>${queue.length ? `${queue.length} 条后续指令` : "后续指令"}</b><small>${escapeHtml(headline)}</small></span><em>⌄</em></summary>${current.queuePaused ? '<div class="queue-paused">已停止当前会话，排队指令尚未执行。</div><button type="button" class="queue-resume" data-queue-resume>继续执行队列</button>' : ""}<div class="queue-items">${items || '<div class="queue-paused">队列为空</div>'}</div></details>`;
}
function updateComposerQueueState() {
  const queueing = isSessionRunning(); const stopping = queueing && !hasComposerContent();
  const send = $("#send"); const composer = $("#composer"); const input = $("#message");
  send.disabled = !queueing && !hasComposerContent();
  send.classList.toggle("is-queue", queueing && !stopping); send.classList.toggle("is-stop", stopping); composer.dataset.queueing = String(queueing);
  const label = stopping ? "停止会话" : queueing ? "发送后续消息" : "发送";
  send.setAttribute("aria-label", label); send.title = label;
  if (input && !input.value) input.placeholder = current?.state === "waiting_for_approval" ? "等待授权后继续" : current?.state === "failed" ? "描述下一步，或让 Agent 修复失败" : queueing ? "补充指令会在当前步骤后执行" : current?.state === "completed" ? "继续这项工作，或开始下一步" : "继续这项工作";
}

function buildConversationTurns(rows = []) {
  const turns = []; let currentTurn = null; let prelude = [];
  const startTurn = (request, index) => ({ id: request.turnId || request.id || `turn-${index}`, request, entries: [] });
  rows.forEach((message, index) => {
    if (message?.role === "user") {
      if (currentTurn) turns.push(currentTurn); else if (prelude.length) turns.push({ id: `prelude-${index}`, request: null, entries: prelude.splice(0) });
      currentTurn = startTurn(message, index); return;
    }
    if (currentTurn) currentTurn.entries.push({ message, index }); else prelude.push({ message, index });
  });
  if (currentTurn) turns.push(currentTurn); else if (prelude.length) turns.push({ id: "prelude", request: null, entries: prelude });
  return turns;
}
function groupWorkByPhase(entries = []) {
  const groups = []; let currentGroup = null;
  entries.filter(({ message }) => isToolMessage(message) && !isPlanToolMessage(message)).forEach((entry) => {
    const phase = workPhase(entry.message);
    if (!currentGroup || currentGroup.phase.id !== phase.id) { currentGroup = { phase, entries: [] }; groups.push(currentGroup); }
    currentGroup.entries.push(entry);
  });
  return groups;
}
function renderTurnWork(turn) {
  const entries = turn.entries || [];
  const workEntries = entries.filter(({ message }) => isToolMessage(message) || message.kind === "thinking");
  if (!workEntries.length) return { html: "", summary: null };
  const tools = workEntries.map(({ message }) => message).filter(isToolMessage);
  const planEntry = [...workEntries].reverse().find(({ message }) => isPlanToolMessage(message));
  const actionTools = tools.filter((message) => !isPlanToolMessage(message));
  const summary = summarizeWork(tools);
  const thought = workEntries.filter(({ message }) => message.kind === "thinking").map(({ message, index }) => renderMessage(message, "", index)).join("");
  const execution = planEntry ? renderExecutionCard(planEntry.message, actionTools, messageKey(planEntry.message, planEntry.index)) : "";
  const phases = groupWorkByPhase(workEntries).map((group) => renderToolGroup(group.entries.map(({ message }) => message), group.entries[0]?.index || 0, group.phase)).join("");
  return { summary, html: `<section class="turn-work" aria-label="工作过程"><div class="turn-work-label"><span>工作过程</span><small>${escapeHtml(summary.detail || summary.text)}</small></div>${execution}${thought}${phases}</section>` };
}
function renderConversationTurn(turn) {
  const request = turn.request ? `<div class="turn-request">${renderMessage(turn.request, "", 0)}</div>` : "";
  const work = renderTurnWork(turn);
  const finals = turn.entries.filter(({ message }) => message.role === "assistant" && !isToolMessage(message) && message.kind !== "thinking").map(({ message, index }) => renderMessage(message, "turn-final", index)).join("");
  const attachments = turn.entries.filter(({ message }) => message.delivery).map(({ message }) => renderDeliveredFile(message.delivery)).join("");
  const completion = work.summary ? `<div class="turn-completion ${escapeHtml(work.summary.state)}"><i>${work.summary.state === "failed" ? "!" : work.summary.state === "running" ? "…" : "✓"}</i><span><b>${escapeHtml(work.summary.text)}</b><small>${escapeHtml(work.summary.detail || "")}</small></span></div>` : "";
  return `<section class="conversation-turn${turn.request ? " has-request" : ""}" data-turn-id="${escapeHtml(turn.id)}">${request}${work.html}${completion}${finals ? `<div class="turn-result">${finals}</div>` : ""}${attachments}</section>`;
}
function renderNewMessageIndicator() {
  const pill = $("#new-message-indicator"); if (!pill) return;
  pill.hidden = unseenMessageCount <= 0;
  pill.textContent = `↓ ${unseenMessageCount} 条新内容`;
}
function renderMessages(rows = [], { hasMore = false, total = rows.length } = {}) {
  const openKeys = new Set();
  document.querySelectorAll("#messages [data-message-key]").forEach((node) => { if (node.classList?.contains("open") || node.open === true) openKeys.add(node.dataset.messageKey); });
  const html = [];
  if (hasMore) html.push(`<button id="load-earlier-messages" class="load-earlier-messages" type="button">加载更早记录（共 ${Number(total) || rows.length} 条）</button>`);
  buildConversationTurns(rows).forEach((turn) => html.push(renderConversationTurn(turn)));
  let rendered = html.join("");
  if (!rendered.trim()) rendered = '<div class="empty">这个会话还没有消息。</div>';
  $("#messages").innerHTML = rendered;
  for (const key of openKeys) {
    const node = $("#messages").querySelector(`[data-message-key="${CSS.escape(key)}"]`);
    if (!node) continue;
    if (node.matches("details")) node.open = true; else node.classList.add("open");
  }
  lastDetailFingerprint = messageFingerprint(rows); renderSessionQueue(); updateComposerQueueState(); void hydrateAttachmentPreviews($("#messages"));
}
function syncMessages(rows = [], options = {}) {
  const fingerprint = messageFingerprint(rows);
  if (fingerprint === lastDetailFingerprint) return false;
  const follow = shouldFollowConversation();
  renderMessages(rows, options);
  if (follow) { unseenMessageCount = 0; renderNewMessageIndicator(); scrollMessages({ force: true, instant: true }); }
  else if (isDetailVisible()) { unseenMessageCount += 1; renderNewMessageIndicator(); }
  return true;
}

function isDetailVisible() { return document.querySelector('.page[data-page="detail"]')?.classList.contains("active"); }
function shouldFollowConversation() {
  if (!isDetailVisible()) return false;
  const viewportBottom = window.scrollY + window.innerHeight;
  return document.documentElement.scrollHeight - viewportBottom < 180;
}
function scrollMessages({ force = false, instant = false } = {}) {
  if (!force && !shouldFollowConversation()) return;
  unseenMessageCount = 0; renderNewMessageIndicator();
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
  const last = lastTaskPrefs();
  if (last.agent && agents.some((agent) => agent.id === last.agent)) selectedAgent = last.agent;
  else if (!selectedAgent || !agents.some((agent) => agent.id === selectedAgent)) selectedAgent = agents[0]?.id || "";
  renderFilters(); renderAgentPicker(); renderAgentNotices(); await loadModels();
}

async function loadModels() {
  if (!selectedAgent) return;
  const models = await api(`/mobile/v1/models?agent=${encodeURIComponent(selectedAgent)}`);
  $("#model-select").innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join("") || '<option value="">暂无可用模型</option>';
  const last = lastTaskPrefs();
  if (last.model && models.some((model) => model.id === last.model)) $("#model-select").value = last.model;
  else {
    const preferred = agents.find((agent) => agent.id === selectedAgent)?.defaultModelId;
    if (preferred && models.some((model) => model.id === preferred)) $("#model-select").value = preferred;
  }
}

async function loadSessions({ background = false } = {}) {
  let rows;
  try { rows = await api(`/mobile/v1/sessions${archivedView ? "?archived=true" : ""}`); }
  catch (error) { if (!allSessions.length) $("#session-list").innerHTML = `<div class="empty">会话列表加载失败。<br>${escapeHtml(error.message || "请下拉重试")}</div>`; throw error; }
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
function applySessionDetail(detail, { activate = true, instant = false, anchor = false } = {}) {
  current = detail;
  $("#detail-title").textContent = current.title;
  $("#detail-meta").textContent = `${agentLabel(current.agent)}${current.model ? ` · ${current.model}` : ""}`;
  $("#chat-state-dot").className = current.state || "";
  renderRuntimeShortcut(); renderApprovalInbox(); renderSessionQueue(); renderGoalPanel(); updateComposerQueueState();
  const options = { hasMore: Boolean(current.hasMoreMessages), total: current.messagesTotal };
  if (activate) { renderMessages(current.messages || [], options); page("detail"); if (!anchor) scrollMessages({ force: true, instant }); }
  else syncMessages(current.messages || [], options);
}
async function fetchSessionDetail(id, { messageLimit = INITIAL_MESSAGE_LIMIT } = {}) {
  const detail = await api(`/mobile/v1/sessions/${encodeURIComponent(id)}?messages=${encodeURIComponent(messageLimit)}`, { timeoutMs: 45_000 });
  cacheSessionDetail(detail);
  return detail;
}
let openSessionSeq = 0;
async function openSession(id, { activate = true, messageLimit = INITIAL_MESSAGE_LIMIT, anchor = false } = {}) {
  const seq = ++openSessionSeq;
  const cached = sessionDetailCache.get(id);
  const cacheFresh = cached && Date.now() - cached.at < SESSION_DETAIL_CACHE_TTL_MS;
  if (activate) {
    page("detail");
    if (cacheFresh) applySessionDetail(cached.detail, { activate: true, instant: true });
    else {
      $("#detail-title").textContent = "载入中…";
      $("#detail-meta").textContent = "";
      $("#messages").innerHTML = '<div class="skel-msg"><div class="skel m1"></div><div class="skel m2"></div><div class="skel m3"></div></div><div class="skel-msg" style="width:64%"><div class="skel m1"></div><div class="skel m2"></div></div><div class="skel-msg" style="width:78%"><div class="skel m1"></div><div class="skel m3"></div></div>';
    }
  }
  let detail;
  try {
    detail = await fetchSessionDetail(id, { messageLimit });
  } catch (error) {
    if (seq !== openSessionSeq) return;
    sessionDetailCache.delete(id);
    if (activate) {
      $("#detail-title").textContent = "加载失败";
      $("#messages").innerHTML = `<div class="empty detail-load-error"><strong>会话加载失败</strong><span>${escapeHtml(error.message || "请稍后重试")}</span><button type="button" class="detail-retry" data-retry-open="${escapeHtml(id)}">重新加载</button></div>`;
    }
    throw error;
  }
  if (seq !== openSessionSeq) return;
  applySessionDetail(detail, { activate, instant: true, anchor });
  syncLiveExecutionTimer();
  // Approval data is independent: never delay the first message paint on it.
  void loadApprovals().catch(() => {});
}
async function loadEarlierMessages() {
  if (!current?.id || !current.hasMoreMessages) return;
  const button = $("#load-earlier-messages"); if (button) { button.disabled = true; button.textContent = "正在加载更早记录…"; }
  // Anchor the viewport: older messages insert above, so compensate for the
  // height delta instead of jumping to the newest message.
  const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY;
  await openSession(current.id, { messageLimit: 500, anchor: true });
  requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, document.documentElement.scrollHeight - distanceFromBottom), behavior: "auto" }));
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

function routeTerminalLabel(route = {}) {
  const state = ({ completed: "已完成", incomplete: "未完成", failed: "失败", cancelled: "已取消" })[route.terminalState] || route.terminalState || "";
  const reason = ({ protocol_terminal: "协议完成", adapter_eof: "上游 EOF", upstream_stall_timeout: "上游静默超时", upstream_error: "上游错误", client_cancelled: "客户端取消" })[route.terminalReason] || route.terminalReason || "";
  return [state, reason].filter(Boolean).join(" · ");
}

let executionSummaryTimer = null;
function liveExecutionElapsed() {
  const at = Date.parse(current?.updatedAt || current?.createdAt || "");
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}小时${Math.floor(seconds % 3600 / 60)}分` : seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}
function renderLiveExecutionSummary() {
  if (!current) return "";
  const running = ["running", "queued", "waiting_for_approval"].includes(current.state);
  const route = current.liveRoute || {};
  const label = running ? `${stateLabel(current.state)} · ${liveExecutionElapsed() || "刚刚开始"}` : stateLabel(current.state || route.terminalState);
  const upstream = [route.providerId, route.upstreamModel].filter(Boolean).join(" / ");
  return `<section class="live-execution-summary ${running ? "running" : "terminal"}"><span class="live-execution-dot"></span><div><b>${escapeHtml(label || "执行状态")}</b><small>${escapeHtml([agentLabel(current.agent), current.model, upstream].filter(Boolean).join(" · ") || "等待实际路由")}</small></div></section>`;
}
function refreshLiveExecutionSummary() {
  const node = document.querySelector("#messages > .live-execution-summary");
  if (!node) return;
  node.outerHTML = renderLiveExecutionSummary();
}
function syncLiveExecutionTimer() {
  clearInterval(executionSummaryTimer); executionSummaryTimer = null;
  if (current && ["running", "queued", "waiting_for_approval"].includes(current.state)) executionSummaryTimer = setInterval(refreshLiveExecutionSummary, 1000);
}

function renderLiveRouteCard(route) {
  if (!route || !Object.values(route).some(Boolean)) return "";
  const rows = [
    ["请求", route.requestedModel],
    ["命中", route.modelId],
    ["上游", [route.providerId, route.upstreamModel].filter(Boolean).join(" / ")],
    ["协议", route.apiFormat],
    ["账号", route.account],
    ["终态", routeTerminalLabel(route)]
  ].filter(([, value]) => value);
  if (!rows.length) return "";
  return `<details class="live-route-card" open><summary><span>⌁</span><b>实际路由</b><small>${escapeHtml(routeTerminalLabel(route) || route.upstreamModel || "实时诊断")}</small><i>⌄</i></summary><dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></details>`;
}

function updateLiveRouteCard(route) {
  if (!route || !current) return;
  current.liveRoute = { ...(current.liveRoute || {}), ...route };
  const turn = liveTurn();
  const existing = turn.querySelector(":scope > .live-route-card");
  refreshLiveExecutionSummary();
  const html = renderLiveRouteCard(current.liveRoute);
  if (!html) return;
  if (existing) existing.outerHTML = html;
  else turn.insertAdjacentHTML("afterbegin", html);
}

function liveTurn() {
  const host = $("#messages");
  let turn = host.querySelector(".conversation-turn:last-of-type");
  if (!turn) { host.insertAdjacentHTML("beforeend", `${renderLiveExecutionSummary()}<section class="conversation-turn" data-turn-id="live"></section>`); turn = host.querySelector(".conversation-turn:last-of-type"); syncLiveExecutionTimer(); }
  return turn;
}
function liveTurnWork(turn) {
  let work = turn.querySelector(":scope > .turn-work");
  if (!work) { turn.insertAdjacentHTML("beforeend", '<section class="turn-work" aria-label="工作过程"><div class="turn-work-label"><span>工作过程</span><small>正在准备…</small></div></section>'); work = turn.querySelector(":scope > .turn-work"); }
  return work;
}
function appendEvent(event) {
  if (!current || event.sessionId !== current.id) return;
  sessionDetailCache.delete(current.id);
  if (event.goal) { current.goal = event.goal; renderGoalPanel(); }
  if (event.route) updateLiveRouteCard(event.route);
  const host = $("#messages");
  if (event.type === "message" && event.summary) {
    const role = event.role || "assistant";
    if (role === "user") {
      const existing = host.querySelector(`[data-message-id="${CSS.escape(String(event.id || ""))}"]`);
      if (!existing) host.insertAdjacentHTML("beforeend", renderConversationTurn({ id: event.id || `live-${Date.now()}`, request: { id: event.id, role, text: event.summary, attachments: event.attachments || [] }, entries: [] }));
    } else {
      const turn = liveTurn(); let result = turn.querySelector(":scope > .turn-result");
      let last = result?.querySelector(".ai:last-child");
      if (last) {
        const body = last.querySelector(".msg-body"); const raw = last.dataset.raw || body.textContent || "";
        last.dataset.raw = `${raw}${event.summary}`; scheduleStreamingRichText(last, ".msg-body");
      } else {
        if (!result) { turn.insertAdjacentHTML("beforeend", '<div class="turn-result"></div>'); result = turn.querySelector(":scope > .turn-result"); }
        result.insertAdjacentHTML("beforeend", renderMessage({ role, text: event.summary, attachments: event.attachments || [] })); void hydrateAttachmentPreviews(result);
      }
    }
    scrollMessages(); return;
  }
  if (event.type === "thinking" && event.summary) {
    const turn = liveTurn(); const work = liveTurnWork(turn); const last = work.querySelector(".think:last-of-type");
    if (last) { const body = last.querySelector(".think-body"); const raw = last.dataset.raw || body.textContent || ""; last.dataset.raw = `${raw}${event.summary}`; scheduleStreamingRichText(last, ".think-body"); }
    else work.insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", kind: "thinking", text: event.summary }));
    scrollMessages(); return;
  }
  if (event.type === "status") {
    const status = String(event.summary || ""); const knownStates = new Set(["queued", "running", "waiting_for_approval", "completed", "failed", "cancelled", "canceled", "incomplete"]);
    if (knownStates.has(status)) { current.state = status; updateComposerQueueState(); setConnectionStatus(stateLabel(status) || "已安全连接"); $("#chat-state-dot").className = status; }
  }
  if (event.type === "file_delivery" && event.delivery) {
    const turn = liveTurn(); turn.insertAdjacentHTML("beforeend", renderDeliveredFile(event.delivery)); void hydrateAttachmentPreviews(turn); scrollMessages(); return;
  }
  if (event.type === "error") {
    const turn = liveTurn(); let result = turn.querySelector(":scope > .turn-result"); if (!result) { turn.insertAdjacentHTML("beforeend", '<div class="turn-result"></div>'); result = turn.querySelector(":scope > .turn-result"); }
    result.insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", text: `发送失败：${event.summary}` }, "failed")); toast("消息没有发送成功，请重试"); return;
  }
  if (event.type === "tool") {
    const message = { id: event.id, role: "tool", kind: "tool", text: event.summary || "正在使用工具", tool: event.tool || null };
    const toolId = event.tool?.id ? CSS.escape(event.tool.id) : ""; const existing = toolId ? host.querySelector(`[data-tool-id="${toolId}"]`) : null;
    if (isPlanToolMessage(message)) {
      const work = liveTurnWork(liveTurn()); const actionTools = [...work.querySelectorAll(".tl")].map((item) => ({ tool: { activity: item.dataset.toolActivity || "other", status: item.dataset.toolStatus || "completed", title: item.dataset.toolTitle || "", name: item.dataset.toolTitle || "", files: Array.from({ length: Number(item.dataset.toolFiles || 0) }), patchStats: { adds: Number(item.dataset.toolAdds || 0), dels: Number(item.dataset.toolDels || 0) } } }));
      if (existing) existing.outerHTML = renderExecutionCard(message, actionTools, messageKey(message));
      else work.insertAdjacentHTML("afterbegin", renderExecutionCard(message, actionTools, messageKey(message)));
    } else if (existing) {
      const group = existing.closest(".work-group"); existing.outerHTML = renderToolItem(message, messageKey(message)); refreshToolGroup(group);
    } else {
      const work = liveTurnWork(liveTurn()); const group = work.querySelector(".work-group-wrap:last-of-type .work-group");
      if (group) { group.querySelector(":scope > .work-items")?.insertAdjacentHTML("beforeend", renderToolItem(message, messageKey(message))); refreshToolGroup(group); }
      else work.insertAdjacentHTML("beforeend", renderToolGroup([message], 0, workPhase(message)));
    }
    refreshLiveExecutionCard(host.querySelector(".conversation-turn:last-of-type .turn-work"));
    scrollMessages();
  }
}

function refreshToolGroup(group) {
  if (!group) return;
  const items = [...group.querySelectorAll(":scope > .work-items > .tl")];
  if (!items.length) return;
  const messages = items.map((item) => ({
    tool: { status: item.dataset.toolStatus || "completed", title: item.dataset.toolTitle || "", name: item.dataset.toolTitle || "", activity: item.dataset.toolActivity || "other" }
  }));
  const status = aggregateToolStatus(messages);
  for (const name of ["failed", "waiting_for_approval", "running", "pending", "cancelled", "completed"]) group.classList.toggle(`status-${name}`, name === status);
  group.dataset.toolCount = String(items.length);
  const head = group.querySelector(":scope > .work-head");
  if (head) head.outerHTML = workHeadHtml(messages, status);
  if (["failed", "waiting_for_approval", "running", "pending"].includes(status)) group.classList.add("open");
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
      setConnectionStatus(stateLabel(current.state));
      toast("有操作等待你的授权");
    }
  }
  appendEvent(event);
  scheduleFinalReconcile(event);
}
async function readEventStream(response) { if (!response.ok || !response.body) throw new Error(`事件流 HTTP ${response.status}`); const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); let boundary; while ((boundary = buffer.indexOf("\n\n")) >= 0) { const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2); const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"); if (data) await handleEvent(JSON.parse(data)); } } }
async function connectEvents() { while (token && !eventLoopStopped) { const controller = new AbortController(); const reconnect = setTimeout(() => controller.abort(), 20_000); try { await readEventStream(await fetch(`/mobile/v1/events?after=${eventCursor}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal })); } catch (error) { if (error.name !== "AbortError") setConnectionStatus("正在重连", false); } finally { clearTimeout(reconnect); } await new Promise((resolve) => setTimeout(resolve, 800)); } }

function closeWorkspaceMenus(except = null) {
  document.querySelectorAll(".group-menu:not([hidden])").forEach((menu) => { if (menu !== except) menu.hidden = true; });
}

// Capture links before WebView's own navigation pipeline sees target="_blank".
// Android's native bridge owns external navigation; this prevents the WebView
// from attempting a second popup/navigation for the same tap.
document.addEventListener("click", (event) => {
  const conversationLink = event.target?.closest?.(".msg-body a[href]");
  if (!conversationLink) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openConversationLink(conversationLink);
}, true);

document.addEventListener("click", async (event) => {
  try {
    const commandOption = event.target.closest("[data-command-index]");
    if (commandOption) { chooseCommand(Number(commandOption.dataset.commandIndex)); return; }
    const workHead = event.target.closest(".work-head");
    if (workHead) { workHead.closest(".work-group")?.classList.toggle("open"); return; }
    if (event.target.closest("#new-message-indicator")) { scrollMessages({ force: true }); return; }
    const diffFilter = event.target.closest("[data-diff-filter]");
    if (diffFilter) { const diff = diffFilter.closest("[data-diff]"); diff?.setAttribute("data-filter", diffFilter.dataset.diffFilter); diff?.querySelectorAll("[data-diff-filter]").forEach((button) => button.classList.toggle("selected", button === diffFilter)); return; }
    const diffContext = event.target.closest("[data-diff-context-toggle]");
    if (diffContext) { const diff = diffContext.closest("[data-diff]"); const collapsed = diff?.classList.toggle("context-collapsed"); diffContext.textContent = collapsed ? "显示未变内容" : "折叠未变内容"; return; }
    const copyValue = event.target.closest("[data-copy-value]");
    if (copyValue) { await navigator.clipboard?.writeText(decodeURIComponent(copyValue.dataset.copyValue || "")); toast("已复制"); return; }
    const approvalOpen = event.target.closest("[data-approval-open]");
    if (approvalOpen) { showApprovalSheet(approvalOpen.dataset.approvalOpen); return; }
    if (event.target.closest("#close-approval-sheet") || event.target === $("#approval-sheet")) { hideApprovalSheet(); return; }
    const toolRow = event.target.closest(".tl > .tl-row");
    if (toolRow) { toolRow.parentElement.classList.toggle("open"); return; }
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
    const retryOpen = event.target.closest("[data-retry-open]");
    if (retryOpen) { await openSession(retryOpen.dataset.retryOpen); return; }
    if (event.target.closest("#load-more-sessions")) { sessionDisplayLimit += SESSION_PAGE_SIZE; renderSessionList(); return; }
    const switchSession = event.target.closest("[data-switch-session]");
    if (switchSession) { closeSessionSwitcher(); await openSession(switchSession.dataset.switchSession); return; }
    const filter = event.target.closest("[data-filter]"); if (filter) { selectedFilter = filter.dataset.filter; sessionDisplayLimit = SESSION_PAGE_SIZE; renderFilters(); renderSessionList(); return; }
    if (event.target.closest("[data-open-active-sessions]")) { const active = activeSessionRows(); if (active.length === 1) await openSession(active[0].id); else openSessionSwitcher(); return; }
    if (event.target.closest("[data-open-approvals]")) { document.querySelector("#approval-inbox")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    const group = event.target.closest("[data-group]"); if (group) { const name = group.dataset.group; setGroupCollapsed(name, !isGroupCollapsed(name)); renderSessionList(); return; }
    const projectPin = event.target.closest("[data-project-pin]"); if (projectPin) { const name = projectPin.dataset.projectPin; setProjectPinned(name, projectPin.dataset.pinned !== "true"); closeWorkspaceMenus(); renderSessionList(); toast(projectPin.dataset.pinned === "true" ? "已取消置顶项目" : "已置顶项目"); return; }
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
      if (!await showInputSheet({ title: `删除文件夹「${name}」？`, description: "如果里面有文件，会继续询问是否强制删除。", mode: "confirm", confirmLabel: "删除", danger: true })) return;
      try {
        await api(`/mobile/v1/workspaces/directories?path=${encodeURIComponent(target)}`, { method: "DELETE" });
      } catch (error) {
        if (!/不为空|NOT_EMPTY|force/i.test(error.message || "")) throw error;
        if (!await showInputSheet({ title: `「${name}」不是空文件夹`, description: "是否强制删除其中全部内容？此操作不可恢复。", mode: "confirm", confirmLabel: "强制删除", danger: true })) return;
        await api(`/mobile/v1/workspaces/directories?path=${encodeURIComponent(target)}&force=1`, { method: "DELETE" });
      }
      if (selectedWorkspace === target) selectedWorkspace = browsedWorkspace?.path || "";
      if (workspaceDelete.closest("#workspace-browser-list") && browsedWorkspace?.path) await browseWorkspace(browsedWorkspace.path);
      else await Promise.all([loadWorkspaces(), loadSessions()]);
      renderWorkspaces();
      toast("目录已删除");
      return;
    }
    if (event.target.closest("#workspace-create") && browsedWorkspace?.path) { const name = await showInputSheet({ title: "新建文件夹", description: "在当前目录下创建" }); if (!name?.trim()) return; const created = await api("/mobile/v1/workspaces/directories", { method: "POST", body: JSON.stringify({ parent: browsedWorkspace.path, name: name.trim() }) }); selectedWorkspace = created.path; await browseWorkspace(browsedWorkspace.path); renderWorkspaces(); toast("文件夹已创建并选中"); return; }
    const sessionAction = event.target.closest("[data-session-action]");
    if (sessionAction) {
      const id = sessionAction.dataset.id;
      const action = sessionAction.dataset.sessionAction;
      closeAllSwipe();
      if (action === "pin") {
        const pinned = sessionAction.dataset.pinned !== "true";
        await api(`/mobile/v1/sessions/${encodeURIComponent(id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) });
        toast(pinned ? "已置顶会话" : "已取消置顶会话");
        return loadSessions();
      }
      if (action === "rename") {
        const session = allSessions.find((item) => item.id === id);
        const title = await showInputSheet({ title: "重命名会话", value: session?.title || "" });
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
      if (action === "delete") { requestSessionDeletion([id]); return; }
    }
    const workspaceRename = event.target.closest("[data-workspace-rename]");
    if (workspaceRename) {
      closeAllSwipe();
      const oldPath = workspaceRename.dataset.workspaceRename;
      const oldName = workspaceRename.dataset.workspaceName || oldPath.split("/").pop();
      const name = await showInputSheet({ title: "重命名文件夹", value: oldName });
      if (!name?.trim() || name.trim() === oldName) return;
      const result = await api("/mobile/v1/workspaces/directories/rename", { method: "POST", body: JSON.stringify({ path: oldPath, name: name.trim() }) });
      renameProjectPreferences(oldName, name.trim());
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
      const text = await showInputSheet({ title: "编辑排队指令", value: item?.text || "" });
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
    const sessionSelect = event.target.closest("[data-session-select]");
    if (sessionSelect) { toggleSessionSelection(sessionSelect.dataset.sessionSelect); return; }
    const openSwipeItem = document.querySelector(".swipe-item.open");
    if (openSwipeItem && event.target.closest(".swipe-item") && !event.target.closest(".swipe-actions") && !sessionSelectionMode) { closeAllSwipe(); return; }
    const card = event.target.closest(".session-row[data-id]"); if (card) { if (sessionSelectionMode) { toggleSessionSelection(card.dataset.id); return; } closeAllSwipe(); return openSession(card.dataset.id); }
    if (event.target.closest("#session-select-toggle")) { setSessionSelectionMode(!sessionSelectionMode); return; }
    if (event.target.closest("#session-selection-delete")) { requestSessionDeletion([...selectedSessionIds]); return; }
    if (event.target.closest("#close-session-delete-sheet") || event.target.closest("#cancel-session-delete") || event.target === $("#session-delete-sheet")) { hideSessionDeleteSheet(); return; }
    if (event.target.closest("#confirm-session-delete")) { await confirmSessionDeletion(); return; }
    if (event.target.closest("#more")) { const menu = $("#session-menu"); menu.hidden = !menu.hidden; const pinAction = $("#session-pin-action"); if (pinAction) pinAction.textContent = current?.pinned ? "取消置顶会话" : "置顶会话"; return; }
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
    const openApprovalSession = event.target.closest("[data-open-session]");
    if (openApprovalSession) { await openSession(openApprovalSession.dataset.openSession); return; }
    const approval = event.target.closest("[data-approval]"); if (approval) {
      await api(`/mobile/v1/approvals/${encodeURIComponent(approval.dataset.approval)}/resolve`, { method: "POST", body: JSON.stringify({ decision: approval.dataset.decision }) });
      hideApprovalSheet(); await loadApprovals(); if (current) await openSession(current.id, { activate: false });
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
    if (action === "pin") { const pinned = !current.pinned; $("#session-menu").hidden = true; await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/pin`, { method: "POST", body: JSON.stringify({ pinned }) }); current.pinned = pinned; await loadSessions(); toast(pinned ? "已置顶会话" : "已取消置顶会话"); return; }
    if (action === "refresh") { $("#session-menu").hidden = true; return refreshMobileData(); }
    if (action === "delete") { $("#session-menu").hidden = true; requestSessionDeletion([current.id]); return; }
    let body = {}; if (action === "rename") { const title = await showInputSheet({ title: "重命名会话", value: current.title }); body.title = title?.trim() || current.title; }
    const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/${action}`, { method: "POST", body: JSON.stringify(body) });
    if (action === "archive") { current = null; page("sessions"); toast("已归档"); return loadSessions(); } await openSession(current.id);
  } catch (error) { toast(error.message); }
});

$("#confirm-input-sheet").addEventListener("click", () => closeInputSheet($("#input-sheet-text").hidden ? true : $("#input-sheet-text").value));
$("#cancel-input-sheet").addEventListener("click", () => closeInputSheet(null));
$("#close-input-sheet").addEventListener("click", () => closeInputSheet(null));
$("#refresh").addEventListener("click", () => refreshMobileData());
setupPullToRefresh();
$("#show-archive").addEventListener("click", async () => { archivedView = !archivedView; sessionSelectionMode = false; selectedSessionIds.clear(); sessionDisplayLimit = SESSION_PAGE_SIZE; $("#show-archive").textContent = archivedView ? "最近" : "归档"; await loadSessions().catch((error) => toast(error.message)); });
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
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { eventLoopStopped = true; return; }
  if (!token || eventLoopRevoked || !eventLoopStopped) return;
  eventLoopStopped = false;
  connectEvents();
  refreshSessionsInBackground();
  void loadApprovals().catch(() => {});
  if (current) openSession(current.id, { activate: false }).catch(() => {});
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
  const next = Array.from(files || []);
  if (target.length + next.length > MAX_ATTACHMENTS) throw new Error(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
  const totalBytes = target.reduce((sum, item) => sum + Number(item.byteLength || 0), 0) + next.reduce((sum, item) => sum + Number(item.size || 0), 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error("附件总大小不能超过 8MB");
  for (const file of next) {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 8MB 限制`);
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",").at(-1)); reader.onerror = reject; reader.readAsDataURL(file); });
    const image = file.type.startsWith("image/"); const text = file.type.startsWith("text/") || /\.(txt|md|json|ya?ml|js|ts|py|go|rs|java|c|cpp|h|css|html|sql|sh)$/i.test(file.name);
    target.push({ name: file.name, mimeType: file.type || "application/octet-stream", data, byteLength: file.size, kind: image ? "image" : text ? "text" : "file", preview: image ? URL.createObjectURL(file) : "" });
  }
  if (next.some((file) => /\.(pdf|docx|xlsx|zip)$/i.test(file.name))) toast("文件会作为附件交给 Agent；二进制文件是否可解析取决于当前 Agent。");
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
    rememberLastTask();
    newAttachments = []; renderComposerAttachments(newAttachments, $("#new-attachment-preview"), "new"); $("#prompt").value = ""; sent.forEach((file) => file.preview && URL.revokeObjectURL(file.preview)); await openSession(result.sessionId);
  } catch (error) { toast(error.message); } finally { submit.disabled = false; }
});
async function submitComposerMessage(deliveryMode = "") {
  const input = $("#message"); const text = input.value.trim(); if ((!text && !activeAttachments.length) || !current) return;
  const id = createClientMessageId(); const sentAttachments = activeAttachments; input.value = ""; activeAttachments = []; renderAttachments(); $("#send").disabled = true;
  $("#messages").insertAdjacentHTML("beforeend", renderConversationTurn({ id: `live-${id}`, request: { id, role: "user", text, attachments: sentAttachments }, entries: [] })); setConnectionStatus("正在发送"); scrollMessages();
  try {
    const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/messages`, { method: "POST", body: JSON.stringify({ text, attachments: sentAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })), messageId: id, ...(deliveryMode ? { deliveryMode } : {}) }) });
    if (result.queued) { toast(result.deliveryMode === "guide" ? "已添加引导，当前步骤结束后优先执行" : "已加入排队指令"); await openSession(current.id, { activate: false }); }
    else setConnectionStatus("正在生成");
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
$("#theme-toggle").addEventListener("click", () => {
  const next = THEME_ORDER[(THEME_ORDER.indexOf(currentTheme()) + 1) % THEME_ORDER.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
  toast(`外观已切换为${themeLabel(next)}`);
});
$("#density-toggle").addEventListener("click", () => {
  const next = DENSITY_ORDER[(DENSITY_ORDER.indexOf(currentDensity()) + 1) % DENSITY_ORDER.length];
  localStorage.setItem(DENSITY_KEY, next); applyDensity(); toast(`已切换为${densityLabel(next)}密度`);
});
$("#edit-pairing-link").addEventListener("click", async () => {
  if (!nativePairingEditAvailable()) {
    toast("请在 Android App 内使用此功能；浏览器版可撤销设备后重新打开新的配对链接");
    return;
  }
  if (!await showInputSheet({ title: "更换配对链接", description: "会清除本机授权，并回到配对输入页。继续吗？", mode: "confirm", confirmLabel: "继续", danger: true })) return;
  eventLoopStopped = true; eventLoopRevoked = true;
  try { await api("/mobile/v1/devices/self/revoke", { method: "POST" }); } catch {}
  persistToken("");
  localStorage.removeItem(CURSOR_KEY);
  window.SwitchyardNative.editPairingLink();
});
$("#revoke").addEventListener("click", async () => { if (!await showInputSheet({ title: "撤销此设备", description: "确定撤销这台手机的访问权限？", mode: "confirm", confirmLabel: "撤销", danger: true })) return; await api("/mobile/v1/devices/self/revoke", { method: "POST" }); eventLoopStopped = true; eventLoopRevoked = true; persistToken(""); localStorage.removeItem(CURSOR_KEY); location.reload(); });

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

window.addEventListener("scroll", () => { if (shouldFollowConversation() && unseenMessageCount) { unseenMessageCount = 0; renderNewMessageIndicator(); } }, { passive: true });
applyTheme(); applyDensity();
async function boot() {
  try {
    hideModelSheet(); bindSwipe(); await pair();
    if (!token) { setConnectionStatus("等待配对", false); return; }
    // Sessions are the landing screen. Do not make their first paint wait for
    // workspaces, models, preferences, or the approval inbox.
    await loadSessions();
    void Promise.all([loadAgents(), loadWorkspaces(), loadApprovals(), loadPreferences()]).catch((error) => {
      setConnectionStatus("部分数据加载失败", false);
      console.warn("mobile background bootstrap failed", error);
    });
    connectEvents();
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
  } catch (error) { setConnectionStatus("连接失败", false); toast(error.message); }
}
boot();

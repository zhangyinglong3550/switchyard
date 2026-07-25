const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "switchyard_mobile_token";
const CURSOR_KEY = "switchyard_mobile_event_cursor";
let token = localStorage.getItem(TOKEN_KEY) || "";
let eventCursor = Number(localStorage.getItem(CURSOR_KEY) || 0);
let current = null;
let agents = [];
let sessions = [];
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
let lastDetailFingerprint = "";

function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function agentKey(agent) { return String(agent || "").toLowerCase(); }
function agentLabel(agent) { return agents.find((item) => item.id === agent)?.name || ({ codex: "Codex", "claude-code": "Claude Code", grok: "Grok Build", opencode: "OpenCode" })[agent] || agent; }
function agentInitial(agent) { return ({ codex: "C", "claude-code": "CL", grok: "G", opencode: "OC" })[agentKey(agent)] || String(agent || "A").slice(0, 2).toUpperCase(); }
function agentClass(agent) { return ({ "claude-code": "avatar-claude", grok: "avatar-grok", opencode: "avatar-opencode" })[agentKey(agent)] || ""; }
function agentSettings(agent) { return agents.find((item) => item.id === agent)?.settings || null; }
function stateLabel(state) { return ({ queued: "正在排队", running: "正在生成", waiting_for_approval: "等待审批", waiting_for_desktop_approval: "等待桌面审批", completed: "已完成", failed: "已失败", cancelled: "已停止", incomplete: "未完成" })[state] || ""; }
function avatar(agent) { return `<span class="agent-avatar ${agentClass(agent)}">${escapeHtml(agentInitial(agent))}</span>`; }
function icon(name) { return name === "folder" ? '<svg viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6.5Z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>'; }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("toast-show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("toast-show"), 2900); }

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  $("#connection").textContent = "已安全连接";
  $("#connection-detail").textContent = "已连接";
  return body;
}

function page(name) {
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.dataset.page === name));
  document.querySelectorAll("[data-tab]").forEach((element) => element.classList.toggle("active", element.dataset.tab === name));
  $("#session-menu").hidden = true;
  hideModelSheet();
  workspaceSheet(false);
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

function renderSessionList() {
  const query = $("#search").value.trim().toLowerCase();
  const rows = sessions.filter((session) => (selectedFilter === "all" || session.agent === selectedFilter) && (!query || `${session.title} ${session.agent} ${session.project || ""}`.toLowerCase().includes(query)));
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
  renderStatusSummary();
}

function renderStatusSummary() {
  const strip = $("#status-strip");
  const running = sessions.filter((session) => ["running", "queued"].includes(session.state)).length;
  const waiting = pendingApprovals.length;
  if (!running && !waiting) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = `${running ? '<span class="spin"></span>' : ""}${running ? `${running} 个任务正在运行` : ""}${running && waiting ? " · " : ""}${waiting ? `<b>${waiting} 个等待你审批</b>` : ""}`;
}

function renderApprovalInbox() {
  $("#approval-inbox").innerHTML = pendingApprovals.map((approval) => {
    const session = sessions.find((item) => item.id === approval.sessionId);
    const title = session?.title || approval.title || "待审批任务";
    return `<div class="approval-card"><div class="r1"><i></i>${escapeHtml(title)}</div><div class="r2">${escapeHtml(approval.summary)}</div><div class="approval-actions"><button data-approval="${escapeHtml(approval.id)}" data-decision="deny_once" type="button">拒绝</button><button class="allow" data-approval="${escapeHtml(approval.id)}" data-decision="allow_once" type="button">允许一次</button></div></div>`;
  }).join("");
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
    for (const line of lines) {
      if (!line.trim()) { flush(); continue; }
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
function renderToolMessage(message, key) {
  const tool = message.tool || {}; const status = tool.status || "completed";
  const title = tool.title || tool.name || firstLine(message.text) || "工具调用";
  const command = tool.command || "";
  const argumentsText = tool.arguments && tool.arguments !== command ? tool.arguments : "";
  const details = [toolDetailBlock("命令", command, "tool-command"), toolDetailBlock("参数", argumentsText), toolDetailBlock("输出", tool.output, "tool-output"), toolDetailBlock("错误", tool.error, "tool-error")].join("");
  const open = status === "failed" || status === "waiting_for_approval";
  return `<details class="tool status-${escapeHtml(status)}" data-message-key="${escapeHtml(key)}" data-tool-id="${escapeHtml(tool.id || "")}" data-tool-status="${escapeHtml(status)}"${open ? " open" : ""}><summary><span class="ic">⌘</span><span class="tool-head"><b>${escapeHtml(title)}</b><small>${escapeHtml(tool.name && tool.name !== title ? tool.name : command || "点击查看详情")}</small></span><span class="tool-state">${escapeHtml(toolStatusLabel(status))}</span><span class="chevron">⌄</span></summary><div class="tool-detail">${details || '<div class="tool-empty">Agent 未提供命令或参数详情</div>'}</div></details>`;
}
function renderMessage(message, extraClass = "", index = 0) {
  const kind = message.kind || "message"; const key = messageKey(message, index); const text = String(message.text || "");
  if (kind === "thinking") return `<details class="think" data-message-key="${escapeHtml(key)}" data-raw="${escapeHtml(text)}"><summary><i></i><b>思考过程</b><span class="preview">${escapeHtml(firstLine(text)).slice(0, 120)}</span><span class="fold">展开</span><span class="chevron">⌄</span></summary><div class="think-body">${renderRichText(text)}</div></details>`;
  if (message.role === "tool" || kind === "tool") return renderToolMessage(message, key);
  if (message.role === "user") return `<div class="me ${extraClass}" data-message-key="${escapeHtml(key)}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}${extraClass.includes("failed") ? ` data-retry-text="${escapeHtml(text)}"` : ""}><div class="msg-body">${escapeHtml(text)}</div>${extraClass.includes("failed") ? '<button type="button" class="retry-send" data-retry>重试</button>' : ""}</div>`;
  const who = `${escapeHtml(agentLabel(current?.agent || ""))}${current?.model ? ` · ${escapeHtml(current.model)}` : ""}`;
  return `<div class="ai ${extraClass}" data-message-key="${escapeHtml(key)}" data-raw="${escapeHtml(text)}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}><div class="who">${who}</div><div class="msg-body">${renderRichText(text)}</div></div>`;
}
function messageFingerprint(rows = []) { return rows.map((message) => `${message.role || ""}|${message.kind || ""}|${message.text || ""}|${JSON.stringify(message.tool || null)}`).join("\u001f"); }
function renderMessages(rows = []) { $("#messages").innerHTML = rows.map((message, index) => renderMessage(message, "", index)).join(""); lastDetailFingerprint = messageFingerprint(rows); }
function syncMessages(rows = []) {
  const fingerprint = messageFingerprint(rows);
  if (fingerprint === lastDetailFingerprint) return false;
  const follow = shouldFollowConversation(); renderMessages(rows); if (follow) scrollMessages({ force: true, instant: true }); return true;
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
  token = paired.token; localStorage.setItem(TOKEN_KEY, token); history.replaceState({}, document.title, "/");
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

async function loadSessions() {
  const rows = await api(`/mobile/v1/sessions${archivedView ? "?archived=true" : ""}`);
  // Defensive client-side guard for older/lagging mobile services and stale
  // caches: the normal list must never show archived conversations.
  sessions = (Array.isArray(rows) ? rows : []).filter((session) => Boolean(session?.archived) === archivedView);
  renderSessionList();
  renderAgentNotices();
}
async function loadWorkspaces() { workspaces = await api("/mobile/v1/workspaces"); renderWorkspaces(); renderSessionList(); }
async function loadApprovals() { pendingApprovals = await api("/mobile/v1/approvals"); renderApprovalInbox(); renderStatusSummary(); }

let openSessionSeq = 0;
async function openSession(id, { activate = true } = {}) {
  const seq = ++openSessionSeq;
  if (activate) {
    page("detail");
    $("#detail-title").textContent = "载入中…";
    $("#detail-meta").textContent = "";
    $("#messages").innerHTML = '<div class="empty">正在载入会话…</div>';
  }
  const detail = await api(`/mobile/v1/sessions/${encodeURIComponent(id)}`);
  if (seq !== openSessionSeq) return;
  current = detail;
  $("#detail-title").textContent = current.title;
  $("#detail-meta").textContent = `${agentLabel(current.agent)}${current.model ? ` · ${current.model}` : ""}`;
  $("#chat-state-dot").className = current.state || "";
  renderRuntimeShortcut();
  if (activate) { renderMessages(current.messages || []); page("detail"); scrollMessages({ force: true, instant: true }); }
  else syncMessages(current.messages || []);
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
  if (event.type === "message" && event.summary) {
    const role = event.role || "assistant"; const last = $("#messages").lastElementChild;
    if (role === "user" && last?.classList.contains("me") && last.textContent === event.summary) return;
    if (role === "assistant" && last?.classList.contains("ai")) {
      const body = last.querySelector(".msg-body"); const raw = last.dataset.raw || body.textContent || "";
      last.dataset.raw = `${raw}${event.summary}`;
      // Debounce rather than repainting for every token: Markdown becomes rich
      // during the stream without bringing back Grok's full-message flicker.
      scheduleStreamingRichText(last, ".msg-body");
    } else $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role, text: event.summary }));
    scrollMessages();
  }
  if (event.type === "thinking" && event.summary) { const last = $("#messages").lastElementChild; if (last?.classList.contains("think")) { const body = last.querySelector(".think-body"); const raw = last.dataset.raw || body.textContent || ""; last.dataset.raw = `${raw}${event.summary}`; scheduleStreamingRichText(last, ".think-body"); } else $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", kind: "thinking", text: event.summary })); scrollMessages(); }
  if (event.type === "status") {
    const status = String(event.summary || "");
    current.state = status;
    $("#connection").textContent = stateLabel(status) || "已安全连接";
    $("#chat-state-dot").className = status;
  }
  if (event.type === "error") { $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", text: `发送失败：${event.summary}` }, "failed")); toast("消息没有发送成功，请重试"); }
  if (event.type === "tool") {
    const selector = event.tool?.id ? `.tool[data-tool-id="${CSS.escape(event.tool.id)}"]` : "";
    const existing = selector ? $("#messages").querySelector(selector) : null;
    const expanded = existing?.open;
    const html = renderMessage({ id: event.id, role: "tool", kind: "tool", text: event.summary || "正在使用工具", tool: event.tool || null });
    if (existing) { existing.outerHTML = html; const updated = selector ? $("#messages").querySelector(selector) : null; if (updated && expanded) updated.open = true; }
    else $("#messages").insertAdjacentHTML("beforeend", html);
    scrollMessages();
  }
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
  const terminal = new Set(["completed", "failed", "cancelled", "canceled", "incomplete", "end_turn", "stop", "max_tokens", "length"]);
  if (event?.type !== "status" || !terminal.has(String(event.summary || "").toLowerCase())) return;
  if (!current || !isDetailVisible()) return;
  finalizeStreamingMessages();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => openSession(current.id, { activate: false }).catch(() => {}), 900);
}
async function handleEvent(event) {
  if (event.id > eventCursor) { eventCursor = event.id; localStorage.setItem(CURSOR_KEY, String(eventCursor)); }
  if (event.type === "approval") void loadApprovals();
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
    const workspaceMenuButton = event.target.closest("[data-workspace-menu]");
    if (workspaceMenuButton) {
      const menu = workspaceMenuButton.parentElement?.querySelector(".group-menu");
      const opening = Boolean(menu?.hidden);
      closeWorkspaceMenus(menu);
      if (menu) menu.hidden = !opening;
      return;
    }
    if (!event.target.closest(".group-menu")) closeWorkspaceMenus();
    const nav = event.target.closest("[data-nav]"); if (nav) { page(nav.dataset.nav); if (nav.dataset.nav === "sessions") await Promise.all([loadSessions(), loadApprovals()]); if (nav.dataset.nav === "new") { await loadWorkspaces(); renderAgentPicker(); } return; }
    const filter = event.target.closest("[data-filter]"); if (filter) { selectedFilter = filter.dataset.filter; renderFilters(); renderSessionList(); return; }
    const group = event.target.closest("[data-group]"); if (group) { const name = group.dataset.group; collapsedGroups.has(name) ? collapsedGroups.delete(name) : collapsedGroups.add(name); renderSessionList(); return; }
    const agent = event.target.closest("[data-agent]"); if (agent) { selectedAgent = agent.dataset.agent; renderAgentPicker(); await loadModels(); return; }
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
        const session = sessions.find((item) => item.id === id);
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
    const approval = event.target.closest("[data-approval]"); if (approval) { await api(`/mobile/v1/approvals/${encodeURIComponent(approval.dataset.approval)}/resolve`, { method: "POST", body: JSON.stringify({ decision: approval.dataset.decision }) }); return loadApprovals(); }
    const copy = event.target.closest("[data-copy-code]"); if (copy) { await navigator.clipboard?.writeText(decodeURIComponent(copy.dataset.copyCode)); toast("代码已复制"); return; }
    if (event.target.closest("#attach-control")) { $("#attachment-input").click(); return; }
    const removeAttachment = event.target.closest("[data-remove-attachment]"); if (removeAttachment) { activeAttachments.splice(Number(removeAttachment.dataset.removeAttachment), 1); renderAttachments(); return; }
    const action = event.target.dataset.action; if (!action || !current) return;
    let body = {}; if (action === "rename") body.title = prompt("会话名称", current.title) || current.title; if (action === "delete" && !confirm("确认删除这个会话？\n\n部分 Agent 的桌面历史不能物理删除，会从手机列表隐藏。")) return;
    const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST", body: action === "delete" ? undefined : JSON.stringify(body) });
    if (["archive", "delete"].includes(action)) { current = null; page("sessions"); toast(action === "delete" && result?.hiddenOnly ? "已从手机列表移除" : action === "delete" ? "已删除" : "已归档"); return loadSessions(); } if (action === "fork" && result.sessionId) return openSession(result.sessionId); await openSession(current.id);
  } catch (error) { toast(error.message); }
});

$("#refresh").addEventListener("click", () => Promise.all([loadSessions(), loadApprovals()]).catch((error) => toast(error.message)));
$("#show-archive").addEventListener("click", async () => { archivedView = !archivedView; $("#show-archive").textContent = archivedView ? "最近" : "归档"; await loadSessions().catch((error) => toast(error.message)); });
$("#search").addEventListener("input", renderSessionList);
$("#back").addEventListener("click", async () => { current = null; page("sessions"); await loadSessions(); });
$("#new-session").addEventListener("submit", async (event) => { event.preventDefault(); const submit = $("#new-submit"); submit.disabled = true; try { const cwd = selectedWorkspace; if (!selectedAgent) throw new Error("请选择 Agent"); if (!cwd) throw new Error("请选择或输入工作区"); const result = await api("/mobile/v1/sessions", { method: "POST", body: JSON.stringify({ agent: selectedAgent, cwd, model: $("#model-select").value, effort: $("#effort")?.value || "", permissionMode: $("#new-permission")?.value || "", prompt: $("#prompt").value, messageId: crypto.randomUUID() }) }); await openSession(result.sessionId); } catch (error) { toast(error.message); } finally { submit.disabled = false; } });
function renderAttachments() { const preview = $("#attachment-preview"); preview.hidden = !activeAttachments.length; preview.innerHTML = activeAttachments.map((file, index) => `<div class="attachment-chip">${file.kind === "image" ? `<img src="${file.preview}" alt="">` : "<span>FILE</span>"}<strong>${escapeHtml(file.name)}</strong><button type="button" data-remove-attachment="${index}" aria-label="移除附件">×</button></div>`).join(""); }
async function selectAttachments(files) { const next = Array.from(files || []).slice(0, 4 - activeAttachments.length); for (const file of next) { if (file.size > 4 * 1024 * 1024) throw new Error(`${file.name} 超过 4MB 限制`); const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",").at(-1)); reader.onerror = reject; reader.readAsDataURL(file); }); activeAttachments.push({ name: file.name, mimeType: file.type || "text/plain", data, kind: file.type.startsWith("image/") ? "image" : "text", preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" }); } renderAttachments(); }
$("#attachment-input").addEventListener("change", async (event) => { try { await selectAttachments(event.target.files); } catch (error) { toast(error.message); } finally { event.target.value = ""; } });
$("#composer").addEventListener("submit", async (event) => { event.preventDefault(); const input = $("#message"); const text = input.value.trim(); if ((!text && !activeAttachments.length) || !current) return; const id = crypto.randomUUID(); const sentAttachments = activeAttachments; input.value = ""; activeAttachments = []; renderAttachments(); $("#send").disabled = true; $("#messages").insertAdjacentHTML("beforeend", renderMessage({ id, role: "user", text: `${text}${text && sentAttachments.length ? "\n" : ""}${sentAttachments.map((file) => `📎 ${file.name}`).join("\n")}` })); $("#connection").textContent = "正在发送"; scrollMessages(); try { await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/messages`, { method: "POST", body: JSON.stringify({ text, attachments: sentAttachments.map(({ name, mimeType, data }) => ({ name, mimeType, data })), messageId: id }) }); $("#connection").textContent = "正在生成"; input.blur(); } catch (error) { document.querySelector(`[data-message-id="${id}"]`)?.classList.add("failed"); input.value = text; activeAttachments = sentAttachments; renderAttachments(); toast(error.message); } finally { $("#send").disabled = false; } });
$("#revoke").addEventListener("click", async () => { if (!confirm("确定撤销这台手机的访问权限？")) return; await api("/mobile/v1/devices/self/revoke", { method: "POST" }); eventLoopStopped = true; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(CURSOR_KEY); token = ""; location.reload(); });

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

async function boot() { try { hideModelSheet(); bindSwipe(); await pair(); if (!token) { $("#connection").textContent = "等待配对"; return; } await Promise.all([loadAgents(), loadSessions(), loadWorkspaces(), loadApprovals()]); connectEvents(); if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js"); } catch (error) { $("#connection").textContent = "连接失败"; toast(error.message); } }
boot();

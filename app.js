const $ = (selector) => document.querySelector(selector);
const TOKEN_KEY = "switchyard_mobile_token";
const CURSOR_KEY = "switchyard_mobile_event_cursor";
let token = localStorage.getItem(TOKEN_KEY) || "";
let eventCursor = Number(localStorage.getItem(CURSOR_KEY) || 0);
let current = null;
let eventLoopStopped = false;
let refreshTimer = null;

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("toast-show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("toast-show"), 2800);
}

function agentInitial(agent) {
  return ({ codex: "C", claude: "CL", grok: "G", opencode: "OC" })[String(agent).toLowerCase()] || String(agent || "A").slice(0, 2).toUpperCase();
}

function stateLabel(state) {
  return ({ queued: "正在排队", running: "正在生成", waiting_for_approval: "等待审批", completed: "已完成", failed: "已失败", cancelled: "已停止", incomplete: "未完成" })[state] || "";
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.body) headers["content-type"] = "application/json";
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  $("#connection").textContent = "已连接";
  return body;
}

function page(name) {
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.dataset.page === name));
  $("#session-menu").hidden = true;
}

function renderMessage(message, extraClass = "") {
  return `<div class="message ${escapeHtml(message.role || "assistant")} ${extraClass}"${message.id ? ` data-message-id="${escapeHtml(message.id)}"` : ""}>${escapeHtml(message.text || "")}</div>`;
}

function scrollMessages() {
  requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function renderSessionList(sessions) {
  const query = $("#search").value.trim().toLowerCase();
  const filtered = sessions.filter((session) => !query || `${session.title} ${session.agent} ${session.project || ""}`.toLowerCase().includes(query));
  $("#session-list").innerHTML = filtered.map((session) => `
    <button class="session-row" data-id="${escapeHtml(session.id)}">
      <span class="agent-avatar">${escapeHtml(agentInitial(session.agent))}</span>
      <span class="session-copy"><span class="session-title">${escapeHtml(session.title)}</span><span class="session-subtitle">${escapeHtml(session.agent)}${session.model ? ` · ${escapeHtml(session.model)}` : ""}${session.project ? ` · ${escapeHtml(session.project)}` : ""}</span></span>
      <span class="state-dot ${escapeHtml(session.state)}" title="${escapeHtml(stateLabel(session.state))}"></span>
    </button>`).join("") || '<div class="empty">还没有可继续的会话</div>';
}

async function pair() {
  const challenge = new URLSearchParams(location.search).get("challenge");
  if (!challenge || token) return;
  const name = prompt("设备名称", "我的手机") || "移动设备";
  const paired = await api("/mobile/pair/complete", { method: "POST", body: JSON.stringify({ challenge, name }) });
  token = paired.token;
  localStorage.setItem(TOKEN_KEY, token);
  history.replaceState({}, document.title, "/");
}

async function loadAgents() {
  const agents = await api("/mobile/v1/agents");
  $("#agent-select").innerHTML = agents.filter((agent) => agent.available).map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}</option>`).join("");
  await loadModels();
}

async function loadModels() {
  const agent = $("#agent-select").value;
  if (!agent) return;
  const models = await api(`/mobile/v1/models?agent=${encodeURIComponent(agent)}`);
  $("#model-select").innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)} · ${escapeHtml(model.provider)}</option>`).join("");
}

async function loadSessions() {
  renderSessionList(await api("/mobile/v1/sessions"));
}

async function loadApprovals() {
  const approvals = await api("/mobile/v1/approvals");
  $("#approval-list").innerHTML = approvals.map((approval) => `<div class="settings-row"><strong>${escapeHtml(approval.title)}</strong><p>${escapeHtml(approval.summary)}</p><p><button data-approval="${escapeHtml(approval.id)}" data-decision="deny_once">拒绝</button> <button data-approval="${escapeHtml(approval.id)}" data-decision="allow_once">允许一次</button></p></div>`).join("") || '<div class="empty">暂无可在手机处理的低风险审批</div>';
}

async function openSession(id) {
  current = await api(`/mobile/v1/sessions/${encodeURIComponent(id)}`);
  $("#detail-title").textContent = current.title;
  $("#detail-meta").textContent = `${current.agent}${current.model ? ` · ${current.model}` : ""}`;
  $("#messages").innerHTML = (current.messages || []).map(renderMessage).join("");
  const models = await api(`/mobile/v1/models?agent=${encodeURIComponent(current.agent)}`);
  $("#session-model-select").innerHTML = models.map((model) => `<option value="${escapeHtml(model.id)}" ${model.id === current.model ? "selected" : ""}>${escapeHtml(model.name)}</option>`).join("");
  page("detail");
  scrollMessages();
}

function appendEvent(event) {
  if (!current || event.sessionId !== current.id) return;
  if (event.type === "message" && event.summary) {
    const role = event.role || "assistant";
    const last = $("#messages").lastElementChild;
    if (role === "user" && last?.classList.contains("user") && last.textContent === event.summary) return;
    if (role === "assistant" && last?.classList.contains("assistant")) last.textContent += event.summary;
    else $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role, text: event.summary }));
    scrollMessages();
  }
  if (event.type === "status") $("#connection").textContent = stateLabel(event.summary) || "已连接";
  if (event.type === "error") {
    $("#connection").textContent = "发送失败";
    $("#messages").insertAdjacentHTML("beforeend", renderMessage({ role: "assistant", text: `发送失败：${event.summary}` }, "failed"));
    toast("消息没有发送成功，请重试");
  }
  if (event.type === "tool") {
    $("#messages").insertAdjacentHTML("beforeend", `<div class="message tool">${escapeHtml(event.summary || "正在使用工具")}</div>`);
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try { if (current) await openSession(current.id); else await loadSessions(); } catch {}
  }, 1200);
}

async function handleEvent(event) {
  if (event.id > eventCursor) {
    eventCursor = event.id;
    localStorage.setItem(CURSOR_KEY, String(eventCursor));
  }
  if (event.type === "approval") void loadApprovals();
  appendEvent(event);
  scheduleRefresh();
}

async function readEventStream(response) {
  if (!response.ok || !response.body) throw new Error(`事件流 HTTP ${response.status}`);
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }); let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) await handleEvent(JSON.parse(data));
    }
  }
}

async function connectEvents() {
  while (token && !eventLoopStopped) {
    const controller = new AbortController(); const reconnect = setTimeout(() => controller.abort(), 20_000);
    try { await readEventStream(await fetch(`/mobile/v1/events?after=${eventCursor}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal: controller.signal })); }
    catch (error) { if (error.name !== "AbortError") $("#connection").textContent = "正在重连"; }
    finally { clearTimeout(reconnect); }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

document.addEventListener("click", async (event) => {
  try {
    const nav = event.target.closest("[data-nav]");
    if (nav) { page(nav.dataset.nav); if (nav.dataset.nav === "sessions") await loadSessions(); if (nav.dataset.nav === "approvals") await loadApprovals(); return; }
    const card = event.target.closest("[data-id]"); if (card) return openSession(card.dataset.id);
    if (event.target.closest("#more")) { $("#session-menu").hidden = !$("#session-menu").hidden; return; }
    const approval = event.target.closest("[data-approval]");
    if (approval) { await api(`/mobile/v1/approvals/${encodeURIComponent(approval.dataset.approval)}/resolve`, { method: "POST", body: JSON.stringify({ decision: approval.dataset.decision }) }); return loadApprovals(); }
    const action = event.target.dataset.action; if (!action || !current) return;
    let body = {}; if (action === "rename") body.title = prompt("会话名称", current.title) || current.title;
    if (action === "delete" && !confirm("确认删除这个会话？")) return;
    const result = await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST", body: action === "delete" ? undefined : JSON.stringify(body) });
    if (["archive", "delete"].includes(action)) { current = null; page("sessions"); return loadSessions(); }
    if (action === "fork" && result.sessionId) return openSession(result.sessionId);
    await openSession(current.id);
  } catch (error) { $("#connection").textContent = "操作失败"; toast(error.message); }
});

$("#agent-select").addEventListener("change", loadModels);
$("#refresh").addEventListener("click", () => loadSessions().catch((error) => toast(error.message)));
$("#search").addEventListener("input", () => loadSessions().catch(() => {}));
$("#back").addEventListener("click", async () => { current = null; page("sessions"); await loadSessions(); });
$("#new-session").addEventListener("submit", async (event) => {
  event.preventDefault(); const submit = $("#new-submit"); submit.disabled = true;
  try {
    const result = await api("/mobile/v1/sessions", { method: "POST", body: JSON.stringify({ agent: $("#agent-select").value, cwd: $("#cwd").value, model: $("#model-select").value, effort: $("#effort").value, prompt: $("#prompt").value, messageId: crypto.randomUUID() }) });
    await openSession(result.sessionId);
  } catch (error) { toast(error.message); } finally { submit.disabled = false; }
});
$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#message"); const text = input.value.trim(); if (!text || !current) return;
  const id = crypto.randomUUID(); input.value = ""; $("#send").disabled = true; $("#composer").classList.add("sending");
  $("#messages").insertAdjacentHTML("beforeend", renderMessage({ id, role: "user", text })); $("#connection").textContent = "正在发送"; scrollMessages();
  try { await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/messages`, { method: "POST", body: JSON.stringify({ text, messageId: id }) }); $("#connection").textContent = "正在生成"; }
  catch (error) { const bubble = document.querySelector(`[data-message-id="${id}"]`); bubble?.classList.add("failed"); input.value = text; $("#connection").textContent = "发送失败"; toast(error.message); }
  finally { $("#send").disabled = false; $("#composer").classList.remove("sending"); input.focus(); }
});
$("#session-model-apply").addEventListener("click", async () => {
  try { await api(`/mobile/v1/sessions/${encodeURIComponent(current.id)}/model`, { method: "POST", body: JSON.stringify({ model: $("#session-model-select").value }) }); $("#model-note").textContent = "下一轮已切换"; toast("模型将在下一轮生效"); } catch (error) { toast(error.message); }
});
$("#revoke").addEventListener("click", async () => { await api("/mobile/v1/devices/self/revoke", { method: "POST" }); eventLoopStopped = true; localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(CURSOR_KEY); token = ""; location.reload(); });

async function boot() {
  try { await pair(); if (!token) return void ($("#connection").textContent = "等待配对"); await Promise.all([loadAgents(), loadSessions(), loadApprovals()]); connectEvents(); if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js"); }
  catch (error) { $("#connection").textContent = "连接失败"; toast(error.message); }
}
boot();

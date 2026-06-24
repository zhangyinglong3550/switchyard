import { filterDiscoveryModels } from "./discovery-filter.mjs";
import { modelIdConflict } from "./model-form-utils.mjs";
import { normalizeDiscoveredModelForProvider, selectedImportResult as buildSelectedImportResult } from "./import-selection-utils.mjs";
import { buildTestRequest, parseTestMessages } from "../src/test-console.mjs";

const { invoke, onLog } = window.lls;

const state = {
  config: null,
  status: { running: false },
  filter: { models: "", providerDiscovery: "" },
  providerDiscovery: [],
  providerPresets: [],
  importShowKeys: false,
  importSelection: { providers: new Set(), models: new Set() },
  textEditor: null,
  sessionRaw: "",
  skillLink: null,
  skillHub: { items: [], install: null, detail: null },
  plugins: { sources: [], marketplaces: [], installed: [], available: [] },
  coreFiles: { items: [], current: null },
  compatPacks: [],
  providerHealth: {},
  diagnostics: null,
  usageRequests: [],
  lastCapabilitySuggestion: null,
  traces: { sessions: [], requests: [], selected: null },
  usageRange: defaultUsageRange(),
  liveLogAgent: ""
};

const toast = (msg) => {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2000);
};

const PROTOCOL_LABEL = {
  openai_chat: "OpenAI Chat",
  openai_responses: "OpenAI Responses",
  anthropic_messages: "Anthropic Messages"
};

const PROTOCOL_HELP = {
  openai_chat: "最通用，适合大多数 OpenAI-compatible / 中转服务",
  openai_responses: "OpenAI 新协议，Codex 和新版 OpenAI 更适合这条链路",
  anthropic_messages: "Claude / Claude Code 原生协议"
};

const CAPABILITY_LABEL = {
  text: "文本",
  tools: "工具调用",
  reasoning: "思考",
  images: "图片",
  stream: "流式",
  multimodal: "多模态"
};

const AUTH_MODE_LABEL = {
  api_key: "API Key",
  keychain: "系统安全存储",
  codex_oauth: "Codex OAuth",
  none: "无需认证"
};

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function defaultUsageRange() {
  const until = new Date();
  const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { preset: "7d", since: since.toISOString(), until: until.toISOString(), compareEnabled: false, compareSince: "", compareUntil: "" };
}

function dateInputValue(date) {
  if (!date) return "";
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function endOfDateInput(value) {
  if (!value) return "";
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(year, month - 1, day, 23, 59, 59, 999);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function startOfDateInput(value) {
  if (!value) return "";
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatLocalTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function setActiveTab(tab) {
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab}`));
  if (tab === "logs") refreshLogTail().catch(() => {});
  if (tab === "traces") renderLiveLogs();
  if (tab === "diagnostics") refreshDiagnostics().catch(() => {});
}

document.querySelectorAll(".nav a").forEach((a) => {
  a.addEventListener("click", () => setActiveTab(a.dataset.tab));
});

async function refreshAll() {
  const [config, status, configPath, presets, compatPacks, providerHealth] = await Promise.all([
    invoke("config:read"),
    invoke("gateway:status"),
    invoke("config:file"),
    invoke("provider:presets"),
    invoke("compat:packs"),
    invoke("provider-health:list").catch(() => ({}))
  ]);
  state.config = config;
  state.status = status;
  state.configPath = configPath;
  state.providerPresets = presets || [];
  state.compatPacks = compatPacks || [];
  state.providerHealth = providerHealth || {};
  renderProviderPresetOptions();
  renderHeader();
  renderOverview();
  renderProviders();
  renderModels();
  renderClients();
  renderSettings();
  syncUsageRangeControls();
  renderUsageRangeSummary();
  try { refreshTestModelOptions(); } catch {}
  try { refreshUsageStats(); } catch {}
  try { refreshDiagnostics(); } catch {}
  try { refreshLogTail(); } catch {}
  try { refreshAgentSessions(); } catch {}
  try { refreshAgentSkills(); } catch {}
  try { refreshAgentPlugins(); } catch {}
  try { refreshCoreFiles(); } catch {}
  try { refreshTraces(); } catch {}
}

function renderHeader() {
  const { config, status } = state;
  document.getElementById("nav-providers-count").textContent = config.providers.length;
  document.getElementById("nav-models-count").textContent = config.models.length;
  const pill = document.getElementById("service-pill");
  if (status.running) {
    pill.className = "status-pill running";
    document.getElementById("service-state").textContent = "运行中";
    document.getElementById("service-port").textContent = `端口 ${status.port}`;
    document.getElementById("service-endpoint").textContent = `${status.host}:${status.port}`;
  } else {
    pill.className = "status-pill stopped";
    document.getElementById("service-state").textContent = "未启动";
    document.getElementById("service-port").textContent = "-";
    document.getElementById("service-endpoint").textContent = "-";
  }
}

function renderOverview() {
  const { config, status, configPath } = state;
  document.getElementById("ov-running").textContent = status.running ? "运行中" : "未启动";
  document.getElementById("ov-endpoint").textContent = status.running ? `${status.host}:${status.port}` : "-";
  document.getElementById("ov-config").textContent = configPath || "-";
  document.getElementById("ov-providers").textContent = config.providers.length;
  document.getElementById("ov-models").textContent = config.models.length;
  const ready = config.providers.filter((p) => p.apiKey || (p.apiKeyEnv && false)).length; // env presence checked in main
  document.getElementById("overview-subtitle").textContent =
    `共 ${config.providers.length} 个供应商 · ${config.models.length} 个模型`;

  const ovEndpoints = document.getElementById("ov-endpoints");
  ovEndpoints.innerHTML = "";
  if (!status.running) {
    ovEndpoints.innerHTML = `<div class="tiny muted">启动后显示客户端接入地址</div>`;
    return;
  }
  const base = `http://${status.host}:${status.port}`;
  const rows = [
    ["Codex", `${base}/codex/v1`],
    ["Claude Code", `${base}/claude-code`],
    ["Hermes", `${base}/hermes/v1`],
    ["通用 OpenAI", `${base}/v1`]
  ];
  for (const [label, url] of rows) {
    const row = document.createElement("div");
    row.className = "endpoint-row";
    row.innerHTML = `<span class="label">${escapeHtml(label)}</span><span class="mono">${escapeHtml(url)}</span><button class="btn icon" title="复制">⎘</button>`;
    row.querySelector("button").addEventListener("click", () => {
      navigator.clipboard.writeText(url).then(() => toast(`已复制：${url}`));
    });
    ovEndpoints.appendChild(row);
  }
}

function renderProviderPresetOptions(selectedId = "") {
  const select = document.getElementById("provider-preset-select");
  if (!select) return;
  const current = selectedId || select.value;
  select.innerHTML = [
    `<option value="">自定义供应商</option>`,
    ...state.providerPresets.map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label || preset.name || preset.id)}</option>`)
  ].join("");
  if (current && state.providerPresets.some((preset) => preset.id === current)) select.value = current;
}

function providerPresetById(id) {
  return state.providerPresets.find((preset) => preset.id === id) || null;
}

function renderAuthModeOptions(preset, selected = "api_key") {
  const select = document.getElementById("provider-auth-mode");
  if (!select) return;
  const modes = preset?.authModes?.length ? Array.from(new Set([...preset.authModes, "keychain"])) : ["api_key", "keychain", "none"];
  const current = modes.includes(selected) ? selected : (preset?.defaultAuthMode || modes[0] || "api_key");
  select.innerHTML = modes.map((mode) => `<option value="${escapeHtml(mode)}">${escapeHtml(AUTH_MODE_LABEL[mode] || mode)}</option>`).join("");
  select.value = current;
  syncProviderAuthControls();
}

function presetBaseUrlForAuth(preset, authMode) {
  if (!preset) return "";
  if (authMode === "api_key" && preset.apiKeyBaseUrl) return preset.apiKeyBaseUrl;
  if (authMode === "codex_oauth" && preset.baseUrl) return preset.baseUrl;
  return preset.baseUrl || "";
}

function syncProviderAuthControls() {
  const mode = document.getElementById("provider-auth-mode")?.value || "api_key";
  const preset = providerPresetById(document.getElementById("provider-preset-select")?.value);
  const baseUrl = presetBaseUrlForAuth(preset, mode);
  if (baseUrl) document.getElementById("provider-form").querySelector('[name="baseUrl"]').value = baseUrl;
  const keyFields = document.getElementById("provider-key-fields");
  const note = document.getElementById("provider-auth-note");
  if (!keyFields || !note) return;
  const needsKey = mode === "api_key" || mode === "keychain";
  keyFields.style.display = needsKey ? "" : "none";
  note.style.display = mode === "api_key" ? "none" : "";
  note.textContent = mode === "keychain"
    ? "已选择系统安全存储：macOS 使用 Keychain，Windows 使用当前用户 DPAPI 加密存储；配置文件只保存引用，不保存明文。"
    : mode === "codex_oauth"
    ? "已选择 Codex OAuth：Switchyard 会复用本机 codex login 的登录态，不需要在这里填写 API Key。"
    : "已选择无需认证：适合 Ollama、LM Studio 等本机服务。";
}

function applyProviderPreset(preset) {
  if (!preset) return;
  const form = document.getElementById("provider-form");
  const editing = Boolean(form._editId);
  if (!editing) form.querySelector('[name="id"]').value = preset.providerId || preset.id || "";
  form.querySelector('[name="name"]').value = preset.name || preset.label || "";
  form.querySelector('[name="apiFormat"]').value = preset.apiFormat || "openai_chat";
  form.querySelector('[name="apiKeyEnv"]').value = preset.apiKeyEnv || "";
  renderAuthModeOptions(preset, preset.defaultAuthMode || "api_key");
}

function providerAuthCell(provider) {
  if (provider.authMode === "codex_oauth") return '<span class="chip good">Codex OAuth</span>';
  if (provider.authMode === "keychain" || provider.keychainAccount) return '<span class="chip good">安全存储</span>';
  if (provider.authMode === "none") return '<span class="chip good">无需认证</span>';
  if (provider.apiKey) return '<span class="chip warn">inline · 仅本机</span>';
  if (provider.apiKeyEnv) return `<span class="chip good">环境变量 · ${escapeHtml(provider.apiKeyEnv)}</span>`;
  return '<span class="chip warn">未配置</span>';
}

function compatPacksHtml(ids = []) {
  const selected = Array.isArray(ids) ? ids : [];
  if (!selected.length) return "";
  const byId = new Map((state.compatPacks || []).map((pack) => [pack.id, pack]));
  return selected.map((id) => `<span class="chip">${escapeHtml(byId.get(id)?.label || id)}</span>`).join("");
}

function providerRouteExtrasCell(provider) {
  const chips = [];
  if (state.providerHealth?.[provider.id]) chips.push(healthChip(state.providerHealth[provider.id]));
  if (provider.proxyUrl) chips.push(`<span class="chip good">Provider 代理</span>`);
  if (provider.routingMode && provider.routingMode !== "auto") {
    chips.push(`<span class="chip">${provider.routingMode === "native" ? "强制原生" : "强制转换"}</span>`);
  }
  const packs = compatPacksHtml(provider.compatPacks || []);
  if (packs) chips.push(packs);
  return chips.length ? `<div class="chip-row compact">${chips.join("")}</div>` : '<span class="tiny muted">-</span>';
}

function renderProviders() {
  const { config } = state;
  const counts = {};
  for (const m of config.models) counts[m.providerId] = (counts[m.providerId] || 0) + 1;
  document.getElementById("providers-subtitle").textContent = `${config.providers.length} 个供应商 · ${config.models.length} 个模型`;
  const tbody = document.getElementById("providers-tbody");
  tbody.innerHTML = "";
  for (const p of config.providers) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(p.id)}</td>
      <td>${escapeHtml(p.name || p.id)}</td>
      <td>
        <div style="display:flex; flex-direction:column; gap:2px;">
          <span class="chip">${escapeHtml(PROTOCOL_LABEL[p.apiFormat] || p.apiFormat)}</span>
          <span class="tiny muted">${escapeHtml(PROTOCOL_HELP[p.apiFormat] || "")}</span>
        </div>
      </td>
      <td class="mono">${escapeHtml(p.baseUrl)}</td>
      <td>${providerAuthCell(p)}</td>
      <td>${providerRouteExtrasCell(p)}</td>
      <td>${counts[p.id] || 0}</td>
      <td><div class="row-actions" style="display:flex; gap:4px;"><button class="btn" data-edit="${escapeHtml(p.id)}">编辑</button><button class="btn danger" data-del="${escapeHtml(p.id)}">删除</button></div></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openProviderDialog(b.dataset.edit)));
  tbody.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeProvider(b.dataset.del)));
}

function renderModels() {
  const { config, filter } = state;
  document.getElementById("models-subtitle").textContent = `${config.models.length} 个模型`;
  const tbody = document.getElementById("models-tbody");
  tbody.innerHTML = "";
  const q = (filter.models || "").trim().toLowerCase();
  const filtered = config.models.filter((m) => {
    if (!q) return true;
    return m.id.toLowerCase().includes(q) ||
      m.upstreamModel.toLowerCase().includes(q) ||
      (m.aliases || []).some((a) => a.toLowerCase().includes(q));
  });
  for (const m of filtered) {
    const tr = document.createElement("tr");
    const caps = [
      Object.entries(m.capabilities || {}).filter(([_k, v]) => v).map(([k]) => `<span class="chip">${k}</span>`).join(" "),
      compatPacksHtml(m.compatPacks || [])
    ].filter(Boolean).join(" ");
    const aliases = (m.aliases || []).map((a) => `<span class="chip">${escapeHtml(a)}</span>`).join(" ") || '<span class="tiny muted">—</span>';
    tr.innerHTML = `
      <td class="mono">${escapeHtml(m.id)}</td>
      <td class="mono">${escapeHtml(m.providerId)}</td>
      <td class="mono">${escapeHtml(m.upstreamModel)}</td>
      <td>${aliases}</td>
      <td class="chip-row">${caps}</td>
      <td><div class="row-actions" style="display:flex; gap:4px;"><button class="btn" data-edit-model="${escapeHtml(m.id)}">编辑</button><button class="btn danger" data-del-model="${escapeHtml(m.id)}">删除</button></div></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll("[data-edit-model]").forEach((b) => b.addEventListener("click", () => openModelDialog(b.dataset.editModel)));
  tbody.querySelectorAll("[data-del-model]").forEach((b) => b.addEventListener("click", () => removeModel(b.dataset.delModel)));
}

const PROFILE_META = {
  codex: { label: "Codex", file: "~/.codex/config.toml", entry: "/codex/v1", note: "写入 model_provider = custom、model_catalog_json，并指向 Switchyard Responses 入口；备份保存在 ~/.switchyard/backups/" },
  "claude-code": { label: "Claude Code", file: "~/.claude/settings.json", entry: "/claude-code", note: "写入 env.ANTHROPIC_BASE_URL；ANTHROPIC_AUTH_TOKEN 读取 ${SWITCHYARD_KEY}" },
  hermes: { label: "Hermes", file: "~/.hermes/config.json", entry: "/hermes/v1", note: "写入 baseUrl，apiKeyEnv = SWITCHYARD_KEY" }
};

const CLAUDE_CODE_MAPPING_SLOTS = [
  ["default", "Default"],
  ["haiku", "Haiku"],
  ["sonnet", "Sonnet"],
  ["opus", "Opus"],
  ["fable", "Fable"]
];

function providerDisplayName(providerId) {
  const provider = (state.config?.providers || []).find((item) => item.id === providerId);
  return provider?.name || provider?.id || providerId || "";
}

function modelDisplayName(model) {
  const base = String(model?.displayName || model?.upstreamModel || model?.id || "").trim() || model?.id || "";
  const provider = providerDisplayName(model?.providerId);
  if (!provider) return base;
  return `${base} · ${provider}`;
}

function renderModelSelectOptions(models, selected, { autoLabel = "自动选择" } = {}) {
  const options = [`<option value="">${escapeHtml(autoLabel)}</option>`];
  for (const model of models || []) {
    const id = model.id || "";
    options.push(`<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(modelDisplayName(model))}</option>`);
  }
  return options.join("");
}

function renderClaudeCodeMapping(filter, visible) {
  const mapping = filter?.modelMapping || {};
  return `
    <div class="client-mapping">
      <div class="client-mapping-head">
        <div>
          <div class="callout-title">Claude Code 模型槽位</div>
          <div class="callout-body">显式指定 Default / Haiku / Sonnet / Opus / Fable 映射，避免自动顺序选到不可用模型。</div>
        </div>
        <button class="btn" data-claude-map-save>保存映射</button>
      </div>
      <div class="client-mapping-grid">
        ${CLAUDE_CODE_MAPPING_SLOTS.map(([slot, label]) => `
          <label>${escapeHtml(label)}
            <select class="field" data-claude-map-slot="${escapeHtml(slot)}">
              ${renderModelSelectOptions(visible, mapping[slot] || "")}
            </select>
          </label>
        `).join("")}
      </div>
    </div>
  `;
}

function renderClients() {
  const { config } = state;
  const grid = document.getElementById("clients-grid");
  grid.innerHTML = "";
  const clients = Object.entries(config.clients || {});
  for (const [id, filter] of clients) {
    const visible = (filter.allowedModels || []).includes("*")
      ? config.models
      : config.models.filter((m) => (filter.allowedModels || []).includes(m.id) || (m.aliases || []).some((a) => (filter.allowedModels || []).includes(a)));
    const meta = PROFILE_META[id];
    const div = document.createElement("div");
    div.className = "card";
    const mappingHtml = id === "claude-code" ? renderClaudeCodeMapping(filter, visible) : "";
    const historyActions = id === "codex" ? `
        <button class="btn" data-history-unify-preview>预览历史统一</button>
        <button class="btn" data-history-unify-apply>统一会话历史</button>
    ` : "";
    const actionsHtml = meta ? `
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button class="btn" data-profile-preview="${escapeHtml(id)}">预览</button>
        <button class="btn primary" data-profile-apply="${escapeHtml(id)}">一键写入</button>
        <button class="btn" data-profile-restore="${escapeHtml(id)}">恢复备份</button>
        ${historyActions}
      </div>
      <div class="tiny muted" style="margin-top:6px;">${escapeHtml(meta.note)}</div>
    ` : "";
    div.innerHTML = `
      <div class="hd"><h3>${escapeHtml(meta?.label || id)}</h3><span class="sub">${filter.enabled === false ? "已停用" : "启用中"} · ${visible.length} 个模型</span></div>
      <div class="bd">
        <dl class="kv" style="margin:0 0 6px;">
          <dt>客户端 ID</dt><dd class="mono">${escapeHtml(id)}</dd>
          ${meta ? `<dt>入口路径</dt><dd class="mono">${escapeHtml(meta.entry)}</dd>` : ""}
          ${meta ? `<dt>配置文件</dt><dd class="mono">${escapeHtml(meta.file)}</dd>` : ""}
        </dl>
        <div class="tiny muted" style="margin-bottom:6px;">allowedModels：${(filter.allowedModels || []).map(escapeHtml).join(", ")}</div>
        <div style="display:flex; flex-wrap:wrap; gap:4px;">${visible.slice(0, 8).map((m) => `<span class="chip">${escapeHtml(m.id)}</span>`).join("")}${visible.length > 8 ? `<span class="tiny muted">…共 ${visible.length}</span>` : ""}</div>
        ${mappingHtml}
        ${actionsHtml}
      </div>
    `;
    grid.appendChild(div);
  }
  grid.querySelectorAll("[data-profile-preview]").forEach((b) => b.addEventListener("click", () => profilePreview(b.dataset.profilePreview)));
  grid.querySelectorAll("[data-profile-apply]").forEach((b) => b.addEventListener("click", () => profileApply(b.dataset.profileApply)));
  grid.querySelectorAll("[data-profile-restore]").forEach((b) => b.addEventListener("click", () => profileRestore(b.dataset.profileRestore)));
  grid.querySelectorAll("[data-claude-map-save]").forEach((b) => b.addEventListener("click", () => saveClaudeCodeModelMapping(b.closest(".card"))));
  grid.querySelectorAll("[data-history-unify-preview]").forEach((b) => b.addEventListener("click", () => codexHistoryUnifyPreview()));
  grid.querySelectorAll("[data-history-unify-apply]").forEach((b) => b.addEventListener("click", () => codexHistoryUnifyApply()));
}

function statusChip(status) {
  const cls = status === "ok" ? "good" : status === "missing" ? "warn" : status === "drifted" ? "warn" : "";
  const label = { ok: "正常", drifted: "漂移", missing: "缺失", unreadable: "不可读" }[status] || status || "-";
  return `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
}

function capabilityChips(capabilities = {}) {
  const caps = Object.entries(capabilities).filter(([_key, value]) => value);
  return caps.length
    ? caps.map(([key]) => `<span class="chip">${escapeHtml(CAPABILITY_LABEL[key] || key)}</span>`).join("")
    : '<span class="tiny muted">未声明</span>';
}

function healthChip(health) {
  if (!health?.status || health.status === "unknown") return '<span class="chip">健康未知</span>';
  if (health.status === "checking") return '<span class="chip">检查中</span>';
  if (health.status === "healthy") return `<span class="chip good">健康 · ${escapeHtml(health.latencyMs ?? "-")} ms</span>`;
  return `<span class="chip warn">异常 · ${escapeHtml(health.statusCode || "n/a")}</span>`;
}

async function refreshDiagnostics() {
  const output = document.getElementById("diagnostics-output");
  const canWriteOutput = output && output.dataset.mode !== "probe";
  if (canWriteOutput) {
    output.dataset.mode = "diagnostics";
    output.textContent = "正在运行诊断…";
  }
  const result = await invoke("diagnostics:run");
  state.diagnostics = result;
  renderDiagnostics();
  if (canWriteOutput) {
    output.textContent = "诊断完成。选择模型后点击“运行探针”，结果会在这里展开显示。";
  }
}

function renderDiagnostics() {
  const data = state.diagnostics;
  if (!data) return;
  const clientGrid = document.getElementById("diagnostics-client-grid");
  if (clientGrid) {
    const clients = [
      ["codex", "Codex"],
      ["claude-code", "Claude Code"],
      ["hermes", "Hermes"]
    ];
    clientGrid.innerHTML = clients.map(([id, label]) => {
      const row = data.clients?.[id] || {};
      const repair = row.status && row.status !== "ok"
        ? `<button class="btn primary" data-diagnostic-client-repair="${escapeHtml(id)}">修复配置</button>`
        : "";
      return `
        <div class="card diagnostic-card">
          <div class="hd"><h3>${escapeHtml(label)}</h3>${statusChip(row.status)}</div>
          <div class="bd">
            <div class="tiny muted">${escapeHtml(row.label || "-")}</div>
            <div class="mono tiny">${escapeHtml(row.expected || "")}</div>
            ${row.missing?.length ? `<div class="chip-row compact">${row.missing.map((item) => `<span class="chip warn">${escapeHtml(item)}</span>`).join("")}</div>` : ""}
            ${repair}
          </div>
        </div>
      `;
    }).join("");
    clientGrid.querySelectorAll("[data-diagnostic-client-repair]").forEach((button) => {
      button.addEventListener("click", async () => {
        await profileApply(button.dataset.diagnosticClientRepair);
        await refreshDiagnostics();
      });
    });
  }
  const providers = document.getElementById("diagnostics-providers");
  if (providers) {
    providers.innerHTML = (data.providers || []).map((provider) => `
      <div class="diagnostic-row">
        <div>
          <strong>${escapeHtml(provider.name || provider.id)}</strong>
          <div class="tiny muted mono">${escapeHtml(provider.baseUrl || "-")}</div>
        </div>
        <div class="chip-row compact">
          <span class="chip">${escapeHtml(PROTOCOL_LABEL[provider.apiFormat] || provider.apiFormat)}</span>
          <span class="chip ${provider.keyOk ? "good" : "warn"}">${escapeHtml(provider.keySource || "-")}</span>
          <span class="chip ${provider.ready ? "good" : "warn"}">${provider.ready ? "可用" : "未就绪"}</span>
          ${healthChip(provider.health)}
        </div>
        ${provider.health?.error ? `<div class="tiny muted">${escapeHtml(provider.health.error).slice(0, 180)}</div>` : ""}
      </div>
    `).join("") || '<div class="empty-state">暂无供应商</div>';
  }
  const providerSummary = document.getElementById("diagnostics-provider-summary");
  if (providerSummary) {
    const ready = (data.providers || []).filter((provider) => provider.ready).length;
    providerSummary.textContent = `${ready} / ${data.providers?.length || 0} 就绪`;
  }
  const errors = document.getElementById("diagnostics-errors");
  if (errors) {
    errors.innerHTML = (data.recentErrors || []).map((row, index) => `
      <div class="diagnostic-row">
        <div>
          <strong>${escapeHtml(row.modelId || "-")}</strong>
          <div class="tiny muted">${escapeHtml(formatDate(row.ts))} · status ${escapeHtml(row.status || "-")}</div>
          <div class="tiny muted">${escapeHtml(row.classification?.title || row.error || "-")}</div>
        </div>
        <div class="row-actions">
          <span class="chip warn">${escapeHtml(row.classification?.category || "unknown")}</span>
          <button class="btn" data-diagnostic-replay="${index}">草稿回放</button>
        </div>
      </div>
    `).join("") || '<div class="empty-state">最近没有失败请求</div>';
    errors.querySelectorAll("[data-diagnostic-replay]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = data.recentErrors[Number(button.dataset.diagnosticReplay)]?.id;
        const row = state.usageRequests.find((item) => Number(item.id) === Number(id)) ||
          (await invoke("request-logs:list", { limit: 100 })).find((item) => Number(item.id) === Number(id));
        if (row) await replayRequestToConsole(row);
      });
    });
  }
  const errorSummary = document.getElementById("diagnostics-error-summary");
  if (errorSummary) errorSummary.textContent = `${data.recentErrors?.length || 0} 条`;
  const modelsTbody = document.getElementById("diagnostics-models-tbody");
  if (modelsTbody) {
    modelsTbody.innerHTML = (data.models || []).map((model, index) => `
      <tr>
        <td class="mono">${escapeHtml(model.id)}</td>
        <td class="mono">${escapeHtml(model.providerId)}</td>
        <td class="chip-row compact">${capabilityChips(model.capabilities)}</td>
        <td>${(model.visibleIn || []).map((id) => `<span class="chip">${escapeHtml(agentLabel(id))}</span>`).join("") || '<span class="tiny muted">不可见</span>'}</td>
        <td><button class="btn" data-diagnostic-probe="${index}">运行探针</button></td>
      </tr>
    `).join("") || '<tr><td colspan="5" class="muted">暂无模型</td></tr>';
    modelsTbody.querySelectorAll("[data-diagnostic-probe]").forEach((button) => {
      button.addEventListener("click", () => probeConfiguredModel(data.models[Number(button.dataset.diagnosticProbe)]?.id));
    });
  }
  const modelSummary = document.getElementById("diagnostics-model-summary");
  if (modelSummary) modelSummary.textContent = `${data.models?.length || 0} 个模型`;
}

document.getElementById("btn-diagnostics-run")?.addEventListener("click", () => {
  const output = document.getElementById("diagnostics-output");
  if (output) {
    output.dataset.mode = "diagnostics";
    output.textContent = "正在运行诊断…";
  }
  refreshDiagnostics().then(() => {
    if (output) output.textContent = "诊断完成。上方结果是启发式建议；草稿回放只还原日志摘要里的安全字段。";
  }).catch((err) => {
    if (output) output.textContent = `诊断失败：${err.message}`;
    toast(`诊断失败：${err.message}`);
  });
});

document.getElementById("btn-provider-health-refresh")?.addEventListener("click", async () => {
  try {
    const result = await invoke("provider-health:refresh");
    state.providerHealth = result.snapshot || {};
    await refreshDiagnostics();
    toast("Provider 健康状态已刷新");
  } catch (err) {
    toast(`刷新健康失败：${err.message}`);
  }
});

function formatCapabilityProbe(result) {
  const lines = [
    `模型：${result.modelId || "-"} → ${result.upstreamModel || "-"}`,
    `供应商：${result.providerId || "-"}`,
    ""
  ];
  for (const [key, row] of Object.entries(result.results || {})) {
    const label = CAPABILITY_LABEL[key === "vision" ? "images" : key] || key;
    const status = row.ok ? "✓" : "✗";
    const detail = row.error || row.preview || (row.reasoning ? "reasoning detected" : "");
    lines.push(`${status} ${label} · ${row.status || "n/a"} · ${row.ms || 0} ms${detail ? `\n  ${detail}` : ""}`);
  }
  const caps = result.suggestion?.capabilities || {};
  lines.push("", "启发式建议能力：");
  for (const [key, value] of Object.entries(caps)) {
    lines.push(`- ${CAPABILITY_LABEL[key] || key}: ${value ? "启用" : "关闭"}`);
  }
  return lines.join("\n");
}

async function probeConfiguredModel(modelId) {
  if (!modelId) return;
  const output = document.getElementById("diagnostics-output") || document.getElementById("model-test-output");
  const applyButton = document.getElementById("btn-diagnostics-apply-capabilities");
  if (applyButton) applyButton.style.display = "none";
  if (output.id === "diagnostics-output") output.dataset.mode = "probe";
  output.textContent = `正在校准 ${modelId}…`;
  try {
    const result = await invoke("capabilities:probe", { modelId });
    state.lastCapabilitySuggestion = result.suggestion || null;
    if (output.id === "diagnostics-output") output.dataset.mode = "probe";
    output.textContent = formatCapabilityProbe(result);
    if (applyButton && state.lastCapabilitySuggestion?.modelId) applyButton.style.display = "";
    await refreshDiagnostics();
  } catch (err) {
    output.textContent = `能力校准失败：${err.message}`;
  }
}

function applyCapabilitySuggestionToForm(suggestion) {
  const caps = suggestion?.capabilities || {};
  const form = document.getElementById("model-form");
  if (!form) return;
  for (const [key, name] of [
    ["text", "cap-text"],
    ["tools", "cap-tools"],
    ["reasoning", "cap-reasoning"],
    ["images", "cap-images"],
    ["stream", "cap-stream"],
    ["multimodal", "cap-multimodal"]
  ]) {
    const input = form.querySelector(`[name="${name}"]`);
    if (input) input.checked = !!caps[key];
  }
}

async function replayRequestToConsole(row) {
  const draft = await invoke("request:replay", { row });
  const agentSelect = document.getElementById("test-agent");
  if (agentSelect && row.client_id) agentSelect.value = row.client_id;
  refreshTestModelOptions();
  const modelSelect = document.getElementById("test-model");
  if (modelSelect && draft.modelId) {
    if (!Array.from(modelSelect.options).some((option) => option.value === draft.modelId)) {
      const option = document.createElement("option");
      option.value = draft.modelId;
      option.textContent = draft.modelId;
      modelSelect.appendChild(option);
    }
    modelSelect.value = draft.modelId;
  }
  document.getElementById("test-stream").checked = !!draft.stream;
  const prompt = (draft.messages || []).map((message) => `${roleLabel(message.role)}：${message.content}`).join("\n\n");
  document.getElementById("test-prompt").value = prompt || "你好";
  document.getElementById("test-output").textContent = `已从请求日志 #${draft.sourceLogId || row.id} 生成草稿到测试台。这里只还原安全摘要字段，确认后点击“发送”。`;
  setActiveTab("test");
}

document.getElementById("btn-diagnostics-apply-capabilities")?.addEventListener("click", async () => {
  const suggestion = state.lastCapabilitySuggestion;
  if (!suggestion?.modelId) return;
  try {
    await invoke("capabilities:apply", { modelId: suggestion.modelId, capabilities: suggestion.capabilities });
    toast("建议能力已写入模型配置");
    document.getElementById("btn-diagnostics-apply-capabilities").style.display = "none";
    await refreshAll();
  } catch (err) {
    toast(`应用建议失败：${err.message}`);
  }
});

async function profilePreview(clientId) {
  try {
    const { text, path } = await invoke("profile:preview", { clientId });
    const status = await invoke("profile:status", { clientId });
    document.getElementById("profile-dialog-title").textContent = `预览 · ${PROFILE_META[clientId]?.label || clientId}`;
    document.getElementById("profile-dialog-meta").textContent = `目标：${path} · 已有备份：${status.backups}`;
    document.getElementById("profile-dialog-body").textContent = text;
    document.getElementById("profile-dialog-wrap").classList.add("open");
  } catch (err) {
    toast(`预览失败：${err.message}`);
  }
}

async function profileApply(clientId) {
  try {
    const r = await invoke("profile:apply", { clientId });
    await refreshAll();
    const catalog = r.catalogPath ? `；模型目录：${r.catalogPath}` : "";
    const modelCount = Number.isFinite(r.modelCount) ? `；模型：${r.modelCount}` : "";
    const ccSwitch = r.ccSwitchProfilePath ? "；已同步 CC Switch 网关入口" : "";
    toast(`已写入 ${r.path}${r.backup ? "（已备份）" : ""}${catalog}${modelCount}${ccSwitch}`);
  } catch (err) {
    toast(`写入失败：${err.message}`);
  }
}

async function saveClaudeCodeModelMapping(root) {
  try {
    const mapping = {};
    root?.querySelectorAll("[data-claude-map-slot]").forEach((select) => {
      if (select.value) mapping[select.dataset.claudeMapSlot] = select.value;
    });
    const next = JSON.parse(JSON.stringify(state.config));
    next.clients = next.clients || {};
    next.clients["claude-code"] = {
      enabled: next.clients["claude-code"]?.enabled !== false,
      allowedModels: Array.isArray(next.clients["claude-code"]?.allowedModels) ? next.clients["claude-code"].allowedModels : ["*"],
      modelMapping: mapping
    };
    await invoke("config:save", next);
    toast("Claude Code 模型映射已保存");
    await refreshAll();
  } catch (err) {
    toast(`保存映射失败：${err.message}`);
  }
}

async function codexHistoryUnifyPreview() {
  try {
    const r = await invoke("codex-history:unify", { dryRun: true });
    if (!r.ok) {
      toast(`历史统一预览失败：${r.reason || "unknown"}`);
      return;
    }
    const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k}:${v}`).join("，") || "无";
    toast(`将统一 ${r.affectedThreads || 0} 个会话到 custom；来源：${counts}`);
  } catch (err) {
    toast(`历史统一预览失败：${err.message}`);
  }
}

async function codexHistoryUnifyApply() {
  try {
    const preview = await invoke("codex-history:unify", { dryRun: true });
    if (!preview.ok) {
      toast(`历史统一失败：${preview.reason || "unknown"}`);
      return;
    }
    const count = preview.affectedThreads || 0;
    if (!count) {
      toast("没有需要统一的会话历史");
      return;
    }
    const ok = confirm(`将 ${count} 个 Codex 会话的 model_provider 统一为 custom，并先备份 state_5.sqlite 和 rollout 文件。继续吗？`);
    if (!ok) return;
    const r = await invoke("codex-history:unify", { dryRun: false });
    if (!r.ok) {
      toast(`历史统一失败：${r.reason || "unknown"}`);
      return;
    }
    toast(`已统一 ${r.affectedThreads || 0} 个会话；备份：${r.backupRoot}`);
  } catch (err) {
    toast(`历史统一失败：${err.message}`);
  }
}

async function profileRestore(clientId) {
  try {
    const r = await invoke("profile:restore", { clientId });
    await refreshAll();
    if (r.ok) toast(`已恢复：${r.restoredFrom}`);
    else if (r.reason === "no-distinct-backup") toast("没有和当前文件不同的备份");
    else toast("没有可用备份");
  } catch (err) {
    toast(`恢复失败：${err.message}`);
  }
}

function renderSettings() {
  document.getElementById("settings-config-path").textContent = state.configPath || "-";
}

function resetProviderDiscovery() {
  state.providerDiscovery = [];
  state.filter.providerDiscovery = "";
  const search = document.getElementById("provider-discovery-search");
  if (search) search.value = "";
  renderProviderDiscovery();
}

function renderProviderDiscovery() {
  const wrap = document.getElementById("provider-discovered-models");
  if (!wrap) return;
  const count = document.getElementById("provider-discovery-count");
  if (!state.providerDiscovery.length) {
    wrap.innerHTML = '<div class="empty-state">还没有查询模型</div>';
    if (count) count.textContent = "0 个模型";
    return;
  }
  const filtered = filterDiscoveryModels(state.providerDiscovery, state.filter.providerDiscovery);
  if (count) {
    count.textContent = state.filter.providerDiscovery
      ? `${filtered.length} / ${state.providerDiscovery.length} 个模型`
      : `${state.providerDiscovery.length} 个模型`;
  }
  if (!filtered.length) {
    wrap.innerHTML = '<div class="empty-state">没有匹配的模型</div>';
    return;
  }
  wrap.innerHTML = filtered.map(({ model, index }) => {
    const caps = Object.entries(model.capabilities).map(([key, enabled]) => `
      <label><input type="checkbox" data-discovery-cap="${index}:${escapeHtml(key)}" ${enabled ? "checked" : ""}> ${escapeHtml(CAPABILITY_LABEL[key] || key)}</label>
    `).join("");
    return `
      <div class="discovery-item">
        <div class="discovery-head">
          <div class="discovery-title">
            <label style="display:flex; flex-direction:row; align-items:center; gap:10px;">
              <input type="checkbox" data-discovery-enabled="${index}" ${model.enabled ? "checked" : ""}>
              <span>${escapeHtml(model.upstreamModel)}</span>
            </label>
          </div>
          <span class="chip">${escapeHtml(model.id)}</span>
        </div>
        <div class="row">
          <label>显示名 <input class="field" data-discovery-display="${index}" value="${escapeHtml(model.displayName || "")}"></label>
          <label>别名（逗号分隔） <input class="field" data-discovery-aliases="${index}" value="${escapeHtml((model.aliases || []).join(", "))}"></label>
        </div>
        <div class="row">
          <label>上下文窗口 <input class="field" type="number" min="0" data-discovery-context="${index}" value="${escapeHtml(model.contextWindow || "")}"></label>
          <label>最大输出 Token <input class="field" type="number" min="0" data-discovery-maxout="${index}" value="${escapeHtml(model.maxOutputTokens || "")}"></label>
        </div>
        <div class="capabilities">${caps}</div>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll("[data-discovery-enabled]").forEach((el) => {
    el.addEventListener("change", () => {
      state.providerDiscovery[Number(el.dataset.discoveryEnabled)].enabled = el.checked;
    });
  });
  wrap.querySelectorAll("[data-discovery-display]").forEach((el) => {
    el.addEventListener("input", () => {
      state.providerDiscovery[Number(el.dataset.discoveryDisplay)].displayName = el.value.trim();
    });
  });
  wrap.querySelectorAll("[data-discovery-aliases]").forEach((el) => {
    el.addEventListener("input", () => {
      state.providerDiscovery[Number(el.dataset.discoveryAliases)].aliases = el.value.split(",").map((s) => s.trim()).filter(Boolean);
    });
  });
  wrap.querySelectorAll("[data-discovery-context]").forEach((el) => {
    el.addEventListener("input", () => {
      state.providerDiscovery[Number(el.dataset.discoveryContext)].contextWindow = Number(el.value) || undefined;
    });
  });
  wrap.querySelectorAll("[data-discovery-maxout]").forEach((el) => {
    el.addEventListener("input", () => {
      state.providerDiscovery[Number(el.dataset.discoveryMaxout)].maxOutputTokens = Number(el.value) || undefined;
    });
  });
  wrap.querySelectorAll("[data-discovery-cap]").forEach((el) => {
    el.addEventListener("change", () => {
      const [index, key] = el.dataset.discoveryCap.split(":");
      state.providerDiscovery[Number(index)].capabilities[key] = el.checked;
    });
  });
}

function renderCompatPackOptions(containerId, selected = []) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return;
  const selectedSet = new Set(Array.isArray(selected) ? selected : []);
  const packs = state.compatPacks || [];
  if (!packs.length) {
    wrap.innerHTML = '<div class="tiny muted">暂无可用兼容包</div>';
    return;
  }
  wrap.innerHTML = packs.map((pack) => `
    <label class="checkbox-line compat-pack-option">
      <input type="checkbox" value="${escapeHtml(pack.id)}" ${selectedSet.has(pack.id) ? "checked" : ""}>
      <span>
        <strong>${escapeHtml(pack.label || pack.id)}</strong>
        <small>${escapeHtml(pack.description || (pack.patchIds || []).join(", "))}</small>
      </span>
    </label>
  `).join("");
}

function collectCompatPackOptions(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value).filter(Boolean);
}

function collectProviderForm() {
  const form = document.getElementById("provider-form");
  const fd = new FormData(form);
  const raw = Object.fromEntries(fd.entries());
  const authMode = raw.authMode || "api_key";
  const data = {
    id: raw.id?.trim(),
    name: raw.name?.trim(),
    presetId: raw.presetId?.trim() || undefined,
    authMode,
    apiFormat: raw.apiFormat,
    baseUrl: raw.baseUrl?.trim(),
    proxyUrl: raw.proxyUrl?.trim() || undefined,
    routingMode: raw.routingMode || "auto",
    compatPacks: collectCompatPackOptions("provider-compat-packs"),
    apiKeyEnv: raw.apiKeyEnv?.trim(),
    apiKey: raw.apiKey?.trim()
  };
  if (authMode === "keychain") {
    data.keychainAccount = data.id;
    data._keychainSecret = data.apiKey;
    delete data.apiKeyEnv;
    delete data.apiKey;
  } else if (authMode !== "api_key") {
    delete data.apiKeyEnv;
    delete data.apiKey;
  }
  return data;
}

document.getElementById("models-search").addEventListener("input", (e) => {
  state.filter.models = e.target.value;
  renderModels();
});
document.getElementById("provider-discovery-search")?.addEventListener("input", (e) => {
  state.filter.providerDiscovery = e.target.value;
  renderProviderDiscovery();
});
/* ---- Provider Dialog ---- */
function openProviderDialog(editId) {
  const wrap = document.getElementById("provider-dialog-wrap");
  const title = document.getElementById("provider-dialog-title");
  const form = document.getElementById("provider-form");
  form.reset();
  const existing = editId ? state.config.providers.find((p) => p.id === editId) : null;
  resetProviderDiscovery();
  title.textContent = existing ? `编辑供应商 · ${existing.id}` : "新增供应商";
  renderProviderPresetOptions(existing?.presetId || "");
  if (existing) {
    form.querySelector('[name="id"]').value = existing.id;
    form.querySelector('[name="id"]').readOnly = true;
    form.querySelector('[name="name"]').value = existing.name || "";
    form.querySelector('[name="presetId"]').value = existing.presetId || "";
    form.querySelector('[name="apiFormat"]').value = existing.apiFormat;
    form.querySelector('[name="baseUrl"]').value = existing.baseUrl;
    form.querySelector('[name="proxyUrl"]').value = existing.proxyUrl || "";
    form.querySelector('[name="routingMode"]').value = existing.routingMode || "auto";
    form.querySelector('[name="apiKeyEnv"]').value = existing.apiKeyEnv || "";
    form.querySelector('[name="apiKey"]').value = existing.apiKey || "";
    renderAuthModeOptions(providerPresetById(existing.presetId), existing.authMode || "api_key");
    renderCompatPackOptions("provider-compat-packs", existing.compatPacks || []);
    state.providerDiscovery = state.config.models
      .filter((m) => m.providerId === existing.id)
      .map((m) => ({
        enabled: true,
        id: m.id,
        providerId: existing.id,
        upstreamModel: m.upstreamModel,
        displayName: m.displayName || "",
        aliases: [...(m.aliases || [])],
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens,
        capabilities: {
          text: !!m.capabilities?.text,
          tools: !!m.capabilities?.tools,
          reasoning: !!m.capabilities?.reasoning,
          images: !!m.capabilities?.images,
          stream: !!m.capabilities?.stream,
          multimodal: !!m.capabilities?.multimodal
        }
      }));
  } else {
    form.querySelector('[name="id"]').readOnly = false;
    renderAuthModeOptions(null, "api_key");
    renderCompatPackOptions("provider-compat-packs", []);
  }
  document.getElementById("provider-api-key-input").type = "password";
  document.getElementById("btn-provider-key-toggle").textContent = "显示";
  renderProviderDiscovery();
  wrap.classList.add("open");
  form._editId = editId || null;
}
document.getElementById("btn-provider-add").addEventListener("click", () => openProviderDialog(null));
document.getElementById("provider-preset-select").addEventListener("change", (e) => {
  const preset = providerPresetById(e.target.value);
  if (preset) applyProviderPreset(preset);
  else renderAuthModeOptions(null, "api_key");
});
document.getElementById("provider-auth-mode").addEventListener("change", syncProviderAuthControls);
document.getElementById("btn-provider-key-toggle").addEventListener("click", () => {
  const input = document.getElementById("provider-api-key-input");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  document.getElementById("btn-provider-key-toggle").textContent = show ? "隐藏" : "显示";
});
document.getElementById("provider-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const data = collectProviderForm();
  const keychainSecret = data._keychainSecret;
  delete data._keychainSecret;
  const editId = form._editId;
  if (data.authMode === "keychain" && keychainSecret) {
    await invoke("keychain:set", { account: data.keychainAccount || data.id, secret: keychainSecret });
  }
  let providers = [...state.config.providers];
  const discoveredModels = state.providerDiscovery
    .filter((item) => item.enabled)
    .map((item) => ({
      id: item.id,
      providerId: data.id,
      upstreamModel: item.upstreamModel,
      displayName: item.displayName || item.upstreamModel,
      aliases: item.aliases || [],
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxOutputTokens,
      capabilities: { ...item.capabilities }
    }));
  if (editId) {
    providers = providers.map((p) => p.id === editId ? { ...data, id: data.id, capabilities: {} } : p);
  } else {
    providers.push({ ...data, id: data.id, capabilities: {} });
  }
  let models = [...state.config.models];
  if (editId) {
    const existingById = new Map(models.map((m) => [m.id, m]));
    for (const item of discoveredModels) existingById.set(item.id, item);
    models = Array.from(existingById.values());
  } else {
    const existingIds = new Set(models.map((m) => m.id));
    for (const item of discoveredModels) if (!existingIds.has(item.id)) models.push(item);
  }
  const next = { ...state.config, providers, models };
  await invoke("config:save", next);
  await refreshAll().then(() => checkFirstLaunch());
  toast(editId ? "供应商已更新" : "供应商已新增");
  form.closest(".dialog-overlay").classList.remove("open");
});
document.getElementById("provider-dialog-wrap").querySelector("[data-close]").addEventListener("click", () => {
  document.getElementById("provider-dialog-wrap").classList.remove("open");
});

document.getElementById("btn-provider-test").addEventListener("click", async () => {
  const output = document.getElementById("provider-test-output");
  const payload = collectProviderForm();
  output.textContent = "正在测试连接…";
  try {
    const result = await invoke("provider:test", payload);
    output.textContent = [
      `${result.ok ? "✓" : "✗"} ${result.url || payload.baseUrl}`,
      `status: ${result.status || "n/a"}`,
      result.error || result.bodyPreview || ""
    ].filter(Boolean).join("\n");
  } catch (err) {
    output.textContent = `测试失败：${err.message}`;
  }
});

document.getElementById("btn-provider-discover").addEventListener("click", async () => {
  const output = document.getElementById("provider-test-output");
  const payload = collectProviderForm();
  output.textContent = "正在查询模型…";
  try {
    const result = await invoke("provider:discover-models", payload);
    if (!result.ok) {
      output.textContent = `查询失败：${result.error}`;
      return;
    }
    state.providerDiscovery = result.models.map((item) => ({
      enabled: false,
      id: `${payload.id}/${item.id.replace(/[^a-zA-Z0-9_./@+-]/g, "_")}`,
      providerId: payload.id,
      upstreamModel: item.id,
      displayName: item.displayName || item.id,
      aliases: [item.id],
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxOutputTokens,
      capabilities: {
        text: true,
        tools: item.capabilities?.tools !== false,
        reasoning: !!item.capabilities?.reasoning,
        images: !!item.capabilities?.images,
        stream: true,
        multimodal: !!item.capabilities?.multimodal
      }
    }));
    state.filter.providerDiscovery = "";
    const search = document.getElementById("provider-discovery-search");
    if (search) search.value = "";
    renderProviderDiscovery();
    output.textContent = `已查询到 ${state.providerDiscovery.length} 个模型`;
  } catch (err) {
    output.textContent = `查询失败：${err.message}`;
  }
});

async function removeProvider(id) {
  const next = { ...state.config, providers: state.config.providers.filter((p) => p.id !== id), models: state.config.models.filter((m) => m.providerId !== id) };
  await invoke("config:save", next);
  await refreshAll();
  toast(`已删除供应商 ${id}`);
}

/* ---- Model Dialog ---- */
function openModelDialog(editId) {
  const wrap = document.getElementById("model-dialog-wrap");
  const title = document.getElementById("model-dialog-title");
  const form = document.getElementById("model-form");
  form.reset();
  const sel = document.getElementById("model-provider-select");
  sel.innerHTML = state.config.providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.id)}</option>`).join("");
  const fallbackSel = document.getElementById("model-vision-fallback-select");
  const visionModels = state.config.models.filter((m) => m.capabilities?.images || m.capabilities?.multimodal);
  fallbackSel.innerHTML = `<option value="">不启用</option>` + visionModels.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.displayName || m.id)} · ${escapeHtml(m.id)}</option>`).join("");
  const existing = editId ? state.config.models.find((m) => m.id === editId) : null;
  title.textContent = existing ? `编辑模型 · ${existing.id}` : "新增模型";
  if (existing) {
    form.querySelector('[name="id"]').value = existing.id;
    form.querySelector('[name="providerId"]').value = existing.providerId;
    form.querySelector('[name="upstreamModel"]').value = existing.upstreamModel;
    form.querySelector('[name="displayName"]').value = existing.displayName || "";
    form.querySelector('[name="aliases"]').value = (existing.aliases || []).join(", ");
    form.querySelector('[name="visionFallbackModelId"]').value = existing.visionFallbackModelId || "";
    form.querySelector('[name="proxyUrl"]').value = existing.proxyUrl || "";
    renderCompatPackOptions("model-compat-packs", existing.compatPacks || []);
    if (existing.capabilities) {
      form.querySelector('[name="cap-text"]').checked = !!existing.capabilities.text;
      form.querySelector('[name="cap-tools"]').checked = !!existing.capabilities.tools;
      form.querySelector('[name="cap-reasoning"]').checked = !!existing.capabilities.reasoning;
      form.querySelector('[name="cap-images"]').checked = !!existing.capabilities.images;
      form.querySelector('[name="cap-stream"]').checked = !!existing.capabilities.stream;
      form.querySelector('[name="cap-multimodal"]').checked = !!existing.capabilities.multimodal;
    }
    form.querySelector('[name="contextWindow"]').value = existing.contextWindow || "";
    form.querySelector('[name="maxOutputTokens"]').value = existing.maxOutputTokens || "";
  } else {
    renderCompatPackOptions("model-compat-packs", []);
    form.querySelector('[name="cap-text"]').checked = true;
    form.querySelector('[name="cap-tools"]').checked = true;
    form.querySelector('[name="cap-reasoning"]').checked = false;
    form.querySelector('[name="cap-images"]').checked = false;
    form.querySelector('[name="cap-stream"]').checked = true;
    form.querySelector('[name="cap-multimodal"]').checked = false;
  }
  state.lastCapabilitySuggestion = null;
  document.getElementById("btn-model-apply-capabilities").style.display = "none";
  document.getElementById("model-test-output").textContent = "尚未测试";
  wrap.classList.add("open");
  form._editId = editId || null;
}
document.getElementById("btn-model-add").addEventListener("click", () => openModelDialog(null));

function collectModelForm() {
  const form = document.getElementById("model-form");
  const fd = new FormData(form);
  const raw = Object.fromEntries(fd.entries());
  return {
    id: String(raw.id || "").trim(),
    providerId: String(raw.providerId || "").trim(),
    upstreamModel: String(raw.upstreamModel || "").trim(),
    displayName: String(raw.displayName || "").trim() || undefined,
    aliases: raw.aliases ? String(raw.aliases).split(",").map((s) => s.trim()).filter(Boolean) : [],
    contextWindow: Number(raw.contextWindow) || undefined,
    maxOutputTokens: Number(raw.maxOutputTokens) || undefined,
    visionFallbackModelId: String(raw.visionFallbackModelId || "").trim() || undefined,
    proxyUrl: String(raw.proxyUrl || "").trim() || undefined,
    compatPacks: collectCompatPackOptions("model-compat-packs"),
    capabilities: {
      text: raw["cap-text"] === "on",
      tools: raw["cap-tools"] === "on",
      reasoning: raw["cap-reasoning"] === "on",
      images: raw["cap-images"] === "on",
      stream: raw["cap-stream"] === "on",
      multimodal: raw["cap-multimodal"] === "on"
    }
  };
}

document.getElementById("model-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const submitter = e.submitter || form.querySelector('button[type="submit"]');
  const data = collectModelForm();
  const editId = form._editId;
  const output = document.getElementById("model-test-output");
  const conflict = modelIdConflict(state.config, data, editId);
  if (!conflict.ok) {
    output.textContent = `保存失败：${conflict.message}`;
    toast(conflict.message);
    return;
  }
  if (submitter) {
    submitter.disabled = true;
    submitter.textContent = "保存中…";
  }
  let models = [...state.config.models];
  if (editId) {
    models = models.map((m) => m.id === editId ? data : m);
  } else {
    models.push(data);
  }
  const next = { ...state.config, models };
  try {
    await invoke("config:save", next);
    await refreshAll();
    toast(editId ? "模型已更新" : "模型已新增");
    form.closest(".dialog-overlay").classList.remove("open");
  } catch (err) {
    output.textContent = `保存失败：${err.message}`;
    toast(`保存失败：${err.message}`);
  } finally {
    if (submitter) {
      submitter.disabled = false;
      submitter.textContent = "保存";
    }
  }
});
document.getElementById("model-dialog-wrap").querySelector("[data-close]").addEventListener("click", () => {
  document.getElementById("model-dialog-wrap").classList.remove("open");
});

async function removeModel(id) {
  const next = { ...state.config, models: state.config.models.filter((m) => m.id !== id) };
  await invoke("config:save", next);
  await refreshAll();
  toast(`已删除模型 ${id}`);
}

/* ---- Service Controls ---- */
document.getElementById("btn-start").addEventListener("click", async () => {
  const s = await invoke("gateway:start");
  await refreshAll();
  toast(`服务已启动 · ${s.host}:${s.port}`);
});
document.getElementById("btn-stop").addEventListener("click", async () => {
  await invoke("gateway:stop");
  await refreshAll();
  toast("服务已停止");
});
document.getElementById("btn-restart").addEventListener("click", async () => {
  const s = await invoke("gateway:restart");
  await refreshAll();
  toast(`服务已重启 · ${s.host}:${s.port}`);
});
document.getElementById("btn-reload").addEventListener("click", async () => {
  await invoke("gateway:reload");
  await refreshAll();
  toast("配置已热重载");
});

/* ---- Doctor ---- */
document.getElementById("btn-doctor").addEventListener("click", async () => {
  const out = document.getElementById("doctor-output");
  out.textContent = "正在自检…";
  try {
    const result = await invoke("gateway:doctor");
    const lines = [
      "# Switchyard 自检",
      `运行中: ${result.running ? "是" : "否"}`,
      `监听: ${result.running ? result.host + ":" + result.port : "n/a"}`,
      `供应商: ${result.providerCount}`,
      `模型: ${result.modelCount}`,
      ""
    ];
    for (const p of result.providers) {
      lines.push(`${p.id}: ${PROTOCOL_LABEL[p.apiFormat] || p.apiFormat} · ${p.baseUrl} · key=${p.keySource} ${p.keyOk ? "✓" : "✗"}`);
    }
    out.textContent = lines.join("\n");
  } catch (err) {
    out.textContent = "自检失败: " + err.message;
  }
});
/* ---- Import ---- */
let importResult = null;
function importProviderKey(meta) {
  const provider = importResult?.config?.providers?.find((p) => p.id === meta.slug);
  if (!provider?.apiKey) return meta.keyPreview || "未携带";
  return state.importShowKeys ? provider.apiKey : (meta.keyPreview || "已携带");
}

function resetImportSelection(result) {
  state.importSelection = { providers: new Set(), models: new Set() };
  for (const provider of result?.config?.providers || []) state.importSelection.providers.add(provider.id);
  for (const model of result?.config?.models || []) state.importSelection.models.add(model.id);
}

function importProviderModels(providerId) {
  return (importResult?.config?.models || []).filter((model) => model.providerId === providerId);
}

function selectedImportResult(result = importResult) {
  return buildSelectedImportResult(result, state.importSelection);
}

function setImportRunOutput(lines) {
  const out = document.getElementById("import-run-output");
  if (out) out.textContent = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
}

function renderImportPreview(result = importResult) {
  const preview = document.getElementById("import-preview");
  if (!preview || !result) return;
  const providers = result.importMeta.providers || [];
  const modelCounts = {};
  for (const model of result.config.models || []) modelCounts[model.providerId] = (modelCounts[model.providerId] || 0) + 1;
  const providersHtml = providers.map((meta) => {
    const providerSelected = state.importSelection.providers.has(meta.slug);
    const models = importProviderModels(meta.slug);
    const modelHtml = models.map((model) => `
      <label class="import-model-item" title="${escapeHtml(model.id)}">
        <input type="checkbox" data-import-model="${escapeHtml(model.id)}" data-provider-id="${escapeHtml(meta.slug)}" ${state.importSelection.models.has(model.id) ? "checked" : ""}>
        <span class="mono">${escapeHtml(model.upstreamModel || model.id)}</span>
      </label>
    `).join("") || '<div class="tiny muted">cc-switch 中没有可识别模型，导入后会尝试自动查询。</div>';
    return `
    <div class="import-provider">
      <div class="import-provider-head">
        <label class="import-provider-check">
          <input type="checkbox" data-import-provider="${escapeHtml(meta.slug)}" ${providerSelected ? "checked" : ""}>
          <span class="import-provider-title">${escapeHtml(meta.name || meta.slug)}</span>
        </label>
        <span class="chip">${escapeHtml(PROTOCOL_LABEL[meta.apiFormat] || meta.apiFormat)}</span>
      </div>
      <dl class="import-provider-grid">
        <dt>标识</dt><dd class="mono">${escapeHtml(meta.slug)}</dd>
        <dt>来源</dt><dd>${escapeHtml((meta.appTypes || []).join(", "))}</dd>
        <dt>地址</dt><dd class="mono">${escapeHtml(meta.baseUrl)}</dd>
        <dt>模型</dt><dd>${modelCounts[meta.slug] || 0} 个</dd>
        <dt>密钥</dt><dd class="mono">${escapeHtml(importProviderKey(meta))}</dd>
      </dl>
      <div class="import-model-list">${modelHtml}</div>
    </div>
  `;
  }).join("") || '<div class="empty-state">没有可导入的供应商</div>';
  const selected = selectedImportResult(result);
  preview.innerHTML = `
    <div class="import-summary">
      <div class="metric"><div class="metric-value">${escapeHtml(providers.length)}</div><div class="metric-label">供应商</div></div>
      <div class="metric"><div class="metric-value">${escapeHtml(result.config.models.length)}</div><div class="metric-label">模型</div></div>
      <div class="metric"><div class="metric-value">${escapeHtml(selected?.config.providers.length || 0)}</div><div class="metric-label">已选供应商</div></div>
      <div class="metric"><div class="metric-value">${escapeHtml(selected?.config.models.length || 0)}</div><div class="metric-label">已选模型</div></div>
    </div>
    <div class="import-summary">
      <div class="metric"><div class="metric-value">${escapeHtml(result.importMeta.dedupedFromAppTypes.length)}</div><div class="metric-label">来源实体</div></div>
      <div class="metric"><div class="metric-value">${escapeHtml(result.importMeta.skipped || 0)}</div><div class="metric-label">跳过</div></div>
    </div>
    ${providersHtml}
  `;
  document.getElementById("btn-import-toggle-keys").textContent = state.importShowKeys ? "隐藏明文密钥" : "显示明文密钥";
  preview.querySelectorAll("[data-import-provider]").forEach((input) => input.addEventListener("change", (e) => {
    const providerId = e.currentTarget.dataset.importProvider;
    if (e.currentTarget.checked) {
      state.importSelection.providers.add(providerId);
      for (const model of importProviderModels(providerId)) state.importSelection.models.add(model.id);
    } else {
      state.importSelection.providers.delete(providerId);
      for (const model of importProviderModels(providerId)) state.importSelection.models.delete(model.id);
    }
    renderImportPreview(result);
  }));
  preview.querySelectorAll("[data-import-model]").forEach((input) => input.addEventListener("change", (e) => {
    const modelId = e.currentTarget.dataset.importModel;
    const providerId = e.currentTarget.dataset.providerId;
    if (e.currentTarget.checked) {
      state.importSelection.models.add(modelId);
      state.importSelection.providers.add(providerId);
    } else {
      state.importSelection.models.delete(modelId);
    }
    renderImportPreview(result);
  }));
}

document.querySelectorAll("#btn-import, #btn-provider-import").forEach((btn) => {
  btn.addEventListener("click", async () => {
    importResult = null;
    state.importShowKeys = false;
    try {
      const result = await invoke("import:ccswitch");
      importResult = result;
      resetImportSelection(result);
      setImportRunOutput("等待导入");
    } catch (err) {
      toast(`导入失败: ${err.message}`);
      return;
    }
    renderImportPreview(importResult);
    document.getElementById("import-dialog-wrap").classList.add("open");
  });
});
document.getElementById("btn-import-toggle-keys").addEventListener("click", () => {
  state.importShowKeys = !state.importShowKeys;
  renderImportPreview(importResult);
});
document.getElementById("btn-import-select-all").addEventListener("click", () => {
  if (!importResult) return;
  resetImportSelection(importResult);
  renderImportPreview(importResult);
});
document.getElementById("btn-import-select-none").addEventListener("click", () => {
  state.importSelection = { providers: new Set(), models: new Set() };
  renderImportPreview(importResult);
});
document.getElementById("btn-import-apply").addEventListener("click", async () => {
  if (!importResult) return;
  const selected = selectedImportResult(importResult);
  if (!selected?.config.providers.length) {
    toast("请至少选择一个供应商或模型");
    return;
  }
  const lines = ["开始合并 cc-switch 选择项…"];
  setImportRunOutput(lines);
  const existing = state.config;
  const existingIds = new Set(existing.providers.map((p) => p.id));
  const existingModelIds = new Set(existing.models.map((m) => m.id));
  const newProviders = selected.config.providers.filter((p) => !existingIds.has(p.id));
  const newModels = selected.config.models.filter((m) => !existingModelIds.has(m.id));
  const next = {
    ...existing,
    providers: [...existing.providers, ...newProviders],
    models: [...existing.models, ...newModels]
  };
  await invoke("config:save", next);
  lines.push(`已合并：+${newProviders.length} Provider / +${newModels.length} Model`);
  setImportRunOutput(lines);
  let working = next;
  const discoveredModels = [];
  for (const provider of selected.config.providers) {
    lines.push(`查询模型：${provider.name || provider.id}`);
    setImportRunOutput(lines);
    try {
      const result = await invoke("provider:discover-models", provider);
      if (!result.ok) {
        lines.push(`  ✗ ${result.error || "查询失败"}`);
        continue;
      }
      const normalized = (result.models || []).map((item) => normalizeDiscoveredModelForProvider(provider, item));
      const ids = new Set(working.models.map((m) => m.id));
      const additions = normalized.filter((model) => !ids.has(model.id));
      if (additions.length) {
        working = { ...working, models: [...working.models, ...additions] };
        discoveredModels.push(...additions);
        await invoke("config:save", working);
      }
      lines.push(`  ✓ ${result.models?.length || 0} 个，上新 ${additions.length} 个`);
    } catch (err) {
      lines.push(`  ✗ ${err.message}`);
    }
    setImportRunOutput(lines);
  }
  const testTargets = [...(selected.config.models || []), ...discoveredModels]
    .filter((model, index, arr) => model?.id && arr.findIndex((m) => m.id === model.id) === index);
  for (const model of testTargets) {
    lines.push(`测试模型：${model.id}`);
    setImportRunOutput(lines);
    try {
      const r = await invoke("test:model", {
        modelDraft: model,
        messages: [{ role: "user", content: "Reply OK in one short sentence." }]
      });
      lines.push(r.ok ? `  ✓ status ${r.status}` : `  ✗ ${r.error || "status " + r.status}`);
    } catch (err) {
      lines.push(`  ✗ ${err.message}`);
    }
    setImportRunOutput(lines);
  }
  await refreshAll();
  toast(`已导入并测试：+${newProviders.length} Provider / +${newModels.length + discoveredModels.length} Model`);
  document.getElementById("import-dialog-wrap").classList.remove("open");
});
document.getElementById("import-dialog-wrap").querySelector("[data-close]").addEventListener("click", () => {
  document.getElementById("import-dialog-wrap").classList.remove("open");
});

/* ---- Logs ---- */
document.getElementById("btn-logs-clear")?.addEventListener("click", () => {
  logBuffer = [];
  renderLiveLogs();
});
document.getElementById("btn-logs-open")?.addEventListener("click", async () => {
  await invoke("logs:open-folder");
});
document.getElementById("btn-open-logs")?.addEventListener("click", async () => {
  await invoke("logs:open-folder");
});
document.getElementById("btn-logs-refresh-file")?.addEventListener("click", () => {
  refreshLogTail().catch((err) => toast(`刷新日志失败：${err.message}`));
});

async function refreshLogTail() {
  const out = document.getElementById("logs-output");
  if (!out) return;
  const tail = await invoke("logs:tail", { maxBytes: 320 * 1024 });
  const summary = document.getElementById("log-file-summary");
  if (summary) summary.textContent = tail?.file ? `${tail.truncated ? "已截取尾部 · " : ""}${tail.file}` : "-";
  renderLogTail(out, tail?.text || "");
}

function renderLogTail(out, text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    out.innerHTML = '<div class="empty-state">暂无日志文件内容</div>';
    return;
  }
  out.innerHTML = lines.slice(-600).map((line, index) => {
    const lower = line.toLowerCase();
    const tone = lower.includes("error") || lower.includes("failed") || lower.includes("exception")
      ? "error"
      : lower.includes("warn")
        ? "warn"
        : lower.includes("debug")
          ? "debug"
          : "";
    return `
      <div class="log-file-line ${tone}">
        <span class="log-file-line-number">#${index + 1}</span>
        <span class="log-file-line-text">${escapeHtml(line)}</span>
      </div>
    `;
  }).join("");
}

async function refreshUsageStats() {
  syncUsageRangeFromControls();
  const query = document.getElementById("usage-model-filter")?.value?.trim() || "";
  const agentId = document.getElementById("usage-agent-filter")?.value?.trim() || "";
  const filters = usageFilters({
    ...(query ? { modelQuery: query } : {}),
    ...(agentId ? { agentId } : {})
  });
  const compareFilters = state.usageRange.compareEnabled
    ? usageFilters({
      ...(query ? { modelQuery: query } : {}),
      ...(agentId ? { agentId } : {})
    }, true)
    : null;
  const [usage, requests, daily, compareDaily] = await Promise.all([
    invoke("usage:by-agent-model", { ...filters, limit: 100 }),
    invoke("request-logs:list", { ...filters, limit: 80 }),
    invoke("usage:daily", { ...filters, limit: 60 }),
    compareFilters ? invoke("usage:daily", { ...compareFilters, limit: 60 }) : Promise.resolve([])
  ]);
  state.usageRequests = requests || [];
  const usageTbody = document.getElementById("usage-tbody");
  const reqTbody = document.getElementById("request-log-tbody");
  if (usageTbody) {
    usageTbody.innerHTML = "";
    for (const row of usage || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(agentLabel(row.client_id))}</td>
        <td class="mono">${escapeHtml(row.model_id || "-")}</td>
        <td>${escapeHtml(row.request_count || 0)}</td>
        <td>${escapeHtml(row.error_count || 0)}</td>
        <td>${escapeHtml(row.total_tokens || 0)}</td>
        <td>${escapeHtml(row.avg_latency_ms || 0)} ms</td>
      `;
      usageTbody.appendChild(tr);
    }
    if (!usage?.length) usageTbody.innerHTML = '<tr><td colspan="6" class="muted">暂无用量数据</td></tr>';
  }
  if (reqTbody) {
    reqTbody.innerHTML = "";
    for (const [index, row] of (requests || []).entries()) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${escapeHtml(formatDate(row.ts))}</td>
        <td>${escapeHtml(agentLabel(row.client_id))}</td>
        <td class="mono">${escapeHtml(row.model_id || row.requested_model || "-")}</td>
        <td>${escapeHtml(row.status || "-")}</td>
        <td>${escapeHtml(row.latency_ms || 0)} ms</td>
        <td><button class="btn" data-request-replay="${index}">草稿回放</button></td>
      `;
      reqTbody.appendChild(tr);
    }
    reqTbody.querySelectorAll("[data-request-replay]").forEach((button) => {
      button.addEventListener("click", () => replayRequestToConsole(state.usageRequests[Number(button.dataset.requestReplay)]));
    });
    if (!requests?.length) reqTbody.innerHTML = '<tr><td colspan="6" class="muted">暂无请求记录</td></tr>';
  }
  const totalRequests = (usage || []).reduce((sum, row) => sum + Number(row.request_count || 0), 0);
  const totalTokens = (usage || []).reduce((sum, row) => sum + Number(row.total_tokens || 0), 0);
  const usageSummary = document.getElementById("usage-summary");
  if (usageSummary) usageSummary.textContent = `${totalRequests} 次 · ${totalTokens} tokens`;
  const requestSummary = document.getElementById("request-log-summary");
  if (requestSummary) requestSummary.textContent = `${requests?.length || 0} 条`;
  renderUsageDailyChart(daily || [], compareDaily || []);
  renderUsageRangeSummary();
}

function usageFilters(base = {}, compare = false) {
  const range = state.usageRange || defaultUsageRange();
  const since = compare ? range.compareSince : range.since;
  const until = compare ? range.compareUntil : range.until;
  return {
    ...base,
    ...(since ? { since } : {}),
    ...(until ? { until } : {})
  };
}

function syncUsageRangeControls() {
  const range = state.usageRange || defaultUsageRange();
  const preset = document.getElementById("usage-range-preset");
  if (preset) preset.value = range.preset || "7d";
  const since = document.getElementById("usage-since");
  const until = document.getElementById("usage-until");
  const compareEnabled = document.getElementById("usage-compare-enabled");
  const compareSince = document.getElementById("usage-compare-since");
  const compareUntil = document.getElementById("usage-compare-until");
  if (since) since.value = dateInputValue(range.since);
  if (until) until.value = dateInputValue(range.until);
  if (compareEnabled) compareEnabled.checked = !!range.compareEnabled;
  if (compareSince) compareSince.value = dateInputValue(range.compareSince);
  if (compareUntil) compareUntil.value = dateInputValue(range.compareUntil);
}

function syncUsageRangeFromControls() {
  const range = state.usageRange || defaultUsageRange();
  if (range.preset === "custom") {
    const since = startOfDateInput(document.getElementById("usage-since")?.value);
    const until = endOfDateInput(document.getElementById("usage-until")?.value);
    if (since) range.since = since;
    if (until) range.until = until;
  }
  range.compareEnabled = Boolean(document.getElementById("usage-compare-enabled")?.checked);
  if (range.compareEnabled) {
    const compareSince = startOfDateInput(document.getElementById("usage-compare-since")?.value);
    const compareUntil = endOfDateInput(document.getElementById("usage-compare-until")?.value);
    if (compareSince) range.compareSince = compareSince;
    if (compareUntil) range.compareUntil = compareUntil;
  }
  state.usageRange = range;
}

function applyUsagePreset(value) {
  const until = new Date();
  const preset = value || "7d";
  const durations = {
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "14d": 14 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000
  };
  if (preset === "custom") {
    state.usageRange = { ...(state.usageRange || defaultUsageRange()), preset: "custom" };
  } else {
    const span = durations[preset] || durations["7d"];
    const since = new Date(until.getTime() - span);
    const compareUntil = new Date(since.getTime());
    const compareSince = new Date(compareUntil.getTime() - span);
    state.usageRange = {
      ...(state.usageRange || defaultUsageRange()),
      preset,
      since: since.toISOString(),
      until: until.toISOString(),
      compareSince: compareSince.toISOString(),
      compareUntil: compareUntil.toISOString()
    };
  }
  syncUsageRangeControls();
}

function renderUsageRangeSummary() {
  const summary = document.getElementById("usage-range-summary");
  if (!summary) return;
  const range = state.usageRange || defaultUsageRange();
  const primary = `${formatDate(range.since)} 至 ${formatDate(range.until)}`;
  const compare = range.compareEnabled ? ` · 对比 ${formatDate(range.compareSince)} 至 ${formatDate(range.compareUntil)}` : "";
  summary.textContent = `${primary}${compare}`;
}

function renderUsageDailyChart(rows, compareRows = []) {
  const wrap = document.getElementById("usage-daily-chart");
  const summary = document.getElementById("usage-daily-summary");
  if (!wrap) return;
  const primary = aggregateDailyRows(rows);
  const compare = aggregateDailyRows(compareRows);
  if (summary) {
    const requests = primary.reduce((sum, row) => sum + row.request_count, 0);
    const tokens = primary.reduce((sum, row) => sum + row.total_tokens, 0);
    const compareTokens = compare.reduce((sum, row) => sum + row.total_tokens, 0);
    summary.textContent = `${primary.length} 天 · ${requests} 次 · ${tokens} tokens${compare.length ? ` · 对比 ${compareTokens} tokens` : ""}`;
  }
  if (!primary.length && !compare.length) {
    wrap.innerHTML = '<div class="empty-state">暂无每日用量数据</div>';
    return;
  }
  const maxTokens = Math.max(...primary.map((row) => row.total_tokens), ...compare.map((row) => row.total_tokens), 1);
  const maxLen = Math.max(primary.length, compare.length);
  const groups = Array.from({ length: maxLen }, (_, index) => ({ a: primary[index], b: compare[index] }));
  wrap.innerHTML = groups.map(({ a, b }, index) => {
    const label = a?.day?.slice(5) || b?.day?.slice(5) || String(index + 1);
    return `
      <div class="usage-bar ${b ? "compare" : ""}" title="${escapeHtml(a?.day || "")} · ${escapeHtml(a?.total_tokens || 0)} tokens${b ? ` / B ${escapeHtml(b.total_tokens || 0)} tokens` : ""}">
        <div class="usage-bar-track">
          ${b ? `<div class="usage-bar-fill compare" style="height:${barHeight(b.total_tokens, maxTokens)}px"></div>` : ""}
          ${a ? `<div class="usage-bar-fill" style="height:${barHeight(a.total_tokens, maxTokens)}px"></div>` : ""}
        </div>
        <div class="usage-bar-label">${escapeHtml(label)}</div>
        <div class="usage-bar-value">${escapeHtml(shortNumber(a?.total_tokens || 0))}${b ? `/${escapeHtml(shortNumber(b.total_tokens || 0))}` : ""}</div>
      </div>
    `;
  }).join("");
}

function aggregateDailyRows(rows) {
  const byDay = new Map();
  for (const row of rows || []) {
    const day = row.day || "";
    if (!day) continue;
    const prev = byDay.get(day) || { day, request_count: 0, total_tokens: 0, error_count: 0 };
    prev.request_count += Number(row.request_count || 0);
    prev.total_tokens += Number(row.total_tokens || 0);
    prev.error_count += Number(row.error_count || 0);
    byDay.set(day, prev);
  }
  return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day)).slice(-60);
}

function barHeight(value, maxTokens) {
  return Math.max(4, Math.round((Number(value || 0) / Math.max(maxTokens, 1)) * 132));
}

function shortNumber(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

document.getElementById("btn-usage-refresh")?.addEventListener("click", () => {
  refreshUsageStats().catch((err) => toast(`刷新统计失败：${err.message}`));
});
document.getElementById("usage-model-filter")?.addEventListener("input", () => {
  clearTimeout(refreshUsageStats._t);
  refreshUsageStats._t = setTimeout(() => refreshUsageStats().catch(() => {}), 180);
});
document.getElementById("usage-agent-filter")?.addEventListener("change", () => {
  refreshUsageStats().catch((err) => toast(`刷新统计失败：${err.message}`));
});
document.getElementById("usage-range-preset")?.addEventListener("change", (event) => {
  applyUsagePreset(event.target.value);
  refreshUsageStats().catch((err) => toast(`刷新统计失败：${err.message}`));
});
["usage-since", "usage-until", "usage-compare-since", "usage-compare-until", "usage-compare-enabled"].forEach((id) => {
  document.getElementById(id)?.addEventListener("change", () => {
    if (id === "usage-since" || id === "usage-until") {
      state.usageRange.preset = "custom";
      const preset = document.getElementById("usage-range-preset");
      if (preset) preset.value = "custom";
    }
    refreshUsageStats().catch((err) => toast(`刷新统计失败：${err.message}`));
  });
});

function agentLabel(clientId) {
  const labels = {
    codex: "Codex",
    "claude-code": "Claude Code",
    hermes: "Hermes",
    "generic-openai": "通用 OpenAI",
    "model-test": "模型测试"
  };
  return labels[clientId] || clientId || "-";
}

/* ---- Agent sessions / skills ---- */
function formatBytes(value) {
  const n = Number(value || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).replace(/\//g, "-");
}

async function refreshTraces() {
  const agentId = document.getElementById("trace-agent-filter")?.value || "";
  const [sessions, requests] = await Promise.all([
    invoke("agent:sessions:list", agentId && agentId !== "generic-openai" ? { agentId } : {}),
    invoke("request-logs:list", agentId ? { agentId, limit: 60 } : { limit: 60 })
  ]);
  state.traces.sessions = sessions || [];
  state.traces.requests = requests || [];
  renderTraceList();
}

function renderTraceList() {
  const wrap = document.getElementById("trace-list");
  const summary = document.getElementById("traces-summary");
  if (!wrap) return;
  const sessionItems = (state.traces.sessions || []).slice(0, 30).map((row) => ({ type: "session", row }));
  const requestItems = (state.traces.requests || []).slice(0, 30).map((row) => ({ type: "request", row }));
  const items = [...requestItems, ...sessionItems].sort((a, b) => {
    const at = a.type === "request" ? a.row.ts : a.row.mtime;
    const bt = b.type === "request" ? b.row.ts : b.row.mtime;
    return String(bt || "").localeCompare(String(at || ""));
  }).slice(0, 60);
  if (summary) summary.textContent = `${requestItems.length} 个请求 · ${sessionItems.length} 个会话`;
  if (!items.length) {
    wrap.innerHTML = '<div class="empty-state">暂无可视化对象</div>';
    return;
  }
  wrap.innerHTML = items.map((item, index) => {
    if (item.type === "request") {
      const row = item.row;
      return `
        <button class="trace-list-item" data-trace-kind="request" data-trace-index="${index}">
          <span class="chip ${Number(row.status || 0) >= 400 ? "warn" : "good"}">请求</span>
          <strong>${escapeHtml(agentLabel(row.client_id))}</strong>
          <span class="mono">${escapeHtml(row.model_id || row.requested_model || "-")}</span>
          <small>${escapeHtml(formatDate(row.ts))} · ${escapeHtml(row.latency_ms || 0)} ms · ${escapeHtml(row.total_tokens || 0)} tokens</small>
        </button>
      `;
    }
    const row = item.row;
    return `
      <button class="trace-list-item" data-trace-kind="session" data-trace-index="${index}">
        <span class="chip">会话</span>
        <strong>${escapeHtml(row.agentLabel || agentLabel(row.agentId))}</strong>
        <span class="mono">${escapeHtml(row.name || row.relativePath || "-")}</span>
        <small>${escapeHtml(formatDate(row.mtime))} · ${escapeHtml(row.source === "hermes-state-db" ? `${row.messageCount || 0} 条` : formatBytes(row.size))}</small>
      </button>
    `;
  }).join("");
  wrap.querySelectorAll("[data-trace-kind]").forEach((button) => {
    button.addEventListener("click", () => openTraceItem(items[Number(button.dataset.traceIndex)]));
  });
}

async function openTraceItem(item) {
  if (!item) return;
  if (item.type === "request") {
    renderRequestTrace(item.row);
    return;
  }
  const row = await invoke("agent:sessions:read", { id: item.row.id });
  renderSessionTrace(row);
}

function renderRequestTrace(row) {
  state.traces.selected = { type: "request", row };
  document.getElementById("trace-title").textContent = `请求 · ${agentLabel(row.client_id)}`;
  document.getElementById("trace-subtitle").textContent = row.model_id || row.requested_model || "-";
  const replayButton = document.getElementById("btn-trace-replay");
  if (replayButton) replayButton.style.display = "";
  const request = parseSummary(row.request_summary);
  const response = parseSummary(row.response_summary);
  const events = [];
  if (request?.messages?.system?.length) {
    events.push({ role: "system", title: "系统提示", text: request.messages.system.map((item) => item.text).join("\n\n---\n\n"), timestamp: row.ts });
  }
  if (request?.tools?.length) {
    events.push({ role: "tool", title: "当前可用工具", text: request.tools.map((tool) => `${tool.name}${tool.description ? `\n${tool.description}` : ""}`).join("\n\n"), timestamp: row.ts });
  }
  if (request?.messages?.skills?.length) {
    events.push({ role: "tool", title: "当前可用 Skill", text: request.messages.skills.join("\n"), timestamp: row.ts });
  }
  if (request?.messages?.user?.length) {
    events.push({ role: "user", title: "用户消息", text: request.messages.user.map((item) => item.text).join("\n\n---\n\n"), timestamp: row.ts });
  } else if (row.prompt_preview) {
    events.push({ role: "user", title: "请求内容", text: row.prompt_preview, timestamp: row.ts });
  }
  events.push(
    { role: "system", title: "入口", text: `${row.method || "POST"} ${row.path || "-"}\n${agentLabel(row.client_id)} → ${row.provider_id || "-"} / ${row.upstream_model || "-"}`, timestamp: row.ts },
    { role: Number(row.status || 0) >= 400 ? "event" : "assistant", title: `响应 ${row.status || "-"}`, text: `${row.latency_ms || 0} ms\nprompt ${row.prompt_tokens || 0} · completion ${row.completion_tokens || 0} · total ${row.total_tokens || 0}${row.error ? `\n${row.error}` : ""}`, timestamp: row.ts }
  );
  if (response?.reasoning) {
    events.push({ role: "assistant", title: "思考 / reasoning", text: response.reasoning, timestamp: row.ts });
  }
  if (response?.toolCalls?.length) {
    events.push({ role: "tool", title: "响应工具调用", text: response.toolCalls.map((call) => `${call.name}\n${call.argumentsPreview || ""}`).join("\n\n"), timestamp: row.ts });
  }
  if (response?.text) {
    events.push({ role: "assistant", title: "响应文本", text: response.text, timestamp: row.ts });
  } else if (row.response_preview) {
    events.push({ role: "assistant", title: "响应内容", text: row.response_preview, timestamp: row.ts });
  }
  renderTraceTimeline(events);
}

function renderSessionTrace(row) {
  state.traces.selected = { type: "session", row };
  document.getElementById("trace-title").textContent = `会话 · ${row.agent?.label || row.agentLabel || agentLabel(row.agentId)}`;
  document.getElementById("trace-subtitle").textContent = row.target || row.path || "";
  const replayButton = document.getElementById("btn-trace-replay");
  if (replayButton) replayButton.style.display = "none";
  const events = (row.conversation?.messages || []).map((message) => ({
    role: message.role,
    title: roleLabel(message.role),
    text: message.text,
    timestamp: message.timestamp,
    kind: message.kind
  }));
  renderTraceTimeline(events);
}

function renderTraceTimeline(events) {
  const wrap = document.getElementById("trace-timeline");
  if (!wrap) return;
  if (!events?.length) {
    wrap.innerHTML = '<div class="empty-state">这个对象暂时没有可解析事件</div>';
    return;
  }
  wrap.innerHTML = events.map((event) => `
    <div class="trace-event ${escapeHtml(event.role || "event")}">
      <div class="trace-dot"></div>
      <div class="trace-card">
        <div class="message-meta">
          <span>${escapeHtml(event.title || roleLabel(event.role))}${event.kind ? ` · ${escapeHtml(event.kind)}` : ""}</span>
          <span>${escapeHtml(formatDate(event.timestamp))}</span>
        </div>
        <div class="message-text">${escapeHtml(event.text || "").replace(/\n/g, "<br>")}</div>
      </div>
    </div>
  `).join("");
}

document.getElementById("btn-traces-refresh")?.addEventListener("click", () => {
  refreshTraces().catch((err) => toast(`刷新调用可视化失败：${err.message}`));
});
document.getElementById("btn-trace-replay")?.addEventListener("click", () => {
  const selected = state.traces.selected;
  if (selected?.type === "request" && selected.row) replayRequestToConsole(selected.row).catch((err) => toast(`回放失败：${err.message}`));
});
document.getElementById("trace-agent-filter")?.addEventListener("change", () => {
  state.liveLogAgent = document.getElementById("trace-agent-filter")?.value || "";
  renderLiveLogs();
  refreshTraces().catch((err) => toast(`刷新调用可视化失败：${err.message}`));
});

async function refreshAgentSessions() {
  const agentId = document.getElementById("session-agent-filter")?.value || "";
  const rows = await invoke("agent:sessions:list", agentId ? { agentId } : {});
  const tbody = document.getElementById("sessions-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of rows || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.agentLabel || agentLabel(row.agentId))}</td>
      <td class="mono">${escapeHtml(row.name)}</td>
      <td class="mono">${escapeHtml(row.relativePath || row.path)}</td>
      <td>${escapeHtml(row.source === "hermes-state-db" ? `${row.messageCount || 0} 条` : formatBytes(row.size))}</td>
      <td class="mono">${escapeHtml(formatDate(row.mtime))}</td>
      <td class="actions-cell">
        <button class="btn" data-session-view="${escapeHtml(row.id)}">查看</button>
        <button class="btn danger" data-session-delete="${escapeHtml(row.id)}">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  if (!rows?.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">没有找到会话文件</td></tr>';
  const summary = document.getElementById("sessions-summary");
  if (summary) summary.textContent = `${rows?.length || 0} 条`;
}

async function refreshAgentSkills() {
  const agentId = document.getElementById("skill-agent-filter")?.value || "";
  const rows = await invoke("agent:skills:list", agentId ? { agentId } : {});
  const tbody = document.getElementById("skills-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of rows || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(row.agentLabel || agentLabel(row.agentId))}</td>
      <td class="mono">${escapeHtml(row.name)}</td>
      <td>${row.disabled ? '<span class="chip muted">已禁用</span>' : '<span class="chip ok">启用</span>'}${row.linked ? '<span class="chip">软链接</span>' : ""}</td>
      <td class="mono">${escapeHtml(row.relativePath || row.path)}</td>
      <td class="mono">${escapeHtml(formatDate(row.mtime))}</td>
      <td class="actions-cell">
        <button class="btn" data-skill-edit="${escapeHtml(row.id)}">编辑</button>
        <button class="btn" data-skill-link="${escapeHtml(row.id)}" data-skill-name="${escapeHtml(row.name)}" data-agent-id="${escapeHtml(row.agentId)}">复制</button>
        <button class="btn" data-skill-toggle="${escapeHtml(row.id)}" data-disabled="${row.disabled ? "1" : "0"}">${row.disabled ? "启用" : "禁用"}</button>
        <button class="btn danger" data-skill-delete="${escapeHtml(row.id)}">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  }
  if (!rows?.length) tbody.innerHTML = '<tr><td colspan="6" class="muted">没有找到 Skill</td></tr>';
  const summary = document.getElementById("skills-summary");
  if (summary) summary.textContent = `${rows?.length || 0} 个`;
}

async function refreshAgentPlugins() {
  const agentId = document.getElementById("plugin-agent-filter")?.value || "claude-code";
  const data = await invoke("agent:plugins:list", { agentId });
  state.plugins = data || { sources: [], marketplaces: [], installed: [], available: [] };
  renderAgentPlugins();
}

function renderAgentPlugins() {
  const sourcesTbody = document.getElementById("plugin-sources-tbody");
  const installedTbody = document.getElementById("installed-plugins-tbody");
  const availableTbody = document.getElementById("available-plugins-tbody");
  if (sourcesTbody) {
    const marketplaceBySource = new Map((state.plugins.marketplaces || []).map((item) => [item.sourceId, item]));
    sourcesTbody.innerHTML = "";
    for (const source of state.plugins.sources || []) {
      const marketplace = marketplaceBySource.get(source.id);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="chip">${escapeHtml(source.origin || source.type)}</span></td>
        <td>
          <div>${escapeHtml(source.name)}</div>
          <div class="tiny muted mono">${escapeHtml(source.path || source.url || "")}</div>
          ${marketplace?.error ? `<div class="tiny muted">${escapeHtml(marketplace.error)}</div>` : ""}
        </td>
        <td>${escapeHtml(marketplace?.pluginCount ?? 0)}</td>
        <td class="actions-cell">${source.origin === "switchyard" ? `<button class="btn danger" data-plugin-source-remove="${escapeHtml(source.id)}">移除</button>` : ""}</td>
      `;
      sourcesTbody.appendChild(tr);
    }
    if (!state.plugins.sources?.length) sourcesTbody.innerHTML = '<tr><td colspan="4" class="muted">没有插件源</td></tr>';
    document.getElementById("plugin-sources-summary").textContent = `${state.plugins.sources?.length || 0} 个源`;
  }
  if (installedTbody) {
    installedTbody.innerHTML = "";
    for (const plugin of state.plugins.installed || []) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div>${escapeHtml(plugin.name)}</div><div class="tiny muted">${escapeHtml(plugin.description || plugin.version || "")}</div></td>
        <td class="chip-row">${(plugin.features || []).map((feature) => `<span class="chip">${escapeHtml(feature)}</span>`).join("") || '<span class="muted">-</span>'}</td>
        <td class="mono">${escapeHtml(plugin.path || "-")}</td>
      `;
      installedTbody.appendChild(tr);
    }
    if (!state.plugins.installed?.length) installedTbody.innerHTML = '<tr><td colspan="3" class="muted">没有找到已安装插件</td></tr>';
    document.getElementById("installed-plugins-summary").textContent = `${state.plugins.installed?.length || 0} 个`;
  }
  if (availableTbody) {
    availableTbody.innerHTML = "";
    for (const plugin of (state.plugins.available || []).slice(0, 200)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div>${escapeHtml(plugin.name)}</div><div class="tiny muted">${escapeHtml(plugin.version || plugin.author || "")}</div></td>
        <td>${escapeHtml(plugin.description || "-").slice(0, 260)}</td>
        <td>${plugin.category ? `<span class="chip">${escapeHtml(plugin.category)}</span>` : '<span class="muted">-</span>'}</td>
        <td>${escapeHtml(plugin.marketplace || "-")}</td>
      `;
      availableTbody.appendChild(tr);
    }
    if (!state.plugins.available?.length) availableTbody.innerHTML = '<tr><td colspan="4" class="muted">没有可用插件数据</td></tr>';
    document.getElementById("available-plugins-summary").textContent = `${state.plugins.available?.length || 0} 个`;
  }
}

async function refreshCoreFiles() {
  const agentId = document.getElementById("core-agent-filter")?.value || "codex";
  const rows = await invoke("agent:core-files:list", { agentId });
  state.coreFiles.items = rows || [];
  renderCoreFileOptions();
  if (state.coreFiles.items.length) {
    const currentId = state.coreFiles.current?.id;
    const next = state.coreFiles.items.find((item) => item.id === currentId) || state.coreFiles.items[0];
    await loadCoreFile(next.id);
  } else {
    state.coreFiles.current = null;
    document.getElementById("core-file-select").innerHTML = "";
    document.getElementById("core-file-path").textContent = "-";
    document.getElementById("core-file-editor").value = "";
  }
}

function renderCoreFileOptions() {
  const select = document.getElementById("core-file-select");
  if (!select) return;
  select.innerHTML = (state.coreFiles.items || [])
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.relativePath)}${item.exists ? "" : "（新建）"}</option>`)
    .join("");
  const summary = document.getElementById("core-files-summary");
  if (summary) summary.textContent = `${state.coreFiles.items?.length || 0} 个文件`;
}

async function loadCoreFile(id) {
  if (!id) return;
  const row = await invoke("agent:core-files:read", { id });
  state.coreFiles.current = row;
  document.getElementById("core-file-select").value = id;
  document.getElementById("core-file-path").textContent = `${row.exists ? "已存在" : "将新建"} · ${row.target || row.path || ""}`;
  document.getElementById("core-file-editor").value = row.text || "";
}

document.getElementById("core-agent-filter")?.addEventListener("change", () => {
  state.coreFiles.current = null;
  refreshCoreFiles().catch((err) => toast(`读取核心文件失败：${err.message}`));
});
document.getElementById("core-file-select")?.addEventListener("change", (event) => {
  loadCoreFile(event.target.value).catch((err) => toast(`读取核心文件失败：${err.message}`));
});
document.getElementById("btn-core-file-refresh")?.addEventListener("click", () => {
  const id = document.getElementById("core-file-select")?.value;
  loadCoreFile(id).catch((err) => toast(`读取核心文件失败：${err.message}`));
});
document.getElementById("btn-core-file-save")?.addEventListener("click", async () => {
  const id = document.getElementById("core-file-select")?.value;
  if (!id) return;
  try {
    await invoke("agent:core-files:save", { id, text: document.getElementById("core-file-editor")?.value || "" });
    toast("核心文件已保存");
    await refreshCoreFiles();
  } catch (err) {
    toast(`保存核心文件失败：${err.message}`);
  }
});

function openTextViewer({ title, path, text, editable, save }) {
  state.textEditor = typeof save === "function" ? save : null;
  document.getElementById("text-viewer-title").textContent = title || "查看";
  document.getElementById("text-viewer-path").textContent = path || "";
  const textarea = document.getElementById("text-viewer-content");
  textarea.value = text || "";
  textarea.readOnly = !editable;
  const saveBtn = document.getElementById("btn-text-viewer-save");
  saveBtn.style.display = editable ? "" : "none";
  document.getElementById("text-viewer-wrap").classList.add("open");
}

function openSessionViewer(row) {
  state.sessionRaw = `${row.truncated ? "[仅显示文件末尾内容]\n\n" : ""}${row.text || ""}`;
  document.getElementById("session-viewer-title").textContent = `会话 · ${row.agent?.label || agentLabel(row.agentId)}`;
  document.getElementById("session-viewer-path").textContent = row.target || "";
  document.getElementById("session-raw").value = state.sessionRaw;
  renderConversation(row.conversation);
  setSessionViewMode("conversation");
  document.getElementById("session-viewer-wrap").classList.add("open");
}

function renderConversation(conversation) {
  const wrap = document.getElementById("session-conversation");
  if (!wrap) return;
  const messages = conversation?.messages || [];
  const dialogue = messages.filter((message) => ["user", "assistant"].includes(message.role));
  const visibleMessages = dialogue.length ? dialogue : messages;
  wrap.innerHTML = "";
  if (!visibleMessages.length) {
    wrap.innerHTML = '<div class="empty-state">这个会话暂时无法解析成对话，切到“原始 JSON”查看。</div>';
    return;
  }
  if (dialogue.length && dialogue.length < messages.length) {
    const note = document.createElement("div");
    note.className = "empty-state compact";
    note.textContent = `已隐藏 ${messages.length - dialogue.length} 条系统/工具记录，可切到“原始 JSON”查看完整内容。`;
    wrap.appendChild(note);
  }
  for (const message of visibleMessages) {
    const item = document.createElement("div");
    item.className = `message-bubble ${message.role || "event"}`;
    item.innerHTML = `
      <div class="message-meta">
        <span>${escapeHtml(roleLabel(message.role))}</span>
        <span>${escapeHtml(formatDate(message.timestamp))}</span>
      </div>
      <div class="message-text">${escapeHtml(message.text).replace(/\n/g, "<br>")}</div>
    `;
    wrap.appendChild(item);
  }
}

function roleLabel(role) {
  return {
    user: "用户",
    assistant: "助手",
    system: "系统",
    developer: "开发者",
    tool: "工具",
    event: "事件"
  }[role] || role || "事件";
}

function setSessionViewMode(mode) {
  const isRaw = mode === "raw";
  document.getElementById("session-conversation").style.display = isRaw ? "none" : "";
  document.getElementById("session-raw").style.display = isRaw ? "" : "none";
  document.getElementById("btn-session-view-conversation").classList.toggle("primary", !isRaw);
  document.getElementById("btn-session-view-raw").classList.toggle("primary", isRaw);
}

document.getElementById("btn-sessions-refresh")?.addEventListener("click", () => {
  refreshAgentSessions().catch((err) => toast(`刷新会话失败：${err.message}`));
});
document.getElementById("session-agent-filter")?.addEventListener("change", () => {
  refreshAgentSessions().catch((err) => toast(`刷新会话失败：${err.message}`));
});
document.getElementById("sessions-tbody")?.addEventListener("click", async (event) => {
  const view = event.target.closest("[data-session-view]");
  const del = event.target.closest("[data-session-delete]");
  try {
    if (view) {
      const row = await invoke("agent:sessions:read", { id: view.dataset.sessionView });
      openSessionViewer(row);
    } else if (del) {
      if (!confirm("确定删除或归档这个会话吗？文件会移到废纸篓，Hermes 数据库会话会标记为归档。")) return;
      await invoke("agent:sessions:delete", { id: del.dataset.sessionDelete });
      toast("会话已删除或归档");
      await refreshAgentSessions();
    }
  } catch (err) {
    toast(`会话操作失败：${err.message}`);
  }
});

document.getElementById("btn-session-view-conversation")?.addEventListener("click", () => setSessionViewMode("conversation"));
document.getElementById("btn-session-view-raw")?.addEventListener("click", () => setSessionViewMode("raw"));

document.getElementById("btn-skills-refresh")?.addEventListener("click", () => {
  refreshAgentSkills().catch((err) => toast(`刷新 Skill 失败：${err.message}`));
});
document.getElementById("skill-agent-filter")?.addEventListener("change", () => {
  refreshAgentSkills().catch((err) => toast(`刷新 Skill 失败：${err.message}`));
});
document.getElementById("skills-tbody")?.addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-skill-edit]");
  const link = event.target.closest("[data-skill-link]");
  const toggle = event.target.closest("[data-skill-toggle]");
  const del = event.target.closest("[data-skill-delete]");
  try {
    if (edit) {
      const row = await invoke("agent:skills:read", { id: edit.dataset.skillEdit });
      openTextViewer({
        title: `编辑 Skill · ${pathName(row.target)}`,
        path: row.contentPath || row.target,
        text: row.text || "",
        editable: true,
        save: async (text) => {
          await invoke("agent:skills:save", { id: edit.dataset.skillEdit, text });
          toast("Skill 已保存");
          await refreshAgentSkills();
        }
      });
    } else if (link) {
      openSkillLinkDialog({
        id: link.dataset.skillLink,
        name: link.dataset.skillName,
        agentId: link.dataset.agentId
      });
    } else if (toggle) {
      const disabled = toggle.dataset.disabled !== "1";
      await invoke("agent:skills:disable", { id: toggle.dataset.skillToggle, disabled });
      toast(disabled ? "Skill 已禁用" : "Skill 已启用");
      await refreshAgentSkills();
    } else if (del) {
      if (!confirm("确定把这个 Skill 目录移到废纸篓吗？")) return;
      await invoke("agent:skills:delete", { id: del.dataset.skillDelete });
      toast("Skill 已移到废纸篓");
      await refreshAgentSkills();
    }
  } catch (err) {
    toast(`Skill 操作失败：${err.message}`);
  }
});

function openSkillLinkDialog(skill) {
  state.skillLink = skill;
  document.getElementById("skill-link-source").textContent = `${agentLabel(skill.agentId)} / ${skill.name}`;
  document.getElementById("skill-link-name").value = skill.name || "";
  const target = document.getElementById("skill-link-target");
  const options = Array.from(target.options).map((item) => item.value);
  target.value = options.find((value) => value !== skill.agentId) || options[0] || "codex";
  document.getElementById("skill-link-wrap").classList.add("open");
}

document.getElementById("btn-skill-link-confirm")?.addEventListener("click", async () => {
  if (!state.skillLink?.id) return;
  try {
    const result = await invoke("agent:skills:link", {
      id: state.skillLink.id,
      targetAgentId: document.getElementById("skill-link-target").value,
      skillName: document.getElementById("skill-link-name").value
    });
    toast(`已创建软链接：${result.skillName}`);
    document.getElementById("skill-link-wrap").classList.remove("open");
    await refreshAgentSkills();
  } catch (err) {
    toast(`创建软链接失败：${err.message}`);
  }
});

document.getElementById("btn-plugins-refresh")?.addEventListener("click", () => {
  refreshAgentPlugins().catch((err) => toast(`刷新插件失败：${err.message}`));
});
document.getElementById("plugin-agent-filter")?.addEventListener("change", () => {
  refreshAgentPlugins().catch((err) => toast(`刷新插件失败：${err.message}`));
});
document.getElementById("btn-plugin-source-add")?.addEventListener("click", async () => {
  try {
    await invoke("agent:plugins:add-source", {
      agentId: document.getElementById("plugin-agent-filter")?.value || "claude-code",
      name: document.getElementById("plugin-source-name")?.value || "",
      path: document.getElementById("plugin-source-path")?.value || "",
      url: document.getElementById("plugin-source-url")?.value || ""
    });
    document.getElementById("plugin-source-name").value = "";
    document.getElementById("plugin-source-path").value = "";
    document.getElementById("plugin-source-url").value = "";
    toast("插件源已添加");
    await refreshAgentPlugins();
  } catch (err) {
    toast(`添加插件源失败：${err.message}`);
  }
});
document.getElementById("plugin-sources-tbody")?.addEventListener("click", async (event) => {
  const remove = event.target.closest("[data-plugin-source-remove]");
  if (!remove) return;
  try {
    await invoke("agent:plugins:remove-source", { id: remove.dataset.pluginSourceRemove });
    toast("插件源已移除");
    await refreshAgentPlugins();
  } catch (err) {
    toast(`移除插件源失败：${err.message}`);
  }
});

async function searchSkillHub() {
  const tbody = document.getElementById("skillhub-tbody");
  const summary = document.getElementById("skillhub-summary");
  if (!tbody || !summary) return;
  const keyword = document.getElementById("skillhub-search")?.value || "";
  tbody.innerHTML = '<tr><td colspan="4" class="muted">搜索中…</td></tr>';
  summary.textContent = "正在查询 SkillHub…";
  try {
    const result = await invoke("skillhub:search", { keyword, limit: 20 });
    state.skillHub.items = result.items || [];
    summary.textContent = `${result.total || state.skillHub.items.length} 个结果 · ${result.url}`;
    tbody.innerHTML = "";
    for (const item of state.skillHub.items) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <div class="mono">${escapeHtml(item.slug)}</div>
          <div>${escapeHtml(item.name)}</div>
          <div class="chip-row">${skillHubTagsHtml(item)}</div>
        </td>
        <td>${escapeHtml(item.description || "-").slice(0, 220)}</td>
        <td><div class="chip-row compact">${skillHubMetricsHtml(item) || '<span class="muted">-</span>'}</div></td>
        <td class="actions-cell">
          <button class="btn" data-skillhub-open="${escapeHtml(item.slug)}">详情</button>
          <button class="btn" data-skillhub-download="${escapeHtml(item.slug)}">下载</button>
          <button class="btn primary" data-skillhub-install="${escapeHtml(item.slug)}">安装</button>
        </td>
      `;
      tbody.appendChild(tr);
    }
    if (!state.skillHub.items.length) tbody.innerHTML = '<tr><td colspan="4" class="muted">没有匹配结果</td></tr>';
  } catch (err) {
    summary.textContent = `查询失败：${err.message}`;
    tbody.innerHTML = '<tr><td colspan="4" class="muted">SkillHub 查询失败</td></tr>';
  }
}

function skillHubMetric(label, value) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? { label, value: Number(value).toLocaleString("zh-CN") } : null;
}

function skillHubMetrics(item) {
  return [
    skillHubMetric("下载", item.downloads),
    skillHubMetric("Star", item.stars),
    skillHubMetric("安装", item.installs)
  ].filter(Boolean);
}

function skillHubMetricsHtml(item) {
  return skillHubMetrics(item)
    .map((metric) => `<span class="chip">${escapeHtml(metric.label)} ${escapeHtml(metric.value)}</span>`)
    .join("");
}

function skillHubTags(item) {
  return [
    item.requiresApiKey ? "需要 Key" : "无需 Key",
    item.source,
    item.category,
    ...(Array.isArray(item.subCategories) ? item.subCategories.slice(0, 2) : [])
  ].filter(Boolean);
}

function skillHubTagsHtml(item) {
  return skillHubTags(item)
    .map((tag, index) => `<span class="chip ${index === 0 && !item.requiresApiKey ? "good" : index === 0 ? "warn" : ""}">${escapeHtml(tag)}</span>`)
    .join("");
}

document.getElementById("btn-skillhub-search")?.addEventListener("click", searchSkillHub);
document.getElementById("skillhub-search")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") searchSkillHub();
});
document.getElementById("skillhub-tbody")?.addEventListener("click", async (event) => {
  const open = event.target.closest("[data-skillhub-open]");
  const download = event.target.closest("[data-skillhub-download]");
  const install = event.target.closest("[data-skillhub-install]");
  if (!open && !download && !install) return;
  const slug = open?.dataset.skillhubOpen || download?.dataset.skillhubDownload || install?.dataset.skillhubInstall;
  const item = state.skillHub.items.find((row) => row.slug === slug) || { slug, name: slug };
  if (install) {
    openSkillHubInstallDialog(item);
    return;
  }
  if (open) {
    openSkillHubDetailDialog(item);
    return;
  }
  try {
    if (download) {
      const result = await invoke("skillhub:download", { slug, version: item.version || "" });
      toast(result.canceled ? "已取消下载" : `已下载：${pathName(result.path)}`);
    }
  } catch (err) {
    toast(`SkillHub 操作失败：${err.message}`);
  }
});

function openSkillHubDetailDialog(item) {
  state.skillHub.detail = item;
  document.getElementById("skillhub-detail-title").textContent = item.name || item.slug || "SkillHub 详情";
  document.getElementById("skillhub-detail-slug").textContent = item.slug || "-";
  document.getElementById("skillhub-detail-tags").innerHTML = skillHubTagsHtml(item) || '<span class="muted">-</span>';
  document.getElementById("skillhub-detail-description").textContent = item.description || "暂无说明";
  document.getElementById("skillhub-detail-metrics").innerHTML = skillHubMetricsHtml(item) || '<span class="muted">暂无公开数据</span>';
  document.getElementById("skillhub-detail-owner").textContent = item.ownerName || "-";
  document.getElementById("skillhub-detail-version").textContent = item.version || "-";
  document.getElementById("skillhub-detail-source").textContent = item.source || "-";
  document.getElementById("skillhub-detail-homepage").textContent = item.homepage || `https://skillhub.cn/skills/${item.slug || ""}`;
  document.getElementById("skillhub-detail-wrap").classList.add("open");
}

function openSkillHubInstallDialog(item) {
  state.skillHub.install = item;
  document.getElementById("skillhub-install-source").textContent = `${item.name || item.slug} / ${item.slug}`;
  document.getElementById("skillhub-install-name").value = item.slug || item.name || "";
  document.getElementById("skillhub-install-target").value = "codex";
  document.getElementById("skillhub-install-overwrite").checked = false;
  document.getElementById("skillhub-install-wrap").classList.add("open");
}

document.getElementById("btn-skillhub-detail-open")?.addEventListener("click", async () => {
  const item = state.skillHub.detail;
  if (!item?.slug) return;
  try {
    await invoke("skillhub:open", { slug: item.slug, kind: "detail" });
  } catch (err) {
    toast(`打开 SkillHub 失败：${err.message}`);
  }
});

document.getElementById("btn-skillhub-detail-download")?.addEventListener("click", async () => {
  const item = state.skillHub.detail;
  if (!item?.slug) return;
  try {
    const result = await invoke("skillhub:download", { slug: item.slug, version: item.version || "" });
    toast(result.canceled ? "已取消下载" : `已下载：${pathName(result.path)}`);
  } catch (err) {
    toast(`下载 Skill 失败：${err.message}`);
  }
});

document.getElementById("btn-skillhub-detail-install")?.addEventListener("click", () => {
  const item = state.skillHub.detail;
  if (!item?.slug) return;
  document.getElementById("skillhub-detail-wrap").classList.remove("open");
  openSkillHubInstallDialog(item);
});

document.getElementById("btn-skillhub-install-confirm")?.addEventListener("click", async () => {
  const item = state.skillHub.install;
  if (!item?.slug) return;
  try {
    const result = await invoke("skillhub:install", {
      slug: item.slug,
      targetAgentId: document.getElementById("skillhub-install-target").value,
      skillName: document.getElementById("skillhub-install-name").value || item.slug,
      overwrite: Boolean(document.getElementById("skillhub-install-overwrite").checked)
    });
    toast(`已安装到 ${agentLabel(result.targetAgentId)}：${result.skillName}`);
    document.getElementById("skillhub-install-wrap").classList.remove("open");
    await refreshAgentSkills();
  } catch (err) {
    toast(`安装 Skill 失败：${err.message}`);
  }
});

document.getElementById("btn-text-viewer-save")?.addEventListener("click", async () => {
  if (!state.textEditor) return;
  try {
    await state.textEditor(document.getElementById("text-viewer-content").value);
    document.getElementById("text-viewer-wrap").classList.remove("open");
  } catch (err) {
    toast(`保存失败：${err.message}`);
  }
});

function pathName(value) {
  return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "Skill";
}

function modelsForClient(clientId) {
  const models = (state.config?.models || []).filter((model) => model.enabled !== false);
  const filter = state.config?.clients?.[clientId] || { enabled: true, allowedModels: ["*"] };
  if (filter.enabled === false) return [];
  const allowed = new Set(filter.allowedModels || ["*"]);
  if (allowed.has("*")) return models;
  return models.filter((model) => {
    const keys = [model.id, model.upstreamModel, ...(model.aliases || [])].filter(Boolean);
    return keys.some((key) => allowed.has(key));
  });
}

function responseText(body) {
  if (!body) return "";
  const chat = body.choices?.[0]?.message?.content;
  if (chat) return String(chat);
  const content = body.content;
  if (Array.isArray(content)) return content.map((item) => item.text || item.content || "").filter(Boolean).join("\n");
  const output = body.output;
  if (Array.isArray(output)) {
    return output.flatMap((item) => item.content || []).map((item) => item.text || "").filter(Boolean).join("\n");
  }
  return body.error?.message || body.message || "";
}

function visionModeLabel(mode) {
  return {
    direct: "直连视觉模型",
    fallback: "已走视觉兜底",
    unsupported_no_fallback: "模型未声明视觉且未配置兜底",
    fallback_self: "兜底模型配置为自己，未实际兜底",
    no_route: "未找到模型路由",
    direct_unverified: "直接发送图片，模型未声明视觉"
  }[mode] || mode || "-";
}

function imageDiagnosticText(diag) {
  if (!diag?.included) return "";
  const actual = diag.actual || {};
  const mode = actual.mode || diag.expectedPath;
  const lines = [
    "图片测试",
    `- 测试图：${diag.fixture || "PNG 图片"}，预期答案：${diag.expectedColor || "红色"}`,
    `- 模型：${diag.modelId || diag.requestedModel || "-"} → 上游 ${diag.upstreamModel || "-"}`,
    `- 模型声明：${diag.supportsImages ? "支持视觉" : "未声明视觉"}${diag.visionFallbackModelId ? `；兜底模型 ${diag.visionFallbackModelId}` : ""}`,
    `- 实际路径：${visionModeLabel(mode)}`
  ];
  if (actual.mode === "fallback") {
    lines.push(`- 兜底结果：${actual.fallbackOk ? "成功，图片已先交给兜底视觉模型描述" : `失败：${actual.fallbackError || "未知错误"}`}`);
  } else if (actual.mode === "direct") {
    lines.push("- 结果判断：图片已直接传给当前上游模型");
  } else if (mode === "unsupported_no_fallback" || mode === "direct_unverified") {
    lines.push("- 提醒：如果上游报无效图片，通常需要把该模型标为支持视觉，或配置一个视觉兜底模型。");
  }
  return lines.join("\n");
}

function collectTestRequest(modelOverride) {
  const prompt = document.getElementById("test-prompt")?.value || "你好";
  const temperatureRaw = document.getElementById("test-temperature")?.value;
  const maxTokensRaw = document.getElementById("test-max-tokens")?.value;
  return {
    clientId: document.getElementById("test-agent")?.value || "generic-openai",
    protocol: document.getElementById("test-protocol")?.value || "openai_chat",
    model: modelOverride || document.getElementById("test-model")?.value || "",
    messages: parseTestMessages(prompt),
    stream: Boolean(document.getElementById("test-stream")?.checked),
    includeImage: Boolean(document.getElementById("test-image")?.checked),
    temperature: temperatureRaw === "" ? undefined : Number(temperatureRaw),
    maxTokens: maxTokensRaw === "" ? undefined : Number(maxTokensRaw)
  };
}

function renderTestRequestPreview(req, actual = null) {
  const out = document.getElementById("test-request-preview");
  if (!out || !req?.model) return;
  const base = state.status?.running
    ? `http://${state.status.host}:${state.status.port}`
    : `http://${state.config?.host || "127.0.0.1"}:${state.config?.port || 17888}`;
  const preview = actual || safePreviewRequest(buildTestRequest({ base, ...req }));
  out.textContent = JSON.stringify(preview, null, 2);
}

function safePreviewRequest(built) {
  return {
    url: built.url,
    headers: Object.fromEntries(Object.entries(built.headers || {}).map(([key, value]) => [
      key,
      /authorization|api-key/i.test(key) ? redactPreviewHeader(value) : value
    ])),
    body: built.body
  };
}

function redactPreviewHeader(value) {
  const text = String(value || "");
  if (/^bearer\s+/i.test(text)) return "Bearer ***";
  return text ? "***" : "";
}

document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", (e) => {
  const ov = e.currentTarget.closest(".dialog-overlay");
  if (ov) ov.classList.remove("open");
}));

/* Close dialogs on overlay click */
document.querySelectorAll(".dialog-overlay").forEach((el) => {
  el.addEventListener("click", (e) => { if (e.target === el) el.classList.remove("open"); });
});

/* Subscribe to live logs */
let logBuffer = [];
const LOG_LIMIT = 500;

function logEntryAgent(entry) {
  if (entry?.clientId) return entry.clientId;
  const text = `${entry?.msg || ""} ${entry?.model || ""} ${entry?.path || ""}`.toLowerCase();
  if (text.includes("claude-code") || text.includes("claude code")) return "claude-code";
  if (text.includes("codex")) return "codex";
  if (text.includes("hermes")) return "hermes";
  if (text.includes("model-test")) return "model-test";
  if (text.includes("generic-openai") || text.includes("openai")) return "generic-openai";
  return "";
}

function visibleLogEntries() {
  const agent = state.liveLogAgent || "";
  return agent ? logBuffer.filter((entry) => logEntryAgent(entry) === agent) : logBuffer;
}

function formatLogLine(entry) {
  return `${formatLocalTime(entry.ts)} ${(entry.level || "info").padEnd(6)} ${entry.msg || ""} ${entry.model ? "model=" + entry.model : ""} ${entry.clientId ? "client=" + entry.clientId : ""}`;
}

function renderLiveLogs() {
  const entries = visibleLogEntries();
  renderStructuredLogs(entries);
}

function renderStructuredLogs(entries) {
  const wrap = document.getElementById("structured-logs");
  const summary = document.getElementById("live-log-summary");
  if (!wrap) return;
  const traceEntries = (entries || []).filter((entry) => entry?.requestLog || entry?.traceLog);
  const latest = traceEntries.slice(-80).reverse();
  if (summary) summary.textContent = `${latest.length} / ${traceEntries.length} 条`;
  if (!latest.length) {
    wrap.innerHTML = '<div class="empty-state">等待新的网关请求</div>';
    return;
  }
  wrap.innerHTML = latest.map((entry) => {
    const isRequest = !!entry.requestLog || !!entry.traceLog;
    const bad = entry.level === "error" || Number(entry.status || 0) >= 400;
    const title = isRequest
      ? `${agentLabel(entry.clientId)} · ${entry.method || "POST"} ${entry.path || ""}`
      : (entry.msg || "事件");
    const chips = [
      entry.level ? `<span class="chip ${bad ? "warn" : "good"}">${escapeHtml(entry.level)}</span>` : "",
      entry.traceLog ? `<span class="chip good">开始</span>` : "",
      entry.requestLog ? `<span class="chip">${escapeHtml(entry.status || "-")}</span>` : "",
      entry.apiFormat ? `<span class="chip">${escapeHtml(PROTOCOL_LABEL[entry.apiFormat] || entry.apiFormat)}</span>` : ""
    ].filter(Boolean).join("");
    return `
      <div class="structured-log-card ${bad ? "warn" : ""}">
        <div class="structured-log-head">
          <div>
            <strong>${escapeHtml(title)}</strong>
            <div class="tiny muted mono">${escapeHtml(formatDate(entry.ts))}</div>
          </div>
          <div class="chip-row">${chips}</div>
        </div>
        ${entry.modelId || entry.requestedModel || entry.upstreamModel ? `
          <dl class="structured-log-grid">
            <dt>模型</dt><dd class="mono">${escapeHtml(entry.modelId || entry.requestedModel || entry.model || "-")}</dd>
            <dt>上游</dt><dd class="mono">${escapeHtml(entry.providerId || "-")} / ${escapeHtml(entry.upstreamModel || "-")}</dd>
            <dt>耗时</dt><dd>${escapeHtml(entry.ms ?? entry.latencyMs ?? "-")} ms</dd>
            <dt>Token</dt><dd>${escapeHtml(entry.promptTokens || 0)} + ${escapeHtml(entry.completionTokens || 0)} = ${escapeHtml(entry.totalTokens || 0)}</dd>
          </dl>
        ` : ""}
        ${structuredSummaryHtml(entry)}
        ${entry.error ? `<div class="structured-log-section error"><span>错误</span><p>${escapeHtml(entry.error)}</p></div>` : ""}
      </div>
    `;
  }).join("");
}

function parseSummary(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function logValue(entry, camel, snake) {
  return entry?.[camel] ?? entry?.[snake] ?? "";
}

function structuredSummaryHtml(entry) {
  const request = parseSummary(logValue(entry, "requestSummary", "request_summary"));
  const response = parseSummary(logValue(entry, "responseSummary", "response_summary"));
  const parts = [];
  if (request) {
    const messages = request.messages || {};
    if (messages.system?.length) parts.push(summaryBlock("系统提示", messages.system.map((item) => item.text).filter(Boolean)));
    if (messages.user?.length) parts.push(summaryBlock("用户消息", messages.user.map((item) => item.text).filter(Boolean)));
    if (messages.assistant?.some((item) => item.toolCalls?.length)) {
      const calls = messages.assistant.flatMap((item) => item.toolCalls || []).map((call) => `${call.name}${call.id ? ` · ${call.id}` : ""}`);
      parts.push(summaryListBlock("历史工具调用", calls));
    }
    if (messages.tool?.length) parts.push(summaryBlock("工具结果", messages.tool.map((item) => item.text).filter(Boolean)));
    if (request.tools?.length) {
      parts.push(summaryToolBlock("当前可用工具", request.tools));
    }
    if (messages.skills?.length) parts.push(summaryListBlock("当前可用 Skill", messages.skills));
    if (messages.images) parts.push(summaryListBlock("图片 / 附件", [`图片 ${messages.images} 个`]));
    parts.push(summaryListBlock("模型参数", [
      `stream: ${request.params?.stream ? "true" : "false"}`,
      request.params?.temperature !== undefined ? `temperature: ${request.params.temperature}` : "",
      request.params?.maxTokens !== undefined ? `max_tokens: ${request.params.maxTokens}` : "",
      request.params?.toolChoice ? `tool_choice: ${JSON.stringify(request.params.toolChoice).slice(0, 180)}` : ""
    ].filter(Boolean)));
  } else if (entry.promptPreview) {
    parts.push(summaryBlock("请求", [entry.promptPreview]));
  }
  if (response) {
    if (response.text) parts.push(summaryBlock("响应文本", [response.text]));
    if (response.reasoning) parts.push(summaryBlock("思考 / reasoning", [response.reasoning]));
    if (response.toolCalls?.length) parts.push(summaryToolCallBlock("响应工具调用", response.toolCalls));
    if (response.usage) {
      parts.push(summaryListBlock("响应用量", [
        `prompt: ${response.usage.promptTokens || 0}`,
        `completion: ${response.usage.completionTokens || 0}`,
        `total: ${response.usage.totalTokens || 0}`,
        response.finishReason ? `finish: ${response.finishReason}` : "",
        response.stream ? "stream: true" : ""
      ].filter(Boolean)));
    }
    if (response.error) parts.push(`<div class="structured-log-section error"><span>响应错误</span><p>${escapeHtml(response.error)}</p></div>`);
  } else if (entry.responsePreview) {
    parts.push(summaryBlock("响应", [entry.responsePreview]));
  }
  return parts.join("");
}

function summaryBlock(title, texts) {
  const body = (texts || []).filter(Boolean).slice(0, 4).map((text) => `<p>${escapeHtml(text)}</p>`).join("");
  if (!body) return "";
  return `<div class="structured-log-section"><span>${escapeHtml(title)}</span>${body}</div>`;
}

function summaryListBlock(title, items) {
  const list = (items || []).filter(Boolean).slice(0, 80);
  if (!list.length) return "";
  return `<div class="structured-log-section"><span>${escapeHtml(title)}</span><div class="chip-row">${list.map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("")}</div></div>`;
}

function summaryToolBlock(title, tools) {
  const list = (tools || []).filter((tool) => tool.name).slice(0, 80);
  if (!list.length) return "";
  return `<div class="structured-log-section"><span>${escapeHtml(title)} · ${list.length}</span><div class="tool-grid">${list.map((tool) => `
    <div class="tool-pill">
      <strong>${escapeHtml(tool.name)}</strong>
      <small>${escapeHtml(tool.description || `${tool.propertyCount || 0} 个参数`)}</small>
    </div>
  `).join("")}</div></div>`;
}

function summaryToolCallBlock(title, calls) {
  const list = (calls || []).filter((call) => call.name).slice(0, 60);
  if (!list.length) return "";
  return `<div class="structured-log-section"><span>${escapeHtml(title)}</span>${list.map((call) => `
    <p><strong>${escapeHtml(call.name)}</strong>${call.argumentsPreview ? `<br>${escapeHtml(call.argumentsPreview)}` : ""}</p>
  `).join("")}</div>`;
}

onLog((entry) => {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
  renderLiveLogs();
  if (document.getElementById("panel-logs")?.classList.contains("active")) {
    clearTimeout(refreshLogTail._t);
    refreshLogTail._t = setTimeout(() => refreshLogTail().catch(() => {}), 300);
  }
  if (entry?.requestLog) {
    clearTimeout(refreshUsageStats._logT);
    refreshUsageStats._logT = setTimeout(() => refreshUsageStats().catch(() => {}), 250);
    clearTimeout(refreshTraces._logT);
    refreshTraces._logT = setTimeout(() => refreshTraces().catch(() => {}), 400);
  }
});

/* ---- First-launch onboarding (cc-switch import prompt) ---- */
async function checkFirstLaunch() {
  try {
    const config = await invoke("config:read");
    if (config.providers.length > 0) return; // already configured
    const result = await invoke("import:ccswitch");
    if (!result || !result.ok || result.config.providers.length === 0) return;
    // Set the global importResult so the existing btn-import-apply handler works
    importResult = result;
    state.importShowKeys = false;
    renderImportPreview(result);
    document.getElementById("import-dialog-wrap").classList.add("open");
  } catch {}
}

// Also add a "首次设置" button in settings/overview for manual trigger
// The existing btn-import already handles cc-switch for non-first-launch


function refreshTestModelOptions() {
  const sel = document.getElementById("test-model");
  if (!sel || !state.config) return;
  const clientId = document.getElementById("test-agent")?.value || "generic-openai";
  const current = sel.value;
  const models = modelsForClient(clientId);
  sel.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join("");
  if (current && models.some((m) => m.id === current)) sel.value = current;
  try { renderTestRequestPreview(collectTestRequest()); } catch {}
}
document.getElementById("test-agent")?.addEventListener("change", refreshTestModelOptions);
["test-protocol", "test-model", "test-stream", "test-image", "test-temperature", "test-max-tokens", "test-prompt"].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const eventName = el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? "input" : "change";
  el.addEventListener(eventName, () => {
    try { renderTestRequestPreview(collectTestRequest()); } catch {}
  });
});
document.getElementById("btn-test-sample")?.addEventListener("click", () => {
  document.getElementById("test-prompt").value = [
    "system: 你是 Switchyard 连通性测试助手，只回答必要信息。",
    "",
    "user: 第一轮，请回复 pong。",
    "",
    "assistant: pong",
    "",
    "user: 第二轮，请用一句话说明你还记得上一轮。"
  ].join("\n");
  renderTestRequestPreview(collectTestRequest());
});
document.getElementById("btn-test-clear")?.addEventListener("click", () => {
  document.getElementById("test-prompt").value = "user: ";
  renderTestRequestPreview(collectTestRequest());
});
document.getElementById("btn-test-run")?.addEventListener("click", async () => {
  const out = document.getElementById("test-output");
  const req = collectTestRequest();
  if (!req.model) { toast("请选择模型"); return; }
  renderTestRequestPreview(req);
  out.textContent = `→ ${req.clientId} · ${req.protocol} · ${req.model}\n请求中…`;
  try {
    const r = await invoke("test:chat", req);
    if (r.requestPreview) renderTestRequestPreview(req, r.requestPreview);
    const vision = imageDiagnosticText(r.imageDiagnostic);
    if (r.ok === false) {
      out.textContent = `${vision ? `${vision}\n\n` : ""}✗ ${r.error || "status " + r.status}\n${r.url || ""}\n${r.bodyPreview || ""}`;
      return;
    }
    if (req.stream) {
      out.textContent = `${vision ? `${vision}\n\n` : ""}✓ stream OK · status ${r.status} · ${r.ms} ms · ${r.streamChunks} chunks\n${r.url}\n\n${r.bodyPreview || ""}`;
    } else {
      const text = responseText(r.body) || "(no content)";
      out.textContent = `${vision ? `${vision}\n\n` : ""}✓ status ${r.status} · ${r.ms} ms\n${r.url}\n\n${text}\n\n--- raw ---\n${JSON.stringify(r.body || r.bodyPreview, null, 2).slice(0, 1600)}`;
    }
  } catch (err) {
    out.textContent = `❌ ${err.message}`;
  }
});

document.getElementById("btn-test-vision")?.addEventListener("click", async () => {
  document.getElementById("test-image").checked = true;
  document.getElementById("test-stream").checked = false;
  document.getElementById("test-prompt").value = "user: 请判断这张图片的主要颜色，只回答颜色。";
  document.getElementById("btn-test-run").click();
});

document.getElementById("btn-test-batch")?.addEventListener("click", async () => {
  const out = document.getElementById("test-output");
  const clientId = document.getElementById("test-agent")?.value || "generic-openai";
  const count = Math.min(Math.max(Number(document.getElementById("test-batch-count")?.value || 10), 1), 20);
  const models = modelsForClient(clientId).slice(0, count);
  if (!models.length) { toast("没有可测试模型"); return; }
  const lines = [`批量验证 ${clientId} · ${models.length} 个模型`];
  out.textContent = lines.join("\n");
  for (const model of models) {
    const req = { ...collectTestRequest(model.id), stream: false, includeImage: false };
    if (model === models[0]) renderTestRequestPreview(req);
    lines.push(`→ ${model.id}`);
    out.textContent = lines.join("\n");
    try {
      const r = await invoke("test:chat", req);
      lines.push(r.ok ? `  ✓ status ${r.status} · ${r.ms} ms` : `  ✗ ${r.error || "status " + r.status}`);
    } catch (err) {
      lines.push(`  ✗ ${err.message}`);
    }
    out.textContent = lines.join("\n");
  }
});

/* Init */
refreshAll();

/* ---- Model-level test ---- */
document.getElementById("btn-model-test")?.addEventListener("click", async () => {
  const out = document.getElementById("model-test-output");
  const draft = collectModelForm();
  if (!draft.id) { out.textContent = "请先填写模型 ID"; return; }
  if (!draft.providerId) { out.textContent = "请先选择供应商"; return; }
  if (!draft.upstreamModel) { out.textContent = "请先填写上游模型名"; return; }
  out.textContent = `正在测试 ${draft.id} → ${draft.upstreamModel}…`;
  try {
    const r = await invoke("test:model", {
      modelDraft: draft,
      messages: [{ role: "user", content: "Hi, respond in one sentence." }]
    });
    if (r.ok === false) {
      const details = r.body ? `\n\n${JSON.stringify(r.body, null, 2).slice(0, 1000)}` : "";
      out.textContent = `✗ ${r.error || "status " + r.status}${details}`;
    } else {
      const text = r.body?.choices?.[0]?.message?.content || "(no content)";
      out.textContent = `✓ status ${r.status}\n\n${text}`;
    }
  } catch (err) {
    out.textContent = `✗ ${err.message}`;
  }
});

document.getElementById("btn-model-probe")?.addEventListener("click", async () => {
  const out = document.getElementById("model-test-output");
  const draft = collectModelForm();
  if (!draft.id) { out.textContent = "请先填写模型 ID"; return; }
  if (!draft.providerId) { out.textContent = "请先选择供应商"; return; }
  if (!draft.upstreamModel) { out.textContent = "请先填写上游模型名"; return; }
  document.getElementById("btn-model-apply-capabilities").style.display = "none";
  out.textContent = `正在校准 ${draft.id}…`;
  try {
    const result = await invoke("capabilities:probe", { modelDraft: draft });
    state.lastCapabilitySuggestion = result.suggestion || null;
    out.textContent = formatCapabilityProbe(result);
    if (state.lastCapabilitySuggestion?.capabilities) {
      document.getElementById("btn-model-apply-capabilities").style.display = "";
    }
  } catch (err) {
    out.textContent = `能力校准失败：${err.message}`;
  }
});

document.getElementById("btn-model-apply-capabilities")?.addEventListener("click", () => {
  if (!state.lastCapabilitySuggestion?.capabilities) return;
  applyCapabilitySuggestionToForm(state.lastCapabilitySuggestion);
  toast("建议能力已应用到表单，保存后生效");
});

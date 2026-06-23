const { invoke, onLog } = window.lls;

const state = {
  config: null,
  status: { running: false },
  filter: { models: "" }
};

const toast = (msg) => {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2000);
};

const PROTOCOL_LABEL = {
  openai_chat: "openai_chat",
  openai_responses: "openai_responses",
  anthropic_messages: "anthropic_messages"
};

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function setActiveTab(tab) {
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${tab}`));
}

document.querySelectorAll(".nav a").forEach((a) => {
  a.addEventListener("click", () => setActiveTab(a.dataset.tab));
});

async function refreshAll() {
  const [config, status, configPath] = await Promise.all([
    invoke("config:read"),
    invoke("gateway:status"),
    invoke("config:file")
  ]);
  state.config = config;
  state.status = status;
  state.configPath = configPath;
  renderHeader();
  renderOverview();
  renderProviders();
  renderModels();
  renderClients();
  renderSettings();
  try { refreshTestModelOptions(); } catch {}
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
      <td><span class="chip">${escapeHtml(PROTOCOL_LABEL[p.apiFormat] || p.apiFormat)}</span></td>
      <td class="mono">${escapeHtml(p.baseUrl)}</td>
      <td>${p.apiKey ? '<span class="chip warn">inline · 仅本机</span>' : (p.apiKeyEnv ? `<span class="chip good">环境变量 · ${escapeHtml(p.apiKeyEnv)}</span>` : '<span class="chip warn">未配置</span>')}</td>
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
    const caps = Object.entries(m.capabilities || {}).filter(([_k, v]) => v).map(([k]) => `<span class="chip">${k}</span>`).join(" ");
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
  codex: { label: "Codex", file: "~/.codex/config.toml", entry: "/codex/v1", note: "写入后请在 Codex 中选择 switchyard provider；备份保存在 ~/.switchyard/backups/" },
  "claude-code": { label: "Claude Code", file: "~/.claude/settings.json", entry: "/claude-code", note: "写入 env.ANTHROPIC_BASE_URL；ANTHROPIC_AUTH_TOKEN 读取 ${SWITCHYARD_KEY}" },
  hermes: { label: "Hermes", file: "~/.hermes/config.json", entry: "/hermes/v1", note: "写入 baseUrl，apiKeyEnv = SWITCHYARD_KEY" }
};

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
    const actionsHtml = meta ? `
      <div style="display:flex; gap:6px; margin-top:8px;">
        <button class="btn" data-profile-preview="${escapeHtml(id)}">预览</button>
        <button class="btn primary" data-profile-apply="${escapeHtml(id)}">一键写入</button>
        <button class="btn" data-profile-restore="${escapeHtml(id)}">恢复备份</button>
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
        ${actionsHtml}
      </div>
    `;
    grid.appendChild(div);
  }
  grid.querySelectorAll("[data-profile-preview]").forEach((b) => b.addEventListener("click", () => profilePreview(b.dataset.profilePreview)));
  grid.querySelectorAll("[data-profile-apply]").forEach((b) => b.addEventListener("click", () => profileApply(b.dataset.profileApply)));
  grid.querySelectorAll("[data-profile-restore]").forEach((b) => b.addEventListener("click", () => profileRestore(b.dataset.profileRestore)));
}

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
    toast(`已写入 ${r.path}${r.backup ? "（已备份）" : ""}`);
  } catch (err) {
    toast(`写入失败：${err.message}`);
  }
}

async function profileRestore(clientId) {
  try {
    const r = await invoke("profile:restore", { clientId });
    if (r.ok) toast(`已恢复：${r.restoredFrom}`);
    else toast(`没有可用备份`);
  } catch (err) {
    toast(`恢复失败：${err.message}`);
  }
}

function renderSettings() {
  document.getElementById("settings-config-path").textContent = state.configPath || "-";
}

document.getElementById("models-search").addEventListener("input", (e) => {
  state.filter.models = e.target.value;
  renderModels();
});
/* ---- Provider Dialog ---- */
function openProviderDialog(editId) {
  const wrap = document.getElementById("provider-dialog-wrap");
  const title = document.getElementById("provider-dialog-title");
  const form = document.getElementById("provider-form");
  form.reset();
  const existing = editId ? state.config.providers.find((p) => p.id === editId) : null;
  title.textContent = existing ? `编辑供应商 · ${existing.id}` : "新增供应商";
  if (existing) {
    form.querySelector('[name="id"]').value = existing.id;
    form.querySelector('[name="id"]').readOnly = true;
    form.querySelector('[name="name"]').value = existing.name || "";
    form.querySelector('[name="apiFormat"]').value = existing.apiFormat;
    form.querySelector('[name="baseUrl"]').value = existing.baseUrl;
    form.querySelector('[name="apiKeyEnv"]').value = existing.apiKeyEnv || "";
    form.querySelector('[name="apiKey"]').value = "";
  } else {
    form.querySelector('[name="id"]').readOnly = false;
  }
  wrap.classList.add("open");
  form._editId = editId || null;
}
document.getElementById("btn-provider-add").addEventListener("click", () => openProviderDialog(null));
document.getElementById("provider-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const data = Object.fromEntries(fd.entries());
  const editId = form._editId;
  let providers = [...state.config.providers];
  if (editId) {
    providers = providers.map((p) => p.id === editId ? { ...data, id: data.id, capabilities: {} } : p);
  } else {
    providers.push({ ...data, id: data.id, capabilities: {} });
  }
  const next = { ...state.config, providers };
  await invoke("config:save", next);
  await refreshAll().then(() => checkFirstLaunch());
  toast(editId ? "供应商已更新" : "供应商已新增");
  form.closest(".dialog-overlay").classList.remove("open");
});
document.getElementById("provider-dialog-wrap").querySelector("[data-close]").addEventListener("click", () => {
  document.getElementById("provider-dialog-wrap").classList.remove("open");
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
  const existing = editId ? state.config.models.find((m) => m.id === editId) : null;
  title.textContent = existing ? `编辑模型 · ${existing.id}` : "新增模型";
  if (existing) {
    form.querySelector('[name="id"]').value = existing.id;
    form.querySelector('[name="providerId"]').value = existing.providerId;
    form.querySelector('[name="upstreamModel"]').value = existing.upstreamModel;
    form.querySelector('[name="displayName"]').value = existing.displayName || "";
    form.querySelector('[name="aliases"]').value = (existing.aliases || []).join(", ");
    if (existing.capabilities) {
      form.querySelector('[name="cap-text"]').checked = !!existing.capabilities.text;
      form.querySelector('[name="cap-tools"]').checked = !!existing.capabilities.tools;
      form.querySelector('[name="cap-reasoning"]').checked = !!existing.capabilities.reasoning;
      form.querySelector('[name="cap-images"]').checked = !!existing.capabilities.images;
    }
  }
  wrap.classList.add("open");
  form._editId = editId || null;
}
document.getElementById("btn-model-add").addEventListener("click", () => openModelDialog(null));
document.getElementById("model-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const raw = Object.fromEntries(fd.entries());
  const data = {
    id: raw.id,
    providerId: raw.providerId,
    upstreamModel: raw.upstreamModel,
    displayName: raw.displayName || undefined,
    aliases: raw.aliases ? raw.aliases.split(",").map((s) => s.trim()).filter(Boolean) : [],
    capabilities: { text: raw["cap-text"] === "on", tools: raw["cap-tools"] === "on", reasoning: raw["cap-reasoning"] === "on", images: raw["cap-images"] === "on" }
  };
  const editId = form._editId;
  let models = [...state.config.models];
  if (editId) {
    models = models.map((m) => m.id === editId ? data : m);
  } else {
    models.push(data);
  }
  const next = { ...state.config, models };
  await invoke("config:save", next);
  await refreshAll();
  toast(editId ? "模型已更新" : "模型已新增");
  form.closest(".dialog-overlay").classList.remove("open");
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
      lines.push(`${p.id}: ${p.apiFormat} ${p.baseUrl} key=${p.keySource} ${p.keyOk ? "✓" : "✗"}`);
    }
    out.textContent = lines.join("\n");
  } catch (err) {
    out.textContent = "自检失败: " + err.message;
  }
});
/* ---- Import ---- */
let importResult = null;
document.querySelectorAll("#btn-import, #btn-provider-import").forEach((btn) => {
  btn.addEventListener("click", async () => {
    importResult = null;
    try {
      const result = await invoke("import:ccswitch");
      importResult = result;
    } catch (err) {
      toast(`导入失败: ${err.message}`);
      return;
    }
    const preview = document.getElementById("import-preview");
    const lines = [
      `从 cc-switch 读取：${importResult.importMeta.dedupedFromAppTypes.length} 个实体`,
      `→ ${importResult.config.providers.length} 个 Provider`,
      `→ ${importResult.config.models.length} 个 Model`,
      `跳过：${importResult.importMeta.skipped}`,
      "",
      ...importResult.importMeta.dedupedFromAppTypes.map((e) => `  ${e.slug} (${e.appTypes.join(", ")})`),
      "",
      "所有 API Key 已映射为环境变量名，未写入任何密钥。"
    ];
    preview.textContent = lines.join("\n");
    document.getElementById("import-dialog-wrap").classList.add("open");
  });
});
document.getElementById("btn-import-apply").addEventListener("click", async () => {
  if (!importResult) return;
  const existing = state.config;
  const existingIds = new Set(existing.providers.map((p) => p.id));
  const existingModelIds = new Set(existing.models.map((m) => m.id));
  const newProviders = importResult.config.providers.filter((p) => !existingIds.has(p.id));
  const newModels = importResult.config.models.filter((m) => !existingModelIds.has(m.id));
  const next = {
    ...existing,
    providers: [...existing.providers, ...newProviders],
    models: [...existing.models, ...newModels]
  };
  await invoke("config:save", next);
  await refreshAll();
  toast(`已合并导入：+${newProviders.length} Provider / +${newModels.length} Model`);
  document.getElementById("import-dialog-wrap").classList.remove("open");
});
document.getElementById("import-dialog-wrap").querySelector("[data-close]").addEventListener("click", () => {
  document.getElementById("import-dialog-wrap").classList.remove("open");
});

/* ---- Logs ---- */
document.getElementById("btn-logs-clear").addEventListener("click", () => {
  document.getElementById("logs-output").textContent = "";
});
document.getElementById("btn-logs-open").addEventListener("click", async () => {
  await invoke("logs:open-folder");
});
document.getElementById("btn-open-logs").addEventListener("click", async () => {
  await invoke("logs:open-folder");
});

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
const logOutput = document.getElementById("logs-output");
onLog((entry) => {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
  const line = `${entry.ts ? entry.ts.slice(11, 19) : ""} ${(entry.level || "info").padEnd(6)} ${entry.msg || ""} ${entry.model ? "model=" + entry.model : ""} ${entry.clientId ? "client=" + entry.clientId : ""}`;
  logOutput.textContent += line + "\n";
  logOutput.scrollTop = logOutput.scrollHeight;
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
    const preview = document.getElementById("import-preview");
    preview.textContent = [
      "首次启动检测到 cc-switch 配置。导入后即可使用：",
      "",
      ...result.importMeta.dedupedFromAppTypes.map((e) => `  ${e.slug}`),
      "",
      "所有 API Key 已映射为环境变量名，不含任何密钥。",
      "点击「合并到配置」→ 然后在终端设置上述环境变量即可开始使用。"
    ].join("\n");
    document.getElementById("import-dialog-wrap").classList.add("open");
  } catch {}
}

// Also add a "首次设置" button in settings/overview for manual trigger
// The existing btn-import already handles cc-switch for non-first-launch


function refreshTestModelOptions() {
  const sel = document.getElementById("test-model");
  if (!sel || !state.config) return;
  const current = sel.value;
  sel.innerHTML = state.config.models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join("");
  if (current && state.config.models.some((m) => m.id === current)) sel.value = current;
}
document.getElementById("btn-test-run")?.addEventListener("click", async () => {
  const out = document.getElementById("test-output");
  const sel = document.getElementById("test-model");
  const prompt = document.getElementById("test-prompt").value || "你好";
  const stream = document.getElementById("test-stream").checked;
  if (!sel.value) { toast("请选择模型"); return; }
  out.textContent = `→ ${sel.value} stream=${stream}\n请求中…`;
  try {
    const r = await invoke("test:chat", {
      model: sel.value,
      messages: [{ role: "user", content: prompt }],
      stream
    });
    if (r.ok === false) { out.textContent = `❌ ${r.error || r.status}`; return; }
    if (stream) {
      out.textContent = `✓ stream OK (status ${r.status}, ${r.streamChunks} chunks)`;
    } else {
      const text = r.body?.choices?.[0]?.message?.content || "(no content)";
      out.textContent = `✓ status ${r.status}\n\n${text}\n\n--- raw ---\n${JSON.stringify(r.body, null, 2).slice(0, 1200)}`;
    }
  } catch (err) {
    out.textContent = `❌ ${err.message}`;
  }
});

/* Init */
refreshAll();

// Electron main process for Switchyard.
import { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import AdmZip from "adm-zip";
import { readConfig, saveValidated, configFile, readRaw } from "./config-store.mjs";
import { startGateway, stopGateway, restartGateway, reloadConfig, statusFromServer } from "./gateway-host.mjs";
import { appendLog, snapshotLogs, subscribeLogs, logFilePath, readLogTail } from "./logs.mjs";
import { listRequestLogs, usageByModel, usageByAgentModel, usageDaily } from "./request-log-store.mjs";
import { createProviderHealthMonitor } from "./provider-health.mjs";
import { buildTestRequest, TEST_IMAGE_DATA_URL, TEST_IMAGE_LABEL } from "./test-console.mjs";
import {
  buildCompatibilityProfile,
  buildReplayDraft,
  classifyGatewayError,
  doctorClientConfigs,
  suggestCapabilitiesFromProbeResults
} from "./diagnostics.mjs";
import { buildIssueBundleReport, issueBundleFileStem, saveIssueBundleFiles } from "./issue-bundle.mjs";
import {
  deleteKeychainSecret,
  describeKeychainSecret,
  hasKeychainSecret,
  keychainAccountForProvider,
  setKeychainSecret
} from "./keychain-store.mjs";
import {
  listAgentSessions,
  readAgentSession,
  listAgentSkills,
  readAgentSkill,
  saveAgentSkill,
  setAgentSkillDisabled,
  resolveAgentResource,
  linkAgentSkill,
  archiveAgentSession,
  installAgentSkillFromDirectory,
  listAgentCoreFiles,
  readAgentCoreFile,
  saveAgentCoreFile
} from "./agent-resources.mjs";
import { listAgentPlugins, addPluginSource, removePluginSource } from "./agent-plugins.mjs";
import { importProviders } from "../../../packages/core/src/importers/ccswitch.mjs";
import { listProviderPresets, providerPresetFor, presetModelHints } from "../../../packages/core/src/provider-presets.mjs";
import {
  applyProfile, restoreProfile, restoreProfileBackup,
  profileTargets, listBackups,
  previewCodexProfile, previewClaudeCodeProfile, previewHermesProfile,
  syncClientModelArtifacts,
  CODEX_ACCESS_MODES
} from "../../../packages/core/src/profile-writer.mjs";
import { unifyCodexHistory } from "../../../packages/core/src/history-unify.mjs";
import {
  CODEX_OAUTH_CLIENT_VERSION,
  providerAuthHeaders,
  providerReady,
  proxyDispatcher,
  readCodexOAuthAuth,
  isCodexOAuthProvider
} from "../../../packages/core/src/upstream/clients.mjs";
import { dispatchChat } from "../../../packages/core/src/upstream/dispatch.mjs";
import { listModelsForClient } from "../../../packages/core/src/config.mjs";
import { resolveRoute } from "../../../packages/core/src/router.mjs";
import {
  activePatchDescriptors,
  listCompatPacks,
  registerBuiltinPatches
} from "../../../packages/core/src/compat/index.mjs";
import {
  recommendCompatRules,
  registryRecommendationsForConfig
} from "../../../packages/core/src/compat/registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let providerHealthMonitor = null;
let codexArtifactTimer = null;
// 托盘常驻 + 关窗保活：mainWindow 保留主窗口引用，tray 为系统托盘，
// isQuitting 标记是否真正退出（区分“点叉隐藏”与“菜单/托盘退出”）。
let mainWindow = null;
let tray = null;
let isQuitting = false;
registerBuiltinPatches();

function modelsForProfile(cfg, models) {
  const providerNames = new Map((cfg.providers || []).map((provider) => [provider.id, provider.name || provider.id]));
  return (models || []).map((model) => ({
    ...model,
    providerName: providerNames.get(model.providerId) || model.providerId
  }));
}

function clientDefaultModel(cfg, clientId, visibleModels = []) {
  const matches = (value) => value && visibleModels.some((model) => model.id === value || model.upstreamModel === value || (model.aliases || []).includes(value));
  const clientValue = cfg.clients?.[clientId]?.defaultModel;
  if (matches(clientValue)) return clientValue;
  if (clientId === "codex") {
    if (matches(cfg.defaultModel)) return cfg.defaultModel;
    return visibleModels?.[0]?.id || "";
  }
  return "";
}

function codexProfileMode(mode) {
  return mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT
    ? CODEX_ACCESS_MODES.OFFICIAL_DIRECT
    : CODEX_ACCESS_MODES.SWITCHYARD_PROXY;
}

const COMPAT_DIRECTIONS = ["outbound", "inbound", "stream"];

function activeCompatRulesByDirection(provider, model) {
  const out = {};
  for (const direction of COMPAT_DIRECTIONS) {
    out[direction] = activePatchDescriptors({ provider, model, direction });
  }
  return out;
}

function flattenCompatRules(rulesByDirection) {
  return COMPAT_DIRECTIONS.flatMap((direction) => rulesByDirection?.[direction] || []);
}

function activeCompatSnapshot(cfg) {
  const providersById = new Map((cfg.providers || []).map((provider) => [provider.id, provider]));
  const providers = {};
  const models = {};
  for (const provider of cfg.providers || []) {
    providers[provider.id] = activeCompatRulesByDirection(provider, null);
  }
  for (const model of cfg.models || []) {
    const provider = providersById.get(model.providerId);
    models[model.id] = activeCompatRulesByDirection(provider, model);
  }
  return { providers, models };
}

function syncCodexArtifacts(reason = "manual") {
  try {
    const cfg = readConfig();
    const codexModels = listModelsForClient(cfg, "codex");
    const claudeCodeModels = listModelsForClient(cfg, "claude-code");
    const result = syncClientModelArtifacts({
      host: cfg.host,
      port: cfg.port,
      codexDefaultModel: clientDefaultModel(cfg, "codex", codexModels),
      codexModels: modelsForProfile(cfg, codexModels),
      claudeCodeModels: modelsForProfile(cfg, claudeCodeModels)
    });
    const codexChanged = result.codex?.ok && (result.codex.catalogChanged || result.codex.cacheChanged);
    const claudeChanged = result.claudeCode?.ok && result.claudeCode.cacheChanged;
    if (codexChanged || claudeChanged) {
      appendLog({
        level: "info",
        msg: "client model artifacts synced",
        reason,
        codexModelCount: result.codex?.modelCount || 0,
        claudeCodeModelCount: result.claudeCode?.modelCount || 0,
        codexCacheChanged: Boolean(result.codex?.cacheChanged),
        codexCatalogChanged: Boolean(result.codex?.catalogChanged),
        claudeCodeCacheChanged: Boolean(result.claudeCode?.cacheChanged)
      });
    }
    return result;
  } catch (err) {
    appendLog({ level: "warn", msg: "codex model artifact sync failed", reason, error: err?.message || String(err) });
    return { ok: false, error: err?.message || String(err) };
  }
}

function startCodexArtifactMonitor() {
  if (codexArtifactTimer) clearInterval(codexArtifactTimer);
  codexArtifactTimer = setInterval(() => {
    syncCodexArtifacts("timer");
  }, 30 * 1000);
  codexArtifactTimer.unref?.();
}

function stopCodexArtifactMonitor() {
  if (!codexArtifactTimer) return;
  clearInterval(codexArtifactTimer);
  codexArtifactTimer = null;
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 960, minHeight: 600,
    title: "Switchyard",
    icon: path.resolve(__dirname, "..", "assets", "icon.png"),
    webPreferences: {
      preload: path.resolve(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.loadFile(path.resolve(__dirname, "..", "renderer", "index.html"));
  win.webContents.on("console-message", (_e, level, message) => {
    appendLog({ level: level === 0 ? "info" : "warn", msg: `renderer: ${message}` });
  });
  // 点窗口关闭按钮（叉）时，不退出应用，只隐藏窗口，网关继续后台运行。
  // 只有走托盘菜单 / 应用菜单的"退出"（isQuitting=true）才真正退出。
  // macOS 保留 Dock 图标，方便用户点击恢复窗口。
  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
  mainWindow = win;
  return win;
}

// 显示主窗口（从托盘恢复 / macOS 点 Dock 时调用）。
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
  }
  if (process.platform === "darwin") app.dock?.show();
  mainWindow.show();
  mainWindow.focus();
}

// 创建系统托盘图标与右键菜单（显示窗口 / 退出）。
function createTray() {
  if (tray) return tray;
  const trayIconPath = path.resolve(__dirname, "..", "assets", "tray.png");
  let image = nativeImage.createFromPath(trayIconPath);
  // macOS 菜单栏按 22px 高度显示，避免大图变形。
  if (process.platform === "darwin" && !image.isEmpty()) {
    image = image.resize({ width: 18, height: 18 });
  }
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("Switchyard");
  const menu = Menu.buildFromTemplate([
    { label: "显示窗口", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "退出 Switchyard",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  // 单击托盘图标（Windows/Linux 习惯）唤出窗口；macOS 用右键菜单。
  tray.on("click", () => showMainWindow());
  return tray;
}

ipcMain.handle("config:read", () => readConfig());
ipcMain.handle("config:save", (_e, payload) => {
  const r = saveValidated(payload);
  try { reloadConfig(); } catch {}
  syncCodexArtifacts("config-save");
  return r;
});
ipcMain.handle("config:file", () => configFile());
ipcMain.handle("config:raw", () => readRaw());
ipcMain.handle("gateway:status", () => statusFromServer());
ipcMain.handle("gateway:start", async () => {
  const result = await startGateway();
  syncCodexArtifacts("gateway-start");
  startCodexArtifactMonitor();
  return result;
});
ipcMain.handle("gateway:stop", () => stopGateway());
ipcMain.handle("gateway:restart", async () => {
  const result = await restartGateway();
  syncCodexArtifacts("gateway-restart");
  startCodexArtifactMonitor();
  return result;
});
ipcMain.handle("gateway:reload", () => {
  const result = reloadConfig();
  syncCodexArtifacts("gateway-reload");
  return result;
});
ipcMain.handle("logs:snapshot", () => snapshotLogs());
ipcMain.handle("logs:tail", (_e, options = {}) => readLogTail(options));
ipcMain.handle("request-logs:list", (_e, filters = {}) => listRequestLogs(filters));
ipcMain.handle("usage:by-model", (_e, filters = {}) => usageByModel(filters));
ipcMain.handle("usage:by-agent-model", (_e, filters = {}) => usageByAgentModel(filters));
ipcMain.handle("usage:daily", (_e, filters = {}) => usageDaily(filters));
ipcMain.handle("keychain:status", (_e, payload = {}) => {
  const account = keychainAccountForProvider(payload.provider || payload.account || payload);
  return { ok: true, account, label: describeKeychainSecret(account), exists: hasKeychainSecret(account) };
});
ipcMain.handle("keychain:set", (_e, payload = {}) => {
  const account = keychainAccountForProvider(payload.provider || payload.account || payload);
  if (!account) throw new Error("缺少 Keychain account");
  const result = setKeychainSecret(account, payload.secret || payload.apiKey || "");
  appendLog({ level: "info", msg: "provider key saved to keychain", account });
  return { ...result, label: describeKeychainSecret(account) };
});
ipcMain.handle("keychain:delete", (_e, payload = {}) => {
  const account = keychainAccountForProvider(payload.provider || payload.account || payload);
  const result = deleteKeychainSecret(account);
  appendLog({ level: "info", msg: "provider key removed from keychain", account });
  return { ...result, label: describeKeychainSecret(account) };
});
ipcMain.handle("logs:open-folder", async () => {
  const dir = path.dirname(logFilePath());
  await shell.openPath(dir);
  return dir;
});
ipcMain.handle("logs:open-file", async () => {
  const file = logFilePath();
  await shell.openPath(file);
  return file;
});
ipcMain.handle("agent:sessions:list", (_e, filters = {}) => listAgentSessions(filters));
ipcMain.handle("agent:sessions:read", (_e, { id }) => readAgentSession(id));
ipcMain.handle("agent:sessions:delete", async (_e, { id }) => {
  const resource = resolveAgentResource(id, "session");
  if (resource.source === "hermes-state-db") {
    const result = archiveAgentSession(id);
    appendLog({ level: "info", msg: "hermes session archived", sessionId: resource.sessionId });
    return result;
  }
  await shell.trashItem(resource.target);
  appendLog({ level: "info", msg: `session moved to trash: ${resource.agent.id}`, path: resource.target });
  return { ok: true, path: resource.target };
});
ipcMain.handle("agent:skills:list", (_e, filters = {}) => listAgentSkills(filters));
ipcMain.handle("agent:skills:read", (_e, { id }) => readAgentSkill(id));
ipcMain.handle("agent:skills:save", (_e, { id, text }) => saveAgentSkill(id, text));
ipcMain.handle("agent:skills:disable", (_e, { id, disabled }) => setAgentSkillDisabled(id, Boolean(disabled)));
ipcMain.handle("agent:skills:link", (_e, { id, targetAgentId, skillName }) => linkAgentSkill(id, { targetAgentId, skillName }));
ipcMain.handle("agent:skills:delete", async (_e, { id }) => {
  const resource = resolveAgentResource(id, "skill");
  await shell.trashItem(resource.target);
  appendLog({ level: "info", msg: `skill moved to trash: ${resource.agent.id}`, path: resource.target });
  return { ok: true, path: resource.target };
});
ipcMain.handle("agent:core-files:list", (_e, filters = {}) => listAgentCoreFiles(filters));
ipcMain.handle("agent:core-files:read", (_e, { id }) => readAgentCoreFile(id));
ipcMain.handle("agent:core-files:save", (_e, { id, text }) => saveAgentCoreFile(id, text));
ipcMain.handle("agent:plugins:list", (_e, filters = {}) => listAgentPlugins(filters));
ipcMain.handle("agent:plugins:add-source", (_e, payload = {}) => addPluginSource(payload));
ipcMain.handle("agent:plugins:remove-source", (_e, payload = {}) => removePluginSource(payload));
ipcMain.handle("skillhub:search", (_e, { keyword = "", limit = 20 } = {}) => searchSkillHub({ keyword, limit }));
ipcMain.handle("skillhub:open", async (_e, { slug, kind = "detail" } = {}) => {
  if (!slug) throw new Error("缺少 Skill slug");
  const url = kind === "download"
    ? `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(slug)}`
    : `https://skillhub.cn/skills/${encodeURIComponent(slug)}`;
  await shell.openExternal(url);
  return { ok: true, url };
});
ipcMain.handle("skillhub:download", async (_e, { slug, version = "" } = {}) => {
  if (!slug) throw new Error("缺少 Skill slug");
  const { buffer, url } = await downloadSkillHubZip(slug);
  const defaultPath = path.join(app.getPath("downloads"), `${safeFilePart(slug)}${version ? `-${safeFilePart(version)}` : ""}.zip`);
  const selected = await dialog.showSaveDialog({
    title: "保存 SkillHub 下载包",
    defaultPath,
    filters: [{ name: "Zip Archive", extensions: ["zip"] }]
  });
  if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(selected.filePath, buffer);
  shell.showItemInFolder(selected.filePath);
  return { ok: true, path: selected.filePath, url };
});
ipcMain.handle("skillhub:install", async (_e, { slug, targetAgentId, skillName, overwrite = false } = {}) => {
  if (!slug) throw new Error("缺少 Skill slug");
  const { buffer, url } = await downloadSkillHubZip(slug);
  const extracted = extractSkillHubZip(buffer, slug);
  try {
    const result = installAgentSkillFromDirectory(extracted.skillDir, {
      targetAgentId,
      skillName: skillName || slug,
      overwrite
    });
    return { ...result, url };
  } finally {
    fs.rmSync(extracted.root, { recursive: true, force: true });
  }
});
ipcMain.handle("dialog:info", async (_e, { title, message }) => {
  await dialog.showMessageBox({ type: "info", title: title || "Info", message: message || "" });
});
ipcMain.handle("import:ccswitch", () => {
  const result = importProviders();
  if (!result.ok) throw new Error(result.error || "import failed");
  return result;
});
ipcMain.handle("provider:presets", () => listProviderPresets());
ipcMain.handle("provider:test", async (_e, provider) => testProviderConnectivity(provider));
ipcMain.handle("provider-health:list", () => getProviderHealthMonitor().snapshot());
ipcMain.handle("provider-health:refresh", async (_e, payload = {}) => {
  const rows = await getProviderHealthMonitor().refresh(payload.providerId || "");
  return { ok: true, rows, snapshot: getProviderHealthMonitor().snapshot() };
});
ipcMain.handle("compat:packs", () => listCompatPacks());
ipcMain.handle("compat:active", () => activeCompatSnapshot(readConfig()));
ipcMain.handle("compat:registry:snapshot", () => registryRecommendationsForConfig(readConfig()));
ipcMain.handle("compat:registry:recommend", (_e, payload = {}) => recommendCompatRules(payload));
ipcMain.handle("provider:discover-models", async (_e, provider) => {
  const probe = { ...provider };
  const baseUrl = String(probe.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("缺少 Base URL");
  const preset = providerPresetFor(probe);
  const hints = presetModelHints(preset);
  const presetModels = Array.from(hints.values()).map((model) => normalizeHintModel(model));
  if (isCodexOAuthProvider(probe)) {
    const auth = readCodexOAuthAuth({ provider: probe });
    if (!auth.ok) return { ok: false, error: `未找到可用 Codex OAuth：${auth.reason}` };
    const url = `${baseUrl}/models?client_version=${encodeURIComponent(CODEX_OAUTH_CLIENT_VERSION)}`;
    try {
      const { resp, text } = await fetchTextOnce(url, { method: "GET", headers: buildProviderHeaders(probe) }, probe);
      if (resp.ok) {
        const models = normalizeDiscoveredModels(JSON.parse(text), hints);
        if (models.length) return { ok: true, url, models };
      }
      if (presetModels.length) return { ok: true, url: "preset:fallback", models: presetModels, warning: `${url} -> ${resp.status}: ${text.slice(0, 200)}` };
      return { ok: false, error: `${url} -> ${resp.status}: ${text.slice(0, 400)}` };
    } catch (err) {
      if (presetModels.length) return { ok: true, url: "preset:fallback", models: presetModels, warning: `${url} -> ${errorSummary(err)}` };
      return { ok: false, error: `${url} -> ${errorSummary(err)}` };
    }
  }
  const headers = buildProviderHeaders(probe);
  const tryUrls = apiFormatModelUrls(baseUrl, probe.apiFormat);
  const errors = [];
  for (const url of tryUrls) {
    try {
      const resp = await fetch(url, providerFetchInit(probe, { method: "GET", headers }));
      const text = await resp.text();
      if (!resp.ok) {
        errors.push(`${url} -> ${resp.status}`);
        continue;
      }
      const parsed = JSON.parse(text);
      const models = normalizeDiscoveredModels(parsed, hints);
      if (models.length) return { ok: true, url, models };
      errors.push(`${url} -> empty`);
    } catch (err) {
      errors.push(`${url} -> ${err?.message || String(err)}`);
    }
  }
  if (presetModels.length) return { ok: true, url: "preset:fallback", models: presetModels, warning: errors.join(" | ") };
  return { ok: false, error: errors.join(" | ") || "未发现模型" };
});

ipcMain.handle("gateway:doctor", () => {
  const cfg = readConfig();
  const status = statusFromServer();
  const providers = cfg.providers.map((p) => {
    let keySource = "未配置";
    let keyOk = false;
    if (isCodexOAuthProvider(p)) {
      const auth = readCodexOAuthAuth({ provider: p });
      keySource = "codex oauth";
      keyOk = auth.ok;
    } else if (p.authMode === "none") {
      keySource = "无需认证";
      keyOk = true;
    } else if (p.authMode === "keychain" || p.keychainAccount) {
      const account = keychainAccountForProvider(p);
      keySource = describeKeychainSecret(account);
      keyOk = hasKeychainSecret(account);
    } else if (p.apiKey) { keySource = "inline"; keyOk = true; }
    else if (p.apiKeyEnv) {
      keySource = `env:${p.apiKeyEnv}`;
      keyOk = Boolean(process.env[p.apiKeyEnv]);
    } else { keyOk = true; }
    return { id: p.id, apiFormat: p.apiFormat, baseUrl: p.baseUrl, keySource, keyOk };
  });
  return {
    running: status.running === true,
    host: status.host || null,
    port: status.port || null,
    providers,
    modelCount: cfg.models.length,
    providerCount: cfg.providers.length
  };
});
ipcMain.handle("client-config:doctor", () => {
  const status = statusFromServer();
  const cfg = readConfig();
  return doctorClientConfigs({
    host: status.host || cfg.host || "127.0.0.1",
    port: status.port || cfg.port || 17888
  });
});
ipcMain.handle("diagnostics:run", async () => {
  const cfg = readConfig();
  const status = statusFromServer();
  const healthSnapshot = getProviderHealthMonitor().snapshot();
  const providers = cfg.providers.map((provider) => ({
    ...providerDiagnostic(provider),
    health: healthSnapshot[provider.id] || null
  }));
  const providerIds = new Set(cfg.providers.map((provider) => provider.id));
  const clients = doctorClientConfigs({
    host: status.host || cfg.host || "127.0.0.1",
    port: status.port || cfg.port || 17888
  });
  const models = cfg.models.map((model) => ({
    id: model.id,
    providerId: model.providerId,
    upstreamModel: model.upstreamModel,
    enabled: model.enabled !== false,
    providerOk: providerIds.has(model.providerId),
    capabilities: model.capabilities || {},
    visibleIn: Object.keys(cfg.clients || {}).filter((clientId) => listModelsForClient(cfg, clientId).some((item) => item.id === model.id))
  }));
  const recentErrors = listRequestLogs({ limit: 30 })
    .filter((row) => Number(row.status || 0) >= 400 || row.error)
    .slice(0, 10)
    .map((row) => ({
      id: row.id,
      ts: row.ts,
      modelId: row.model_id,
      providerId: row.provider_id,
      status: row.status,
      error: row.error || row.response_preview || "",
      requestSummary: row.request_summary || "",
      responseSummary: row.response_summary || "",
      classification: classifyGatewayError(row.error || row.response_summary || row.response_preview || "")
    }));
  return {
    gateway: {
      running: status.running === true,
      host: status.host || cfg.host,
      port: status.port || cfg.port
    },
    providers,
    models,
    clients,
    recentErrors
  };
});

ipcMain.handle("profile:apply", async (_e, { clientId, mode } = {}) => {
  const status = statusFromServer();
  const profileMode = clientId === "codex" ? codexProfileMode(mode) : undefined;
  if (!status.running && profileMode !== CODEX_ACCESS_MODES.OFFICIAL_DIRECT) throw new Error("Gateway not running");
  const cfg = readConfig();
  const visibleModels = listModelsForClient(cfg, clientId);
  const opts = {
    host: status.running ? status.host : cfg.host,
    port: status.running ? status.port : cfg.port,
    mode: profileMode,
    defaultModel: clientDefaultModel(cfg, clientId, visibleModels),
    models: ["codex", "claude-code"].includes(clientId) ? modelsForProfile(cfg, visibleModels) : visibleModels,
    modelMapping: clientId === "claude-code" ? cfg.clients?.["claude-code"]?.modelMapping : undefined
  };
  const result = applyProfile(clientId, opts);
  if (clientId === "codex" && profileMode !== CODEX_ACCESS_MODES.OFFICIAL_DIRECT) syncCodexArtifacts("profile-apply");
  appendLog({
    level: "info",
    msg: `profile applied: ${clientId}`,
    mode: profileMode || null,
    path: result.path,
    backup: result.backup || null,
    visibleModels: visibleModels.length,
    defaultModel: opts.defaultModel || null,
    catalogPath: result.catalogPath || null,
    cachePath: result.cachePath || null,
    ccSwitchCatalogPath: result.ccSwitchCatalogPath || null,
    ccSwitchProfilePath: result.ccSwitchProfilePath || null
  });
  return result;
});
ipcMain.handle("codex-history:unify", (_e, { dryRun, targetProvider } = {}) => {
  const result = unifyCodexHistory({ dryRun: dryRun === true, targetProvider });
  appendLog({
    level: result.ok ? "info" : "warn",
    msg: dryRun ? "codex history unify preview" : "codex history unified",
    ...result
  });
  return result;
});
ipcMain.handle("profile:restore", (_e, { clientId, backupName } = {}) => {
  const result = backupName ? restoreProfileBackup(clientId, backupName) : restoreProfile(clientId);
  appendLog({ level: "info", msg: `profile restored: ${clientId}`, ...result });
  return result;
});
ipcMain.handle("profile:status", (_e, { clientId }) => {
  const targets = profileTargets();
  const file = targets[clientId];
  if (!file) throw new Error(`Unknown client: ${clientId}`);
  const exists = fs.existsSync(file);
  let current = null;
  if (exists) { try { current = fs.readFileSync(file, "utf8"); } catch {} }
  const backups = listBackups(file).map((entry) => ({
    name: entry.name,
    full: entry.full,
    mtimeMs: entry.mtimeMs || 0,
    size: entry.size || 0
  }));
  return { exists, current: current ? current.slice(0, 600) : null, backups: backups.length, backupItems: backups };
});
ipcMain.handle("profile:preview", (_e, { clientId, mode } = {}) => {
  const status = statusFromServer();
  const cfg = readConfig();
  const visibleModels = listModelsForClient(cfg, clientId);
  const opts = {
    host: status.running ? status.host : "127.0.0.1",
    port: status.running ? status.port : 17888,
    mode: clientId === "codex" ? codexProfileMode(mode) : undefined,
    defaultModel: clientDefaultModel(cfg, clientId, visibleModels),
    models: ["codex", "claude-code"].includes(clientId) ? modelsForProfile(cfg, visibleModels) : visibleModels,
    modelMapping: clientId === "claude-code" ? cfg.clients?.["claude-code"]?.modelMapping : undefined
  };
  if (clientId === "codex") return { text: previewCodexProfile(opts), path: profileTargets().codex };
  if (clientId === "claude-code") return { text: previewClaudeCodeProfile(opts), path: profileTargets()["claude-code"] };
  if (clientId === "hermes") return { text: previewHermesProfile(opts), path: profileTargets().hermes };
  throw new Error(`Unknown client: ${clientId}`);
});
ipcMain.handle("test:chat", async (_e, { model, messages, stream, clientId = "generic-openai", protocol = "openai_chat", includeImage = false, temperature, maxTokens }) => {
  const status = statusFromServer();
  if (!status.running) throw new Error("Gateway not running");
  const cfg = readConfig();
  const imageDiagnostic = buildImageDiagnostic(cfg, { model, clientId, includeImage: !!includeImage });
  const built = buildTestRequest({
    base: `http://${status.host}:${status.port}`,
    clientId,
    protocol,
    model,
    messages,
    stream: !!stream,
    includeImage: !!includeImage,
    temperature,
    maxTokens
  });
  const requestPreview = safeRequestPreview(built);
  const started = Date.now();
  try {
    const resp = await fetch(built.url, {
      method: "POST",
      headers: built.headers,
      body: JSON.stringify(built.body)
    });
    if (built.body.stream) {
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, url: built.url, requestPreview, ms: Date.now() - started, imageDiagnostic: mergeVisionDiagnostic(imageDiagnostic, resp), streamChunks: text.split("\n").filter((l) => l.startsWith("data: ")).length, bodyPreview: text.slice(0, 1600) };
    }
    const text = await resp.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, url: built.url, requestPreview, ms: Date.now() - started, imageDiagnostic: mergeVisionDiagnostic(imageDiagnostic, resp), body, bodyPreview: text.slice(0, 2000) };
  } catch (err) {
    return { ok: false, url: built.url, requestPreview, ms: Date.now() - started, imageDiagnostic, error: errorSummary(err) };
  }
});
ipcMain.handle("test:model", async (_e, { modelDraft, messages }) => {
  const cfg = readConfig();
  const draft = {
    id: String(modelDraft?.id || "").trim(),
    providerId: String(modelDraft?.providerId || "").trim(),
    upstreamModel: String(modelDraft?.upstreamModel || "").trim(),
    proxyUrl: String(modelDraft?.proxyUrl || "").trim(),
    maxOutputTokens: Number(modelDraft?.maxOutputTokens || 0),
    compatPacks: Array.isArray(modelDraft?.compatPacks) ? modelDraft.compatPacks : []
  };
  if (!draft.id) return { ok: false, error: "缺少模型 ID" };
  if (!draft.providerId) return { ok: false, error: "缺少供应商" };
  const provider = cfg.providers.find((p) => p.id === draft.providerId);
  if (!provider) return { ok: false, error: `未找到供应商：${draft.providerId}` };
  const upstreamModel = draft.upstreamModel || draft.id;
  try {
    const result = await dispatchChat(provider, upstreamModel, {
      model: draft.id,
      _modelId: draft.id,
      messages: Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: "Hi, respond in one sentence." }],
      max_tokens: Math.min(Math.max(draft.maxOutputTokens || 256, 128), 1024),
      stream: false
    }, { clientId: "model-test", model: draft, proxyUrl: draft.proxyUrl });
    if (result.kind === "error") {
      return {
        ok: false,
        status: result.status,
        body: result.payload,
        error: payloadError(result.payload) || `status ${result.status}`
      };
    }
    if (result.kind !== "json") return { ok: false, error: "模型测试暂不支持流式返回" };
    const content = String(result.payload?.choices?.[0]?.message?.content || "").trim();
    const toolCalls = result.payload?.choices?.[0]?.message?.tool_calls;
    if (!content && !(Array.isArray(toolCalls) && toolCalls.length)) {
      return { ok: false, status: result.status, body: result.payload, error: "模型返回为空，请检查模型名、协议或代理配置" };
    }
    return { ok: true, status: result.status, body: result.payload };
  } catch (err) {
    return { ok: false, error: errorSummary(err) };
  }
});
ipcMain.handle("capabilities:probe", async (_e, payload = {}) => probeModelCapabilities(payload));
ipcMain.handle("capabilities:apply", (_e, { modelId, capabilities } = {}) => {
  const id = String(modelId || "").trim();
  if (!id) throw new Error("缺少模型 ID");
  const cfg = readConfig();
  const index = cfg.models.findIndex((model) => model.id === id);
  if (index < 0) throw new Error(`未找到模型：${id}`);
  cfg.models[index] = {
    ...cfg.models[index],
    capabilities: {
      ...(cfg.models[index].capabilities || {}),
      ...(capabilities || {})
    }
  };
  const result = saveValidated(cfg);
  try { reloadConfig(); } catch {}
  appendLog({ level: "info", msg: "model capabilities applied", modelId: id });
  return { ok: true, model: cfg.models[index], path: result.path };
});
ipcMain.handle("request:replay", (_e, payload = {}) => buildReplayDraft(payload.row || payload));
ipcMain.handle("request:issue-bundle", (_e, payload = {}) => buildIssueBundleReport(payload.row || payload));
ipcMain.handle("request:issue-bundle:save", async (_e, payload = {}) => {
  const report = buildIssueBundleReport(payload.row || payload);
  const defaultPath = path.join(app.getPath("downloads"), `${issueBundleFileStem(report.bundle)}.md`);
  const selected = await dialog.showSaveDialog({
    title: "导出 Switchyard 脱敏问题包",
    defaultPath,
    filters: [{ name: "Markdown", extensions: ["md"] }]
  });
  if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
  const result = saveIssueBundleFiles(report, selected.filePath);
  shell.showItemInFolder(result.markdownPath);
  return result;
});

function providerDiagnostic(provider) {
  let keySource = "未配置";
  let keyOk = false;
  if (isCodexOAuthProvider(provider)) {
    const auth = readCodexOAuthAuth({ provider });
    keySource = "Codex OAuth";
    keyOk = auth.ok;
  } else if (provider.authMode === "none") {
    keySource = "无需认证";
    keyOk = true;
  } else if (provider.authMode === "keychain" || provider.keychainAccount) {
    const account = keychainAccountForProvider(provider);
    keySource = describeKeychainSecret(account);
    keyOk = hasKeychainSecret(account);
  } else if (provider.apiKey) {
    keySource = "inline";
    keyOk = true;
  } else if (provider.apiKeyEnv) {
    keySource = `env:${provider.apiKeyEnv}`;
    keyOk = Boolean(process.env[provider.apiKeyEnv]);
  } else {
    keyOk = true;
  }
  return {
    id: provider.id,
    name: provider.name || provider.id,
    apiFormat: provider.apiFormat,
    baseUrl: provider.baseUrl,
    authMode: provider.authMode || "api_key",
    ready: providerReady(provider),
    keySource,
    keyOk
  };
}

function resolveProbeTarget(cfg, payload = {}) {
  const draft = payload.modelDraft || payload.model || {};
  const modelId = String(payload.modelId || draft.id || draft.modelId || "").trim();
  const configured = cfg.models.find((model) => model.id === modelId);
  const model = configured || {
    id: modelId,
    providerId: String(draft.providerId || "").trim(),
    upstreamModel: String(draft.upstreamModel || modelId).trim(),
    proxyUrl: String(draft.proxyUrl || "").trim(),
    capabilities: draft.capabilities || {}
  };
  const provider = cfg.providers.find((item) => item.id === model.providerId);
  if (!model.id) throw new Error("缺少模型 ID");
  if (!provider) throw new Error(`未找到供应商：${model.providerId}`);
  return { model, provider, upstreamModel: model.upstreamModel || model.id };
}

function baseProbeBody(model, body = {}) {
  return {
    model: model.id,
    _modelId: model.id,
    max_tokens: Math.min(Math.max(Number(model.maxOutputTokens || 256), 64), 512),
    stream: false,
    ...body
  };
}

async function dispatchCapabilityProbe(provider, model, upstreamModel, body) {
  const started = Date.now();
  try {
    const result = await dispatchChat(provider, upstreamModel, body, {
      clientId: "capability-probe",
      model,
      proxyUrl: model.proxyUrl || ""
    });
    if (result.kind === "stream") {
      const upstream = result.upstream;
      const text = await upstream.text().catch((err) => err?.message || "");
      if (!upstream.ok) {
        return {
          ok: false,
          status: upstream.status,
          ms: Date.now() - started,
          error: text.slice(0, 500),
          classification: classifyGatewayError(text)
        };
      }
      return { ok: true, status: upstream.status, ms: Date.now() - started, preview: text.slice(0, 500) };
    }
    if (result.kind === "error") {
      const error = payloadError(result.payload) || `status ${result.status}`;
      return {
        ok: false,
        status: result.status,
        ms: Date.now() - started,
        error,
        classification: classifyGatewayError(error)
      };
    }
    const message = result.payload?.choices?.[0]?.message || {};
    const content = String(message.content || "").trim();
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return {
      ok: Boolean(content || toolCalls.length || result.rawPayload),
      status: result.status,
      ms: Date.now() - started,
      preview: content.slice(0, 500),
      toolCalls: toolCalls.length,
      reasoning: Boolean(message.reasoning_content || result.rawPayload?.reasoning || result.rawPayload?.reasoning_content)
    };
  } catch (err) {
    const error = errorSummary(err);
    return {
      ok: false,
      ms: Date.now() - started,
      error,
      classification: classifyGatewayError(error)
    };
  }
}

async function probeModelCapabilities(payload = {}) {
  const cfg = readConfig();
  const { model, provider, upstreamModel } = resolveProbeTarget(cfg, payload);
  const requested = payload.probes || {
    text: true,
    stream: true,
    tools: true,
    vision: true,
    reasoning: true,
    developerRole: true,
    schemaStrictness: true
  };
  const results = {};
  if (requested.text !== false) {
    results.text = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      messages: [{ role: "user", content: "Reply with the single word: ok" }]
    }));
  }
  if (requested.stream) {
    results.stream = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      stream: true,
      messages: [{ role: "user", content: "Reply with a short sentence." }]
    }));
  }
  if (requested.tools) {
    results.tools = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      messages: [{ role: "user", content: "Reply with plain text. Do not call tools." }],
      tools: [{
        type: "function",
        function: {
          name: "switchyard_ping",
          description: "A harmless capability probe tool.",
          parameters: { type: "object", properties: {}, additionalProperties: false }
        }
      }],
      tool_choice: "auto"
    }));
  }
  if (requested.developerRole || requested["developer-role"]) {
    results["developer-role"] = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      messages: [
        { role: "developer", content: "You are running a compatibility probe. Keep the answer short." },
        { role: "user", content: "Reply with the single word: ok" }
      ]
    }));
  }
  if (requested.schemaStrictness || requested["schema-strictness"]) {
    results["schema-strictness"] = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      messages: [{ role: "user", content: "Reply with plain text. Do not call tools." }],
      tools: [{
        type: "function",
        function: {
          name: "switchyard_schema_probe",
          description: "A harmless schema compatibility probe.",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              value: {
                anyOf: [{ type: "string" }],
                examples: ["ok"],
                default: null
              }
            },
            additionalProperties: { type: "string" }
          }
        }
      }],
      tool_choice: "auto"
    }));
  }
  if (requested.vision) {
    results.vision = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "What color is the square? Reply with one word." },
          { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } }
        ]
      }]
    }));
  }
  if (requested.reasoning) {
    const result = await dispatchCapabilityProbe(provider, model, upstreamModel, baseProbeBody(model, {
      messages: [{ role: "user", content: "Think briefly, then answer with the word ok." }]
    }));
    results.reasoning = { ...result, ok: Boolean(result.reasoning || model.capabilities?.reasoning) };
  }
  const compatRules = activeCompatRulesByDirection(provider, model);
  return {
    ok: Object.values(results).some((result) => result.ok),
    modelId: model.id,
    providerId: provider.id,
    upstreamModel,
    results,
    suggestion: suggestCapabilitiesFromProbeResults(model, results),
    compatRules,
    compatibilityProfile: buildCompatibilityProfile({
      provider,
      model,
      results,
      activeRules: flattenCompatRules(compatRules)
    })
  };
}

function buildImageDiagnostic(config, { model, clientId, includeImage }) {
  if (!includeImage) return { included: false };
  const route = resolveRoute(config, model || "", { clientId });
  if (!route) return { included: true, fixture: TEST_IMAGE_LABEL, requestedModel: model || "", expectedColor: "红色", expectedPath: "no_route" };
  const capabilities = route.model.capabilities || {};
  const supportsImages = Boolean(capabilities.images || capabilities.multimodal);
  return {
    included: true,
    fixture: TEST_IMAGE_LABEL,
    expectedColor: "红色",
    requestedModel: model || "",
    modelId: route.model.id,
    providerId: route.provider.id,
    upstreamModel: route.upstreamModel,
    supportsImages,
    visionFallbackModelId: route.model.visionFallbackModelId || "",
    expectedPath: supportsImages ? "direct" : (route.model.visionFallbackModelId ? "fallback" : "direct_unverified")
  };
}

function mergeVisionDiagnostic(diagnostic, resp) {
  if (!diagnostic?.included) return diagnostic;
  const raw = resp.headers.get("x-switchyard-vision") || "";
  if (!raw) return diagnostic;
  try {
    return { ...diagnostic, actual: JSON.parse(decodeURIComponent(raw)) };
  } catch {
    return diagnostic;
  }
}

function safeFilePart(value) {
  return String(value || "skill")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "skill";
}

async function downloadSkillHubZip(slug) {
  const url = `https://api.skillhub.cn/api/v1/download?slug=${encodeURIComponent(slug)}`;
  const resp = await fetch(url, { headers: { Accept: "application/zip", "User-Agent": "Switchyard/0.2" } });
  if (!resp.ok) throw new Error(`SkillHub 下载失败：${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error("SkillHub 下载内容不是 zip");
  return { buffer, url: resp.url || url };
}

function assertSafeZipEntries(zip) {
  for (const entry of zip.getEntries()) {
    const name = String(entry.entryName || "");
    const normalized = path.normalize(name);
    if (!name || path.isAbsolute(name) || normalized === ".." || normalized.startsWith(`..${path.sep}`) || normalized.includes(`${path.sep}..${path.sep}`)) {
      throw new Error(`SkillHub zip 包含不安全路径：${name}`);
    }
  }
}

function findExtractedSkillDir(root) {
  if (fs.existsSync(path.join(root, "SKILL.md"))) return root;
  const pending = [{ dir: root, depth: 0 }];
  while (pending.length) {
    const item = pending.shift();
    if (item.depth >= 3) continue;
    let entries = [];
    try { entries = fs.readdirSync(item.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(item.dir, entry.name);
      if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
      pending.push({ dir, depth: item.depth + 1 });
    }
  }
  throw new Error("SkillHub zip 中没有找到 SKILL.md");
}

function extractSkillHubZip(buffer, slug) {
  const root = fs.mkdtempSync(path.join(app.getPath("temp"), `switchyard-skillhub-${safeFilePart(slug)}-`));
  try {
    const zip = new AdmZip(buffer);
    assertSafeZipEntries(zip);
    zip.extractAllTo(root, true);
    return { root, skillDir: findExtractedSkillDir(root) };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

async function searchSkillHub({ keyword = "", limit = 20 } = {}) {
  const params = new URLSearchParams({
    page: "1",
    pageSize: String(Math.min(Math.max(Number(limit) || 20, 1), 50)),
    sortBy: "score",
    order: "desc"
  });
  if (String(keyword || "").trim()) params.set("keyword", String(keyword).trim());
  const url = `https://api.skillhub.cn/api/skills?${params.toString()}`;
  const resp = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "Switchyard/0.2" } });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`SkillHub 查询失败：${resp.status}`);
  let payload = null;
  try { payload = JSON.parse(text); } catch {
    throw new Error("SkillHub 返回了非 JSON 内容");
  }
  if (payload.code !== 0) throw new Error(payload.message || "SkillHub 查询失败");
  const skills = payload?.data?.skills || [];
  return {
    ok: true,
    url,
    total: payload?.data?.total || skills.length,
    items: skills.map((skill) => ({
      slug: skill.slug,
      name: skill.name || skill.displayName || skill.slug,
      version: skill.version || "",
      description: skill.description_zh || skill.description || "",
      category: skill.category || "",
      ownerName: skill.ownerName || "",
      subCategories: Array.isArray(skill.subCategories) ? skill.subCategories.map((item) => item.name || item.key).filter(Boolean) : [],
      downloads: Number.isFinite(Number(skill.downloads)) ? Number(skill.downloads) : null,
      stars: Number.isFinite(Number(skill.stars)) ? Number(skill.stars) : null,
      installs: Number.isFinite(Number(skill.installs)) ? Number(skill.installs) : null,
      verified: !!skill.verified,
      requiresApiKey: skill.labels?.requires_api_key === "true",
      homepage: `https://skillhub.cn/skills/${skill.slug}`,
      source: skill.source || ""
    }))
  };
}

// 单实例锁：应用关窗后驻留后台，若用户再次启动，不开新实例（避免重复
// 拉起网关导致端口冲突），而是唤出已有窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0); // 第二实例直接退出，跳过清理钩子（它未启动网关）
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });
}

app.whenReady().then(async () => {
  const win = createMainWindow();
  createTray();
  subscribeLogs((entry) => {
    if (!win.isDestroyed()) win.webContents.send("gateway:log", entry);
  });
  for (const e of snapshotLogs()) {
    if (!win.isDestroyed()) win.webContents.send("gateway:log", e);
  }
  try {
    await startGateway();
    syncCodexArtifacts("app-start");
    startCodexArtifactMonitor();
    getProviderHealthMonitor().start({ immediate: true });
  } catch (err) {
    appendLog({ level: "error", msg: "gateway autostart failed", error: err?.message || String(err) });
  }
});

// macOS：点 Dock 图标 / 应用被激活时，恢复主窗口。
app.on("activate", () => {
  showMainWindow();
});

// 关窗保活：窗口全部关闭时不退出（网关继续后台跑，托盘常驻）。
// macOS 本就默认不退出；这里对所有平台统一保活，真正退出走托盘菜单。
app.on("window-all-closed", () => {
  // 不调用 app.quit()，应用驻留后台。
});

// macOS: 点击 Dock 图标时恢复窗口（关窗隐藏后重新唤出）。
app.on("activate", () => {
  showMainWindow();
});

// 真正退出前统一做收尾清理（停网关 / 监控）。无论从托盘“退出”、
// Cmd+Q 还是系统关机触发，都先异步清理再放行退出。
let cleanedUp = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  if (cleanedUp) return; // 清理已完成，放行本次退出
  event.preventDefault();
  (async () => {
    try {
      stopCodexArtifactMonitor();
      await stopGateway();
    } catch (err) {
      appendLog({ level: "error", msg: "gateway stop on quit failed", error: err?.message || String(err) });
    } finally {
      cleanedUp = true;
      app.quit();
    }
  })();
});

function apiFormatModelUrls(baseUrl, apiFormat) {
  if (apiFormat === "anthropic_messages") {
    return [`${baseUrl}/v1/models`, `${baseUrl}/models`];
  }
  if (apiFormat === "openai_responses") {
    return [`${baseUrl}/models`, `${baseUrl}/v1/models`];
  }
  return [`${baseUrl}/models`, `${baseUrl}/v1/models`];
}

function buildProviderHeaders(provider) {
  return providerAuthHeaders(provider, provider.apiFormat === "anthropic_messages" ? "anthropic" : "bearer");
}

function getProviderHealthMonitor() {
  if (!providerHealthMonitor) {
    providerHealthMonitor = createProviderHealthMonitor({
      listProviders: () => readConfig().providers,
      probeProvider: (provider) => testProviderConnectivity(provider),
      intervalMs: 5 * 60 * 1000
    });
  }
  return providerHealthMonitor;
}

async function testProviderConnectivity(provider) {
  const probe = { ...provider };
  const baseUrl = String(probe.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, error: "缺少 Base URL" };
  if (isCodexOAuthProvider(probe)) {
    const auth = readCodexOAuthAuth({ provider: probe });
    if (!auth.ok) return { ok: false, error: `未找到可用 Codex OAuth：${auth.reason}` };
    const url = `${baseUrl}/models?client_version=${encodeURIComponent(CODEX_OAUTH_CLIENT_VERSION)}`;
    try {
      const { resp, text } = await fetchTextOnce(url, { method: "GET", headers: buildProviderHeaders(probe) }, probe);
      return {
        ok: resp.ok,
        status: resp.status,
        url,
        bodyPreview: resp.ok
          ? `已检测到本机 Codex OAuth，并成功连接官方模型接口。${text.slice(0, 500)}`
          : text.slice(0, 800)
      };
    } catch (err) {
      return { ok: false, url, error: errorSummary(err) };
    }
  }
  const apiFormat = probe.apiFormat || "openai_chat";
  const headers = buildProviderHeaders(probe);
  const candidates = apiFormatModelUrls(baseUrl, apiFormat);
  let last = null;
  for (const url of candidates) {
    try {
      const { resp, text } = await fetchTextOnce(url, { method: "GET", headers }, probe);
      last = {
        ok: resp.ok,
        status: resp.status,
        url,
        bodyPreview: text.slice(0, 800)
      };
      if (resp.ok) return last;
    } catch (err) {
      last = { ok: false, url, error: err?.message || String(err) };
    }
  }
  return last || { ok: false, error: "测试失败" };
}

function providerFetchInit(provider, init = {}) {
  const proxyUrl = String(provider?.proxyUrl || "").trim();
  if (!proxyUrl) return init;
  return { ...init, dispatcher: proxyDispatcher(proxyUrl) };
}

function safeRequestPreview(built) {
  return {
    url: built.url,
    headers: Object.fromEntries(Object.entries(built.headers || {}).map(([key, value]) => [
      key,
      /authorization|api-key/i.test(key) ? redactHeader(value) : value
    ])),
    body: built.body
  };
}

function redactHeader(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/^bearer\s+/i.test(text)) return "Bearer ***";
  return "***";
}

function errorSummary(err) {
  const base = err?.message || String(err);
  const cause = err?.cause;
  const details = [
    cause?.code,
    cause?.host,
    cause?.port ? `:${cause.port}` : ""
  ].filter(Boolean).join(" ");
  return details ? `${base} (${details})` : base;
}

function payloadError(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.slice(0, 500);
  if (typeof payload.error === "string") return payload.error;
  if (payload.error?.message) return payload.error.message;
  if (payload.message) return payload.message;
  return "";
}

async function fetchTextOnce(url, init = {}, provider = null) {
  const controller = init.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const finalInit = provider ? providerFetchInit(provider, init) : { ...init };
    if (controller) finalInit.signal = controller.signal;
    const resp = await fetch(url, finalInit);
    const text = await resp.text();
    return { resp, text };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function inputModalities(item) {
  const raw = item?.input_modalities || item?.inputModalities || item?.modalities || item?.capabilities?.input_modalities || [];
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v).toLowerCase());
}

function normalizeHintModel(item) {
  const caps = item.capabilities || {};
  return {
    id: item.id || item.slug || item.model || item.name || "",
    displayName: item.displayName || item.display_name || item.name || item.id,
    contextWindow: firstNumber(item.contextWindow, item.context_window, item.max_context_window),
    maxOutputTokens: firstNumber(item.maxOutputTokens, item.max_output_tokens, item.max_completion_tokens, item.output_token_limit),
    capabilities: {
      text: caps.text !== false,
      tools: caps.tools !== false,
      reasoning: !!caps.reasoning,
      images: !!caps.images,
      stream: caps.stream !== false,
      multimodal: !!caps.multimodal
    },
    raw: item
  };
}

function mergeModelHint(item, hints) {
  const hint = hints?.get(item.id) || hints?.get(item.raw?.id) || null;
  if (!hint) return item;
  const normalizedHint = normalizeHintModel(hint);
  return {
    ...item,
    displayName: item.displayName || normalizedHint.displayName,
    contextWindow: item.contextWindow || normalizedHint.contextWindow,
    maxOutputTokens: item.maxOutputTokens || normalizedHint.maxOutputTokens,
    capabilities: { ...(normalizedHint.capabilities || {}), ...(item.capabilities || {}) }
  };
}

function normalizeDiscoveredModels(payload, hints = new Map()) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return list.map((item) => {
    const id = item?.id || item?.slug || item?.model || item?.name || "";
    if (!id) return null;
    const modalities = inputModalities(item);
    const caps = item?.capabilities || {};
    return mergeModelHint({
      id,
      displayName: item?.display_name || item?.name || id,
      contextWindow: firstNumber(item?.contextWindow, item?.context_window, item?.context_length, item?.max_context_window, item?.maxContextWindow, item?.metadata?.context_window),
      maxOutputTokens: firstNumber(item?.maxOutputTokens, item?.max_output_tokens, item?.max_completion_tokens, item?.output_token_limit, item?.metadata?.max_output_tokens),
      capabilities: {
        text: true,
        tools: caps.tools !== false,
        reasoning: Boolean(caps.reasoning || item?.supports_reasoning || item?.reasoning || (Array.isArray(item?.supported_reasoning_levels) && item.supported_reasoning_levels.length)),
        images: modalities.includes("image") || modalities.includes("vision") || Boolean(caps.images || caps.vision),
        stream: caps.stream !== false && item?.stream !== false,
        multimodal: modalities.includes("image") || modalities.length > 1 || Boolean(caps.multimodal)
      },
      raw: item
    }, hints);
  }).filter(Boolean);
}

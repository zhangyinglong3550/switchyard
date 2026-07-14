// Electron main process for Switchyard.
import { app, BrowserWindow, ipcMain, shell, dialog, Tray, Menu, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import AdmZip from "adm-zip";

const execFileAsync = promisify(execFile);
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
import { listAgentPlugins, addPluginSource, removePluginSource, installPlugin, uninstallPlugin } from "./agent-plugins.mjs";
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
  isCodexOAuthProvider,
  isAnthropicOAuthProvider,
  isAccountPoolProvider,
  readAnthropicOAuthAuth
} from "../../../packages/core/src/upstream/clients.mjs";
import {
  anthropicOAuthAuthPath,
  anthropicOAuthStatus,
  clearAnthropicOAuthFile,
  runAnthropicOAuthLogin,
  writeAnthropicOAuthFile,
  refreshAnthropicTokens,
  readAnthropicOAuthFile
} from "../../../packages/core/src/oauth-anthropic.mjs";
import { dispatchChat } from "../../../packages/core/src/upstream/dispatch.mjs";
import { checkBalance } from "../../../packages/core/src/balance-check.mjs";
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
import {
  bindProviderToAccount,
  deleteAccounts,
  importAntigravityFromCpaDirs,
  importCodexAccountsFromText,
  importCodexFromPaths,
  importXaiAccountsFromCpaDirs,
  importXaiAccountsFromText,
  listPoolAccountsPublic,
  patchAccounts,
  pickAndRefreshAccount,
  poolKindOf,
  savePool,
  loadPool,
  syncAntigravityPoolToCliproxyDir,
  refreshPoolQuotas,
  refreshAccountQuota
} from "../../../packages/core/src/account-pool/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let providerHealthMonitor = null;
let codexArtifactTimer = null;
// 托盘常驻 + 关窗保活：mainWindow 保留主窗口引用，tray 为系统托盘，
// isQuitting 标记是否真正退出（区分“点叉隐藏”与“菜单/托盘退出”）。
let mainWindow = null;
let tray = null;
let isQuitting = false;
registerBuiltinPatches();

// ── 自动更新检查 + 下载安装 ──────────────────────────────────
let updateCheckTimer = null;
let pendingUpdateInfo = null;
let updateInstallInProgress = false;
const GITHUB_RELEASES_API = "https://api.github.com/repos/zhangyinglong3550/switchyard/releases/latest";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时

function semverGt(a, b) {
  const pa = String(a || "").replace(/^v/, "").split(".").map(Number);
  const pb = String(b || "").replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

function platformUpdateAssetPreference() {
  if (process.platform === "darwin") {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    return {
      platform: "darwin",
      arch,
      // 优先匹配顺序：arch-specific dmg → generic dmg
      matchers: arch === "arm64"
        ? [/\.dmg$/i, /arm64/i]
        : [/\.dmg$/i, /(x64|intel|amd64)/i],
      prefer: (name) => {
        const n = String(name || "").toLowerCase();
        if (!n.endsWith(".dmg")) return 0;
        if (arch === "arm64") return n.includes("arm64") ? 100 : n.includes("x64") ? 10 : 50;
        return n.includes("arm64") ? 10 : n.includes("x64") || n.includes("intel") ? 100 : 80;
      }
    };
  }
  if (process.platform === "win32") {
    return {
      platform: "win32",
      arch: "x64",
      prefer: (name) => {
        const n = String(name || "").toLowerCase();
        if (n.endsWith(".exe") && (n.includes("setup") || n.includes("switchyard"))) return 100;
        if (n.endsWith("-win.zip") || (n.endsWith(".zip") && n.includes("win"))) return 80;
        if (n.endsWith(".exe")) return 60;
        return 0;
      }
    };
  }
  return {
    platform: process.platform,
    arch: process.arch,
    prefer: () => 0
  };
}

function pickReleaseAsset(assets = []) {
  const pref = platformUpdateAssetPreference();
  let best = null;
  let bestScore = 0;
  for (const asset of assets) {
    const name = asset?.name || "";
    const url = asset?.browser_download_url || "";
    if (!name || !url) continue;
    const score = pref.prefer(name);
    if (score > bestScore) {
      bestScore = score;
      best = { name, url, size: Number(asset.size) || 0, contentType: asset.content_type || "" };
    }
  }
  return bestScore > 0 ? best : null;
}

function sendUpdateEvent(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function checkForUpdate() {
  try {
    const { fetch } = await import("undici");
    const res = await fetch(GITHUB_RELEASES_API, {
      headers: {
        "User-Agent": "Switchyard-Desktop",
        Accept: "application/vnd.github+json"
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const latestTag = String(data.tag_name || "").replace(/^v/, "");
    const currentVersion = app.getVersion();
    if (!latestTag || !semverGt(latestTag, currentVersion)) {
      pendingUpdateInfo = null;
      return { ok: true, updateAvailable: false, current: currentVersion, latest: latestTag || currentVersion };
    }
    const asset = pickReleaseAsset(data.assets || []);
    const info = {
      current: currentVersion,
      latest: latestTag,
      url: data.html_url || "https://github.com/zhangyinglong3550/switchyard/releases/latest",
      notes: String(data.body || "").slice(0, 2000),
      publishedAt: data.published_at || "",
      asset
    };
    pendingUpdateInfo = info;
    sendUpdateEvent("app:update-available", info);
    return { ok: true, updateAvailable: true, ...info };
  } catch {
    return null;
  }
}

function startUpdateChecker() {
  checkForUpdate();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  updateCheckTimer = setInterval(() => checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
  updateCheckTimer.unref?.();
}

async function downloadUpdateAsset(asset, onProgress) {
  const { fetch } = await import("undici");
  const res = await fetch(asset.url, {
    headers: { "User-Agent": "Switchyard-Desktop", Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(30 * 60 * 1000),
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || asset.size || 0;
  const destDir = path.join(app.getPath("temp"), "switchyard-updates");
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(asset.name));
  if (fs.existsSync(dest)) {
    try { fs.unlinkSync(dest); } catch {}
  }
  const fileStream = createWriteStream(dest);
  let received = 0;
  const body = res.body;
  if (!body) throw new Error("下载响应无 body");
  // undici body 是 Web ReadableStream；转 Node stream 便于 pipeline
  const nodeStream = Readable.fromWeb(body);
  nodeStream.on("data", (chunk) => {
    received += chunk.length;
    if (typeof onProgress === "function") {
      onProgress({
        phase: "downloading",
        received,
        total,
        percent: total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0
      });
    }
  });
  await pipeline(nodeStream, fileStream);
  if (typeof onProgress === "function") {
    onProgress({ phase: "downloaded", received, total: total || received, percent: 100, path: dest });
  }
  return dest;
}

async function installMacUpdate(dmgPath, onProgress) {
  onProgress?.({ phase: "installing", message: "正在挂载安装包…", percent: 100 });
  const mountRoot = path.join(app.getPath("temp"), `switchyard-mount-${Date.now()}`);
  fs.mkdirSync(mountRoot, { recursive: true });
  let mountPoint = "";
  try {
    const { stdout } = await execFileAsync("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountroot", mountRoot], {
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024
    });
    // 输出最后一行通常含 mount point
    const lines = String(stdout || "").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\t+/);
      const candidate = parts[parts.length - 1];
      if (candidate && candidate.startsWith(mountRoot) && fs.existsSync(candidate)) {
        mountPoint = candidate;
      }
    }
    if (!mountPoint) {
      const entries = fs.readdirSync(mountRoot);
      if (entries[0]) mountPoint = path.join(mountRoot, entries[0]);
    }
    if (!mountPoint || !fs.existsSync(mountPoint)) {
      throw new Error("无法解析 DMG 挂载点");
    }
    const appEntry = fs.readdirSync(mountPoint).find((name) => name.endsWith(".app"));
    if (!appEntry) throw new Error("安装包中未找到 .app");
    const srcApp = path.join(mountPoint, appEntry);
    const destApp = path.join("/Applications", appEntry);
    onProgress?.({ phase: "installing", message: `正在安装到 ${destApp}…`, percent: 100 });
    // 先复制到临时再替换，避免覆盖运行中的 app 时部分写入
    const staging = path.join(app.getPath("temp"), `${appEntry}.staging-${Date.now()}`);
    await execFileAsync("rm", ["-rf", staging], { timeout: 60000 }).catch(() => {});
    await execFileAsync("cp", ["-R", srcApp, staging], { timeout: 180000 });
    if (fs.existsSync(destApp)) {
      const backup = `${destApp}.bak-${Date.now()}`;
      try {
        await execFileAsync("mv", [destApp, backup], { timeout: 60000 });
      } catch {
        // 若权限不足，尝试直接覆盖
      }
    }
    await execFileAsync("rm", ["-rf", destApp], { timeout: 60000 }).catch(() => {});
    await execFileAsync("mv", [staging, destApp], { timeout: 60000 });
    onProgress?.({ phase: "installed", message: "安装完成，即将重启…", percent: 100, destApp });
    return { ok: true, destApp };
  } finally {
    if (mountPoint) {
      try {
        await execFileAsync("hdiutil", ["detach", mountPoint, "-quiet"], { timeout: 60000 });
      } catch {
        try {
          await execFileAsync("hdiutil", ["detach", mountPoint, "-force"], { timeout: 60000 });
        } catch {}
      }
    }
    try {
      fs.rmSync(mountRoot, { recursive: true, force: true });
    } catch {}
  }
}

async function installWinUpdate(filePath, onProgress) {
  onProgress?.({ phase: "installing", message: "正在启动安装程序…", percent: 100 });
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".exe")) {
    // NSIS 安装器：异步拉起后退出当前进程，安装完成由用户/安装器重启
    spawn(filePath, [], { detached: true, stdio: "ignore" }).unref();
    return { ok: true, launchedInstaller: true };
  }
  if (lower.endsWith(".zip")) {
    const extractDir = path.join(app.getPath("temp"), `switchyard-win-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractDir, true);
    onProgress?.({
      phase: "installed",
      message: `已解压到 ${extractDir}，请手动替换安装目录后重启。`,
      percent: 100,
      extractDir
    });
    shell.openPath(extractDir).catch(() => {});
    return { ok: true, extractDir, manual: true };
  }
  throw new Error("不支持的 Windows 安装包格式");
}

async function downloadAndInstallUpdate(info = pendingUpdateInfo) {
  if (updateInstallInProgress) return { ok: false, error: "更新正在进行中" };
  if (!info?.asset?.url) {
    // 无匹配资源时回退打开发布页
    if (info?.url) await shell.openExternal(info.url);
    return { ok: false, error: "当前平台没有可自动安装的安装包，已打开发布页", openedUrl: true };
  }
  updateInstallInProgress = true;
  const report = (payload) => sendUpdateEvent("app:update-progress", payload);
  try {
    report({ phase: "starting", percent: 0, message: `开始下载 v${info.latest}…` });
    const filePath = await downloadUpdateAsset(info.asset, report);
    let result;
    if (process.platform === "darwin") {
      result = await installMacUpdate(filePath, report);
      // 安装到 /Applications 后 relaunch
      report({ phase: "relaunching", message: "正在重新打开…", percent: 100 });
      setTimeout(() => {
        try {
          const exe = result?.destApp
            ? path.join(result.destApp, "Contents", "MacOS", "Switchyard")
            : process.execPath;
          if (result?.destApp && fs.existsSync(exe)) {
            app.relaunch({ execPath: exe });
          } else {
            app.relaunch();
          }
        } catch {
          app.relaunch();
        }
        app.exit(0);
      }, 600);
      return { ok: true, relaunching: true, ...result };
    }
    if (process.platform === "win32") {
      result = await installWinUpdate(filePath, report);
      if (result.launchedInstaller) {
        setTimeout(() => app.exit(0), 800);
        return { ok: true, relaunching: true, ...result };
      }
      return { ok: true, ...result };
    }
    await shell.openExternal(info.url || info.asset.url);
    return { ok: false, error: "当前系统暂不支持自动安装，已打开下载链接", openedUrl: true };
  } catch (err) {
    const message = err?.message || String(err);
    report({ phase: "error", message, percent: 0 });
    return { ok: false, error: message };
  } finally {
    updateInstallInProgress = false;
  }
}


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
  if (mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) return CODEX_ACCESS_MODES.OFFICIAL_DIRECT;
  if (mode === CODEX_ACCESS_MODES.PROVIDER_DIRECT) return CODEX_ACCESS_MODES.PROVIDER_DIRECT;
  return CODEX_ACCESS_MODES.SWITCHYARD_PROXY;
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
    const status = statusFromServer();
    const result = syncClientModelArtifacts({
      host: cfg.host,
      port: cfg.port,
      codexDefaultModel: clientDefaultModel(cfg, "codex", codexModels),
      codexModels: modelsForProfile(cfg, codexModels),
      claudeCodeModels: modelsForProfile(cfg, claudeCodeModels)
    });
    const codexChanged = result.codex?.ok && (result.codex.catalogChanged || result.codex.cacheChanged);
    const claudeChanged = result.claudeCode?.ok && result.claudeCode.cacheChanged;

    // Auto-sync settings.json for Claude Code so env vars stay current
    // (Claude Code reads these on next startup)
    try {
      applyProfile("claude-code", {
        host: status.running ? status.host : cfg.host,
        port: status.running ? status.port : cfg.port,
        defaultModel: clientDefaultModel(cfg, "claude-code", claudeCodeModels),
        models: modelsForProfile(cfg, claudeCodeModels),
        modelMapping: cfg.clients?.["claude-code"]?.modelMapping
      });
    } catch (_e) { /* non-fatal */ }

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
    // 笔记本内建屏高度有限：默认高度略降，最小高度保证侧栏底栏（服务+版本）可见
    width: 1180, height: 720, minWidth: 900, minHeight: 560,
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
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("shell:open-url", async (_e, { url } = {}) => {
  if (url) await shell.openExternal(url);
  return { ok: true };
});
ipcMain.handle("app:check-update", async () => {
  const result = await checkForUpdate();
  return result || { ok: false, error: "检查更新失败" };
});
ipcMain.handle("app:install-update", async (_e, payload = {}) => {
  const info = payload?.latest
    ? { ...pendingUpdateInfo, ...payload, asset: payload.asset || pendingUpdateInfo?.asset }
    : pendingUpdateInfo;
  return downloadAndInstallUpdate(info);
});
ipcMain.handle("app:open-release-page", async () => {
  const url = pendingUpdateInfo?.url || "https://github.com/zhangyinglong3550/switchyard/releases/latest";
  await shell.openExternal(url);
  return { ok: true, url };
});

// ── Anthropic 官方 OAuth ─────────────────────────────────────
ipcMain.handle("anthropic-oauth:status", (_e, payload = {}) => {
  const providerId = payload.providerId || payload.id || "";
  return anthropicOAuthStatus({ id: providerId });
});
ipcMain.handle("anthropic-oauth:login", async (_e, payload = {}) => {
  const providerId = payload.providerId || payload.id || "";
  const authFile = anthropicOAuthAuthPath(providerId);
  const proxyUrl = payload.proxyUrl || "";
  appendLog({ level: "info", msg: "anthropic oauth login started", providerId: providerId || "default" });
  const result = await runAnthropicOAuthLogin({
    openUrl: (url) => shell.openExternal(url),
    proxyUrl,
    authFile
  });
  if (result.ok) {
    appendLog({ level: "info", msg: "anthropic oauth login ok", email: result.email || "" });
  } else {
    appendLog({ level: "warn", msg: "anthropic oauth login failed", error: result.error || "" });
  }
  return result;
});
ipcMain.handle("anthropic-oauth:logout", (_e, payload = {}) => {
  const providerId = payload.providerId || payload.id || "";
  const authFile = anthropicOAuthAuthPath(providerId);
  const result = clearAnthropicOAuthFile(authFile);
  // 只清 Switchyard 自管缓存，不碰 Claude Code Keychain / .credentials.json
  const fallback = anthropicOAuthAuthPath();
  if (fallback !== authFile) clearAnthropicOAuthFile(fallback);
  appendLog({ level: "info", msg: "anthropic oauth clear switchyard cache", authFile });
  return {
    ...result,
    note: "已清除 Switchyard 缓存凭证；Claude Code 本机登录不受影响。"
  };
});
ipcMain.handle("anthropic-oauth:import-refresh", async (_e, payload = {}) => {
  const refreshToken = String(payload.refreshToken || payload.refresh_token || "").trim();
  if (!refreshToken) throw new Error("请提供 refresh_token");
  const providerId = payload.providerId || payload.id || "";
  const proxyUrl = payload.proxyUrl || "";
  const tokens = await refreshAnthropicTokens(refreshToken, { proxyUrl });
  const authFile = anthropicOAuthAuthPath(providerId);
  writeAnthropicOAuthFile(tokens, authFile);
  appendLog({ level: "info", msg: "anthropic oauth import refresh ok", email: tokens.email || "" });
  return { ok: true, email: tokens.email, expiresAt: tokens.expiresAt, authFile };
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
ipcMain.handle("agent:plugins:install", (_e, payload = {}) => installPlugin(payload));
ipcMain.handle("agent:plugins:uninstall", (_e, payload = {}) => uninstallPlugin(payload));
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

function resolvePoolKind(payload = {}, providerId = "") {
  const explicit = String(payload.poolKind || "").trim();
  if (explicit) return explicit;
  try {
    const cfg = readConfig();
    const provider = (cfg.providers || []).find((p) => p.id === providerId);
    if (provider) return poolKindOf(provider);
  } catch {}
  return "xai_oauth";
}

ipcMain.handle("account-pool:list", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  return listPoolAccountsPublic(providerId, {
    poolKind: resolvePoolKind(payload, providerId)
  });
});

ipcMain.handle("account-pool:import-text", async (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const poolKind = resolvePoolKind(payload, providerId);

  // Codex：粘贴 JSON / RT 列表（不依赖 ~/.cli-proxy-api）
  if (poolKind === "codex_oauth") {
    return importCodexAccountsFromText(providerId, payload.text || "", {
      skipDuplicates: payload.skipDuplicates !== false
    });
  }
  if (poolKind === "antigravity_oauth") {
    return {
      ok: false,
      error: "Antigravity 粘贴导入暂未开放，可先用 Codex / Grok 池"
    };
  }

  // Grok / xAI：优先用前端传入的 proxy，否则读供应商配置，再 fallback 本机 7890
  let proxyUrl = String(payload.proxyUrl || "").trim();
  if (!proxyUrl) {
    try {
      const cfg = readConfig();
      const provider = (cfg.providers || []).find((p) => p.id === providerId);
      proxyUrl = String(provider?.proxyUrl || "").trim();
    } catch {}
  }
  if (!proxyUrl) proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7890";
  // 自动 SSO→OAuth：卡密 / sso=JWT 粘贴后走 Device Flow 转换
  return importXaiAccountsFromText(providerId, payload.text || "", {
    poolKind,
    skipDuplicates: payload.skipDuplicates !== false,
    convertSso: payload.convertSso !== false,
    proxyUrl,
    gapMs: payload.gapMs ?? 2500
  });
});

ipcMain.handle("account-pool:import-cpa", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const poolKind = resolvePoolKind(payload, providerId);
  if (poolKind === "antigravity_oauth") {
    return importAntigravityFromCpaDirs(providerId, {
      dirs: payload.dirs,
      skipDuplicates: payload.skipDuplicates !== false,
      syncToCliproxy: payload.syncToCliproxy !== false
    });
  }
  if (poolKind === "codex_oauth") {
    return importCodexFromPaths(providerId, {
      paths: payload.paths,
      dirs: payload.dirs,
      skipDuplicates: payload.skipDuplicates !== false
    });
  }
  return importXaiAccountsFromCpaDirs(providerId, {
    dirs: payload.dirs,
    skipDuplicates: payload.skipDuplicates !== false
  });
});

ipcMain.handle("account-pool:import-antigravity", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  return importAntigravityFromCpaDirs(providerId, {
    dirs: payload.dirs,
    skipDuplicates: payload.skipDuplicates !== false,
    syncToCliproxy: payload.syncToCliproxy !== false
  });
});

ipcMain.handle("account-pool:import-codex", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  return importCodexFromPaths(providerId, {
    paths: payload.paths,
    dirs: payload.dirs,
    skipDuplicates: payload.skipDuplicates !== false
  });
});

/** 弹窗多选本地 JSON 文件并导入账号池（Codex 主用；也可给 xAI 用） */
ipcMain.handle("account-pool:import-files-dialog", async (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const poolKind = resolvePoolKind(payload, providerId);
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: poolKind === "codex_oauth" ? "选择 Codex 账号 JSON（可多选）" : "选择账号 JSON（可多选）",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  if (result.canceled || !result.filePaths?.length) {
    return { ok: false, cancelled: true, added: 0, skipped: 0, scanned: 0 };
  }
  if (poolKind === "codex_oauth") {
    return {
      ...importCodexFromPaths(providerId, {
        paths: result.filePaths,
        dirs: [],
        skipDuplicates: payload.skipDuplicates !== false
      }),
      selectedFiles: result.filePaths.length
    };
  }
  if (poolKind === "xai_oauth") {
    let added = 0;
    let skipped = 0;
    let scanned = 0;
    const errors = [];
    for (const file of result.filePaths) {
      try {
        const text = fs.readFileSync(file, "utf8");
        const one = await importXaiAccountsFromText(providerId, text, {
          poolKind: "xai_oauth",
          skipDuplicates: payload.skipDuplicates !== false,
          convertSso: false
        });
        if (one.ok) {
          added += one.added || 0;
          skipped += one.skipped || 0;
          scanned += 1;
        } else {
          errors.push({ file, error: one.error });
        }
      } catch (err) {
        errors.push({ file, error: err?.message || String(err) });
      }
    }
    return {
      ok: added > 0 || skipped > 0,
      added,
      skipped,
      scanned,
      selectedFiles: result.filePaths.length,
      errors,
      error: added || skipped ? undefined : (errors[0]?.error || "未导入任何账号")
    };
  }
  return {
    ok: false,
    error: `${poolKind} 暂不支持文件多选导入`,
    selectedFiles: result.filePaths.length
  };
});

/** 弹窗选择文件夹，扫描其中全部 codex/CPA json */
ipcMain.handle("account-pool:import-dir-dialog", async (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const poolKind = resolvePoolKind(payload, providerId);
  const result = await dialog.showOpenDialog(mainWindow || undefined, {
    title: poolKind === "codex_oauth" ? "选择存放 Codex JSON 的文件夹" : "选择账号 JSON 文件夹",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths?.[0]) {
    return { ok: false, cancelled: true, added: 0, skipped: 0, scanned: 0 };
  }
  const dir = result.filePaths[0];
  if (poolKind === "codex_oauth") {
    return {
      ...importCodexFromPaths(providerId, {
        paths: [],
        dirs: [dir],
        skipDuplicates: payload.skipDuplicates !== false
      }),
      selectedDir: dir
    };
  }
  if (poolKind === "xai_oauth") {
    return {
      ...importXaiAccountsFromCpaDirs(providerId, {
        dirs: [dir],
        skipDuplicates: payload.skipDuplicates !== false
      }),
      selectedDir: dir
    };
  }
  if (poolKind === "antigravity_oauth") {
    return {
      ...importAntigravityFromCpaDirs(providerId, {
        dirs: [dir],
        skipDuplicates: payload.skipDuplicates !== false,
        syncToCliproxy: payload.syncToCliproxy !== false
      }),
      selectedDir: dir
    };
  }
  return { ok: false, error: `${poolKind} 暂不支持文件夹导入`, selectedDir: dir };
});

ipcMain.handle("account-pool:sync-antigravity", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  return syncAntigravityPoolToCliproxyDir(providerId, {
    authDir: payload.authDir
  });
});

/** 刷新账号池额度：Codex 查 wham/usage；Grok 仅展示团队信息 */
ipcMain.handle("account-pool:refresh-quota", async (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const poolKind = resolvePoolKind(payload, providerId);
  let proxyUrl = String(payload.proxyUrl || "").trim();
  let provider = { id: providerId, authMode: "account_pool", poolKind, proxyUrl };
  try {
    const cfg = readConfig();
    const found = (cfg.providers || []).find((p) => p.id === providerId);
    if (found) {
      provider = { ...found, poolKind: found.poolKind || poolKind };
      if (!proxyUrl) proxyUrl = String(found.proxyUrl || "").trim();
    }
  } catch {}
  if (!proxyUrl) proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7890";
  provider.proxyUrl = proxyUrl;

  if (payload.accountId) {
    return refreshAccountQuota(provider, String(payload.accountId), {
      forceRefreshToken: payload.forceRefreshToken === true
    });
  }
  return refreshPoolQuotas(provider, {
    accountIds: payload.accountIds || null,
    concurrency: payload.concurrency ?? 3
  });
});

ipcMain.handle("account-pool:patch", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  return patchAccounts(providerId, payload.accountIds || [], payload.patch || {}, {
    poolKind: resolvePoolKind(payload, providerId)
  });
});

ipcMain.handle("account-pool:delete", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  return deleteAccounts(providerId, payload.accountIds || [], {
    poolKind: resolvePoolKind(payload, providerId)
  });
});

ipcMain.handle("account-pool:set-strategy", (_e, payload = {}) => {
  const providerId = String(payload.providerId || "").trim();
  if (!providerId) throw new Error("providerId is required");
  const pool = loadPool(providerId, { poolKind: resolvePoolKind(payload, providerId) });
  if (payload.strategy) pool.strategy = payload.strategy;
  return savePool(pool);
});

ipcMain.handle("provider:presets", () => listProviderPresets());
ipcMain.handle("provider:test", async (_e, provider) => testProviderConnectivity(provider));
ipcMain.handle("provider-health:list", () => getProviderHealthMonitor().snapshot());
ipcMain.handle("provider-health:refresh", async (_e, payload = {}) => {
  const rows = await getProviderHealthMonitor().refresh(payload.providerId || "");
  return { ok: true, rows, snapshot: getProviderHealthMonitor().snapshot() };
});
// 单个供应商余额查询。
ipcMain.handle("provider:balance", async (_e, provider) => checkBalance(provider));
// 全量余额查询：对所有已配置供应商并发查询余额，返回 providerId -> UsageResult 映射。
ipcMain.handle("provider:balance-check-all", async () => {
  const providers = readConfig().providers || [];
  const entries = await Promise.all(
    providers.filter((p) => p?.id).map(async (provider) => [provider.id, await checkBalance(provider)])
  );
  return Object.fromEntries(entries);
});
ipcMain.handle("compat:packs", () => listCompatPacks());
ipcMain.handle("compat:active", () => activeCompatSnapshot(readConfig()));
ipcMain.handle("compat:registry:snapshot", () => registryRecommendationsForConfig(readConfig()));
ipcMain.handle("compat:registry:recommend", (_e, payload = {}) => recommendCompatRules(payload));
ipcMain.handle("provider:discover-models", async (_e, provider) => {
  const resolved = await resolveProbeProvider(provider);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const probe = resolved.provider;
  const baseUrl = String(probe.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("缺少 Base URL");
  const preset = providerPresetFor({ ...provider, ...probe, authMode: provider.authMode });
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

ipcMain.handle("profile:apply", async (_e, { clientId, mode, providerId, modelId } = {}) => {
  const status = statusFromServer();
  const profileMode = clientId === "codex" ? codexProfileMode(mode) : undefined;
  const skipGateway =
    profileMode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT ||
    profileMode === CODEX_ACCESS_MODES.PROVIDER_DIRECT;
  if (!status.running && !skipGateway) throw new Error("Gateway not running");
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
  if (profileMode === CODEX_ACCESS_MODES.PROVIDER_DIRECT) {
    const provider = (cfg.providers || []).find((item) => item.id === providerId);
    if (!provider) throw new Error(`provider not found: ${providerId || "(empty)"}`);
    const model = (cfg.models || []).find((item) => item.id === modelId)
      || (cfg.models || []).find((item) => item.providerId === provider.id && item.enabled !== false)
      || null;
    opts.provider = provider;
    opts.model = model;
    opts.apiKey = provider.apiKey || "";
  }
  const result = applyProfile(clientId, opts);
  if (clientId === "codex" && profileMode === CODEX_ACCESS_MODES.SWITCHYARD_PROXY) syncCodexArtifacts("profile-apply");
  appendLog({
    level: "info",
    msg: `profile applied: ${clientId}`,
    mode: profileMode || null,
    path: result.path,
    backup: result.backup || null,
    visibleModels: visibleModels.length,
    defaultModel: opts.defaultModel || null,
    providerId: result.providerId || providerId || null,
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
ipcMain.handle("profile:preview", (_e, { clientId, mode, providerId, modelId } = {}) => {
  const status = statusFromServer();
  const cfg = readConfig();
  const visibleModels = listModelsForClient(cfg, clientId);
  const profileMode = clientId === "codex" ? codexProfileMode(mode) : undefined;
  const opts = {
    host: status.running ? status.host : "127.0.0.1",
    port: status.running ? status.port : 17888,
    mode: profileMode,
    defaultModel: clientDefaultModel(cfg, clientId, visibleModels),
    models: ["codex", "claude-code"].includes(clientId) ? modelsForProfile(cfg, visibleModels) : visibleModels,
    modelMapping: clientId === "claude-code" ? cfg.clients?.["claude-code"]?.modelMapping : undefined
  };
  if (profileMode === CODEX_ACCESS_MODES.PROVIDER_DIRECT) {
    const provider = (cfg.providers || []).find((item) => item.id === providerId)
      || (cfg.providers || []).find((item) => String(item.id).includes("aigo-codex"))
      || null;
    const model = (cfg.models || []).find((item) => item.id === modelId)
      || (cfg.models || []).find((item) => item.providerId === provider?.id)
      || null;
    opts.provider = provider;
    opts.model = model;
    opts.apiKey = provider?.apiKey || "";
  }
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
  } else if (isAnthropicOAuthProvider(provider)) {
    const auth = readAnthropicOAuthAuth({ provider });
    keySource = auth.email ? `Claude OAuth · ${auth.email}` : "Claude OAuth";
    keyOk = Boolean(auth.ok && (auth.accessToken || auth.refreshToken));
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
    startUpdateChecker();
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
let cleanupStarted = false;
app.on("before-quit", (event) => {
  isQuitting = true;
  if (cleanedUp) return; // 清理已完成，放行本次退出
  if (cleanupStarted) return; // 清理已在进行中，等待完成即可
  cleanupStarted = true;
  event.preventDefault();
  (async () => {
    const timeout = setTimeout(() => {
      appendLog({ level: "warn", msg: "quit cleanup timed out, forcing exit" });
      cleanedUp = true;
      app.exit(0);
    }, 3000);
    try {
      stopCodexArtifactMonitor();
      await stopGateway();
    } catch (err) {
      appendLog({ level: "error", msg: "gateway stop on quit failed", error: err?.message || String(err) });
    } finally {
      clearTimeout(timeout);
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
      checkBalance: (provider) => checkBalance(provider),
      intervalMs: 5 * 60 * 1000
    });
  }
  return providerHealthMonitor;
}

async function resolveProbeProvider(provider) {
  const probe = { ...provider };
  if (!isAccountPoolProvider(probe)) return { ok: true, provider: probe };
  const picked = await pickAndRefreshAccount(probe);
  if (!picked.ok) {
    return { ok: false, error: picked.error || "账号池无可用账号，请先导入凭证" };
  }
  return {
    ok: true,
    provider: bindProviderToAccount(probe, picked.account),
    accountEmail: picked.account.email || picked.account.id
  };
}

async function testProviderConnectivity(provider) {
  const resolved = await resolveProbeProvider(provider);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const probe = resolved.provider;
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
  // 1. 模型列表探测
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
  // 2. /models 404 等 → 轻量 chat 探测兜底：发极小请求验证推理端点可用
  const chatUrl = `${baseUrl}/chat/completions`;
  try {
    const chatBody = JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false
    });
    const { resp, text } = await fetchTextOnce(chatUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: chatBody
    }, probe);
    const chatOk = resp.ok || (resp.status >= 400 && resp.status < 500);
    return {
      ok: chatOk,
      status: resp.status,
      url: chatUrl,
      bodyPreview: chatOk
        ? `推理端点可达 (${resp.status}${resp.ok ? "" : " · 模型或凭证需确认"})`
        : text.slice(0, 800)
    };
  } catch (err) {
    return last || { ok: false, url: chatUrl, error: `${last?.error || "测试失败"}；chat 探测：${err?.message || String(err)}` };
  }
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
  const discovered = list.map((item) => {
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
  // 上游 /models 可能不列出部分可用模型（如 Composer、预设补充项）；把预设 hints 中未返回的补进结果
  return mergeDiscoveredWithPresetModels(discovered, hints);
}

/** 合并上游发现列表与预设 hints：已有的用上游，缺失的用预设补齐。 */
function mergeDiscoveredWithPresetModels(discovered, hints = new Map()) {
  const byId = new Map();
  for (const item of discovered || []) {
    if (item?.id) byId.set(item.id, item);
  }
  for (const [id, hint] of hints || []) {
    if (!id || byId.has(id)) continue;
    const normalized = normalizeHintModel(hint);
    if (!normalized.id) continue;
    byId.set(normalized.id, {
      ...normalized,
      fromPreset: true,
      raw: { ...(hint || {}), _switchyardPresetOnly: true }
    });
  }
  return Array.from(byId.values());
}

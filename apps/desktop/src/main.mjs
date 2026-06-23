// Electron main process for Switchyard.
import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { readConfig, saveValidated, configFile, readRaw } from "./config-store.mjs";
import { startGateway, stopGateway, restartGateway, reloadConfig, statusFromServer } from "./gateway-host.mjs";
import { appendLog, snapshotLogs, subscribeLogs, logFilePath } from "./logs.mjs";
import { importProviders } from "@switchyard/core/importers/ccswitch";
import {
  applyProfile, restoreProfile,
  profileTargets, listBackups,
  previewCodexProfile, previewClaudeCodeProfile, previewHermesProfile
} from "@switchyard/core/profile-writer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 960, minHeight: 600,
    title: "Switchyard",
    webPreferences: {
      preload: path.resolve(__dirname, "preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  win.loadFile(path.resolve(__dirname, "..", "renderer", "index.html"));
  win.webContents.on("console-message", (_e, level, message) => {
    appendLog({ level: level === 0 ? "info" : "warn", msg: `renderer: ${message}` });
  });
  return win;
}

ipcMain.handle("config:read", () => readConfig());
ipcMain.handle("config:save", (_e, payload) => { const r = saveValidated(payload); try { reloadConfig(); } catch {} return r; });
ipcMain.handle("config:file", () => configFile());
ipcMain.handle("config:raw", () => readRaw());
ipcMain.handle("gateway:status", () => statusFromServer());
ipcMain.handle("gateway:start", () => startGateway());
ipcMain.handle("gateway:stop", () => stopGateway());
ipcMain.handle("gateway:restart", () => restartGateway());
ipcMain.handle("gateway:reload", () => reloadConfig());
ipcMain.handle("logs:snapshot", () => snapshotLogs());
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
ipcMain.handle("dialog:info", async (_e, { title, message }) => {
  await dialog.showMessageBox({ type: "info", title: title || "Info", message: message || "" });
});
ipcMain.handle("import:ccswitch", () => {
  const result = importProviders();
  if (!result.ok) throw new Error(result.error || "import failed");
  return result;
});

ipcMain.handle("gateway:doctor", () => {
  const cfg = readConfig();
  const status = statusFromServer();
  const providers = cfg.providers.map((p) => {
    let keySource = "未配置";
    let keyOk = false;
    if (p.apiKey) { keySource = "inline"; keyOk = true; }
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

ipcMain.handle("profile:apply", async (_e, { clientId }) => {
  const status = statusFromServer();
  if (!status.running) throw new Error("Gateway not running");
  const opts = { host: status.host, port: status.port };
  const result = applyProfile(clientId, opts);
  appendLog({ level: "info", msg: `profile applied: ${clientId}`, path: result.path, backup: result.backup || null });
  return result;
});
ipcMain.handle("profile:restore", (_e, { clientId }) => {
  const result = restoreProfile(clientId);
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
  const backups = listBackups(file);
  return { exists, current: current ? current.slice(0, 600) : null, backups: backups.length };
});
ipcMain.handle("profile:preview", (_e, { clientId }) => {
  const status = statusFromServer();
  const opts = { host: status.running ? status.host : "127.0.0.1", port: status.running ? status.port : 17888 };
  if (clientId === "codex") return { text: previewCodexProfile(opts), path: profileTargets().codex };
  if (clientId === "claude-code") return { text: previewClaudeCodeProfile(opts), path: profileTargets()["claude-code"] };
  if (clientId === "hermes") return { text: previewHermesProfile(opts), path: profileTargets().hermes };
  throw new Error(`Unknown client: ${clientId}`);
});
ipcMain.handle("test:chat", async (_e, { model, messages, stream }) => {
  const status = statusFromServer();
  if (!status.running) throw new Error("Gateway not running");
  const url = `http://${status.host}:${status.port}/v1/chat/completions`;
  const body = { model, messages, stream: !!stream };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (body.stream) {
      const text = await resp.text();
      return { ok: resp.ok, status: resp.status, streamChunks: text.split("\n").filter((l) => l.startsWith("data: ")).length };
    }
    return { ok: resp.ok, status: resp.status, body: await resp.json() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});

app.whenReady().then(async () => {
  const win = createMainWindow();
  subscribeLogs((entry) => {
    if (!win.isDestroyed()) win.webContents.send("gateway:log", entry);
  });
  for (const e of snapshotLogs()) {
    if (!win.isDestroyed()) win.webContents.send("gateway:log", e);
  }
  try {
    await startGateway();
  } catch (err) {
    appendLog({ level: "error", msg: "gateway autostart failed", error: err?.message || String(err) });
  }
});

app.on("window-all-closed", async () => {
  await stopGateway();
  app.quit();
});

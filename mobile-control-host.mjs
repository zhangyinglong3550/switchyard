import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { readConfig } from "./config-store.mjs";
import { createMobileControlStore } from "./mobile-control/store.mjs";
import { createEventLedger } from "./mobile-control/event-ledger.mjs";
import { createCodexRuntime } from "./mobile-control/codex-runtime.mjs";
import { createClaudeRuntime } from "./mobile-control/claude-runtime.mjs";
import { createGrokRuntime } from "./mobile-control/grok-runtime.mjs";
import { createOpenCodeRuntime } from "./mobile-control/opencode-runtime.mjs";
import {
  createSessionRegistry,
  encodeMobileSessionId
} from "./mobile-control/session-registry.mjs";
import { createMobileControlServer } from "./mobile-control/server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17889;

let instance = null;
let startPromise = null;

function mobileRoot() {
  return path.join(os.homedir(), ".switchyard", "mobile-control");
}

function mobilePublicDir() {
  return path.resolve(__dirname, "..", "..", "mobile");
}

function overlayFor(store, agentId) {
  const patch = (nativeId, value) => store.patchOverlay(
    encodeMobileSessionId(agentId, nativeId),
    value
  );
  return {
    rename: (nativeId, title) => patch(nativeId, { title }),
    archive: (nativeId) => patch(nativeId, { archived: true }),
    unarchive: (nativeId) => patch(nativeId, { archived: false })
  };
}

function createRuntimeSet(store) {
  const codexClient = new CodexAppServerClient();
  const runtimes = [
    createCodexRuntime({ client: codexClient }),
    createClaudeRuntime({ overlay: overlayFor(store, "claude-code") }),
    createGrokRuntime({ overlay: overlayFor(store, "grok") }),
    createOpenCodeRuntime({ overlay: overlayFor(store, "opencode") })
  ];
  return { codexClient, runtimes };
}

export async function startMobileControl({
  host = DEFAULT_HOST,
  port = Number(process.env.SWITCHYARD_MOBILE_CONTROL_PORT) || DEFAULT_PORT
} = {}) {
  if (instance?.server) return mobileControlStatus();
  if (startPromise) return startPromise;
  startPromise = (async () => {
    if (host !== DEFAULT_HOST) {
      throw new Error("移动控制服务仅允许监听 127.0.0.1");
    }
    const root = mobileRoot();
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const store = createMobileControlStore({ root });
    const ledger = createEventLedger({ file: path.join(root, "events.jsonl") });
    const { codexClient, runtimes } = createRuntimeSet(store);
    try {
      await codexClient.connect();
    } catch {
      // Codex 不可用时仍允许移动控制服务启动；registry 会在访问时报告该 runtime 的错误。
    }
    const registry = createSessionRegistry({
      runtimes,
      store,
      ledger,
      readConfig
    });
    const server = createMobileControlServer({
      host,
      port,
      store,
      registry,
      publicDir: mobilePublicDir()
    });
    try {
      await server.start();
    } catch (error) {
      codexClient.close();
      for (const runtime of runtimes) runtime.close?.();
      throw error;
    }
    instance = { root, store, ledger, registry, server, codexClient, runtimes };
    return mobileControlStatus();
  })();
  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function stopMobileControl() {
  if (startPromise) {
    try { await startPromise; } catch {}
  }
  const current = instance;
  instance = null;
  if (!current) return mobileControlStatus();
  await current.server.stop();
  current.codexClient.close();
  for (const runtime of current.runtimes) runtime.close?.();
  return mobileControlStatus();
}

export function mobileControlStatus() {
  const status = instance?.server?.status?.() || {
    running: false,
    host: DEFAULT_HOST,
    port: null,
    url: null
  };
  return {
    ...status,
    configuredPort: Number(process.env.SWITCHYARD_MOBILE_CONTROL_PORT) || DEFAULT_PORT,
    root: mobileRoot()
  };
}

export function createMobilePairingChallenge(options = {}) {
  if (!instance?.store) throw new Error("请先启用移动控制");
  const challenge = instance.store.createChallenge(options);
  const status = mobileControlStatus();
  const pairingUrl = status.url
    ? `${status.url}/?challenge=${encodeURIComponent(challenge.secret)}`
    : null;
  return { ...challenge, pairingUrl };
}

export function listMobileDevices() {
  if (!instance?.store) return [];
  return instance.store.listDevices();
}

export function revokeMobileDevice(deviceId) {
  if (!instance?.store) throw new Error("移动控制未启用");
  return instance.store.revokeDevice(deviceId);
}

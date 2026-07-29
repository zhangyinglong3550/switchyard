import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { readConfig } from "./config-store.mjs";
import { subscribeLogs } from "./logs.mjs";
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
import { ensureTailscaleServe, inspectTailscaleServe } from "./mobile-control/tailscale-serve.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17889;

let instance = null;
let startPromise = null;
let tailscaleStatus = null;

function mobileRoot() {
  return path.join(os.homedir(), ".switchyard", "mobile-control");
}

function mobilePublicDir() {
  return path.resolve(__dirname, "..", "..", "mobile");
}

/**
 * launchd deliberately starts user agents with only the system PATH. Native
 * coding clients inherit that environment, so globally installed skills and
 * CLIs (for example lark-cli) would otherwise look unavailable on the phone.
 */
export function mobileRuntimeEnv(baseEnv = process.env, home = os.homedir()) {
  const extraPaths = [
    path.join(home, "npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin"
  ].filter((candidate) => fs.existsSync(candidate));
  const existing = String(baseEnv.PATH || "").split(path.delimiter).filter(Boolean);
  return {
    ...baseEnv,
    HOME: home,
    PATH: [...new Set([...extraPaths, ...existing])].join(path.delimiter)
  };
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

function executableOnPath(name, env = process.env) {
  for (const directory of String(env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

function installedExecutable(name, candidates = [], env = process.env) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || executableOnPath(name, env);
}

export function detectMobileAgents({ env = mobileRuntimeEnv(), home = os.homedir() } = {}) {
  return {
    codex: installedExecutable("codex", [
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(home, "npm-global", "bin", "codex")
    ], env),
    "claude-code": installedExecutable("claude", [path.join(home, "npm-global", "bin", "claude")], env),
    grok: installedExecutable("grok", [path.join(home, ".local", "bin", "grok")], env),
    opencode: installedExecutable("opencode", [path.join(home, "npm-global", "bin", "opencode")], env)
  };
}

function createRuntimeSet(store) {
  const env = mobileRuntimeEnv();
  const installed = detectMobileAgents({ env });
  const codexClient = new CodexAppServerClient({ env });
  const runtimes = [];
  if (installed.codex) runtimes.push(createCodexRuntime({
    client: codexClient,
    overlay: overlayFor(store, "codex"),
    command: installed.codex,
    env
  }));
  if (installed["claude-code"]) runtimes.push(createClaudeRuntime({
    overlay: overlayFor(store, "claude-code"),
    command: installed["claude-code"],
    env
  }));
  if (installed.grok) runtimes.push(createGrokRuntime({
    overlay: overlayFor(store, "grok"),
    command: installed.grok,
    env
  }));
  if (installed.opencode) runtimes.push(createOpenCodeRuntime({
    overlay: overlayFor(store, "opencode"),
    command: installed.opencode,
    env
  }));
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
    // Feed trusted gateway trace/final records into the same mobile event
    // ledger. A record is accepted only when the gateway provided a Codex
    // parent-thread correlation id; no heuristic prompt matching is used.
    const unsubscribeGatewayLogs = subscribeLogs((entry) => {
      if (entry?.traceLog || entry?.requestLog) registry.recordGatewayRequest?.(entry);
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
      unsubscribeGatewayLogs();
      codexClient.close();
      for (const runtime of runtimes) runtime.close?.();
      throw error;
    }
    instance = { root, store, ledger, registry, server, codexClient, runtimes, unsubscribeGatewayLogs };
    const inspectConnection = process.env.SWITCHYARD_TAILSCALE_AUTO_REPAIR === "0"
      ? inspectTailscaleServe
      : ensureTailscaleServe;
    tailscaleStatus = await inspectConnection({ port }).catch((error) => ({
      installed: false, online: false, serveConfigured: false, expectedUrl: null,
      repaired: false, error: error?.message || String(error)
    }));
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
  current.unsubscribeGatewayLogs?.();
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

export async function mobileControlConnectionStatus() {
  const port = mobileControlStatus().configuredPort;
  tailscaleStatus = await inspectTailscaleServe({ port });
  return tailscaleStatus;
}

export async function repairMobileControlConnection() {
  const port = mobileControlStatus().configuredPort;
  tailscaleStatus = await ensureTailscaleServe({ port });
  return tailscaleStatus;
}

export function createMobilePairingChallenge(options = {}) {
  if (!instance?.store) throw new Error("请先启用移动控制");
  const challenge = instance.store.createChallenge(options);
  const status = mobileControlStatus();
  return {
    ...challenge,
    pairingPath: `/?challenge=${encodeURIComponent(challenge.secret)}`,
    pairingUrl: status.url
      ? `${status.url}/?challenge=${encodeURIComponent(challenge.secret)}`
      : null
  };
}

export function listMobileDevices() {
  if (!instance?.store) return [];
  return instance.store.listDevices();
}

export function revokeMobileDevice(deviceId) {
  if (!instance?.store) throw new Error("移动控制未启用");
  return instance.store.revokeDevice(deviceId);
}

export function listUnmatchedMobileGatewayRequests() {
  return instance?.registry?.listUnmatchedGatewayRequests?.() || [];
}

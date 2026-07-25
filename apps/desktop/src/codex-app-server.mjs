import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCodexBinary() {
  if (process.env.SWITCHYARD_CODEX_BINARY) return process.env.SWITCHYARD_CODEX_BINARY;
  if (process.platform === "darwin") {
    for (const candidate of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex"
    ]) if (fs.existsSync(candidate)) return candidate;
    return "codex";
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    for (const candidate of [
      path.join(local, "Programs", "Codex", "resources", "codex.exe"),
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Codex", "resources", "codex.exe"),
      path.join(local, "Programs", "Codex", "Codex.exe")
    ]) if (fs.existsSync(candidate)) return candidate;
    return "codex.exe";
  }
  return "codex";
}

function resolveCodexDaemonSocket(home = os.homedir()) {
  if (process.platform === "win32") return null;
  const sock = path.join(home, ".codex", "ipc", "ipc.sock");
  try { return fs.existsSync(sock) ? sock : null; } catch { return null; }
}

export class CodexAppServerClient {
  constructor({ binary = resolveCodexBinary(), env, spawnProcess = spawn, resolveDaemonSocket = resolveCodexDaemonSocket } = {}) {
    this.binary = binary;
    this.env = env;
    this.spawnProcess = spawnProcess;
    this.resolveDaemonSocket = resolveDaemonSocket;
    this.child = null;
    this.buffer = "";
    this.stderr = [];
    this.nextId = 1;
    this.pending = new Map();
    this.subscribers = new Set();
    this.usingProxy = false;
    this.connectPromise = null;
  }

  async connect({ force = false } = {}) {
    if (this.connectPromise) return this.connectPromise;
    if (force && this.child) this.disposeChild();
    if (this.child) return;
    this.connectPromise = this.connectOnce();
    try {
      await this.connectPromise;
    } catch (error) {
      const child = this.child;
      this.child = null;
      try { child?.kill(); } catch {}
      throw error;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectOnce() {
    // A socket file can survive while its Desktop daemon is no longer
    // accepting app-server proxy traffic. Try the shared daemon first so
    // Desktop threads remain available, but fall back to a private stdio
    // server when the proxy cannot complete initialization.
    const daemonSock = this.resolveDaemonSocket(os.homedir());
    if (daemonSock) {
      try {
        await this.startTransport(["app-server", "proxy", "--sock", daemonSock], true, 5_000);
        return;
      } catch {
        this.disposeChild();
      }
    }
    await this.startTransport(["app-server", "--stdio"], false, 30_000);
  }

  async startTransport(args, usingProxy, initializeTimeoutMs) {
    this.buffer = "";
    this.stderr = [];
    this.usingProxy = usingProxy;
    const child = this.spawnProcess(this.binary, args, {
      env: { ...process.env, HOME: os.homedir(), ...(this.env || {}) }
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) this.stderr.push(line.trim());
      this.stderr = this.stderr.slice(-8);
    });
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.rejectAll(new Error(`无法启动 Codex app-server：${error.message}`));
      this.child = null;
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      if (this.pending.size) this.rejectAll(new Error(`Codex app-server 已退出（${code}）${this.stderr.length ? `：${this.stderr.join(" | ")}` : ""}`));
      this.child = null;
    });
    await this.call("initialize", {
      clientInfo: { name: "switchyard", title: "Switchyard", version: "2.2.20" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    }, initializeTimeoutMs);
    this.notify("initialized");
  }

  disposeChild() {
    const child = this.child;
    this.child = null;
    this.rejectAll(new Error("Codex app-server 连接不可用"));
    try { child?.kill(); } catch {}
    this.buffer = "";
    this.stderr = [];
    this.usingProxy = false;
  }

  onStdout(chunk) {
    this.buffer += String(chunk);
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.method) {
        this.emitFrame({
          kind: message.id === undefined ? "notification" : "request",
          id: message.id,
          method: message.method,
          params: message.params || {}
        });
        continue;
      }
      const pending = this.pending.get(Number(message.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  call(method, params = {}, timeoutMs = 30000) {
    if (!this.child) return Promise.reject(new Error("Codex app-server 尚未连接"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs = 30000) {
    // The mobile service is allowed to start while Codex Desktop is still
    // booting. Reconnect lazily on the first operation, and again after an
    // app-server/proxy child exits, instead of surfacing a permanent
    // "尚未连接" error until the whole mobile service is restarted.
    await this.connect();
    return this.call(method, params, timeoutMs);
  }

  async reconnect() {
    await this.connect({ force: true });
  }

  notify(method, params) {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  respond(id, result, error) {
    if (!this.child || id === undefined || id === null) return;
    const message = error
      ? { id, error: typeof error === "object" ? error : { message: String(error) } }
      : { id, result: result ?? {} };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  subscribe(handler) {
    if (typeof handler !== "function") throw new TypeError("subscriber 必须是函数");
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  emitFrame(frame) {
    for (const handler of this.subscribers) {
      try { handler(frame); } catch {}
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    if (!this.child) return;
    this.rejectAll(new Error("Codex app-server 已关闭"));
    this.child.kill();
    this.child = null;
    this.connectPromise = null;
    this.usingProxy = false;
  }
}

export async function withCodexAppServer(operation) {
  const client = new CodexAppServerClient();
  try {
    await client.connect();
    return await operation(client);
  } finally {
    client.close();
  }
}

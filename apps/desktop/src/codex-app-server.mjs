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

export class CodexAppServerClient {
  constructor({ binary = resolveCodexBinary(), spawnProcess = spawn } = {}) {
    this.binary = binary;
    this.spawnProcess = spawnProcess;
    this.child = null;
    this.buffer = "";
    this.stderr = [];
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.child) return;
    const child = this.spawnProcess(this.binary, ["app-server", "--stdio"], { env: { ...process.env, HOME: os.homedir() } });
    this.child = child;
    child.stdout.on("data", (chunk) => this.onStdout(chunk));
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split("\n").filter(Boolean)) this.stderr.push(line.trim());
      this.stderr = this.stderr.slice(-8);
    });
    child.on("error", (error) => {
      this.rejectAll(new Error(`无法启动 Codex app-server：${error.message}`));
      this.child = null;
    });
    child.on("close", (code) => {
      if (this.pending.size) this.rejectAll(new Error(`Codex app-server 已退出（${code}）${this.stderr.length ? `：${this.stderr.join(" | ")}` : ""}`));
      this.child = null;
    });
    await this.call("initialize", {
      clientInfo: { name: "switchyard", title: "Switchyard", version: "2.2.20" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    });
    this.notify("initialized");
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

  notify(method, params) {
    if (!this.child) return;
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
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

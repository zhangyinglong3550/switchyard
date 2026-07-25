import os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_INITIALIZE = Object.freeze({
  protocolVersion: 1,
  clientCapabilities: {},
  clientInfo: {
    name: "switchyard",
    title: "Switchyard",
    version: "2.2.20"
  }
});

export function createAcpClient({
  command,
  args = [],
  cwd,
  env,
  spawnProcess = spawn,
  initializeParams = DEFAULT_INITIALIZE
} = {}) {
  if (!command) throw new Error("ACP command 不能为空");
  let child = null;
  let buffer = "";
  let nextId = 1;
  let initializeResult = null;
  let connectPromise = null;
  const pending = new Map();
  const subscribers = new Set();
  const stderr = [];

  const emit = (frame) => {
    for (const subscriber of subscribers) {
      try { subscriber(frame); } catch {}
    }
  };

  const rejectAll = (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  };

  const onMessage = (message) => {
    if (message?.method) {
      emit({
        kind: message.id === undefined ? "notification" : "request",
        id: message.id,
        method: message.method,
        params: message.params || {}
      });
      return;
    }
    const item = pending.get(Number(message?.id));
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(Number(message.id));
    if (message.error) {
      const error = new Error(message.error.message || JSON.stringify(message.error));
      error.code = message.error.code;
      error.data = message.error.data;
      item.reject(error);
    } else {
      item.resolve(message.result);
    }
  };

  const onStdout = (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { onMessage(JSON.parse(line)); } catch {}
    }
  };

  const write = (message) => {
    if (!child) throw new Error("ACP agent 尚未连接");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const request = (method, params = {}, timeoutMs = 60_000) => {
    if (!child) return Promise.reject(new Error("ACP agent 尚未连接"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP 请求超时：${method}`));
      }, timeoutMs);
      pending.set(id, { method, resolve, reject, timer });
      try { write({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };

  const connect = async () => {
    if (initializeResult) return initializeResult;
    if (connectPromise) return connectPromise;
    connectPromise = (async () => {
      const processHandle = spawnProcess(command, args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, HOME: os.homedir(), ...(env || {}) },
        stdio: ["pipe", "pipe", "pipe"]
      });
      child = processHandle;
      processHandle.stdout.on("data", onStdout);
      processHandle.stderr.on("data", (chunk) => {
        stderr.push(...String(chunk).split(/\r?\n/).filter(Boolean).map((line) => line.trim()));
        if (stderr.length > 20) stderr.splice(0, stderr.length - 20);
      });
      processHandle.on("error", (error) => {
        rejectAll(new Error(`无法启动 ACP agent：${error.message}`));
        child = null;
        connectPromise = null;
      });
      processHandle.on("close", (code) => {
        const detail = stderr.length ? `：${stderr.slice(-5).join(" | ")}` : "";
        rejectAll(new Error(`ACP agent 已退出（${code}）${detail}`));
        child = null;
        initializeResult = null;
        connectPromise = null;
        emit({ kind: "lifecycle", method: "process/closed", params: { code } });
      });
      initializeResult = await request("initialize", initializeParams, 30_000);
      return initializeResult;
    })();
    return connectPromise;
  };

  return {
    get initializeResult() {
      return initializeResult;
    },
    connect,
    request,
    notify(method, params = {}) {
      write({ method, params });
    },
    respond(id, result, error) {
      if (id === undefined || id === null) return;
      if (error) {
        write({
          id,
          error: typeof error === "object"
            ? error
            : { code: -32000, message: String(error) }
        });
      } else {
        write({ id, result: result ?? {} });
      }
    },
    subscribe(handler) {
      if (typeof handler !== "function") throw new TypeError("subscriber 必须是函数");
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    close() {
      if (!child) return;
      rejectAll(new Error("ACP agent 已关闭"));
      child.kill();
      child = null;
      initializeResult = null;
      connectPromise = null;
    }
  };
}

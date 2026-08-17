import { spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WebSocket } from "undici";

/**
 * DeepSeek Harness (DSH) host client.
 *
 * DSH Desktop 与 `dsh web` 都在本地暴露同一套 HTTP API：
 *   POST /api/<namespace.method>  { type:"client-request", rpcId, method, payload:{args} }
 *   GET  /api/events.mux          SSE，推送 { type:"server-request", rpcId, method, payload }
 *   POST /api/respond             { type:"client-response", rpcId, result }
 *
 * 连接策略：优先附着正在运行的 DSH Desktop（同一服务器意味着手机与桌面实时同步），
 * 找不到时用 `dsh web` 自托管固定端口。两者共享 ~/.dsh 会话存储，桌面端重新打开
 * 会话即可看到手机侧的续聊内容。
 */

// 17888=OpenAI 兼容网关 / 17889=mobile-control / 17890=会话核心网关。自托管
// DSH host 用 17891 避免与上述端口冲突。
const HOSTED_PORT = Number(process.env.SWITCHYARD_DSH_PORT) || 17891;
const HOSTED_READY_TIMEOUT_MS = 45_000;
const RPC_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 20_000;

function rpcId() {
  return randomUUID();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || RPC_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`DSH host HTTP ${response.status}：${url}`);
  return response.json().catch(() => ({}));
}

/** 探测某个端口是否是 DSH host（boot 页包含 __DSH_BOOT__ 标记）。 */
export async function probeDshHost(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_200) });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes("__DSH_BOOT__");
  } catch {
    return false;
  }
}

/**
 * 用 lsof 找正在监听本机端口的 DSH 进程（DSH Desktop / dsh web）。
 * 返回端口号；找不到返回 null。lsof 不可用时快速失败。
 */
export async function discoverDshHostPort({ runCommand } = {}) {
  const run = runCommand || ((args) => new Promise((resolve) => {
    const child = spawnChild("lsof", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  }));
  const output = await run(["-nP", "-iTCP", "-sTCP:LISTEN"]);
  const seen = new Set();
  for (const line of String(output || "").split(/\r?\n/)) {
    // lsof 的 COMMAND 列会把空格转义（“DSH\x20De”），因此按首列前缀判断。
    const commandName = String(line).split(/\s+/)[0] || "";
    if (commandName !== "dsh" && !commandName.startsWith("DSH")) continue;
    const match = line.match(/(?:127\.0\.0\.1|localhost|\[?::1\]?|\*):(\d{2,5})\s*\(LISTEN\)/i);
    if (!match) continue;
    const port = Number(match[1]);
    if (!port || seen.has(port)) continue;
    seen.add(port);
    if (await probeDshHost(port)) return port;
  }
  return null;
}

function spawnHostedServer(command, env, log) {
  const child = spawnChild(command, ["web", "--host", "127.0.0.1", "--port", String(HOSTED_PORT)], {
    env: { ...process.env, HOME: process.env.HOME, ...(env || {}) },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${String(chunk)}`.slice(-2000);
    log?.(`[dsh-host] ${String(chunk).trim()}`);
  });
  child.on("exit", (code) => log?.(`[dsh-host] 自托管 dsh web 退出（code ${code}）`));
  return { child, stderr: () => stderrTail };
}

export function createDshHostClient({
  command,
  env,
  spawnProcess = spawnChild,
  log = () => {}
} = {}) {
  let mode = null; // "attach" | "hosted"
  let port = null;
  let hosted = null;
  let connecting = null;
  let closed = false;
  const subscribers = new Set();
  let reconnectDelay = RECONNECT_BASE_MS;

  const baseUrl = () => `http://127.0.0.1:${port}`;

  const emit = (envelope) => {
    for (const handler of subscribers) {
      try { handler(envelope); } catch (error) { log?.(`[dsh-host] 事件回调失败：${error?.message || error}`); }
    }
  };

  const stopEventStream = () => {};

  // DSH web server 的 /api/events.mux 只接受 WebSocket 升级（HTTP GET 会得到
  // 426）；浏览器端同样直接 new WebSocket(url)，不带订阅负载。
  const runEventStream = async () => {
    while (!closed) {
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        let socket;
        try {
          socket = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`);
        } catch (error) {
          log?.(`[dsh-host] 事件流创建失败：${error?.message || error}`);
          return finish();
        }
        // events.mux 是纯下行通道：任何上行帧都会被服务端以 1008 "downlink
        // only" 拒绝。不要发送应用层心跳，靠 TCP 与服务端事件保持连接。
        socket.addEventListener("open", () => {
          log?.(`[dsh-host] 事件流已连接（${mode}@${port}）`);
          reconnectDelay = RECONNECT_BASE_MS;
        });
        socket.addEventListener("message", (event) => {
          try {
            const text = typeof event.data === "string" ? event.data : "";
            if (!text.trim()) return;
            emit(JSON.parse(text));
          } catch {}
        });
        socket.addEventListener("close", (event) => {
          log?.(`[dsh-host] 事件流关闭 code=${event.code} reason=${String(event.reason || "").slice(0, 160)}`);
          finish();
        });
        socket.addEventListener("error", (event) => {
          log?.(`[dsh-host] 事件流错误：${event?.error?.message || event?.type || "unknown"}`);
          try { socket.close(); } catch {}
          finish();
        });
      });
      if (closed) return;
      // 连接丢失：先尝试重新发现（桌面端可能换了端口重启），再退回自托管。
      await delay(reconnectDelay);
      reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
      try { await ensureConnected({ forceRediscover: true }); } catch {}
      if (!port) continue;
    }
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForHostedReady = async () => {
    const deadline = Date.now() + HOSTED_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (hosted?.child.exitCode !== null) throw new Error(`自托管 dsh web 启动失败：${hosted?.stderr().slice(-400) || "进程已退出"}`);
      if (await probeDshHost(HOSTED_PORT)) return;
      await delay(400);
    }
    throw new Error("自托管 dsh web 启动超时");
  };

  const ensureConnected = async ({ forceRediscover = false } = {}) => {
    if (closed) throw new Error("DSH host client 已关闭");
    if (port && !forceRediscover) return { mode, port };
    if (connecting) return connecting;
    connecting = (async () => {
      if (forceRediscover && mode === "hosted" && hosted?.child.exitCode == null && await probeDshHost(port)) {
        return { mode, port };
      }
      const discovered = await discoverDshHostPort();
      if (discovered) {
        mode = "attach";
        port = discovered;
        log?.(`[dsh-host] 附着运行中的 DSH host（port ${port}）`);
        return { mode, port };
      }
      if (!command) throw new Error("未发现运行中的 DSH host，且 dsh CLI 不可用");
      // 固定托管端口可能已被之前残留的自托管实例占用：探测到即复用，避免 EADDRINUSE。
      if (await probeDshHost(HOSTED_PORT)) {
        mode = "attach";
        port = HOSTED_PORT;
        log?.(`[dsh-host] 复用已占用的自托管端口（port ${port}）`);
        return { mode, port };
      }
      if (mode === "hosted" && hosted?.child.exitCode == null) {
        if (await probeDshHost(port)) return { mode, port };
        hosted.child.kill("SIGTERM");
        hosted = null;
      }
      hosted = spawnHostedServer(command, env, log);
      mode = "hosted";
      port = HOSTED_PORT;
      await waitForHostedReady();
      log?.(`[dsh-host] 自托管 dsh web 就绪（port ${port}）`);
      return { mode, port };
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  };

  const rpc = async (method, args = {}) => {
    await ensureConnected();
    const body = {
      type: "client-request",
      rpcId: rpcId(),
      method,
      // apiproxy 对 payload 直接做请求 schema 解析（不剥 args 包裹）。
      payload: args
    };
    const response = await fetchJson(`${baseUrl()}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = response?.result;
    if (!result?.ok) {
      const error = result?.error;
      throw new Error(`DSH ${method} 失败：${error?.message || error?.code || "未知错误"}`);
    }
    return result.value;
  };

  /** 回复服务器下行的 server-request（审批 / 问询）。 */
  const respond = async (id, value) => {
    await ensureConnected();
    return fetchJson(`${baseUrl()}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-response",
        rpcId: String(id),
        result: { ok: true, value }
      })
    });
  };

  const subscribe = (handler) => {
    subscribers.add(handler);
    if (subscribers.size === 1) {
      void ensureConnected().then(() => { if (!closed) void runEventStream(); }).catch(() => {});
    }
    return () => {
      subscribers.delete(handler);
    };
  };

  return {
    ensureConnected,
    rpc,
    respond,
    subscribe,
    describe: () => ({ mode, port: mode ? port : null }),
    close() {
      closed = true;
      stopEventStream();
      hosted?.child.kill("SIGTERM");
      hosted = null;
      mode = null;
      port = null;
    }
  };
}

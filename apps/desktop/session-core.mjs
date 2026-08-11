#!/usr/bin/env node
// Session-Core 独立 daemon 入口。
// 职责：以独立进程（不依赖 Electron）运行 mobile-control 服务 + SQLite 镜像
//      + Native Mirror 增量导入，供 Android/iOS 原生 App 与桌面 Electron 共用。
//
// 用法：
//   node session-core.mjs start          # 前台启动
//   node session-core.mjs status         # 健康探测
//   node session-core.mjs stop           # 停止（需 pid 文件，launchd 场景用 launchctl 停）
//
// 环境变量：
//   SWITCHYARD_MOBILE_CONTROL_PORT 覆盖端口（默认 17889）
//   SESSION_CORE_MIRROR_DB         覆盖 SQLite 镜像路径（默认 ~/.switchyard/mobile-control/mirror.sqlite）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  startMobileControl,
  mobileControlStatus,
  stopMobileControl,
  mobileRuntimeEnv
} from "./src/mobile-control-host.mjs";
import { createSqliteMirror } from "./src/mobile-control/sqlite-store.mjs";
import { createNativeMirror } from "./src/mobile-control/native-mirror.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 17889;
const PID_FILE = path.join(os.homedir(), ".switchyard", "mobile-control", "session-core.pid");
const MIRROR_DB = process.env.SESSION_CORE_MIRROR_DB
  || path.join(os.homedir(), ".switchyard", "mobile-control", "mirror.sqlite");

async function probe(port = DEFAULT_PORT) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/mobile/v1/status`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function runStart() {
  const port = Number(process.env.SWITCHYARD_MOBILE_CONTROL_PORT) || DEFAULT_PORT;

  // 端口已被占用：若是本 daemon 在跑则直接复用；否则报错避免双实例。
  const existing = await probe(port);
  if (existing?.ok) {
    console.error(`[session-core] daemon 已在运行（port ${port}），直接复用。`);
    process.exit(0);
  }

  // 启动 mobile-control 服务（复用现有组装逻辑）。
  const status = await startMobileControl({ host: "127.0.0.1", port });
  console.error(`[session-core] mobile-control 已启动: ${JSON.stringify(status)}`);

  // 挂载 SQLite 镜像 + Native Mirror。
  const mirror = createSqliteMirror({ file: MIRROR_DB });
  const nativeMirror = createNativeMirror({ mirror, intervalMs: 30_000 });
  await nativeMirror.start();
  console.error(`[session-core] SQLite 镜像已挂载: ${MIRROR_DB}`);

  // 写 pid 文件（供 stop 命令使用）。
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {}

  const shutdown = async (signal) => {
    console.error(`[session-core] 收到 ${signal}，正在关闭…`);
    nativeMirror.stop();
    mirror.close();
    try { fs.unlinkSync(PID_FILE); } catch {}
    await stopMobileControl();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 保持进程存活（HTTP server 本身会 keep-alive，这里兜底）。
  setInterval(() => {}, 1 << 30);
}

async function runStatus() {
  const port = Number(process.env.SWITCHYARD_MOBILE_CONTROL_PORT) || DEFAULT_PORT;
  const existing = await probe(port);
  if (!existing) {
    console.error(JSON.stringify({ ok: false, running: false, port }));
    process.exit(1);
  }
  console.error(JSON.stringify({ ok: true, running: true, port, ...existing }));
  process.exit(0);
}

async function runStop() {
  const port = Number(process.env.SWITCHYARD_MOBILE_CONTROL_PORT) || DEFAULT_PORT;
  let pid = null;
  try { pid = Number(fs.readFileSync(PID_FILE, "utf8").trim()); } catch {}
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
    console.error(`[session-core] 已发送 SIGTERM 到 pid ${pid}`);
  } else {
    console.error(`[session-core] 未找到 pid 文件（${PID_FILE}）；请用 launchctl 停止。`);
  }
  process.exit(0);
}

const cmd = process.argv[2] || "start";
if (cmd === "start") {
  runStart().catch((error) => {
    console.error(`[session-core] 启动失败: ${error?.stack || error}`);
    process.exit(1);
  });
} else if (cmd === "status") {
  runStatus().catch(() => process.exit(1));
} else if (cmd === "stop") {
  runStop();
} else {
  console.error(`未知命令: ${cmd}（支持 start / status / stop）`);
  process.exit(1);
}

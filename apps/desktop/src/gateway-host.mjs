// Runs the gateway HTTP server inside the Electron main process.
// Exposes start/stop/restart and reload primitives that map 1:1 to UI buttons.
import { createServer } from "../../../packages/core/src/server.mjs";
import { configFile, readConfig } from "./config-store.mjs";
import { appendLog } from "./logs.mjs";
import { scheduleRequestLogCleanup } from "./request-log-store.mjs";

let current = null;

export async function startGateway() {
  if (current?.server) return statusFromServer();
  process.env.SWITCHYARD_CONFIG = process.env.SWITCHYARD_CONFIG || configFile();
  const config = readConfig();
  scheduleRequestLogCleanup();
  const host = config.host || "127.0.0.1";
  const port = Number(config.port || 17888);
  const server = createServer({ onLog: (entry) => appendLog(entry) });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  current = { server, host, port: typeof addr === "object" && addr ? addr.port : port, startedAt: Date.now() };
  appendLog({ level: "info", msg: "gateway started", host: current.host, port: current.port });
  return statusFromServer();
}

export async function stopGateway() {
  if (!current?.server) return { running: false };
  await new Promise((r) => current.server.close(r));
  appendLog({ level: "info", msg: "gateway stopped" });
  current = null;
  return { running: false };
}

export async function restartGateway() {
  await stopGateway();
  return startGateway();
}

export function reloadConfig() {
  if (!current?.server) throw new Error("Gateway is not running");
  const r = current.server.reloadConfig();
  appendLog({ level: "info", msg: "config reload via UI", ...r });
  return r;
}

export function statusFromServer() {
  if (!current?.server) return { running: false };
  return {
    running: true,
    host: current.host,
    port: current.port,
    startedAt: current.startedAt
  };
}

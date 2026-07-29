import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BINARY_CANDIDATES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
];

function binaryOnPath(name, env = process.env) {
  for (const directory of String(env.PATH || "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

export function resolveTailscaleBinary({ env = process.env } = {}) {
  return BINARY_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || binaryOnPath("tailscale", env);
}

async function runTailscale(binary, args) {
  return execFileAsync(binary, args, {
    encoding: "utf8",
    timeout: 8_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

function parseJson(text, fallback = {}) {
  try { return JSON.parse(String(text || "{}")); } catch { return fallback; }
}

function normalizedDnsName(value) {
  return String(value || "").trim().replace(/\.$/, "");
}

function serveState(serve, dnsName, port) {
  const web = serve?.Web || {};
  const host = `${dnsName}:${port}`;
  const tcpConfigured = Boolean(serve?.TCP?.[String(port)]);
  const handler = web?.[host]?.Handlers?.["/"];
  return {
    configured: serve?.TCP?.[String(port)]?.HTTPS === true
      && handler?.Proxy === `http://127.0.0.1:${port}`,
    conflict: tcpConfigured && handler?.Proxy !== `http://127.0.0.1:${port}`
  };
}

function baseStatus() {
  return {
    installed: false,
    online: false,
    dnsName: null,
    tailscaleIp: null,
    serveConfigured: false,
    expectedUrl: null,
    error: null
  };
}

export async function inspectTailscaleServe({
  port = 17889,
  resolveBinary = resolveTailscaleBinary,
  run = runTailscale
} = {}) {
  const binary = resolveBinary();
  if (!binary) return { ...baseStatus(), error: "未安装 Tailscale" };
  try {
    const statusResult = await run(binary, ["status", "--json"]);
    const status = parseJson(statusResult.stdout);
    const online = status?.BackendState === "Running";
    const dnsName = normalizedDnsName(status?.Self?.DNSName) || null;
    const tailscaleIp = status?.Self?.TailscaleIPs?.[0] || null;
    const expectedUrl = online && dnsName ? `https://${dnsName}:${port}` : null;
    if (!online) {
      return {
        ...baseStatus(), installed: true, online: false, dnsName, tailscaleIp,
        expectedUrl, error: "Tailscale 未连接"
      };
    }
    const serveResult = await run(binary, ["serve", "status", "--json"]);
    const serve = parseJson(serveResult.stdout);
    const state = dnsName ? serveState(serve, dnsName, port) : { configured: false, conflict: false };
    return {
      installed: true,
      online: true,
      dnsName,
      tailscaleIp,
      serveConfigured: state.configured,
      conflict: state.conflict,
      expectedUrl,
      error: null
    };
  } catch (error) {
    return {
      ...baseStatus(), installed: true,
      error: error?.stderr?.trim?.() || error?.message || String(error)
    };
  }
}

export async function ensureTailscaleServe(options = {}) {
  const port = Number(options.port) || 17889;
  const resolveBinary = options.resolveBinary || resolveTailscaleBinary;
  const run = options.run || runTailscale;
  const before = await inspectTailscaleServe({ port, resolveBinary, run });
  if (!before.installed || !before.online || !before.dnsName || before.serveConfigured || before.conflict) {
    return { ...before, repaired: false };
  }
  const binary = resolveBinary();
  try {
    await run(binary, ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
    const after = await inspectTailscaleServe({ port, resolveBinary, run });
    return { ...after, repaired: after.serveConfigured };
  } catch (error) {
    return {
      ...before,
      repaired: false,
      error: error?.stderr?.trim?.() || error?.message || String(error)
    };
  }
}

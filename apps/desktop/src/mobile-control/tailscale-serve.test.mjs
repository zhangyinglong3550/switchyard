import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectTailscaleServe,
  ensureTailscaleServe
} from "./tailscale-serve.mjs";

const ONLINE = JSON.stringify({
  BackendState: "Running",
  Self: {
    DNSName: "zhangyinglongmacbook-pro.tail2ec02b.ts.net.",
    TailscaleIPs: ["100.107.136.32"]
  }
});

function runner(responses, calls = []) {
  return async (binary, args) => {
    calls.push([binary, ...args]);
    const key = args.join(" ");
    const response = responses[key];
    if (response instanceof Error) throw response;
    return { stdout: response ?? "", stderr: "" };
  };
}

test("inspectTailscaleServe reports an online tailnet whose HTTPS proxy is missing", async () => {
  const status = await inspectTailscaleServe({
    port: 17889,
    resolveBinary: () => "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    run: runner({ "status --json": ONLINE, "serve status --json": "{}" })
  });
  assert.deepEqual(status, {
    installed: true,
    online: true,
    dnsName: "zhangyinglongmacbook-pro.tail2ec02b.ts.net",
    tailscaleIp: "100.107.136.32",
    serveConfigured: false,
    conflict: false,
    expectedUrl: "https://zhangyinglongmacbook-pro.tail2ec02b.ts.net:17889",
    error: null
  });
});

test("inspectTailscaleServe recognizes only the expected loopback proxy", async () => {
  const serve = JSON.stringify({
    TCP: { "17889": { HTTPS: true } },
    Web: {
      "zhangyinglongmacbook-pro.tail2ec02b.ts.net:17889": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:17889" } }
      }
    }
  });
  const status = await inspectTailscaleServe({
    port: 17889,
    resolveBinary: () => "/usr/local/bin/tailscale",
    run: runner({ "status --json": ONLINE, "serve status --json": serve })
  });
  assert.equal(status.serveConfigured, true);
});

test("ensureTailscaleServe safely restores a missing tailnet-only HTTPS proxy", async () => {
  const calls = [];
  let serveReads = 0;
  const run = async (binary, args) => {
    calls.push([binary, ...args]);
    if (args.join(" ") === "status --json") return { stdout: ONLINE, stderr: "" };
    if (args.join(" ") === "serve status --json") {
      serveReads += 1;
      return { stdout: serveReads === 1 ? "{}" : JSON.stringify({
        TCP: { "17889": { HTTPS: true } },
        Web: { "zhangyinglongmacbook-pro.tail2ec02b.ts.net:17889": { Handlers: { "/": { Proxy: "http://127.0.0.1:17889" } } } }
      }), stderr: "" };
    }
    if (args.join(" ") === "serve --bg --https=17889 http://127.0.0.1:17889") return { stdout: "", stderr: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const status = await ensureTailscaleServe({ port: 17889, resolveBinary: () => "/usr/local/bin/tailscale", run });
  assert.equal(status.serveConfigured, true);
  assert.equal(status.repaired, true);
  assert.ok(calls.some((call) => call.slice(1).join(" ") === "serve --bg --https=17889 http://127.0.0.1:17889"));
  assert.ok(calls.every((call) => !call.includes("--funnel")));
});

test("ensureTailscaleServe does not mutate serve when Tailscale is offline", async () => {
  const calls = [];
  const status = await ensureTailscaleServe({
    port: 17889,
    resolveBinary: () => "/usr/local/bin/tailscale",
    run: runner({ "status --json": JSON.stringify({ BackendState: "Stopped" }) }, calls)
  });
  assert.equal(status.online, false);
  assert.equal(status.repaired, false);
  assert.equal(calls.length, 1);
});

test("ensureTailscaleServe refuses to overwrite a conflicting Serve listener", async () => {
  const calls = [];
  const conflicting = JSON.stringify({
    TCP: { "17889": { HTTPS: true } },
    Web: {
      "zhangyinglongmacbook-pro.tail2ec02b.ts.net:17889": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } }
      }
    }
  });
  const status = await ensureTailscaleServe({
    port: 17889,
    resolveBinary: () => "/usr/local/bin/tailscale",
    run: runner({ "status --json": ONLINE, "serve status --json": conflicting }, calls)
  });
  assert.equal(status.conflict, true);
  assert.equal(status.repaired, false);
  assert.equal(calls.length, 2);
});

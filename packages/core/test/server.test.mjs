import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../src/server.mjs";

function writeTempConfig(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lls-srv-"));
  const p = path.join(tmp, "config.json");
  fs.writeFileSync(p, JSON.stringify(content, null, 2));
  process.env.SWITCHYARD_CONFIG = p;
  return { tmp, p };
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

test("server filters /v1/models by client prefix", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "pong" } }] }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [
      { id: "p/a", providerId: "p", upstreamModel: "a", aliases: ["alpha"] },
      { id: "p/b", providerId: "p", upstreamModel: "b" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["p/a"] },
      "claude-code": { enabled: true, allowedModels: ["p/b"] },
      hermes: { enabled: true, allowedModels: ["*"] },
      "generic-openai": { enabled: true, allowedModels: ["*"] }
    }
  });

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const codex = await fetchJson(`http://127.0.0.1:${port}/codex/v1/models`);
  assert.equal(codex.body.data.length, 1);
  assert.equal(codex.body.data[0].id, "p/a");

  const claude = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/models`);
  assert.equal(claude.body.data.length, 1);
  assert.equal(claude.body.data[0].id, "p/b");

  const all = await fetchJson(`http://127.0.0.1:${port}/hermes/v1/models`);
  assert.equal(all.body.data.length, 2);
});

test("server admin/reload reflects new config", async (t) => {
  const { tmp, p } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://127.0.0.1:1/v1" }],
    models: [{ id: "p/a", providerId: "p", upstreamModel: "a" }]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const before = await fetchJson(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(before.body.data.length, 1);

  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
  cfg.models.push({ id: "p/b", providerId: "p", upstreamModel: "b" });
  fs.writeFileSync(p, JSON.stringify(cfg));

  const reload = await fetchJson(`http://127.0.0.1:${port}/admin/reload`, { method: "POST" });
  assert.equal(reload.body.ok, true);
  assert.equal(reload.body.models, 2);

  const after = await fetchJson(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(after.body.data.length, 2);
});

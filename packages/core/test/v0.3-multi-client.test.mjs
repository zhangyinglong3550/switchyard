// V0.3 acceptance: one config simultaneously feeds Codex + Claude Code,
// and a freshly added model becomes visible to both clients after reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../src/server.mjs";

function writeTempConfig(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-v03-"));
  const p = path.join(tmp, "config.json");
  fs.writeFileSync(p, JSON.stringify(content, null, 2));
  process.env.SWITCHYARD_CONFIG = p;
  return { tmp, p };
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

test("v0.3 · one config feeds Codex + Claude Code simultaneously", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "pong" } }] }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { p: configPath } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [
      { id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }
    ],
    models: [
      { id: "p/m1", providerId: "p", upstreamModel: "m1" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["*"] },
      "claude-code": { enabled: true, allowedModels: ["*"] },
      hermes: { enabled: true, allowedModels: ["*"] },
      "generic-openai": { enabled: true, allowedModels: ["*"] }
    }
  });

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const codex = await fetchJson(`${base}/codex/v1/models`);
  const cc = await fetchJson(`${base}/claude-code/v1/models`);
  assert.equal(codex.status, 200);
  assert.equal(cc.status, 200);
  assert.deepEqual(codex.body.data.map((m) => m.id), ["p/m1"]);
  assert.deepEqual(cc.body.data.map((m) => m.id), ["p/m1"]);

  // Same model id, two clients, two protocols (openai chat + anthropic messages)
  const chatRes = await fetchJson(`${base}/codex/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "p/m1", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(chatRes.status, 200);
  assert.equal(chatRes.body.choices[0].message.content, "pong");

  const msgRes = await fetchJson(`${base}/claude-code/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "p/m1", max_tokens: 32, messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(msgRes.status, 200);
  // anthropic-shaped body
  assert.equal(msgRes.body.type, "message");
  assert.equal(msgRes.body.role, "assistant");
  assert.ok(Array.isArray(msgRes.body.content));

  // Add a new model, persist, reload — must appear in both clients
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  cfg.models.push({ id: "p/m2", providerId: "p", upstreamModel: "m2", aliases: ["claude-sonnet-alias"] });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const reload = await fetchJson(`${base}/admin/reload`, { method: "POST" });
  assert.equal(reload.status, 200);
  assert.equal(reload.body.models, 2);

  const codex2 = await fetchJson(`${base}/codex/v1/models`);
  const cc2 = await fetchJson(`${base}/claude-code/v1/models`);
  assert.ok(codex2.body.data.some((m) => m.id === "p/m2"));
  assert.ok(cc2.body.data.some((m) => m.id === "p/m2"));

  // alias visibility check (anthropic side requesting "claude-sonnet-alias" hits p/m2)
  const aliasRes = await fetchJson(`${base}/claude-code/v1/messages`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-alias", max_tokens: 16, messages: [{ role: "user", content: "x" }] })
  });
  assert.equal(aliasRes.status, 200);

  server.close();
  upstream.close();
});

test("v0.3 · per-client visibility filters do hide models", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: "pong" } }] }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [
      { id: "p/codex-only", providerId: "p", upstreamModel: "m1" },
      { id: "p/cc-only", providerId: "p", upstreamModel: "m2" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["p/codex-only"] },
      "claude-code": { enabled: true, allowedModels: ["p/cc-only"] },
      hermes: { enabled: false, allowedModels: ["*"] },
      "generic-openai": { enabled: true, allowedModels: ["*"] }
    }
  });

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const codex = await fetchJson(`${base}/codex/v1/models`);
  const cc = await fetchJson(`${base}/claude-code/v1/models`);
  const generic = await fetchJson(`${base}/v1/models`);
  assert.deepEqual(codex.body.data.map((m) => m.id), ["p/codex-only"]);
  assert.deepEqual(cc.body.data.map((m) => m.id), ["p/cc-only"]);
  assert.equal(generic.body.data.length, 2);

  // Cross-client misuse should be rejected at route time
  const bad = await fetchJson(`${base}/codex/v1/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "p/cc-only", messages: [{ role: "user", content: "x" }] })
  });
  assert.equal(bad.status, 400);

  server.close();
  upstream.close();
});

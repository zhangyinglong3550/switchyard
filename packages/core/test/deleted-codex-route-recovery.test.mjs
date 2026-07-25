import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-deleted-codex-home-"));
process.env.HOME = testHome;
const { createServer } = await import("../src/server.mjs");

function writeTempConfig(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-deleted-codex-config-"));
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(content, null, 2));
  process.env.SWITCHYARD_CONFIG = configPath;
  return tmp;
}

function writeManagedCodexProfile(model) {
  const configPath = path.join(testHome, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, [
    "# managed-by: managed-by-switchyard",
    'model_provider = "custom"',
    `model = "${model}"`,
    "",
    "[model_providers.custom]",
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    'wire_api = "responses"',
    ""
  ].join("\n"));
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("recovers a deleted Codex task provider id using the current managed model", async (t) => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      assert.equal(req.url, "/responses");
      upstreamBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_recovered",
        object: "response",
        status: "completed",
        model: upstreamBody.model,
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;

  const configDir = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{
      id: "replacement",
      apiFormat: "openai_responses",
      baseUrl: `http://127.0.0.1:${upstreamPort}`
    }],
    models: [{
      id: "replacement/gpt-5.6-terra",
      providerId: "replacement",
      upstreamModel: "gpt-5.6-terra"
    }],
    clients: { codex: { enabled: true, allowedModels: ["*"] } }
  });
  writeManagedCodexProfile("replacement/gpt-5.6-terra");

  const logs = [];
  const server = createServer({ onLog: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const result = await postJson(`http://127.0.0.1:${port}/codex/v1/responses`, {
    model: "removed-aigo/gpt-5.6-sol",
    input: "ping"
  });

  assert.equal(result.status, 200);
  assert.equal(upstreamBody.model, "gpt-5.6-terra");
  assert.equal(result.body.model, "gpt-5.6-terra");
  assert.ok(logs.some((entry) =>
    entry.msg === "recovered deleted Codex task model route" &&
    entry.requestedModel === "removed-aigo/gpt-5.6-sol" &&
    entry.fallbackModel === "replacement/gpt-5.6-terra"
  ));
  assert.ok(logs.some((entry) =>
    entry.msg === "request" &&
    entry.routeRecovery === "deleted-codex-provider" &&
    entry.requestedModel === "removed-aigo/gpt-5.6-sol" &&
    entry.modelId === "replacement/gpt-5.6-terra"
  ));
});

test("does not recover unknown short names or missing models from a live provider", async (t) => {
  const configDir = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "replacement", apiFormat: "openai_responses", baseUrl: "http://127.0.0.1:1" }],
    models: [{ id: "replacement/gpt-5.6-terra", providerId: "replacement", upstreamModel: "gpt-5.6-terra" }],
    clients: { codex: { enabled: true, allowedModels: ["*"] } }
  });
  writeManagedCodexProfile("replacement/gpt-5.6-terra");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  const unknownShortName = await postJson(`http://127.0.0.1:${port}/codex/v1/responses`, {
    model: "gpt-5.6-sol",
    input: "ping"
  });
  assert.equal(unknownShortName.status, 400);
  assert.equal(unknownShortName.body.error, "No route for model gpt-5.6-sol");

  const missingLiveProviderModel = await postJson(`http://127.0.0.1:${port}/codex/v1/responses`, {
    model: "replacement/gpt-5.6-sol",
    input: "ping"
  });
  assert.equal(missingLiveProviderModel.status, 400);
  assert.equal(missingLiveProviderModel.body.error, "No route for model replacement/gpt-5.6-sol");
});

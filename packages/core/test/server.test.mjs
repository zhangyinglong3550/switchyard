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
  try { return { status: res.status, headers: res.headers, body: JSON.parse(text) }; }
  catch { return { status: res.status, headers: res.headers, body: text }; }
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
  assert.equal(codex.body.models.length, 1);
  assert.equal(codex.body.models[0].slug, "p/a");
  const codexTrailingSlash = await fetchJson(`http://127.0.0.1:${port}/codex/v1/models/`);
  assert.equal(codexTrailingSlash.status, 200);
  assert.equal(codexTrailingSlash.body.models[0].slug, "p/a");

  const claude = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/models`);
  assert.deepEqual(Object.keys(claude.body).sort(), ["data", "first_id", "has_more", "last_id"]);
  assert.equal(claude.body.data.length, 1);
  assert.match(claude.body.data[0].id, /^claude-switchyard-p-b-/);
  assert.deepEqual({ ...claude.body.data[0], id: "<synthetic>" }, {
    type: "model",
    id: "<synthetic>",
    display_name: "b · p",
    created_at: "1970-01-01T00:00:00Z"
  });
  assert.equal(claude.body.has_more, false);
  assert.match(claude.body.first_id, /^claude-switchyard-p-b-/);
  assert.equal(claude.body.last_id, claude.body.first_id);
  const claudeDoubleV1 = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/v1/models`);
  assert.equal(claudeDoubleV1.status, 200);
  assert.equal(claudeDoubleV1.body.data.length, 1);
  assert.equal(claudeDoubleV1.body.data[0].id, claude.body.data[0].id);

  const routedViaClaudeDiscoveryId = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "test" },
    body: JSON.stringify({
      model: claude.body.data[0].id,
      max_tokens: 32,
      messages: [{ role: "user", content: "ping" }]
    })
  });
  assert.equal(routedViaClaudeDiscoveryId.status, 200);
  const routedViaDoubleV1 = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "test" },
    body: JSON.stringify({
      model: claude.body.data[0].id,
      max_tokens: 32,
      messages: [{ role: "user", content: "ping" }]
    })
  });
  assert.equal(routedViaDoubleV1.status, 200);

  const all = await fetchJson(`http://127.0.0.1:${port}/hermes/v1/models`);
  assert.equal(all.body.data.length, 2);
});

test("server returns ok for client prefix health checks", async (t) => {
  const { tmp } = writeTempConfig({
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

  const head = await fetch(`http://127.0.0.1:${port}/claude-code`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const get = await fetch(`http://127.0.0.1:${port}/claude-code`);
  assert.equal(get.status, 200);
  assert.equal((await get.json()).client, "claude-code");
});

test("server emits structured request and response summaries", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "x",
        choices: [{
          message: {
            role: "assistant",
            content: "pong",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }]
          },
          finish_reason: "tool_calls"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const logs = [];
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "p/a", providerId: "p", upstreamModel: "a" }]
  });
  const server = createServer({ onLog: (entry) => logs.push(entry) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "p/a",
      messages: [
        { role: "system", content: "System part. Available skills:\n- ppt-master skill: create slides" },
        { role: "user", content: "hello" }
      ],
      tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }]
    })
  });
  assert.equal(resp.status, 200);
  const record = logs.find((entry) => entry.requestLog);
  assert.equal(record.requestSummary.messages.system[0].text.includes("System part"), true);
  assert.equal(record.requestSummary.tools[0].name, "read_file");
  assert.equal(record.requestSummary.messages.user[0].text, "hello");
  assert.equal(record.responseSummary.text, "pong");
  assert.equal(record.responseSummary.toolCalls[0].name, "read_file");
  assert.equal(record.responseSummary.usage.totalTokens, 13);
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

test("server streams Anthropic response when selected upstream is openai_responses", async (t) => {
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/responses");
      const body = JSON.parse(buf);
      assert.equal(body.model, "glm-5.2");
      assert.equal(body.stream, false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_1",
        object: "response",
        created_at: 0,
        status: "completed",
        model: "glm-5.2",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hello from responses" }] }],
        usage: { input_tokens: 1, output_tokens: 3 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "responses", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "glm-5.2", providerId: "responses", upstreamModel: "glm-5.2" }]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy" },
    body: JSON.stringify({ model: "glm-5.2", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /event: message_start/);
  assert.match(text, /hello from responses/);
});

test("server returns partial Anthropic stream when Codex Responses stream disconnects after text", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write([
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}",
        ""
      ].join("\n"));
      setTimeout(() => res.destroy(new Error("synthetic codex disconnect")), 20);
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" }]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy" },
    body: JSON.stringify({ model: "codex/gpt-5.5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /event: message_start/);
  assert.match(text, /partial/);
  assert.match(text, /event: message_stop/);
});

test("server emits Anthropic SSE error when Codex Responses stream disconnects before text", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      setTimeout(() => res.destroy(new Error("synthetic empty disconnect")), 20);
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" }]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy" },
    body: JSON.stringify({ model: "codex/gpt-5.5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /event: error/);
  assert.match(text, /api_error/);
});

test("server preserves native Codex Responses body for openai_responses upstream", async (t) => {
  let received = null;
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => {
      received = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.end([
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}",
        "",
        "data: [DONE]",
        ""
      ].join("\n"));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "codex/gpt-5.5",
      stream: true,
      input: "ping",
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      service_tier: "priority"
    })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.equal(received.model, "gpt-5.5");
  assert.equal(received.input, "ping");
  assert.deepEqual(received.reasoning, { effort: "low" });
  assert.deepEqual(received.text, { verbosity: "low" });
  assert.equal(received.service_tier, "priority");
  assert.equal(received.store, false);
  assert.equal(received.stream, true);
  assert.doesNotMatch(JSON.stringify(received), /messages/);
  assert.match(text, /response.output_text.delta/);
});

test("server turns upstream response-body decode failures into SSE errors", async (t) => {
  let acceptEncoding = "";
  const upstream = http.createServer((req, res) => {
    acceptEncoding = String(req.headers["accept-encoding"] || "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Content-Encoding": "gzip"
      });
      res.end("not a gzip stream");
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "codex/gpt-5.5", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.equal(acceptEncoding, "identity");
  assert.match(text, /event: error/);
  assert.match(text, /upstream_stream_error/);
  assert.match(text, /data: \[DONE\]/);
});

test("server emits response.failed when native Responses stream disconnects", async (t) => {
  const logs = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write([
        "event: response.created",
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_up\",\"status\":\"in_progress\"}}",
        ""
      ].join("\n"));
      setTimeout(() => res.destroy(new Error("synthetic upstream disconnect")), 20);
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" }]
  });
  const server = createServer({ onLog: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "codex/gpt-5.5", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /event: response.failed/);
  assert.match(text, /upstream_stream_error/);
  assert.match(text, /data: \[DONE\]/);
  const requestLog = logs.find((entry) => entry.requestLog && entry.path === "/codex/v1/responses");
  assert.match(requestLog?.error || "", /terminated|disconnect|socket|fetch failed/i);
});

test("server routingMode=gateway forces Responses conversion even when protocols match", async (t) => {
  let received = null;
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (chunk) => (buf += chunk));
    req.on("end", () => {
      received = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.end([
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}",
        "",
        "data: [DONE]",
        ""
      ].join("\n"));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "responses", apiFormat: "openai_responses", routingMode: "gateway", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "responses/gpt", providerId: "responses", upstreamModel: "gpt-upstream" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "responses/gpt",
      stream: true,
      input: "ping",
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      service_tier: "priority"
    })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.equal(received.model, "gpt-upstream");
  assert.deepEqual(received.input, [{ type: "message", role: "user", content: "ping" }]);
  assert.equal(received.reasoning, undefined);
  assert.equal(received.text, undefined);
  assert.equal(received.service_tier, undefined);
});

test("server routingMode=native rejects mismatched client and provider protocols", async (t) => {
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "responses", apiFormat: "openai_responses", routingMode: "native", baseUrl: "http://127.0.0.1:1" }],
    models: [{ id: "responses/gpt", providerId: "responses", upstreamModel: "gpt-upstream" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy" },
    body: JSON.stringify({ model: "responses/gpt", max_tokens: 32, messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /routingMode=native requires anthropic_messages/);
});

test("server includes streamed chat text in final Responses completed payload", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.end([
        'data: {"choices":[{"delta":{"content":"HELLO","role":"assistant"},"index":0}],"object":"chat.completion.chunk"}',
        "",
        'data: {"choices":[{"delta":{"content":"","role":"assistant"},"finish_reason":"stop","index":0}],"object":"chat.completion.chunk"}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "p/glm", providerId: "p", upstreamModel: "glm-5.2" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "p/glm", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /response.output_text.delta/);
  const lines = text.split(/\r?\n/);
  const completedIndex = lines.findIndex((line) => line === "event: response.completed");
  assert.ok(completedIndex >= 0, text);
  const completed = JSON.parse(lines[completedIndex + 1].slice("data: ".length));
  assert.equal(completed.response.output[0].content[0].text, "HELLO");
});

test("server normalizes Responses developer role before streaming to chat upstream", async (t) => {
  let upstreamBody = null;
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      upstreamBody = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.end([
        'data: {"choices":[{"delta":{"content":"OK","role":"assistant"},"index":0}],"object":"chat.completion.chunk"}',
        "",
        "data: [DONE]",
        ""
      ].join("\n"));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "p/glm", providerId: "p", upstreamModel: "glm-5.2" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "p/glm",
      stream: true,
      input: [
        { type: "message", role: "developer", content: "Developer instructions" },
        { type: "message", role: "user", content: "ping" }
      ]
    })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.equal(upstreamBody.messages[0].role, "system");
  assert.deepEqual(upstreamBody.messages[0].content, [{ type: "text", text: "Developer instructions" }]);
  assert.equal(upstreamBody.messages[1].role, "user");
  assert.match(text, /"delta":"OK"/);
});

test("server returns streaming chat upstream errors instead of blank Responses SSE", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid role", type: "BadRequest" } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "p/glm", providerId: "p", upstreamModel: "glm-5.2" }]
  });
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "p/glm", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 400, text);
  assert.match(text, /invalid role/);
  assert.doesNotMatch(text, /response\.completed/);
});

test("server synthesizes Responses stream for Anthropic upstream", async (t) => {
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/v1/messages");
      const body = JSON.parse(buf);
      assert.equal(body.model, "deepseek-v4-flash");
      assert.equal(body.stream, false);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "deepseek-v4-flash",
        content: [{ type: "text", text: "验证通过" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "anthropic_messages", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "p/deepseek", providerId: "p", upstreamModel: "deepseek-v4-flash" }]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const resp = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "p/deepseek",
      stream: true,
      input: [{ type: "message", role: "user", content: "hi" }]
    })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /event: response.output_text.delta/);
  assert.match(text, /验证通过/);
  assert.match(text, /"input_tokens":5/);
  assert.match(text, /"output_tokens":3/);
  assert.match(text, /event: response.completed/);
});

test("server emits sanitized structured request log events", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chat_1",
        choices: [{ message: { role: "assistant", content: "OK" } }],
        usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "p/a", providerId: "p", upstreamModel: "a" }]
  });
  const events = [];
  const server = createServer({ onLog: (event) => events.push(event) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const prompt = "structured prompt should be summarized";
  const result = await fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer secret-token" },
    body: JSON.stringify({ model: "p/a", messages: [{ role: "user", content: prompt }] })
  });
  assert.equal(result.status, 200);

  const requestEvent = events.find((event) => event.requestLog === true);
  assert.ok(requestEvent);
  assert.equal(requestEvent.clientId, null);
  assert.equal(requestEvent.providerId, "p");
  assert.equal(requestEvent.modelId, "p/a");
  assert.equal(requestEvent.upstreamModel, "a");
  assert.equal(requestEvent.status, 200);
  assert.equal(requestEvent.promptTokens, 11);
  assert.equal(requestEvent.completionTokens, 2);
  assert.equal(requestEvent.totalTokens, 13);
  assert.equal(requestEvent.requestSummary.messages.user[0].text, prompt);
  assert.equal(requestEvent.responseSummary.text, "OK");
  assert.equal(JSON.stringify(requestEvent).includes("secret-token"), false);
});

test("server summarizes raw OpenAI Responses bodies in structured request logs", async (t) => {
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/responses");
      const body = JSON.parse(buf);
      assert.equal(body.model, "gpt-raw");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "resp_raw",
        object: "response",
        status: "completed",
        model: "gpt-raw",
        output: [
          { type: "reasoning", summary: [{ type: "summary_text", text: "checked context before answering" }] },
          { type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: "{\"q\":\"switchyard\"}" },
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "raw responses answer" }] }
        ],
        usage: { input_tokens: 21, output_tokens: 5, total_tokens: 26 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "responses", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "responses/gpt-raw", providerId: "responses", upstreamModel: "gpt-raw" }]
  });
  const events = [];
  const server = createServer({ onLog: (event) => events.push(event) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = await fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "responses/gpt-raw", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(result.status, 200);

  const requestEvent = events.find((event) => event.requestLog === true);
  assert.ok(requestEvent);
  assert.equal(requestEvent.responseSummary.text, "raw responses answer");
  assert.equal(requestEvent.responseSummary.reasoning, "checked context before answering");
  assert.equal(requestEvent.responseSummary.toolCalls[0].name, "lookup");
  assert.equal(requestEvent.responseSummary.usage.totalTokens, 26);
});

test("server summarizes raw Anthropic Messages bodies in structured request logs", async (t) => {
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/v1/messages");
      const body = JSON.parse(buf);
      assert.equal(body.model, "claude-ish");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_raw",
        type: "message",
        role: "assistant",
        model: "claude-ish",
        content: [
          { type: "thinking", thinking: "selected a tool" },
          { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "README.md" } },
          { type: "text", text: "anthropic answer" }
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 9, output_tokens: 4 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "anth", apiFormat: "anthropic_messages", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "anth/claude-ish", providerId: "anth", upstreamModel: "claude-ish" }]
  });
  const events = [];
  const server = createServer({ onLog: (event) => events.push(event) });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = await fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "anth/claude-ish", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(result.status, 200);

  const requestEvent = events.find((event) => event.requestLog === true);
  assert.ok(requestEvent);
  assert.equal(requestEvent.responseSummary.text, "anthropic answer");
  assert.equal(requestEvent.responseSummary.reasoning, "selected a tool");
  assert.equal(requestEvent.responseSummary.toolCalls[0].name, "read_file");
  assert.equal(requestEvent.responseSummary.finishReason, "tool_use");
  assert.equal(requestEvent.responseSummary.usage.totalTokens, 13);
});

test("server applies configured vision fallback before text-only upstream", async (t) => {
  let textUpstreamBody = null;
  let visionCalls = 0;
  const textUpstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      textUpstreamBody = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
    });
  });
  const visionUpstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      visionCalls += 1;
      assert.equal(JSON.parse(buf).model, "vision-upstream");
      assert.match(buf, /data:image\/png;base64,AAAA/);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "图片里是一张仪表盘截图。" } }] }));
    });
  });
  await new Promise((r) => textUpstream.listen(0, "127.0.0.1", r));
  await new Promise((r) => visionUpstream.listen(0, "127.0.0.1", r));
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [
      { id: "text", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${textUpstream.address().port}/v1` },
      { id: "vision", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${visionUpstream.address().port}/v1` }
    ],
    models: [
      { id: "text/model", providerId: "text", upstreamModel: "text-upstream", capabilities: { text: true, images: false }, visionFallbackModelId: "vision/model" },
      { id: "vision/model", providerId: "vision", upstreamModel: "vision-upstream", capabilities: { text: true, images: true } }
    ]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => textUpstream.close(r));
    await new Promise((r) => visionUpstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = await fetchJson(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "text/model",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看图总结" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
        ]
      }]
    })
  });

  assert.equal(result.status, 200);
  assert.equal(JSON.parse(decodeURIComponent(result.headers.get("x-switchyard-vision"))).mode, "fallback");
  assert.equal(JSON.parse(decodeURIComponent(result.headers.get("x-switchyard-vision"))).fallbackOk, true);
  assert.equal(visionCalls, 1);
  assert.equal(JSON.stringify(textUpstreamBody).includes("image_url"), false);
  assert.match(JSON.stringify(textUpstreamBody), /图片里是一张仪表盘截图/);
});

test("server preserves Responses image input for vision fallback", async (t) => {
  let textUpstreamBody = null;
  let visionCalls = 0;
  const textUpstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      textUpstreamBody = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
    });
  });
  const visionUpstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      visionCalls += 1;
      assert.match(buf, /data:image\/png;base64,BBBB/);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "图片里有一张表格。" } }] }));
    });
  });
  await new Promise((r) => textUpstream.listen(0, "127.0.0.1", r));
  await new Promise((r) => visionUpstream.listen(0, "127.0.0.1", r));
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [
      { id: "text", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${textUpstream.address().port}/v1` },
      { id: "vision", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${visionUpstream.address().port}/v1` }
    ],
    models: [
      { id: "text/model", providerId: "text", upstreamModel: "text-upstream", capabilities: { text: true, images: false }, visionFallbackModelId: "vision/model" },
      { id: "vision/model", providerId: "vision", upstreamModel: "vision-upstream", capabilities: { text: true, images: true } }
    ]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => textUpstream.close(r));
    await new Promise((r) => visionUpstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = await fetchJson(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "text/model",
      input: [{
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "看图总结" },
          { type: "input_image", image_url: "data:image/png;base64,BBBB", detail: "low" }
        ]
      }]
    })
  });

  assert.equal(result.status, 200);
  assert.equal(visionCalls, 1);
  assert.equal(JSON.stringify(textUpstreamBody).includes("image_url"), false);
  assert.match(JSON.stringify(textUpstreamBody), /图片里有一张表格/);
});

test("server preserves Anthropic image input for vision fallback", async (t) => {
  let textUpstreamBody = null;
  let visionCalls = 0;
  const textUpstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      textUpstreamBody = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
    });
  });
  const visionUpstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      visionCalls += 1;
      assert.match(buf, /data:image\/png;base64,CCCC/);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "图片里有一个表单。" } }] }));
    });
  });
  await new Promise((r) => textUpstream.listen(0, "127.0.0.1", r));
  await new Promise((r) => visionUpstream.listen(0, "127.0.0.1", r));
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [
      { id: "text", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${textUpstream.address().port}/v1` },
      { id: "vision", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${visionUpstream.address().port}/v1` }
    ],
    models: [
      { id: "text/model", providerId: "text", upstreamModel: "text-upstream", capabilities: { text: true, images: false }, visionFallbackModelId: "vision/model" },
      { id: "vision/model", providerId: "vision", upstreamModel: "vision-upstream", capabilities: { text: true, images: true } }
    ]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => textUpstream.close(r));
    await new Promise((r) => visionUpstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const result = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "dummy", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "text/model",
      max_tokens: 64,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "看图总结" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } }
        ]
      }]
    })
  });

  assert.equal(result.status, 200);
  assert.equal(visionCalls, 1);
  assert.equal(JSON.stringify(textUpstreamBody).includes("image_url"), false);
  assert.match(JSON.stringify(textUpstreamBody), /图片里有一个表单/);
});

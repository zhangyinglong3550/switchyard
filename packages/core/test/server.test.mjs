import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
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

function completedResponseFromSse(text) {
  const lines = text.split(/\r?\n/);
  const completedIndex = lines.findIndex((line) => line === "event: response.completed");
  assert.ok(completedIndex >= 0, text);
  return JSON.parse(lines[completedIndex + 1].slice("data: ".length)).response;
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
  const claudeApp = await fetchJson(`http://127.0.0.1:${port}/claude-app/v1/models`);
  assert.equal(claudeApp.status, 200);
  assert.deepEqual(Object.keys(claudeApp.body).sort(), ["data", "first_id", "has_more", "last_id"]);
  assert.equal(claudeApp.body.data.length, 1);
  assert.match(claudeApp.body.data[0].id, /^claude-sonnet-4-5-switchyard-/);
  assert.equal(claudeApp.body.data[0].anthropic_family_tier, "sonnet");
  assert.equal(claudeApp.body.data[0].is_family_default, true);
  const claudeAppDoubleV1 = await fetchJson(`http://127.0.0.1:${port}/claude-app/v1/v1/models`);
  assert.equal(claudeAppDoubleV1.status, 200);
  assert.equal(claudeAppDoubleV1.body.data.length, 1);
  assert.equal(claudeAppDoubleV1.body.data[0].id, claudeApp.body.data[0].id);

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
  const routedViaClaudeAppDiscoveryId = await fetchJson(`http://127.0.0.1:${port}/claude-app/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "test" },
    body: JSON.stringify({
      model: claudeApp.body.data[0].id,
      max_tokens: 32,
      messages: [{ role: "user", content: "ping" }]
    })
  });
  assert.equal(routedViaClaudeAppDiscoveryId.status, 200);

  const all = await fetchJson(`http://127.0.0.1:${port}/hermes/v1/models`);
  assert.equal(all.body.data.length, 2);
});

test("server preserves Claude Code parallel tool results for OpenAI-compatible upstreams", async (t) => {
  let received = null;
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/v1/chat/completions");
      received = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chat_parallel_tools",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "两个文件都读到了。" },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 17, completion_tokens: 6, total_tokens: 23 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "deepseek", name: "DeepSeek", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }],
    clients: { "claude-code": { enabled: true, allowedModels: ["*"] } }
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const models = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/models`);
  assert.equal(models.status, 200);
  const discoveryId = models.body.data[0].id;
  assert.match(discoveryId, /^claude-switchyard-deepseek-deepseek-v4-pro-/);

  const result = await fetchJson(`http://127.0.0.1:${port}/claude-code/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "dummy" },
    body: JSON.stringify({
      model: discoveryId,
      max_tokens: 128,
      tools: [{
        name: "Read",
        description: "Read a local file",
        input_schema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"]
        }
      }],
      messages: [
        { role: "user", content: "读取两个文件" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "我会并行读取。" },
            { type: "tool_use", id: "toolu_read_a", name: "Read", input: { file_path: "a.md" } },
            { type: "tool_use", id: "toolu_read_b", name: "Read", input: { file_path: "b.md" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_read_a", content: "A content" },
            { type: "tool_result", tool_use_id: "toolu_read_b", content: [{ type: "text", text: "B content" }] },
            { type: "text", text: "继续总结" }
          ]
        }
      ]
    })
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.content[0].text, "两个文件都读到了。");
  assert.ok(received);
  assert.equal(received.model, "deepseek-v4-pro");
  assert.equal(received.tools[0].function.name, "Read");
  assert.deepEqual(received.messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.deepEqual(received.messages[1].tool_calls.map((call) => call.id), ["toolu_read_a", "toolu_read_b"]);
  assert.deepEqual(received.messages[1].tool_calls.map((call) => JSON.parse(call.function.arguments)), [
    { file_path: "a.md" },
    { file_path: "b.md" }
  ]);
  assert.equal(received.messages[2].tool_call_id, "toolu_read_a");
  assert.equal(received.messages[2].content, "A content");
  assert.equal(received.messages[3].tool_call_id, "toolu_read_b");
  assert.equal(received.messages[3].content, "B content");
  assert.equal(received.messages[4].content, "继续总结");
});

test("codex models endpoint exposes official GPT fast tier with bare slug", async (t) => {
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{
      id: "codex",
      name: "Codex",
      apiFormat: "openai_responses",
      authMode: "none",
      providerType: "codex_oauth",
      baseUrl: "https://chatgpt.com/backend-api/codex"
    }],
    models: [{
      id: "codex/gpt-5.5",
      providerId: "codex",
      upstreamModel: "gpt-5.5",
      displayName: "GPT-5.5",
      capabilities: { images: true }
    }],
    clients: {
      codex: { enabled: true, allowedModels: ["*"] }
    }
  });

  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const codex = await fetchJson(`http://127.0.0.1:${port}/codex/v1/models`);
  assert.equal(codex.body.models[0].slug, "gpt-5.5");
  assert.equal(codex.body.models[0]["x-switchyard-model-id"], "codex/gpt-5.5");
  assert.deepEqual(codex.body.models[0].additional_speed_tiers, ["fast"]);
  assert.deepEqual(codex.body.models[0].service_tiers, [{
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage"
  }]);
  assert.equal(codex.body.data[0].id, "gpt-5.5");
  assert.equal(codex.body.data[0].slug, "gpt-5.5");
  assert.deepEqual(codex.body.data[0].service_tiers, codex.body.models[0].service_tiers);
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
  const claudeAppHead = await fetch(`http://127.0.0.1:${port}/claude-app`, { method: "HEAD" });
  assert.equal(claudeAppHead.status, 200);
  const claudeAppGet = await fetch(`http://127.0.0.1:${port}/claude-app`);
  assert.equal(claudeAppGet.status, 200);
  assert.equal((await claudeAppGet.json()).client, "claude-app");
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

test("server streams Anthropic tool_use input as json deltas for Claude Code", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      assert.equal(req.url, "/v1/messages");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "claude-ish",
        content: [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "lark-minutes", args: "读取今天的飞书会议纪要" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 2, output_tokens: 3 }
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
    body: JSON.stringify({ model: "anth/claude-ish", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /"content_block":\{"type":"tool_use","id":"toolu_1","name":"Skill","input":\{\}\}/);
  assert.match(text, /"type":"input_json_delta"/);
  assert.match(text, /\\"skill\\":\\"lark-minutes\\"/);
  assert.match(text, /"stop_reason":"tool_use"/);
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
  assert.deepEqual(received.include, ["reasoning.encrypted_content"]);
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

test("server retries native Responses stream when it disconnects before the first upstream chunk", async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      if (attempts === 1) {
        setTimeout(() => res.destroy(new Error("synthetic prelude disconnect")), 20);
        return;
      }
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
    body: JSON.stringify({ model: "codex/gpt-5.5", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.equal(attempts, 2);
  assert.match(text, /response.output_text.delta/);
  assert.doesNotMatch(text, /response.failed/);
  assert.match(text, /data: \[DONE\]/);
});

test("server retries native Responses stream when it disconnects after prelude only", async (t) => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      if (attempts === 1) {
        res.write([
          "event: response.created",
          "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_up\",\"status\":\"in_progress\"}}",
          ""
        ].join("\n"));
        setTimeout(() => res.destroy(new Error("synthetic prelude-only disconnect")), 20);
        return;
      }
      res.end([
        "event: response.created",
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_retry\",\"status\":\"in_progress\"}}",
        "",
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
    body: JSON.stringify({ model: "codex/gpt-5.5", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.equal(attempts, 2);
  assert.doesNotMatch(text, /resp_up/);
  assert.match(text, /resp_retry/);
  assert.match(text, /response.output_text.delta/);
  assert.doesNotMatch(text, /response.failed/);
  assert.match(text, /data: \[DONE\]/);
});

test("server records sanitized native Responses stream diagnostics", async (t) => {
  const logs = [];
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.end([
        "event: response.created",
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_diag\"}}",
        "",
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"secret-visible-text\"}",
        "",
        "event: response.function_call_arguments.delta",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"path\\\":\"}",
        "",
        "event: response.function_call_arguments.done",
        "data: {\"type\":\"response.function_call_arguments.done\",\"arguments\":\"{\\\"path\\\":\\\"/tmp/a\\\"}\"}",
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
  const requestLog = logs.find((entry) => entry.requestLog && entry.path === "/codex/v1/responses");
  const diag = requestLog?.requestSummary?.streamDiagnostics;
  assert.ok(diag, JSON.stringify(requestLog));
  assert.equal(diag.eventCounts["response.created"], 1);
  assert.equal(diag.eventCounts["response.output_text.delta"], 1);
  assert.equal(diag.eventCounts["response.function_call_arguments.delta"], 1);
  assert.equal(diag.dataTypeCounts["response.created"], 1);
  assert.equal(diag.dataTypeCounts["response.output_text.delta"], 1);
  assert.equal(diag.dataTypeCounts["response.function_call_arguments.done"], 1);
  assert.equal(diag.dataTypeCounts["[DONE]"], 1);
  assert.equal(diag.doneCount, 1);
  assert.equal(diag.sawMeaningfulEvent, true);
  assert.equal(requestLog.responseSummary.finishReason, "completed");
  assert.equal(requestLog.responseSummary.streamEventSummary.textDeltaCount, 1);
  assert.equal(requestLog.responseSummary.streamEventSummary.functionCallDeltaCount, 1);
  assert.equal(requestLog.responseSummary.toolCalls[0].name, "function_call_arguments");
  assert.equal(JSON.stringify(diag).includes("secret-visible-text"), false);
});

test("server emits response.failed when native Responses stream disconnects", async (t) => {
  const logs = [];
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write([
        "event: response.created",
        "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_up\",\"status\":\"in_progress\"}}",
        "",
        "event: response.output_text.delta",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}",
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
  assert.equal(attempts, 1);
  assert.match(text, /event: response.failed/);
  assert.match(text, /upstream_stream_error/);
  assert.match(text, /data: \[DONE\]/);
  const requestLog = logs.find((entry) => entry.requestLog && entry.path === "/codex/v1/responses");
  assert.match(requestLog?.error || "", /terminated|disconnect|socket|fetch failed/i);
});

test("server ignores invalid EOF after native Responses stream completed", async (t) => {
  const payload = [
    "event: response.completed",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_up\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"output\":[]}}",
    "",
    "data: [DONE]",
    ""
  ].join("\n");
  const upstream = net.createServer((socket) => {
    socket.once("data", () => {
      socket.write([
        "HTTP/1.1 200 OK",
        "Content-Type: text/event-stream; charset=utf-8",
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        ""
      ].join("\r\n"));
      socket.write(`${payload.length.toString(16)}\r\n${payload}\r\n`);
      socket.end();
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
  assert.match(text, /event: response.completed/);
  assert.match(text, /data: \[DONE\]/);
  assert.doesNotMatch(text, /response.failed/);
  assert.doesNotMatch(text, /upstream_stream_error/);
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
  const completed = completedResponseFromSse(text);
  assert.equal(completed.output[0].content[0].text, "HELLO");
});

test("server streams chat reasoning_content as Responses reasoning events", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      for (const chunk of [
        'data: {"choices":[{"delta":{"reasoning_content":"先分析","role":"assistant"},"index":0}],"object":"chat.completion.chunk"}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"再回答"},"index":0}],"object":"chat.completion.chunk"}\n\n',
        'data: {"choices":[{"delta":{"content":"结论"},"index":0}],"object":"chat.completion.chunk"}\n\n',
        "data: [DONE]\n\n"
      ]) {
        res.write(chunk);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "deepseek", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-reasoner" }]
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
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", stream: true, input: "ping", reasoning: { effort: "high" } })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.match(text, /event: response\.reasoning_summary_part\.added/);
  assert.match(text, /event: response\.reasoning_summary_text\.delta/);
  assert.match(text, /event: response\.reasoning_text\.delta/);
  const completed = completedResponseFromSse(text);
  assert.equal(completed.output[0].type, "reasoning");
  assert.equal(completed.output[0].summary[0].text, "先分析再回答");
  assert.equal(completed.output[0].content[0].text, "先分析再回答");
  assert.match(completed.output[0].encrypted_content, /^switchyard:anthropic-thinking:v1:/);
  assert.equal(completed.output[1].content[0].text, "结论");
});

test("server splits streamed think tags into Responses reasoning output", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      const chunks = [
        'data: {"choices":[{"delta":{"content":"<thi"},"index":0}],"object":"chat.completion.chunk"}\n\n',
        'data: {"choices":[{"delta":{"content":"nk>思考"},"index":0}],"object":"chat.completion.chunk"}\n\n',
        'data: {"choices":[{"delta":{"content":"</think>答案"},"index":0}],"object":"chat.completion.chunk"}\n\n',
        "data: [DONE]\n\n"
      ];
      for (const chunk of chunks) {
        const splitAt = Math.max(1, Math.floor(chunk.length / 2));
        res.write(chunk.slice(0, splitAt));
        await new Promise((resolve) => setTimeout(resolve, 1));
        res.write(chunk.slice(splitAt));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      res.end();
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "p/reasoner", providerId: "p", upstreamModel: "reasoner" }]
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
    body: JSON.stringify({ model: "p/reasoner", stream: true, input: "ping" })
  });
  const text = await resp.text();
  assert.equal(resp.status, 200, text);
  assert.doesNotMatch(text, /<think>|<\/think>/);
  const completed = completedResponseFromSse(text);
  assert.equal(completed.output[0].type, "reasoning");
  assert.equal(completed.output[0].summary[0].text, "思考");
  assert.equal(completed.output[1].content[0].text, "答案");
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

test("server round-trips Anthropic thinking through Codex Responses tool calls", async (t) => {
  const upstreamBodies = [];
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/v1/messages");
      const body = JSON.parse(buf);
      upstreamBodies.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (upstreamBodies.length === 1) {
        res.end(JSON.stringify({
          id: "msg_tool",
          type: "message",
          role: "assistant",
          model: "deepseek-v4-pro",
          content: [
            { type: "thinking", thinking: "selected a tool", signature: "sig_123" },
            { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a" } }
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 5, output_tokens: 3 }
        }));
        return;
      }
      res.end(JSON.stringify({
        id: "msg_done",
        type: "message",
        role: "assistant",
        model: "deepseek-v4-pro",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 8, output_tokens: 2 }
      }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;

  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "deepseek", apiFormat: "anthropic_messages", baseUrl: `http://127.0.0.1:${upPort}` }],
    models: [{ id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro" }]
  });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => upstream.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const first = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      stream: true,
      input: [{ type: "message", role: "user", content: "read a" }]
    })
  });
  const firstText = await first.text();
  assert.equal(first.status, 200, firstText);
  assert.match(firstText, /event: response.output_item.done/);
  assert.match(firstText, /switchyard:anthropic-thinking:v1:/);
  const completed = firstText.match(/event: response\.completed\ndata: (.+)\n/);
  assert.ok(completed, firstText);
  const response = JSON.parse(completed[1]).response;
  assert.equal(response.output[0].type, "reasoning");
  assert.equal(response.output[1].type, "function_call");

  const second = await fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      stream: true,
      input: [
        response.output[0],
        response.output[1],
        { type: "function_call_output", call_id: "call_1", output: "file a" }
      ]
    })
  });
  const secondText = await second.text();
  assert.equal(second.status, 200, secondText);
  assert.equal(upstreamBodies.length, 2);
  assert.deepEqual(upstreamBodies[1].messages[0].content[0], { type: "thinking", thinking: "selected a tool", signature: "sig_123" });
  assert.equal(upstreamBodies[1].messages[0].content[1].type, "tool_use");
  assert.equal(upstreamBodies[1].messages[1].content[0].type, "tool_result");
  assert.match(secondText, /"delta":"done"/);
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

test("server records active compatibility rules and protocol conversion chain", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{ id: "coding-plan", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${upPort}/v1` }],
    models: [{ id: "coding-plan/glm-5.2", providerId: "coding-plan", upstreamModel: "glm-5.2" }]
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

  const result = await fetchJson(`http://127.0.0.1:${port}/codex/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dummy" },
    body: JSON.stringify({ model: "coding-plan/glm-5.2", input: "hi" })
  });
  assert.equal(result.status, 200);

  const requestEvent = events.find((event) => event.requestLog === true);
  assert.ok(requestEvent);
  assert.deepEqual(requestEvent.requestSummary.conversionChain.steps, ["openai_responses", "openai_chat"]);
  const glmRule = requestEvent.requestSummary.compatRules.outbound.find((rule) => rule.id === "glm-content-text");
  assert.ok(glmRule);
  assert.equal(glmRule.source, "auto");
  assert.match(glmRule.description, /GLM/);
});

test("server records request override summaries without header values", async (t) => {
  let upstreamBody = null;
  let upstreamHeaders = null;
  const upstream = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      upstreamHeaders = req.headers;
      upstreamBody = JSON.parse(buf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const upPort = upstream.address().port;
  const { tmp } = writeTempConfig({
    host: "127.0.0.1",
    port: 0,
    providers: [{
      id: "override-provider",
      apiFormat: "openai_chat",
      baseUrl: `http://127.0.0.1:${upPort}/v1`,
      localProxyRequestOverrides: {
        headers: { "X-Secret-Token": "secret-token" },
        body: { vendor_options: { mode: "compat" } }
      }
    }],
    models: [{ id: "override/model", providerId: "override-provider", upstreamModel: "model" }]
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

  const result = await fetchJson(`http://127.0.0.1:${port}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "override/model", messages: [{ role: "user", content: "hi" }] })
  });
  assert.equal(result.status, 200);
  assert.equal(upstreamHeaders["x-secret-token"], "secret-token");
  assert.deepEqual(upstreamBody.vendor_options, { mode: "compat" });

  const requestEvent = events.find((event) => event.requestLog === true);
  assert.ok(requestEvent);
  assert.deepEqual(requestEvent.requestSummary.requestOverrides.sources, ["provider"]);
  assert.deepEqual(requestEvent.requestSummary.requestOverrides.headerNames, ["[redacted-header]"]);
  assert.deepEqual(requestEvent.requestSummary.requestOverrides.bodyKeys, ["vendor_options"]);
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

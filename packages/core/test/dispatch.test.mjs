import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dispatchChat } from "../src/upstream/dispatch.mjs";
import { resetPatches } from "../src/compat/index.mjs";

function spawnUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => handler(req, res, buf));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) { return new Promise((r) => server.close(r)); }

test("dispatchChat → openai_chat upstream returns chat-shape", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/v1/chat/completions");
    const data = JSON.parse(body);
    assert.equal(data.model, "u-model");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x", object: "chat.completion", model: "u-model",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }));
  });
  t.after(() => close(up));
  const provider = { id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };
  const result = await dispatchChat(provider, "u-model", { messages: [{ role: "user", content: "go" }] });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "hi");
});

test("dispatchChat → openai_responses upstream flattens to chat-shape", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/responses");
    const data = JSON.parse(body);
    assert.equal(data.model, "u-responses-model");
    assert.equal(data.input[0].type, "message");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "r1", object: "response", created_at: 0, status: "completed", model: "u-responses-model",
      output: [{ type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "pong", annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
  });
  t.after(() => close(up));
  const provider = { id: "openai", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${up.address().port}` };
  const result = await dispatchChat(provider, "u-responses-model", { messages: [{ role: "user", content: "ping" }] });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "pong");
});

test("dispatchChat → anthropic_messages upstream flattens to chat-shape", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/v1/messages");
    assert.equal(req.headers["x-api-key"], "test-key");
    const data = JSON.parse(body);
    assert.equal(data.model, "claude-test");
    assert.equal(data.messages[0].role, "user");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "msg1", type: "message", role: "assistant", model: "claude-test",
      content: [{ type: "text", text: "hello from claude" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 3 }
    }));
  });
  t.after(() => close(up));
  const provider = { id: "anth", apiFormat: "anthropic_messages", baseUrl: `http://127.0.0.1:${up.address().port}`, apiKey: "test-key" };
  const result = await dispatchChat(provider, "claude-test", { messages: [{ role: "user", content: "ping" }] });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "hello from claude");
  assert.equal(result.payload.usage.prompt_tokens, 1);
});

test("dispatchChat → openai_responses preserves tool_calls round-trip", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      output: [
        { type: "function_call", id: "f1", call_id: "c1", status: "completed", name: "search", arguments: "{\"q\":\"x\"}" }
      ]
    }));
  });
  t.after(() => close(up));
  const provider = { id: "openai", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${up.address().port}` };
  const result = await dispatchChat(provider, "u", { messages: [{ role: "user", content: "go" }], tools: [{ type: "function", function: { name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } } }] });
  assert.equal(result.kind, "json");
  const tc = result.payload.choices[0].message.tool_calls;
  assert.equal(tc[0].function.name, "search");
});

test("dispatchChat → anthropic upstream preserves tool_use round-trip", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "m1", type: "message", role: "assistant",
      content: [{ type: "tool_use", id: "tu1", name: "lookup", input: { q: "kimi" } }],
      stop_reason: "tool_use"
    }));
  });
  t.after(() => close(up));
  const provider = { id: "anth", apiFormat: "anthropic_messages", baseUrl: `http://127.0.0.1:${up.address().port}` };
  const result = await dispatchChat(provider, "claude-x", { messages: [{ role: "user", content: "go" }] });
  assert.equal(result.kind, "json");
  const tc = result.payload.choices[0].message.tool_calls;
  assert.equal(tc[0].function.name, "lookup");
  assert.equal(result.payload.choices[0].finish_reason, "tool_calls");
});

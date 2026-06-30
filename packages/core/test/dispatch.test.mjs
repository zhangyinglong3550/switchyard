import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dispatchChat, dispatchResponses } from "../src/upstream/dispatch.mjs";
import { registerBuiltinPatches, registerPatch, resetPatches } from "../src/compat/index.mjs";
import { glmContentTextPatch } from "../src/compat/patches/glm-content-text.mjs";
import { SWITCHYARD_THINKING_KEY } from "../src/reasoning.mjs";

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

test("dispatchChat → openai_chat upstream tolerates output_text-style assistant message payload", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/v1/chat/completions");
    const data = JSON.parse(body);
    assert.equal(data.model, "u-model");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x", object: "chat.completion", model: "u-model",
      choices: [{ index: 0, message: { role: "assistant", content: { output_text: "请先调用飞书相关工具。" }, tool_calls: [{ id: "call_1", type: "function", function: { name: "Skill", arguments: JSON.stringify({ skill: "lark-minutes" }) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }));
  });
  t.after(() => close(up));
  const provider = { id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };
  const result = await dispatchChat(provider, "u-model", { messages: [{ role: "user", content: "go" }] });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "请先调用飞书相关工具。");
  assert.equal(result.payload.choices[0].message.tool_calls[0].function.name, "Skill");
});

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

test("dispatchChat → strips internal route fields before upstream", async (t) => {
  resetPatches();
  let received = null;
  const up = await spawnUpstream((req, res, body) => {
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x", object: "chat.completion", model: "glm-5.2",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
    }));
  });
  t.after(() => close(up));
  const provider = { id: "opencode go", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };
  const result = await dispatchChat(provider, "glm-5.2", {
    _modelId: "opencode go/glm-5.2",
    _switchyardInternal: true,
    messages: [{ role: "user", content: "go", _switchyardAnthropicThinking: [{ type: "thinking", thinking: "hidden" }] }]
  });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "ok");
  assert.equal(received.model, "glm-5.2");
  assert.equal(Object.hasOwn(received, "_modelId"), false);
  assert.equal(Object.hasOwn(received, "_switchyardInternal"), false);
  assert.equal(Object.hasOwn(received.messages[0], "_switchyardAnthropicThinking"), false);
});

test("dispatchChat → applies proxy dispatcher only when a model proxy is requested", async () => {
  resetPatches();
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const provider = { id: "p", apiFormat: "openai_chat", baseUrl: "https://upstream.example.com/v1" };

  await dispatchChat(provider, "a", { messages: [{ role: "user", content: "go" }] }, {
    fetchImpl,
    proxyUrl: "http://127.0.0.1:7890"
  });
  await dispatchChat(provider, "b", { messages: [{ role: "user", content: "go" }] }, { fetchImpl });

  assert.ok(calls[0].dispatcher, "proxied request should carry an undici dispatcher");
  assert.equal("dispatcher" in calls[1], false, "non-proxied request should not inherit dispatcher");
});

test("dispatchChat → inherits provider proxy and lets model proxy override it", async () => {
  resetPatches();
  const calls = [];
  const fetchImpl = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const provider = {
    id: "openai",
    apiFormat: "openai_chat",
    baseUrl: "https://upstream.example.com/v1",
    proxyUrl: "http://127.0.0.1:7890"
  };

  await dispatchChat(provider, "a", { messages: [{ role: "user", content: "go" }] }, { fetchImpl });
  await dispatchChat(provider, "b", { messages: [{ role: "user", content: "go" }] }, {
    fetchImpl,
    proxyUrl: "http://127.0.0.1:7891"
  });

  assert.ok(calls[0].dispatcher, "provider proxy should be used when model proxy is absent");
  assert.ok(calls[1].dispatcher, "model proxy should also carry a dispatcher");
  assert.notEqual(calls[0].dispatcher, calls[1].dispatcher, "model proxy should override the provider proxy");
});

test("dispatchChat → applies provider and model request overrides after route transforms", async (t) => {
  resetPatches();
  let received = null;
  const up = await spawnUpstream((req, res, body) => {
    received = { headers: req.headers, body: JSON.parse(body) };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }));
  });
  t.after(() => close(up));
  const provider = {
    id: "custom",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${up.address().port}/v1`,
    localProxyRequestOverrides: {
      headers: {
        "X-Provider-Flag": "provider",
        "X-Shared-Flag": "provider",
        "X-Secret-Token": "secret"
      },
      body: {
        metadata: { provider: true, shared: "provider" },
        top_level: "provider"
      }
    }
  };
  const model = {
    id: "custom/model",
    providerId: "custom",
    requestOverrides: {
      headers: {
        "X-Model-Flag": "model",
        "X-Shared-Flag": "model"
      },
      body: {
        metadata: { model: true, shared: "model" },
        top_level: "model"
      }
    }
  };

  const result = await dispatchChat(provider, "upstream-model", {
    _modelId: "custom/model",
    messages: [{ role: "user", content: "go", _switchyardInternal: "drop" }]
  }, { model });

  assert.equal(result.kind, "json");
  assert.equal(received.headers["x-provider-flag"], "provider");
  assert.equal(received.headers["x-model-flag"], "model");
  assert.equal(received.headers["x-shared-flag"], "model");
  assert.equal(received.headers["x-secret-token"], "secret");
  assert.deepEqual(received.body.metadata, { provider: true, shared: "model", model: true });
  assert.equal(received.body.top_level, "model");
  assert.equal(received.body.messages[0]._switchyardInternal, undefined);
  assert.deepEqual(result.requestOverrides.sources, ["provider", "model"]);
  assert.ok(result.requestOverrides.headerNames.includes("X-Provider-Flag"));
  assert.ok(result.requestOverrides.headerNames.includes("[redacted-header]"));
  assert.deepEqual(result.requestOverrides.bodyKeys.sort(), ["metadata", "top_level"]);
});

test("dispatchChat → applies model compat packs from dispatch context", async (t) => {
  resetPatches();
  registerBuiltinPatches();
  let received = null;
  const up = await spawnUpstream((req, res, body) => {
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }));
  });
  t.after(() => close(up));
  const provider = { id: "custom", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };

  await dispatchChat(provider, "custom-model", {
    _modelId: "custom/custom-model",
    messages: [{ role: "user", content: "go" }]
  }, {
    model: { id: "custom/custom-model", providerId: "custom", compatPacks: ["glm"] }
  });

  assert.ok(Array.isArray(received.messages[0].content), "model compat pack should activate the GLM content wrapper inside dispatch");
  resetPatches();
});

test("dispatchChat → rectifies unsupported image errors and retries once", async (t) => {
  resetPatches();
  let calls = 0;
  let retriedBody = null;
  const up = await spawnUpstream((req, res, body) => {
    calls += 1;
    const data = JSON.parse(body);
    if (calls === 1) {
      assert.equal(data.messages[0].content[0].type, "image_url");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "This model does not support image input" } }));
      return;
    }
    retriedBody = data;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }));
  });
  t.after(() => close(up));
  const provider = { id: "deepseek", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };

  const result = await dispatchChat(provider, "deepseek-v4-pro", {
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "text", text: "识别图片" }
      ]
    }]
  });

  assert.equal(result.kind, "json");
  assert.equal(calls, 2);
  assert.equal(retriedBody.messages[0].content[0].type, "text");
  assert.equal(retriedBody.messages[0].content[0].text, "[Unsupported Image]");
  assert.equal(result.rectifiers[0].id, "media-unsupported-image");
  assert.equal(result.rectifiers[0].retryOk, true);
});

test("dispatchChat → rectifies thinking signature errors and retries once", async (t) => {
  resetPatches();
  let calls = 0;
  let retriedBody = null;
  const up = await spawnUpstream((req, res, body) => {
    calls += 1;
    const data = JSON.parse(body);
    if (calls === 1) {
      assert.equal(data.messages[0].content[0].type, "thinking");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid signature in thinking block" } }));
      return;
    }
    retriedBody = data;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }));
  });
  t.after(() => close(up));
  const provider = { id: "anthropic-compatible", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };

  const result = await dispatchChat(provider, "claude-compatible", {
    thinking: { type: "enabled" },
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden", signature: "bad" },
        { type: "text", text: "visible" }
      ]
    }]
  });

  assert.equal(result.kind, "json");
  assert.equal(calls, 2);
  assert.equal(retriedBody.messages[0].content[0].type, "text");
  assert.equal(retriedBody.messages[0].content[0].signature, undefined);
  assert.equal(result.rectifiers[0].id, "thinking-signature");
});

test("dispatchChat → rectifies thinking budget errors and retries once", async (t) => {
  resetPatches();
  let calls = 0;
  let retriedBody = null;
  const up = await spawnUpstream((req, res, body) => {
    calls += 1;
    const data = JSON.parse(body);
    if (calls === 1) {
      assert.equal(data.max_tokens, 1024);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "thinking.budget_tokens is too large for max_tokens" } }));
      return;
    }
    retriedBody = data;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      choices: [{ message: { role: "assistant", content: "ok" } }]
    }));
  });
  t.after(() => close(up));
  const provider = { id: "anthropic-compatible", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` };

  const result = await dispatchChat(provider, "reasoning-model", {
    max_tokens: 1024,
    messages: [{ role: "user", content: "go" }]
  });

  assert.equal(result.kind, "json");
  assert.equal(calls, 2);
  assert.equal(retriedBody.thinking.type, "enabled");
  assert.equal(retriedBody.thinking.budget_tokens, 32000);
  assert.equal(retriedBody.max_tokens, 64000);
  assert.equal(result.rectifiers[0].id, "thinking-budget");
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

test("dispatchChat → Codex OAuth responses upstream uses stream+store=false and aggregates SSE", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/responses");
    assert.equal(req.headers.accept, "text/event-stream");
    const data = JSON.parse(body);
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.store, false);
    assert.equal(data.stream, true);
    assert.equal(data.instructions, "");
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.end([
      "event: response.output_text.delta",
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"pong\"}",
      "",
      "event: response.completed",
      "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"object\":\"response\",\"created_at\":0,\"model\":\"gpt-5.5\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"pong\"}]}]}}",
      "",
      "data: [DONE]",
      ""
    ].join("\n"));
  });
  t.after(() => close(up));
  const provider = { id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${up.address().port}` };
  let fetchCalls = 0;
  const fetchImpl = async (url, init) => {
    fetchCalls++;
    return fetch(url, init);
  };
  const result = await dispatchChat(provider, "gpt-5.5", { messages: [{ role: "user", content: "ping" }] }, { fetchImpl });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "pong");
  assert.equal(fetchCalls, 1);
});

test("dispatchChat → Codex OAuth rewrites assistant text history for ChatGPT Codex backend", async (t) => {
  resetPatches();
  let received = null;
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/responses");
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.end([
      "data: {\"type\":\"response.output_text.delta\",\"delta\":\"下一轮正常回答\"}",
      "",
      "data: [DONE]",
      ""
    ].join("\n"));
  });
  t.after(() => close(up));
  const provider = { id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${up.address().port}` };
  const result = await dispatchChat(provider, "gpt-5.5", {
    messages: [
      { role: "user", content: "第一句" },
      { role: "assistant", content: "上一轮回答", [SWITCHYARD_THINKING_KEY]: [{ type: "thinking", thinking: "上一轮思考", signature: "sig_prev" }] },
      { role: "user", content: "继续" }
    ]
  });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "下一轮正常回答");
  assert.deepEqual(received.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(received.input.map((item) => item.role || item.type), ["user", "reasoning", "user", "user"]);
  assert.match(received.input[1].encrypted_content, /^switchyard:anthropic-thinking:v1:/);
  assert.equal(received.input[2].content, "Previous assistant response:\n上一轮回答");
});

test("dispatchResponses → Codex OAuth preserves native Responses params", async (t) => {
  resetPatches();
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/responses");
    assert.equal(req.headers.connection, "close");
    const data = JSON.parse(body);
    assert.equal(data.model, "gpt-5.5");
    assert.equal(data.store, false);
    assert.equal(data.stream, true);
    assert.deepEqual(data.reasoning, { effort: "low" });
    assert.deepEqual(data.text, { verbosity: "low" });
    assert.equal(data.service_tier, "priority");
    assert.deepEqual(data.include, ["reasoning.encrypted_content"]);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.end("data: [DONE]\n\n");
  });
  t.after(() => close(up));
  const provider = { id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: `http://127.0.0.1:${up.address().port}` };
  const result = await dispatchResponses(provider, "gpt-5.5", {
    model: "codex/gpt-5.5",
    stream: true,
    input: "ping",
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
    service_tier: "priority"
  });
  assert.equal(result.kind, "stream");
});

test("dispatchResponses → Codex OAuth forces ChatGPT Codex streaming request shape", async (t) => {
  resetPatches();
  let received = null;
  let headers = null;
  const up = await spawnUpstream((req, res, body) => {
    assert.equal(req.url, "/backend-api/codex/responses");
    headers = req.headers;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.end([
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
      "",
      "data: [DONE]",
      ""
    ].join("\n"));
  });
  t.after(() => close(up));
  const provider = {
    id: "codex",
    authMode: "codex_oauth",
    providerType: "codex_oauth",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${up.address().port}/backend-api/codex`
  };

  const result = await dispatchResponses(provider, "gpt-5.5", {
    model: "gpt-5.5",
    stream: false,
    max_output_tokens: 100,
    input: "ping"
  });

  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "ok");
  assert.equal(received.model, "gpt-5.5");
  assert.equal(received.store, false);
  assert.equal(received.stream, true);
  assert.equal(received.instructions, "");
  assert.equal(Object.prototype.hasOwnProperty.call(received, "max_output_tokens"), false);
  assert.equal(headers.accept, "text/event-stream");
});

test("dispatchResponses → Codex OAuth retries transient socket fetch failure once", async () => {
  resetPatches();
  const provider = { id: "codex", providerType: "codex_oauth", apiFormat: "openai_responses", baseUrl: "https://chatgpt.example.test/backend-api/codex" };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new TypeError("fetch failed");
      err.cause = { code: "UND_ERR_SOCKET" };
      throw err;
    }
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" }
    });
  };
  const result = await dispatchResponses(provider, "gpt-5.5", {
    model: "codex/gpt-5.5",
    stream: true,
    input: "ping"
  }, { fetchImpl });
  assert.equal(result.kind, "stream");
  assert.equal(calls, 2);
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

test("dispatchChat → keeps GLM text blocks as Anthropic content arrays", async (t) => {
  resetPatches();
  registerPatch(glmContentTextPatch.id, glmContentTextPatch);
  let received = null;
  const up = await spawnUpstream((req, res, body) => {
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "msg1",
      type: "message",
      role: "assistant",
      model: "glm-5.2",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 }
    }));
  });
  t.after(() => close(up).then(() => resetPatches()));
  const provider = { id: "opencode-go", apiFormat: "anthropic_messages", baseUrl: `http://127.0.0.1:${up.address().port}` };
  const result = await dispatchChat(provider, "glm-5.2", {
    _modelId: "opencode-go/glm-5.2",
    messages: [{ role: "user", content: "Reply OK only." }]
  });
  assert.equal(result.kind, "json");
  assert.ok(Array.isArray(received.messages[0].content));
  assert.deepEqual(received.messages[0].content[0], { type: "text", text: "Reply OK only." });
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

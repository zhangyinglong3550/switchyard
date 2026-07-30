import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";

import {
  clearCursorSubscriptionCredentials,
  loadCursorSubscriptionCredentials,
  saveCursorSubscriptionCredentials
} from "../src/cursor-subscription/auth.mjs";
import {
  assertCursorSubscriptionRequest,
  normalizeCursorSubscriptionProvider,
  resolveCursorSubscriptionModel,
  CURSOR_SUBSCRIPTION_STATIC_MODELS
} from "../src/cursor-subscription/model-catalog.mjs";
import { createCursorSubscriptionLane } from "../src/cursor-subscription/rate-limit.mjs";
import { collectCursorSubscriptionResponse } from "../src/cursor-subscription/adapter.mjs";

const validCredentials = { accessToken: "a".repeat(64), machineId: "12345678-1234-1234-1234-123456789abc" };

test("cursor subscription · provider is opt-in, local-only, bounded-concurrency and never serializes credentials", () => {
  const provider = normalizeCursorSubscriptionProvider({
    id: "cursor-subscription",
    providerType: "cursor_subscription",
    baseUrl: "https://agent.api5.cursor.sh",
    accessToken: validCredentials.accessToken,
    machineId: validCredentials.machineId,
    maxConcurrentRequests: 99
  });
  assert.equal(provider.enabled, false);
  assert.equal(provider.maxConcurrentRequests, 3);
  assert.equal(provider.streamIdleTimeoutMs, 90000);
  assert.equal(provider.keychainAccount, "cursor-subscription");
  assert.equal("accessToken" in provider, false);
  assert.equal("machineId" in provider, false);
  assert.throws(
    () => normalizeCursorSubscriptionProvider({ id: "bad", providerType: "cursor_subscription", baseUrl: "http://0.0.0.0:8000" }),
    /loopback|Cursor/i
  );
});

test("cursor subscription · credentials use only injected keychain storage and clear runtime state", () => {
  let stored = "";
  let cleared = false;
  const keychain = {
    set(account, secret) { assert.equal(account, "cursor-subscription"); stored = secret; return { ok: true }; },
    get(account) { assert.equal(account, "cursor-subscription"); return stored; },
    delete(account) { assert.equal(account, "cursor-subscription"); cleared = true; stored = ""; return { ok: true }; }
  };
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription", providerType: "cursor_subscription", baseUrl: "https://agent.api5.cursor.sh" });
  saveCursorSubscriptionCredentials(provider, validCredentials, keychain);
  assert.deepEqual(loadCursorSubscriptionCredentials(provider, keychain), validCredentials);
  assert.equal(stored.includes("\n"), false);
  assert.equal(JSON.stringify(provider).includes(validCredentials.accessToken), false);
  clearCursorSubscriptionCredentials(provider, keychain);
  assert.equal(cleared, true);
  assert.equal(loadCursorSubscriptionCredentials(provider, keychain), null);
});

test("cursor subscription · rejects unsupported content but accepts only supported request shapes", () => {
  assert.doesNotThrow(() => assertCursorSubscriptionRequest({ messages: [
    { role: "system", content: "Be concise" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ] }));
  for (const request of [
    { messages: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] }] },
    { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_1" }] }] },
    { messages: [{ role: "user", content: "hello" }], tools: [{ type: "web_search" }] }
  ]) {
    assert.throws(() => assertCursorSubscriptionRequest(request), (err) => err?.code === "CURSOR_SUBSCRIPTION_UNSUPPORTED_REQUEST");
  }
});

test("cursor subscription · maps the public auto alias to Cursor's default Agent model", () => {
  assert.equal(resolveCursorSubscriptionModel("auto"), "default");
  assert.equal(resolveCursorSubscriptionModel(""), "default");
  assert.equal(resolveCursorSubscriptionModel("default"), "default");
});

test("cursor subscription · exposes the current Cursor Desktop model choices", () => {
  const ids = CURSOR_SUBSCRIPTION_STATIC_MODELS.map((model) => model.id);
  assert.deepEqual(ids, [
    "auto",
    "grok-4.5",
    "composer-2.5",
    "claude-opus-5",
    "gpt-5.6-sol",
    "claude-fable-5",
    "claude-sonnet-5",
    "gpt-5.6-terra"
  ]);
  assert.ok(CURSOR_SUBSCRIPTION_STATIC_MODELS.every((model) => model.capabilities.tools && model.capabilities.stream));
});

test("cursor subscription · serializes one account and opens a short circuit after upstream failures", async () => {
  const lane = createCursorSubscriptionLane({ maxConcurrentRequests: 1, cooldownMs: 1000, failureThreshold: 2 });
  const order = [];
  let release;
  const first = lane.run(async () => {
    order.push("first:start");
    await new Promise((resolve) => { release = resolve; });
    order.push("first:end");
  });
  const second = lane.run(async () => { order.push("second"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lane.snapshot().state, "busy");
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  lane.recordFailure({ status: 502 });
  lane.recordFailure({ status: 502 });
  assert.equal(lane.snapshot().state, "circuit_open");
  await assert.rejects(() => lane.run(async () => {}), (err) => err?.code === "CURSOR_SUBSCRIPTION_CIRCUIT_OPEN");
});

test("cursor subscription · runs up to the configured bounded concurrency", async () => {
  const lane = createCursorSubscriptionLane({ maxConcurrentRequests: 2 });
  let active = 0;
  let peak = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const task = () => lane.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await gate;
    active -= 1;
  });
  const first = task();
  const second = task();
  const third = task();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(peak, 2);
  assert.equal(lane.snapshot().queued, 1);
  release();
  await Promise.all([first, second, third]);
});

test("cursor subscription · stream keeps its concurrency slot until the upstream terminal event", async () => {
  const provider = normalizeCursorSubscriptionProvider({
    id: "cursor-subscription-stream-slot",
    providerType: "cursor_subscription",
    enabled: true,
    maxConcurrentRequests: 1,
    baseUrl: "https://agent.api5.cursor.sh"
  });
  let finishFirst;
  const first = await callCursorSubscription(provider, {
    model: "auto",
    stream: true,
    messages: [{ role: "user", content: "first" }]
  }, {
    keychain: fakeKeychain(),
    transport: async function* () {
      await new Promise((resolve) => { finishFirst = resolve; });
      yield { type: "terminal" };
    }
  });

  let secondResolved = false;
  const second = callCursorSubscription(provider, {
    model: "auto",
    stream: true,
    messages: [{ role: "user", content: "second" }]
  }, {
    keychain: fakeKeychain(),
    transport: async function* () { yield { type: "terminal" }; }
  }).then((result) => {
    secondResolved = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondResolved, false);
  assert.equal(cursorSubscriptionLaneSnapshot(provider).running, 1);
  assert.equal(cursorSubscriptionLaneSnapshot(provider).queued, 1);

  finishFirst();
  await first.response.text();
  const secondResult = await second;
  await secondResult.response.text();
  clearCursorSubscriptionRuntime(provider);
});

import {
  callCursorSubscription,
  buildAgentRun,
  buildCursorRequestContextResponse,
  clearCursorSubscriptionRuntime,
  cursorAgentEventsFromFrame,
  cursorAgentExecutionEvent,
  decodeCursorConnectFramePayload,
  cursorRequestHeaders,
  cursorSubscriptionLaneSnapshot,
  parseCursorEndStream,
  summarizeCursorAgentFrame
} from "../src/cursor-subscription/client.mjs";
import { dispatchChat } from "../src/upstream/dispatch.mjs";

function fakeKeychain(credentials = validCredentials) {
  return { get: () => JSON.stringify(credentials) };
}

function encodeTestVarint(value) {
  const bytes = [];
  let number = Number(value);
  while (number > 127) { bytes.push((number & 127) | 128); number = Math.floor(number / 128); }
  bytes.push(number);
  return Buffer.from(bytes);
}

function protoVarintField(field, value) {
  return Buffer.concat([encodeTestVarint((field << 3) | 0), encodeTestVarint(value)]);
}

function protoField(field, value) {
  const body = Buffer.from(value);
  return Buffer.concat([Buffer.from([(field << 3) | 2, body.length]), body]);
}

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  while (offset < buffer.length) {
    const byte = buffer[offset++];
    value += (byte & 127) * (2 ** shift);
    if (!(byte & 128)) return { value, offset };
    shift += 7;
  }
  return null;
}

function protoFields(buffer) {
  const result = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    if (!tag || (tag.value & 7) !== 2) break;
    offset = tag.offset;
    const length = readVarint(buffer, offset);
    if (!length) break;
    offset = length.offset;
    const value = buffer.subarray(offset, offset + length.value);
    offset += length.value;
    const field = tag.value >> 3;
    if (!result.has(field)) result.set(field, []);
    result.get(field).push(value);
  }
  return result;
}

test("cursor subscription · includes the mandatory request-context message in a user action", () => {
  const framed = buildAgentRun([{ role: "user", content: "hello" }], "default");
  const clientMessage = protoFields(framed.subarray(5));
  const run = protoFields(clientMessage.get(1)[0]);
  const action = protoFields(run.get(2)[0]);
  const userAction = protoFields(action.get(1)[0]);
  assert.equal(userAction.has(2), true);
  assert.equal(userAction.get(2)[0].length, 0);
});

test("cursor subscription · can answer a deferred AgentService request-context callback", () => {
  const framed = buildCursorRequestContextResponse();
  const clientMessage = protoFields(framed.subarray(5));
  assert.equal(clientMessage.has(2), true);
  const execution = protoFields(clientMessage.get(2)[0]);
  const result = protoFields(execution.get(10)[0]);
  const success = protoFields(result.get(1)[0]);
  assert.equal(success.has(1), true);
  assert.equal(success.get(1)[0].length, 0);
});

test("cursor subscription · serializes model parameters without capability flags", () => {
  const framed = buildAgentRun([{ role: "user", content: "hello" }], "grok-4.5", {
    requestedModel: {
      modelId: "grok-4.5",
      maxMode: false,
      parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }],
      builtInModel: true,
      isVariantStringRepresentation: false
    }
  });
  const clientMessage = protoFields(framed.subarray(5));
  const runBuffer = clientMessage.get(1)[0];
  const run = protoFields(runBuffer);
  const model = protoFields(run.get(9)[0]);
  assert.equal(model.get(1)[0].toString(), "grok-4.5");
  assert.match(run.get(9)[0].toString("hex"), /3801/);
  assert.deepEqual(model.get(3).map((parameter) => {
    const fields = protoFields(parameter);
    return [fields.get(1)[0].toString(), fields.get(2)[0].toString()];
  }), [["effort", "high"], ["fast", "false"]]);
  // Capability flags (fields 19, 23) are intentionally omitted: they trigger
  // heavier server-side processing and are not sent by 9router or the
  // official Cursor Desktop client for simple chat turns.
  assert.doesNotMatch(runBuffer.toString("hex"), /980101/);
  assert.doesNotMatch(runBuffer.toString("hex"), /b80101/);
});


test("cursor subscription · protocol diagnostics expose only flags, field numbers and byte lengths", () => {
  const update = Buffer.concat([protoField(1, protoField(1, "secret response text")), protoField(15, Buffer.from([1]))]);
  const summary = summarizeCursorAgentFrame(protoField(1, update), 2);
  assert.deepEqual(summary, {
    flags: 2,
    server: [{ field: 1, lengths: [update.length] }],
    update: [{ field: 1, lengths: [protoField(1, "secret response text").length] }, { field: 15, lengths: [1] }],
    interaction: []
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret response text/);
});

test("cursor subscription · decodes gzip-compressed ConnectRPC data frames and preserves JSON trailers", () => {
  const source = Buffer.from("protobuf payload");
  assert.deepEqual(decodeCursorConnectFramePayload(zlib.gzipSync(source), 0x01), source);
  const trailer = Buffer.from(JSON.stringify({ metadata: {} }));
  assert.deepEqual(decodeCursorConnectFramePayload(trailer, 0x03), trailer);
});

test("cursor subscription · completes only when TurnEndedUpdate is nested inside InteractionUpdate", () => {
  const textDelta = protoField(1, "OK");
  const interaction = Buffer.concat([
    protoField(1, textDelta),
    protoField(14, Buffer.alloc(0))
  ]);
  const frame = protoField(1, interaction);
  assert.deepEqual(cursorAgentEventsFromFrame(frame), [
    { type: "text", text: "OK" },
    { type: "usage", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    { type: "terminal" }
  ]);
});

test("cursor subscription · stops consuming the bidirectional stream after the terminal update", async () => {
  let advancedPastTerminal = false;
  async function* events() {
    yield { type: "text", text: "OK" };
    yield { type: "terminal" };
    advancedPastTerminal = true;
    await new Promise(() => {});
  }
  const response = await collectCursorSubscriptionResponse("default", events());
  assert.equal(response.choices[0].message.content, "OK");
  assert.equal(advancedPastTerminal, false);
});

test("cursor subscription · uses the 9router-compatible header shape without exposing credentials", () => {
  const headers = cursorRequestHeaders(validCredentials, "3.9.16");
  assert.equal(headers["x-cursor-client-version"], "3.9.16");
  assert.equal(headers["x-cursor-checksum"].endsWith(validCredentials.machineId), true);
  assert.equal(headers["x-cursor-checksum"].includes(","), false);
  assert.equal(headers.authorization, `Bearer ${validCredentials.accessToken}`);
  assert.equal(headers["connect-accept-encoding"], "gzip");
  assert.equal(headers["x-ghost-mode"], "true");
  assert.equal(headers["x-client-key"], crypto.createHash("sha256").update(validCredentials.accessToken).digest("hex"));
  assert.equal(headers["x-cursor-client-type"], "ide");
  assert.equal(typeof headers["x-session-id"], "string");
});

test("cursor subscription · recognizes Connect end-stream success and preserves upstream errors", () => {
  assert.deepEqual(parseCursorEndStream(Buffer.from(JSON.stringify({ metadata: {} }))), {
    ok: true,
    errorCode: "",
    errorMessage: ""
  });
  assert.deepEqual(parseCursorEndStream(Buffer.from(JSON.stringify({
    error: { code: "invalid_argument", message: "model is unavailable" }
  }))), {
    ok: false,
    errorCode: "invalid_argument",
    errorMessage: "model is unavailable"
  });
});

test("cursor subscription · maps a protocol terminal to OpenAI SSE and leaves EOF without terminal incomplete", async () => {
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription", providerType: "cursor_subscription", enabled: true, baseUrl: "https://agent.api5.cursor.sh" });
  const result = await callCursorSubscription(provider, { model: "auto", stream: true, messages: [{ role: "user", content: "hello" }] }, {
    keychain: fakeKeychain(),
    transport: async function* () {
      yield { type: "text", text: "hello" };
      yield { type: "terminal" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.switchyardRequireTerminal, true);
  const text = await result.response.text();
  assert.match(text, /"content":"hello"/);
  assert.match(text, /\[DONE\]/);

  const eof = await callCursorSubscription(provider, { model: "auto", stream: true, messages: [{ role: "user", content: "hello" }] }, {
    keychain: fakeKeychain(),
    transport: async function* () { yield { type: "text", text: "partial" }; }
  });
  assert.doesNotMatch(await eof.response.text(), /\[DONE\]/);
});

test("cursor subscription · returns sanitized auth failure and dispatches through the dedicated api format", async () => {
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription", providerType: "cursor_subscription", enabled: true, baseUrl: "https://agent.api5.cursor.sh" });
  const failed = await callCursorSubscription(provider, { model: "auto", stream: false, messages: [{ role: "user", content: "hello" }] }, {
    keychain: fakeKeychain(),
    transport: async function* () { throw new Error(`Bearer ${validCredentials.accessToken} rejected`); }
  });
  assert.equal(failed.ok, false);
  assert.doesNotMatch(JSON.stringify(failed.payload), new RegExp(validCredentials.accessToken));

  const result = await dispatchChat(provider, "auto", { model: "auto", stream: false, messages: [{ role: "user", content: "hello" }] }, {
    cursorSubscriptionKeychain: fakeKeychain(),
    cursorSubscriptionTransport: async function* () { yield { type: "text", text: "done" }; yield { type: "terminal" }; }
  });
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "done");
});

test("cursor subscription · sends Cursor's concrete default model while preserving the public auto model in its response", async () => {
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription-model-alias", providerType: "cursor_subscription", enabled: true, baseUrl: "https://agent.api5.cursor.sh" });
  let receivedModel = "";
  const result = await callCursorSubscription(provider, { model: "auto", stream: false, messages: [{ role: "user", content: "hello" }] }, {
    keychain: fakeKeychain(),
    transport: async function* ({ model }) {
      receivedModel = model;
      yield { type: "text", text: "done" };
      yield { type: "terminal" };
    }
  });
  assert.equal(receivedModel, "default");
  assert.equal(result.payload.model, "auto");
});

test("cursor subscription · passes API reasoning effort to the local Cursor model selection", async () => {
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription-reasoning", providerType: "cursor_subscription", enabled: true, baseUrl: "https://agent.api5.cursor.sh" });
  let received;
  const result = await callCursorSubscription(provider, {
    model: "grok-4.5",
    stream: false,
    reasoning: { effort: "low" },
    messages: [{ role: "user", content: "hello" }]
  }, {
    keychain: fakeKeychain(),
    readLocalModel: (_model, { reasoningEffort }) => ({
      ok: true,
      requestedModel: {
        modelId: "grok-4.5",
        parameters: [{ id: "effort", value: reasoningEffort }],
        builtInModel: true,
        isVariantStringRepresentation: false
      }
    }),
    transport: async function* (options) {
      received = options.requestedModel;
      yield { type: "text", text: "done" };
      yield { type: "terminal" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(received?.parameters?.find((parameter) => parameter.id === "effort")?.value, "low");
});

test("cursor subscription · passes Agent speed tier to Cursor's local fast parameter", async () => {
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription-speed", providerType: "cursor_subscription", enabled: true, baseUrl: "https://agent.api5.cursor.sh" });
  let received;
  const result = await callCursorSubscription(provider, {
    model: "grok-4.5",
    stream: false,
    service_tier: "priority",
    messages: [{ role: "user", content: "hello" }]
  }, {
    keychain: fakeKeychain(),
    readLocalModel: () => ({
      ok: true,
      requestedModel: { modelId: "grok-4.5", parameters: [{ id: "fast", value: "true" }], builtInModel: true, isVariantStringRepresentation: false }
    }),
    transport: async function* (options) {
      received = options.requestedModel;
      yield { type: "text", text: "done" };
      yield { type: "terminal" };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(received?.parameters?.find((parameter) => parameter.id === "fast")?.value, "true");
});

test("cursor subscription · reports a sanitized authentication-invalid runtime state", async () => {
  const provider = normalizeCursorSubscriptionProvider({ id: "cursor-subscription-auth-state", providerType: "cursor_subscription", enabled: true, baseUrl: "https://agent.api5.cursor.sh" });
  const result = await callCursorSubscription(provider, { model: "auto", stream: false, messages: [{ role: "user", content: "hello" }] }, {
    keychain: fakeKeychain(),
    transport: async function* () {
      const error = new Error(`Bearer ${validCredentials.accessToken} rejected`);
      error.status = 401;
      throw error;
    }
  });
  assert.equal(result.status, 401);
  assert.equal(cursorSubscriptionLaneSnapshot(provider).status, "auth_invalid");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(validCredentials.accessToken));
  clearCursorSubscriptionRuntime(provider);
});

import { mergeWithDefaults, validateConfig } from "../src/config.mjs";

test("cursor subscription · config normalization strips secret fields and rejects unsafe upstream or non-loopback gateway", () => {
  const config = mergeWithDefaults({
    host: "127.0.0.1",
    providers: [{ id: "cursor-subscription", providerType: "cursor_subscription", baseUrl: "https://agent.api5.cursor.sh", accessToken: validCredentials.accessToken, machineId: validCredentials.machineId }],
    models: []
  });
  assert.equal(config.providers[0].enabled, false);
  assert.equal("accessToken" in config.providers[0], false);
  assert.equal("machineId" in config.providers[0], false);
  assert.doesNotThrow(() => validateConfig(config));
  config.providers[0].enabled = true;
  config.host = "0.0.0.0";
  assert.throws(() => validateConfig(config), /127\.0\.0\.1/);
  assert.throws(() => mergeWithDefaults({
    providers: [{ id: "cursor-subscription", providerType: "cursor_subscription", baseUrl: "https://example.com" }],
    models: []
  }), /Cursor 官方域名/);
});

test("cursor subscription · queued work does not run after the preceding request opens the circuit", async () => {
  const lane = createCursorSubscriptionLane({ maxConcurrentRequests: 1, cooldownMs: 1000, failureThreshold: 1 });
  let release;
  const first = lane.run(async () => {
    await new Promise((resolve) => { release = resolve; });
    throw new Error("upstream failed");
  });
  const second = lane.run(async () => "must not run");
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await assert.rejects(first, /upstream failed/);
  await assert.rejects(second, (err) => err?.code === "CURSOR_SUBSCRIPTION_CIRCUIT_OPEN");
});

test("cursor subscription · quota responses do not open the local circuit", async () => {
  const lane = createCursorSubscriptionLane({ cooldownMs: 1000, failureThreshold: 1 });
  await assert.rejects(
    lane.run(async () => {
      const error = new Error("quota exhausted");
      error.status = 429;
      error.code = "CURSOR_SUBSCRIPTION_RESOURCE_EXHAUSTED";
      throw error;
    }),
    /quota exhausted/
  );
  assert.equal(lane.snapshot().state, "connected");
});

import {
  applyCursorToolCompatibility,
  prepareCursorConversation
} from "../src/cursor-subscription/tool-compat.mjs";
import { transformOpenCodeTextToolCalls } from "../src/opencode-text-tool-calls.mjs";

test("cursor subscription · accepts function tools and preserves the tool-result turn", () => {
  const tools = [{
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    }
  }];
  assert.doesNotThrow(() => assertCursorSubscriptionRequest({
    tools,
    messages: [
      { role: "user", content: "Read the config" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"config.json"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "{\"enabled\":true}" }
    ]
  }));
  assert.throws(
    () => assertCursorSubscriptionRequest({ tools: [{ type: "web_search" }], messages: [{ role: "user", content: "x" }] }),
    (error) => error?.code === "CURSOR_SUBSCRIPTION_UNSUPPORTED_REQUEST"
  );

  const conversation = prepareCursorConversation([
    { role: "user", content: "Read the config" },
    { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"config.json"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "{\"enabled\":true}" }
  ], tools);
  assert.match(conversation.system, /API endpoint/);
  assert.match(conversation.user, /TOOL RESULT \(call_1\)/);
  assert.match(conversation.user, /enabled/);
});

test("cursor subscription · converts compatibility XML into an OpenAI function call", () => {
  const tools = [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }];
  const response = applyCursorToolCompatibility({
    choices: [{
      index: 0,
      message: { role: "assistant", content: '<tool_calls><tool_call name="read_file"><arguments>{"path":"config.json"}</arguments></tool_call></tool_calls>' },
      finish_reason: "stop"
    }]
  }, tools);
  assert.equal(response.choices[0].finish_reason, "tool_calls");
  assert.equal(response.choices[0].message.content, "");
  assert.equal(response.choices[0].message.tool_calls[0].function.name, "read_file");
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"path":"config.json"}');
});

test("cursor subscription · streams compatibility XML as an OpenAI tool call without leaking markup", async () => {
  const source = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        id: "x", choices: [{ index: 0, delta: { content: '<tool_calls><tool_call name="read_file"><arguments>{"path":"config.json"}</arguments></tool_call></tool_calls>' }, finish_reason: "stop" }]
      })}\n\n`));
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    }
  }), { headers: { "content-type": "text/event-stream" } });
  const transformed = transformOpenCodeTextToolCalls(source, {
    tools: [{ type: "function", function: { name: "read_file" } }]
  });
  const text = await transformed.text();
  assert.match(text, /"tool_calls"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.doesNotMatch(text, /<tool_calls>/);
});

import {
  cursorAgentPrompt,
  cursorAgentCliModelCatalog,
  findCursorAgentExecutable,
  isCursorAgentCliEligible
} from "../src/cursor-subscription/agent-cli.mjs";

test("cursor subscription · direct AgentService Run is always used (CLI disabled)", () => {
  assert.equal(isCursorAgentCliEligible({ messages: [{ role: "user", content: "hello" }] }), false);
  assert.equal(isCursorAgentCliEligible({ tools: [{ type: "function", function: { name: "read" } }], messages: [{ role: "user", content: "hello" }] }), false);
  assert.equal(isCursorAgentCliEligible({ messages: [{ role: "tool", content: "result" }] }), false);
});

test("cursor subscription · Cursor Agent CLI catalog reflects the locally supported IDs", () => {
  const catalog = cursorAgentCliModelCatalog({
    executablePath: "/fake/cursor-agent",
    execFile() { return "Available models\nauto - Auto (default)\ncursor-grok-4.5-low - Cursor Grok 4.5 Low\ncursor-grok-4.5-high-fast - Cursor Grok 4.5 Fast\ngpt-5.6-sol-xhigh-fast - GPT-5.6 Sol Extra High Fast\n"; }
  });
  assert.equal(catalog.ok, true);
  assert.deepEqual(catalog.models.map((model) => model.id), ["auto", "grok-4.5", "gpt-5.6-sol"]);
  assert.deepEqual(catalog.models[1].aliases, ["cursor-grok-4.5-low", "cursor-grok-4.5-high-fast"]);
  assert.equal(catalog.models[0].capabilities.tools, false);
});

test("cursor subscription · decodes real varint token usage from TurnEndedUpdate", () => {
  const turnEnded = Buffer.concat([
    protoVarintField(1, 11859),
    protoVarintField(2, 85),
    protoVarintField(3, 5760),
    protoVarintField(4, 0),
    protoVarintField(5, 42)
  ]);
  const frame = protoField(1, protoField(14, turnEnded));
  assert.deepEqual(cursorAgentEventsFromFrame(frame), [
    {
      type: "usage",
      usage: {
        prompt_tokens: 11859,
        completion_tokens: 85,
        total_tokens: 11944,
        prompt_tokens_details: { cached_tokens: 5760 },
        completion_tokens_details: { reasoning_tokens: 42 }
      }
    },
    { type: "terminal" }
  ]);
});

test("cursor subscription · advertises real Codex functions as native Cursor MCP tools", () => {
  const tools = [{
    type: "function",
    function: {
      name: "exec_command",
      description: "Run a command",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
        additionalProperties: false
      }
    }
  }];
  const framed = buildAgentRun([{ role: "user", content: "read a skill" }], "grok-4.5", { tools });
  const clientMessage = protoFields(framed.subarray(5));
  const run = protoFields(clientMessage.get(1)[0]);
  assert.equal(run.has(4), true);
  const mcpTools = protoFields(run.get(4)[0]);
  assert.equal(mcpTools.get(1).length, 1);
  const definition = protoFields(mcpTools.get(1)[0]);
  assert.equal(definition.get(1)[0].toString(), "exec_command");
  assert.equal(definition.get(5)[0].toString(), "exec_command");
  assert.match(definition.get(2)[0].toString(), /Run a command/);
  assert.doesNotMatch(framed.toString(), /<tool_calls>/);
});

test("cursor subscription · turns a native Cursor MCP execution request into a Codex function call", () => {
  const mcpArgs = Buffer.concat([
    protoField(1, "exec_command"),
    protoField(2, Buffer.concat([
      protoField(1, "cmd"),
      protoField(2, protoField(3, "cat ~/.agents/skills/lark-minutes/SKILL.md"))
    ])),
    protoField(3, "cursor-call-1"),
    protoField(4, "switchyard"),
    protoField(5, "exec_command")
  ]);
  const exec = Buffer.concat([
    protoVarintField(1, 17),
    protoField(15, "exec-17"),
    protoField(11, mcpArgs)
  ]);
  assert.deepEqual(cursorAgentExecutionEvent(protoField(2, exec), ["exec_command"]), {
    type: "tool_call",
    id: "cursor-call-1",
    name: "exec_command",
    arguments: JSON.stringify({ cmd: "cat ~/.agents/skills/lark-minutes/SKILL.md" })
  });
});

test("cursor subscription · maps Cursor's built-in shell request to Codex exec_command instead of waiting", () => {
  const shellArgs = Buffer.concat([
    protoField(1, "cat ~/.agents/skills/lark-minutes/SKILL.md"),
    protoField(2, "/Users/zhangyinglong/Documents/日常闲聊"),
    protoVarintField(3, 30000),
    protoField(4, "shell-call-1")
  ]);
  const exec = Buffer.concat([protoVarintField(1, 8), protoField(2, shellArgs)]);
  assert.deepEqual(cursorAgentExecutionEvent(protoField(2, exec), ["exec_command"]), {
    type: "tool_call",
    id: "shell-call-1",
    name: "exec_command",
    arguments: JSON.stringify({
      cmd: "cat ~/.agents/skills/lark-minutes/SKILL.md",
      workdir: "/Users/zhangyinglong/Documents/日常闲聊",
      yield_time_ms: 30000
    })
  });
});


test("cursor subscription · maps Cursor's built-in read request to exec_command instead of stalling", () => {
  const readArgs = Buffer.concat([
    protoField(1, "/Users/zhangyinglong/.agents/skills/lark-minutes/SKILL.md"),
    protoField(2, "read-call-1"),
    protoVarintField(4, 0),
    protoVarintField(5, 400)
  ]);
  const exec = Buffer.concat([protoVarintField(1, 9), protoField(7, readArgs)]);
  assert.deepEqual(cursorAgentExecutionEvent(protoField(2, exec), ["exec_command"]), {
    type: "tool_call",
    id: "read-call-1",
    name: "exec_command",
    arguments: JSON.stringify({
      cmd: "sed -n '1,400p' '/Users/zhangyinglong/.agents/skills/lark-minutes/SKILL.md'"
    })
  });
});

test("cursor subscription · maps Cursor built-in read to OpenCode read tool", () => {
  const readArgs = Buffer.concat([
    protoField(1, "/Users/zhangyinglong/.agents/skills/lark-shared/SKILL.md"),
    protoField(2, "read-opencode-1"),
    protoVarintField(4, 0),
    protoVarintField(5, 400)
  ]);
  const exec = Buffer.concat([protoVarintField(1, 9), protoField(7, readArgs)]);
  assert.deepEqual(cursorAgentExecutionEvent(protoField(2, exec), [{
    type: "function",
    function: {
      name: "read",
      description: "Read a file from the local filesystem",
      parameters: { type: "object", properties: { filePath: {}, offset: {}, limit: {} }, required: ["filePath"] }
    }
  }]), {
    type: "tool_call",
    id: "read-opencode-1",
    name: "read",
    arguments: JSON.stringify({
      filePath: "/Users/zhangyinglong/.agents/skills/lark-shared/SKILL.md",
      limit: 400
    })
  });
});

test("cursor subscription · maps Cursor built-in shell to OpenCode bash tool", () => {
  const shellArgs = Buffer.concat([
    protoField(1, "lark-cli minutes +search --format json"),
    protoField(2, "/Users/zhangyinglong/file/codex"),
    protoVarintField(3, 30000),
    protoField(4, "bash-opencode-1")
  ]);
  const exec = Buffer.concat([protoVarintField(1, 8), protoField(2, shellArgs)]);
  assert.deepEqual(cursorAgentExecutionEvent(protoField(2, exec), [{
    type: "function",
    function: {
      name: "bash",
      description: "Execute a bash command",
      parameters: { type: "object", properties: { command: {}, workdir: {}, timeout: {} }, required: ["command"] }
    }
  }]), {
    type: "tool_call",
    id: "bash-opencode-1",
    name: "bash",
    arguments: JSON.stringify({
      command: "lark-cli minutes +search --format json",
      workdir: "/Users/zhangyinglong/file/codex",
      timeout: 30000
    })
  });
});

test("cursor subscription · unknown exec field returns cursor_builtin unsupported execution", () => {
  // An exec payload containing only an unrecognized field (e.g. field 9,
  // which might correspond to a new Cursor built-in like edit_file) should
  // be reported as cursor_builtin rather than crashing the stream.
  const unknownExec = Buffer.concat([
    protoVarintField(1, 99),
    protoField(9, Buffer.concat([
      protoField(1, "/some/file/path"),
      protoField(2, "new-content")
    ]))
  ]);
  assert.deepEqual(cursorAgentExecutionEvent(protoField(2, unknownExec), ["exec_command"]), {
    type: "unsupported_execution",
    execution: "cursor_builtin"
  });
});

test("cursor subscription · cursor_builtin degraded gracefully preserves prior text via collectCursorSubscriptionResponse", async () => {
  // Simulate the degraded event sequence that http2AgentEventsOnce now
  // yields for an unsupported execution: text already received, then a
  // notice, then terminal. collectCursorSubscriptionResponse should return
  // the accumulated text without throwing.
  async function* mockEvents() {
    yield { type: "text", text: "Here is some model output before the error." };
    yield { type: "text", text: "\n\n[switchyard] Cursor requested an unsupported built-in execution (cursor_builtin). Ending the turn to preserve output already received." };
    yield { type: "terminal" };
  }
  const response = await collectCursorSubscriptionResponse("gpt-4", mockEvents());
  assert.equal(response.choices[0].finish_reason, "stop");
  assert.match(response.choices[0].message.content, /Here is some model output/);
  assert.match(response.choices[0].message.content, /unsupported built-in execution/);
});

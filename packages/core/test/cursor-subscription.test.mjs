import test from "node:test";
import assert from "node:assert/strict";

import {
  clearCursorSubscriptionCredentials,
  loadCursorSubscriptionCredentials,
  saveCursorSubscriptionCredentials
} from "../src/cursor-subscription/auth.mjs";
import {
  assertCursorSubscriptionRequest,
  normalizeCursorSubscriptionProvider
} from "../src/cursor-subscription/model-catalog.mjs";
import { createCursorSubscriptionLane } from "../src/cursor-subscription/rate-limit.mjs";

const validCredentials = { accessToken: "a".repeat(64), machineId: "12345678-1234-1234-1234-123456789abc" };

test("cursor subscription · provider is opt-in, local-only, single-concurrency and never serializes credentials", () => {
  const provider = normalizeCursorSubscriptionProvider({
    id: "cursor-subscription",
    providerType: "cursor_subscription",
    baseUrl: "https://agent.api5.cursor.sh",
    accessToken: validCredentials.accessToken,
    machineId: validCredentials.machineId,
    maxConcurrentRequests: 99
  });
  assert.equal(provider.enabled, false);
  assert.equal(provider.maxConcurrentRequests, 1);
  assert.equal(provider.streamIdleTimeoutMs, 600000);
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

test("cursor subscription · accepts only text conversation without tools, images, or tool results", () => {
  assert.doesNotThrow(() => assertCursorSubscriptionRequest({ messages: [
    { role: "system", content: "Be concise" },
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ] }));
  for (const request of [
    { messages: [{ role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,x" }] }] },
    { messages: [{ role: "tool", content: "result" }] },
    { messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_1" }] }] },
    { messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "x" } }] }
  ]) {
    assert.throws(() => assertCursorSubscriptionRequest(request), (err) => err?.code === "CURSOR_SUBSCRIPTION_UNSUPPORTED_REQUEST");
  }
});

test("cursor subscription · serializes one account and opens a short circuit after upstream failures", async () => {
  const lane = createCursorSubscriptionLane({ cooldownMs: 1000, failureThreshold: 2 });
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

import { callCursorSubscription, clearCursorSubscriptionRuntime, cursorSubscriptionLaneSnapshot } from "../src/cursor-subscription/client.mjs";
import { dispatchChat } from "../src/upstream/dispatch.mjs";

function fakeKeychain(credentials = validCredentials) {
  return { get: () => JSON.stringify(credentials) };
}

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
  const lane = createCursorSubscriptionLane({ cooldownMs: 1000, failureThreshold: 1 });
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

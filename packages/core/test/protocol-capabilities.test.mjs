import test from "node:test";
import assert from "node:assert/strict";
import {
  describeProtocolRoute,
  providerProtocolCapabilities
} from "../src/protocol-capabilities.mjs";

test("protocol capabilities prefer a native provider protocol", () => {
  const profile = describeProtocolRoute({ clientProtocol: "openai_responses", provider: { apiFormat: "openai_responses" } });
  assert.equal(profile.mode, "native");
  assert.deepEqual(profile.steps, ["openai_responses"]);
  assert.equal(profile.lossless, true);
});

test("protocol capabilities make multi-hop conversions explicit", () => {
  const profile = describeProtocolRoute({ clientProtocol: "anthropic_messages", provider: { apiFormat: "openai_responses" } });
  assert.equal(profile.mode, "convert");
  assert.deepEqual(profile.steps, ["anthropic_messages", "openai_chat", "openai_responses"]);
  assert.equal(profile.lossless, false);
});

test("cursor subscription exposes its canonical chat bridge and feature limits", () => {
  const profile = providerProtocolCapabilities({ apiFormat: "cursor_subscription" });
  assert.equal(profile.canonicalProtocol, "openai_chat");
  assert.equal(profile.features.streaming, true);
  assert.equal(profile.features.toolCalls, true);
  assert.equal(profile.features.nativeResponses, false);
});

test("server native routing reports the exact conversion chain", async () => {
  const { nativeRoutingDecision } = await import("../src/server.mjs");
  const routing = nativeRoutingDecision({ id: "claude", apiFormat: "anthropic_messages" }, "openai_responses");
  assert.equal(routing.native, false);
  assert.deepEqual(routing.protocolRoute.steps, ["openai_responses", "openai_chat", "anthropic_messages"]);
});

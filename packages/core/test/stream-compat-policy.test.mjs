import test from "node:test";
import assert from "node:assert/strict";
import { streamCompatPolicy } from "../src/stream-compat-policy.mjs";

test("Kimi K3 relay keeps usage footer EOF incomplete by default", () => {
  const policy = streamCompatPolicy({ provider: { id: "ke" }, model: { upstreamModel: "kimi-k3" }, protocol: "responses" });
  assert.equal(policy.acceptUsageFooterAsTerminal, false);
  assert.equal(policy.retryPreludeOnEof, true);
  assert.equal(policy.preludeRetryAttempts, 1);
  assert.equal(policy.knownNonstandardSse, true);
});

test("KE GPT-5.6 Sol retries an empty Responses prelude twice with short backoff", () => {
  const policy = streamCompatPolicy({ provider: { id: "ke" }, model: { upstreamModel: "gpt-5.6-sol" }, protocol: "responses" });
  assert.equal(policy.retryPreludeOnEof, true);
  assert.equal(policy.preludeRetryAttempts, 2);
  assert.deepEqual(policy.preludeRetryBackoffMs, [250, 750]);
  assert.equal(policy.knownNonstandardSse, true);
});

test("explicit stream compatibility settings override built-ins", () => {
  const policy = streamCompatPolicy({ provider: { id: "ke", streamCompat: { acceptUsageFooterAsTerminal: true, retryPreludeOnEof: false, preludeRetryAttempts: 3, idleTimeoutMs: 1234 } }, model: { upstreamModel: "kimi-k3" } });
  assert.equal(policy.acceptUsageFooterAsTerminal, true);
  assert.equal(policy.retryPreludeOnEof, false);
  assert.equal(policy.preludeRetryAttempts, 0);
  assert.equal(policy.idleTimeoutMs, 1234);
});

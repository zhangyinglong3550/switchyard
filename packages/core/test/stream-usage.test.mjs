import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUsageToRequestRecord,
  cacheHitRatePercent,
  extractCacheCreationTokens,
  extractCacheReadTokens,
  extractUsageFromSseDataLine,
  extractUsageFromSseJson,
  mergeUsage,
  normalizeUsageObject
} from "../src/stream-usage.mjs";

test("extractUsageFromSseJson · Responses response.completed", () => {
  const usage = extractUsageFromSseJson({
    type: "response.completed",
    response: {
      usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 }
    }
  });
  assert.deepEqual(usage, {
    prompt_tokens: 100,
    completion_tokens: 40,
    total_tokens: 140,
    cache_read_tokens: 0,
    cache_creation_tokens: 0
  });
});

test("extractUsageFromSseJson · Chat final usage chunk", () => {
  const usage = extractUsageFromSseJson({
    id: "chatcmpl_x",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
  });
  assert.equal(usage.prompt_tokens, 12);
  assert.equal(usage.completion_tokens, 8);
  assert.equal(usage.total_tokens, 20);
  assert.equal(usage.cache_read_tokens, 0);
});

test("extractUsageFromSseDataLine · ignores DONE and invalid", () => {
  assert.equal(extractUsageFromSseDataLine("[DONE]"), null);
  assert.equal(extractUsageFromSseDataLine("not-json"), null);
  assert.ok(extractUsageFromSseDataLine(JSON.stringify({
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  })));
});

test("mergeUsage keeps larger total", () => {
  const a = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 };
  const b = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_read_tokens: 0, cache_creation_tokens: 0 };
  assert.equal(mergeUsage(a, b).total_tokens, 15);
  assert.equal(mergeUsage(b, a).total_tokens, 15);
});

test("mergeUsage keeps max cache fields across partial chunks", () => {
  const partial = { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1, cache_read_tokens: 50, cache_creation_tokens: 0 };
  const full = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cache_read_tokens: 0, cache_creation_tokens: 20 };
  const merged = mergeUsage(partial, full);
  assert.equal(merged.total_tokens, 110);
  assert.equal(merged.cache_read_tokens, 50);
  assert.equal(merged.cache_creation_tokens, 20);
});

test("applyUsageToRequestRecord writes token fields for request_logs", () => {
  const record = {};
  applyUsageToRequestRecord(record, {
    input_tokens: 30,
    output_tokens: 10,
    total_tokens: 40
  });
  assert.equal(record.promptTokens, 30);
  assert.equal(record.completionTokens, 10);
  assert.equal(record.totalTokens, 40);
  assert.equal(record.cacheReadTokens, 0);
  assert.equal(record.cacheCreationTokens, 0);
});

test("normalizeUsageObject returns null when empty", () => {
  assert.equal(normalizeUsageObject({}), null);
  assert.equal(normalizeUsageObject(null), null);
});

test("normalizeUsageObject · Anthropic cache_read / cache_creation", () => {
  const usage = normalizeUsageObject({
    input_tokens: 1000,
    output_tokens: 20,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100
  });
  assert.equal(usage.prompt_tokens, 1000);
  assert.equal(usage.cache_read_tokens, 800);
  assert.equal(usage.cache_creation_tokens, 100);
});

test("normalizeUsageObject · OpenAI / Responses input_tokens_details.cached_tokens", () => {
  const usage = normalizeUsageObject({
    input_tokens: 24,
    output_tokens: 18,
    input_tokens_details: { cached_tokens: 16, cache_write_tokens: 2 }
  });
  assert.equal(usage.cache_read_tokens, 16);
  assert.equal(usage.cache_creation_tokens, 2);
});

test("normalizeUsageObject · prompt_tokens_details.cached_tokens", () => {
  const usage = normalizeUsageObject({
    prompt_tokens: 50,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 }
  });
  assert.equal(usage.cache_read_tokens, 40);
  assert.equal(usage.cache_creation_tokens, 3);
});

test("normalizeUsageObject · Gemini-style cachedContentTokenCount", () => {
  const usage = normalizeUsageObject({
    prompt_tokens: 200,
    completion_tokens: 10,
    cachedContentTokenCount: 150
  });
  assert.equal(usage.cache_read_tokens, 150);
});

test("extractCache helpers · priority order", () => {
  assert.equal(extractCacheReadTokens({
    cache_read_input_tokens: 1,
    cached_tokens: 99
  }), 1);
  assert.equal(extractCacheCreationTokens({
    cache_creation_input_tokens: 2,
    cache_write_tokens: 99
  }), 2);
});

test("applyUsageToRequestRecord writes cache fields", () => {
  const record = {};
  applyUsageToRequestRecord(record, {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 70,
    cache_creation_input_tokens: 5
  });
  assert.equal(record.cacheReadTokens, 70);
  assert.equal(record.cacheCreationTokens, 5);
});

test("cacheHitRatePercent · CC Switch style cr/inp", () => {
  assert.equal(cacheHitRatePercent(716, 1000), 71.6);
  assert.equal(cacheHitRatePercent(0, 100), 0);
  assert.equal(cacheHitRatePercent(50, 0), null);
  assert.equal(cacheHitRatePercent(200, 100), 100); // cap
});

test("extractUsageFromSseJson · Anthropic message_delta with cache", () => {
  const usage = extractUsageFromSseJson({
    type: "message_delta",
    usage: {
      input_tokens: 500,
      output_tokens: 12,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 50
    }
  });
  assert.equal(usage.cache_read_tokens, 400);
  assert.equal(usage.cache_creation_tokens, 50);
});

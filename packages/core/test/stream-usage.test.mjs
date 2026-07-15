import test from "node:test";
import assert from "node:assert/strict";
import {
  applyUsageToRequestRecord,
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
    total_tokens: 140
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
});

test("extractUsageFromSseDataLine · ignores DONE and invalid", () => {
  assert.equal(extractUsageFromSseDataLine("[DONE]"), null);
  assert.equal(extractUsageFromSseDataLine("not-json"), null);
  assert.ok(extractUsageFromSseDataLine(JSON.stringify({
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  })));
});

test("mergeUsage keeps larger total", () => {
  const a = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  const b = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  assert.equal(mergeUsage(a, b).total_tokens, 15);
  assert.equal(mergeUsage(b, a).total_tokens, 15);
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
});

test("normalizeUsageObject returns null when empty", () => {
  assert.equal(normalizeUsageObject({}), null);
  assert.equal(normalizeUsageObject(null), null);
});

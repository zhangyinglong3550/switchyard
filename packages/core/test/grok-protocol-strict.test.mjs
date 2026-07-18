import test from "node:test";
import assert from "node:assert/strict";

import { grokProtocolStrictPatch } from "../src/compat/patches/grok-protocol-strict.mjs";

const VALID_CHUNK = 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}';

test("grok-protocol-strict · only matches grok clientId", () => {
  assert.equal(grokProtocolStrictPatch.match({ clientId: "grok" }), true);
  assert.equal(grokProtocolStrictPatch.match({ clientId: "codex" }), false);
  assert.equal(grokProtocolStrictPatch.match({ clientId: "opencode" }), false);
  assert.equal(grokProtocolStrictPatch.match({}), false);
  assert.equal(grokProtocolStrictPatch.match(undefined), false);
});

test("grok-protocol-strict · keeps valid OpenAI chunk as-is", () => {
  assert.equal(grokProtocolStrictPatch.streamLine(VALID_CHUNK), VALID_CHUNK);
});

test("grok-protocol-strict · keeps [DONE] marker", () => {
  assert.equal(grokProtocolStrictPatch.streamLine("data: [DONE]"), "data: [DONE]");
});

test("grok-protocol-strict · drops chunk missing id", () => {
  const line = 'data: {"choices":[],"x-opencode-type":"inference-cost","cost":"0.00191610"}';
  assert.equal(grokProtocolStrictPatch.streamLine(line), null);
});

test("grok-protocol-strict · drops chunk missing model/created/object", () => {
  const line = 'data: {"id":"chatcmpl-1","choices":[]}';
  assert.equal(grokProtocolStrictPatch.streamLine(line), null);
});

test("grok-protocol-strict · drops trailing cost chunk after [DONE]", () => {
  const line = 'data: {"choices":[],"cost":"0"}';
  assert.equal(grokProtocolStrictPatch.streamLine(line), null);
});

test("grok-protocol-strict · drops chunk with non-array choices", () => {
  const line = 'data: {"id":"a","object":"chat.completion.chunk","created":1,"model":"m","choices":null}';
  assert.equal(grokProtocolStrictPatch.streamLine(line), null);
});

test("grok-protocol-strict · drops non-JSON data line", () => {
  assert.equal(grokProtocolStrictPatch.streamLine("data: <not-json>"), null);
});

test("grok-protocol-strict · keeps empty line untouched", () => {
  // 空行由 pipeStream 上层负责处理（写成 \\n），patch 不动
  assert.equal(grokProtocolStrictPatch.streamLine(""), "");
});

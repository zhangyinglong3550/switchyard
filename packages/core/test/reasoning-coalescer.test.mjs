import test from "node:test";
import assert from "node:assert/strict";

import { createReasoningCoalescer } from "../src/reasoning-coalescer.mjs";

function chunk(text, extra = {}) {
  return "data: " + JSON.stringify({
    id: "chatcmpl-1",
    model: "deepseek-v4.1-flash",
    choices: [{ index: 0, delta: { reasoning_content: text, ...extra }, finish_reason: "" }]
  });
}

function contentChunk(text) {
  return "data: " + JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { content: text, reasoning_content: "" }, finish_reason: "" }]
  });
}

function doneChunk() {
  return "data: " + JSON.stringify({
    id: "chatcmpl-1",
    choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "" }, finish_reason: "stop" }]
  });
}

function collect() {
  const lines = [];
  const coalescer = createReasoningCoalescer({ maxChars: 20, flushMs: 0, write: (line) => lines.push(line) });
  return { lines, coalescer };
}

test("reasoning coalescer · 连续思考分片合并为一帧", () => {
  const { lines, coalescer } = collect();
  for (const word of ["We", " need", " answer", " in"]) coalescer.push(chunk(word));
  assert.equal(lines.length, 0, "阈值未到且有后续时不应提前下发");
  coalescer.push(contentChunk("结论"));
  assert.equal(lines.length, 2, "遇到正文时应先 flush 合并帧再下发正文");
  const merged = JSON.parse(lines[0].slice(5));
  assert.equal(merged.choices[0].delta.reasoning_content, "We need answer in");
  assert.equal(merged.choices[0].delta.content, undefined, "合并帧只带思考，不得混入正文");
  assert.equal(JSON.parse(lines[1].slice(5)).choices[0].delta.content, "结论");
});

test("reasoning coalescer · 达到字数阈值立即下发", () => {
  const { lines, coalescer } = collect();
  coalescer.push(chunk("一二三四五六七八九十一二三四五六七八九十"));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0].slice(5)).choices[0].delta.reasoning_content.length, 20);
});

test("reasoning coalescer · 结束帧前清空暂存思考", () => {
  const { lines, coalescer } = collect();
  coalescer.push(chunk("保留"));
  coalescer.push(doneChunk());
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0].slice(5)).choices[0].delta.reasoning_content, "保留");
  assert.equal(JSON.parse(lines[1].slice(5)).choices[0].finish_reason, "stop");
});

test("reasoning coalescer · 工具调用帧不参与合并", () => {
  const { lines, coalescer } = collect();
  const toolLine = "data: " + JSON.stringify({
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "f", arguments: "{}" } }] }, finish_reason: "" }]
  });
  coalescer.push(chunk("想一下"));
  coalescer.push(toolLine);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0].slice(5)).choices[0].delta.reasoning_content, "想一下");
  assert.equal(JSON.parse(lines[1].slice(5)).choices[0].delta.tool_calls[0].function.name, "f");
});

test("reasoning coalescer · 非 SSE 行（心跳/注释）原样透传且不打断合并语义", () => {
  const { lines, coalescer } = collect();
  coalescer.push(": keepalive");
  assert.equal(lines.length, 1);
  assert.equal(lines[0], ": keepalive");
});

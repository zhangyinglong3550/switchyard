import test from "node:test";
import assert from "node:assert/strict";

import { thinkTagSplitPatch } from "../src/compat/patches/think-tag-split.mjs";

const KE_MINIMAX = {
  provider: { id: "ke", name: "KE", baseUrl: "https://openapi-ait.ke.com/v1", apiFormat: "openai_chat" },
  model: { id: "ke/MiniMax-M2.7", providerId: "ke", upstreamModel: "MiniMax-M2.7", aliases: ["MiniMax-M2.7"] },
  clientId: ""
};

function freshCtx(base = KE_MINIMAX) {
  return { ...base };
}

function deltaOf(line) {
  if (line == null) return null;
  const payload = line.replace(/^data:\s*/, "");
  return JSON.parse(payload).choices[0].delta;
}

function feed(lines, ctx) {
  return lines.map((line) => deltaOf(thinkTagSplitPatch.streamLine(line, ctx)));
}

function chunk(content, extra = {}) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "MiniMax-M2.7",
    choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }]
  })}`;
}

test("think-tag-split · only matches reasoning-model providers", () => {
  assert.equal(thinkTagSplitPatch.match(KE_MINIMAX), true);
  assert.equal(
    thinkTagSplitPatch.match({
      provider: { id: "blank-gpt", baseUrl: "https://blankapi.com/v1" },
      model: { id: "blank-gpt/gpt-5.6-terra" }
    }),
    false
  );
});

test("think-tag-split · moves a leading think block into reasoning_content", () => {
  const ctx = freshCtx();
  const out = feed([chunk("<think>Need to reason.</think>Final answer")], ctx);
  assert.equal(out.length, 1);
  assert.equal(out[0].reasoning_content, "Need to reason.");
  assert.equal(out[0].content, "Final answer");
});

test("think-tag-split · keeps thinking deltas on reasoning_content across the block", () => {
  const ctx = freshCtx();
  const out = feed([
    chunk("<think>"),
    chunk("The user asks"),
    chunk(" in Chinese."),
    chunk("</think>"),
    chunk("答案")
  ], ctx);

  // 思考阶段：全部落到 reasoning_content，content 不出现
  assert.equal(out[1].reasoning_content, "The user asks");
  assert.equal(out[1].content, undefined);
  assert.equal(out[2].reasoning_content, " in Chinese.");
  assert.equal(out[2].content, undefined);
  // 标签之后：正文
  assert.equal(out[4].content, "答案");
  assert.equal(out[4].reasoning_content, undefined);
  // 思考文本拼起来完整无缺
  const reasoning = out.map((d) => d?.reasoning_content || "").join("");
  assert.equal(reasoning, "The user asks in Chinese.");
});

test("think-tag-split · reassembles an open tag split across deltas", () => {
  const ctx = freshCtx();
  const out = feed([
    chunk("<thi"),
    chunk("nk>reasoning"),
    chunk("</think>"),
    chunk("answer")
  ], ctx);
  const reasoning = out.map((d) => d?.reasoning_content || "").join("");
  const content = out.map((d) => d?.content || "").join("");
  assert.equal(reasoning, "reasoning");
  assert.equal(content, "answer");
});

test("think-tag-split · reassembles a close tag split across deltas", () => {
  const ctx = freshCtx();
  const out = feed([
    chunk("<think>done</thi"),
    chunk("nk>answer")
  ], ctx);
  const reasoning = out.map((d) => d?.reasoning_content || "").join("");
  const content = out.map((d) => d?.content || "").join("");
  assert.equal(reasoning, "done");
  assert.equal(content, "answer");
});

test("think-tag-split · leaves content without a leading think block untouched", () => {
  const ctx = freshCtx();
  const line = chunk("天空是蓝色的，因为瑞利散射。");
  assert.equal(thinkTagSplitPatch.streamLine(line, ctx), line);
});

test("think-tag-split · does not touch a think tag that is not leading", () => {
  const ctx = freshCtx();
  const out = feed([
    chunk("先解释用法："),
    chunk("写作 <think>你的推理</think> 即可。")
  ], ctx);
  // 首个非空内容不是 <think>，此后一律透传，不做任何拆分
  const content = out.map((d) => d?.content || "").join("");
  assert.equal(content, "先解释用法：写作 <think>你的推理</think> 即可。");
  assert.equal(out.every((d) => d?.reasoning_content === undefined), true);
});

test("think-tag-split · preserves role and other delta fields", () => {
  const ctx = freshCtx();
  const out = feed([chunk("<think>x</think>y", { role: "assistant" })], ctx);
  assert.equal(out[0].role, "assistant");
  assert.equal(out[0].reasoning_content, "x");
  assert.equal(out[0].content, "y");
});

test("think-tag-split · keeps finish_reason chunk intact", () => {
  const ctx = freshCtx();
  const line = `data: ${JSON.stringify({
    id: "c", object: "chat.completion.chunk", created: 1, model: "m",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  })}`;
  assert.equal(thinkTagSplitPatch.streamLine(line, ctx), line);
});

test("think-tag-split · state is isolated per request context", () => {
  const a = freshCtx();
  const b = freshCtx();
  // a 进入思考态但未闭合
  thinkTagSplitPatch.streamLine(chunk("<think>a-thinking"), a);
  // b 是全新请求，不应受 a 的状态影响
  const line = chunk("普通正文");
  assert.equal(thinkTagSplitPatch.streamLine(line, b), line);
});

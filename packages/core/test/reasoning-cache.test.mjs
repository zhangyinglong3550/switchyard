import test from "node:test";
import assert from "node:assert/strict";

import {
  createReasoningCache,
  resolveReasoningCacheKey,
  assistantFingerprint
} from "../src/reasoning-cache.mjs";

test("reasoning cache · 会话键优先显式 id，其次 sessionKey，最后首条 user 指纹", () => {
  assert.equal(resolveReasoningCacheKey({ conversation_id: "conv-1" }, { clientId: "generic-openai" }), "sid:generic-openai::conv-1");
  assert.equal(resolveReasoningCacheKey({}, { clientId: "generic-openai", sessionKey: "sess-9" }), "sess:generic-openai::sess-9");
  const keyA = resolveReasoningCacheKey({ messages: [{ role: "user", content: "同一个问题" }] }, { clientId: "generic-openai" });
  const keyB = resolveReasoningCacheKey({ messages: [{ role: "user", content: "同一个问题" }] }, { clientId: "generic-openai" });
  const keyC = resolveReasoningCacheKey({ messages: [{ role: "user", content: "另一个问题" }] }, { clientId: "generic-openai" });
  assert.equal(keyA, keyB);
  assert.notEqual(keyA, keyC);
  assert.equal(resolveReasoningCacheKey({ messages: [] }, {}), "");
});

test("reasoning cache · 按 assistant 文本回填思考，匹配不上不填", () => {
  const cache = createReasoningCache();
  const key = "sid:test::conv-1";
  assert.equal(cache.remember(key, "最终回答内容", "这是上一轮的思考"), true);

  const body = {
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "最终回答内容" },
      { role: "user", content: "u2" }
    ]
  };
  assert.equal(cache.apply(body, key), 1);
  assert.equal(body.messages[2].reasoning_content, "这是上一轮的思考");
  // 已有思考不覆盖
  body.messages[2].reasoning_content = "客户端自己回传的思考";
  assert.equal(cache.apply(body, key), 0);
  assert.equal(body.messages[2].reasoning_content, "客户端自己回传的思考");
  // 文本对不上（被编辑/错位）→ 不填
  const other = { messages: [{ role: "assistant", content: "被改写过的回答" }] };
  assert.equal(cache.apply(other, key), 0);
  assert.equal(other.messages[0].reasoning_content, undefined);
});

test("reasoning cache · TTL 过期与容量上限", () => {
  let now = 1000;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const cache = createReasoningCache({ ttlMs: 1000 });
    cache.remember("k1", "回答", "思考");
    const body = { messages: [{ role: "assistant", content: "回答" }] };
    assert.equal(cache.apply(body, "k1"), 1);

    // 过期后不再命中
    now += 2000;
    const expired = { messages: [{ role: "assistant", content: "回答" }] };
    assert.equal(cache.apply(expired, "k1"), 0);
    assert.equal(expired.messages[0].reasoning_content, undefined);

    // 容量上限：只保留最新若干个会话
    const small = createReasoningCache({ maxSessions: 2 });
    small.remember("a", "a", "ta");
    now += 1;
    small.remember("b", "b", "tb");
    now += 1;
    small.remember("c", "c", "tc");
    assert.equal(small.size(), 2);
    assert.equal(small.apply({ messages: [{ role: "assistant", content: "a" }] }, "a"), 0);
    assert.equal(small.apply({ messages: [{ role: "assistant", content: "c" }] }, "c"), 1);
  } finally {
    Date.now = originalNow;
  }
});

test("reasoning cache · 指纹稳定且随内容变化", () => {
  assert.equal(assistantFingerprint("一样的内容"), assistantFingerprint("一样的内容"));
  assert.notEqual(assistantFingerprint("内容 A"), assistantFingerprint("内容 B"));
  assert.equal(assistantFingerprint("   "), "");
});

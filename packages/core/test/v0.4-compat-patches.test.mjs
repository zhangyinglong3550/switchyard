import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPatch, applyOutbound, applyInbound, applyStreamLine, resetPatches, listPatchIds } from "../src/compat/index.mjs";
import { kimiToolSchemaPatch } from "../src/compat/patches/kimi-tool-schema.mjs";
import { deepseekReasoningPatch } from "../src/compat/patches/deepseek-reasoning.mjs";
import { glmContentTextPatch } from "../src/compat/patches/glm-content-text.mjs";
import { opencodeToolHistoryPatch } from "../src/compat/patches/opencode-tool-history.mjs";
import { officialGPTFallbackPatch } from "../src/compat/patches/official-gpt-fallback.mjs";

// Helper: register a single test patch, run the test, then reset.
function testPatch(name, fn) {
  test(name, () => {
    resetPatches();
    try { fn(); } finally { resetPatches(); }
  });
}

// ── 1. Kimi tool schema sanitizer ──────────────────────────────────────────

testPatch("kimi-tool-schema · strips $schema, examples, anyOf wrappers from Kimi function parameters", () => {
  registerPatch(kimiToolSchemaPatch.id, kimiToolSchemaPatch);
  const ctx = { provider: { id: "kimi" }, model: { id: "kimi/k2" } };

  const body = {
    model: "kimi/k2",
    tools: [{
      type: "function",
      function: {
        name: "search",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "search-v1",
          type: "object",
          properties: { q: { type: "string" } },
          examples: ["hello"],
          anyOf: [{ type: "string" }]
        }
      }
    }]
  };

  const out = applyOutbound(body, ctx);
  const params = out.tools[0].function.parameters;
  assert.equal(params.$schema, undefined, "$schema stripped");
  assert.equal(params.$id, undefined, "$id stripped");
  assert.equal(params.examples, undefined, "examples stripped");
  assert.equal(params.anyOf, undefined, "anyOf wrapper stripped");
  assert.ok(params.properties, "properties preserved");
});

testPatch("kimi-tool-schema · does NOT touch non-Kimi providers", () => {
  registerPatch(kimiToolSchemaPatch.id, kimiToolSchemaPatch);
  const body = {
    model: "other/m",
    tools: [{
      type: "function",
      function: { name: "f", parameters: { $schema: "x" } }
    }]
  };
  const out = applyOutbound(body, { provider: { id: "xyz" }, model: { id: "xyz/m" } });
  assert.equal(out.tools[0].function.parameters.$schema, "x");
});

// ── 2. DeepSeek reasoning_content ──────────────────────────────────────────

testPatch("deepseek-reasoning · strips reasoning_content from non-stream response", () => {
  registerPatch(deepseekReasoningPatch.id, deepseekReasoningPatch);
  const ctx = { provider: { id: "deepseek" }, model: { id: "deepseek/v4" } };

  const payload = {
    id: "x",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "Hello",
        reasoning_content: "I'm thinking..."
      }
    }]
  };

  const out = applyInbound(payload, ctx);
  assert.equal(out.choices[0].message.content, "Hello");
  assert.equal(out.choices[0].message.reasoning_content, undefined);
});

testPatch("deepseek-reasoning · strips reasoning_content from stream delta", () => {
  registerPatch(deepseekReasoningPatch.id, deepseekReasoningPatch);
  const ctx = { provider: { id: "deepseek" }, model: { id: "deepseek/v4" } };

  const streamLine = 'data: {"choices":[{"index":0,"delta":{"content":"Hi","reasoning_content":"..."}}]}';
  const out = applyStreamLine(streamLine, ctx);
  const parsed = JSON.parse(out.replace("data: ", ""));
  assert.equal(parsed.choices[0].delta.content, "Hi");
  assert.equal(parsed.choices[0].delta.reasoning_content, undefined);
});

testPatch("deepseek-reasoning · does NOT affect non-DeepSeek providers", () => {
  registerPatch(deepseekReasoningPatch.id, deepseekReasoningPatch);
  const payload = { choices: [{ message: { content: "Hi", reasoning_content: "thinking" } }] };
  const out = applyInbound(payload, { provider: { id: "claude" }, model: { id: "claude/sonnet" } });
  assert.ok(out.choices[0].message.reasoning_content, "kept for non-DeepSeek");
});

// ── 3. GLM content.text ────────────────────────────────────────────────────

testPatch("glm-content-text · wraps bare string content into array for GLM providers", () => {
  registerPatch(glmContentTextPatch.id, glmContentTextPatch);
  const ctx = { provider: { id: "coding-plan" }, model: { id: "coding-plan/glm-5.2" } };

  const body = {
    model: "glm-5.2",
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hi" }
    ]
  };

  const out = applyOutbound(body, ctx);
  assert.ok(Array.isArray(out.messages[0].content), "system content became array");
  assert.ok(Array.isArray(out.messages[1].content), "user content became array");
  assert.equal(out.messages[1].content[0].type, "text");
  assert.equal(out.messages[1].content[0].text, "Hi");
});

testPatch("glm-content-text · does NOT affect non-GLM providers", () => {
  registerPatch(glmContentTextPatch.id, glmContentTextPatch);
  const body = { messages: [{ role: "user", content: "plain" }] };
  const out = applyOutbound(body, { provider: { id: "openai" }, model: { id: "gpt-4" } });
  assert.equal(typeof out.messages[0].content, "string");
});

// ── 4. OpenCode Go tool history ────────────────────────────────────────────

testPatch("opencode-tool-history · reorders tool_results after their assistant message", () => {
  registerPatch(opencodeToolHistoryPatch.id, opencodeToolHistoryPatch);
  const ctx = { provider: { id: "opencode-go" }, model: { id: "opencode-go/kimi-k2.7" } };

  const body = {
    messages: [
      { role: "user", content: "calc" },
      { role: "tool", content: "42" },        // tool result BEFORE assistant
      { role: "assistant", content: "prev", tool_calls: [{ id: "c1" }] },
      { role: "user", content: "next" }
    ]
  };

  const out = applyOutbound(body, ctx);
  // The 'tool' message should be AFTER the assistant that produced it
  const asstIdx = out.messages.findIndex((m) => m.role === "assistant" && m.tool_calls);
  const toolIdx = out.messages.findIndex((m) => m.role === "tool");
  assert.ok(asstIdx < toolIdx, "tool result after assistant message");
});

testPatch("opencode-tool-history · preserves message count", () => {
  registerPatch(opencodeToolHistoryPatch.id, opencodeToolHistoryPatch);
  const ctx = { provider: { id: "opencode-go" }, model: { id: "opencode-go/m" } };
  const body = {
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  };
  const out = applyOutbound(body, ctx);
  assert.equal(out.messages.length, 2);
});

// ── 5. Official GPT fallback ───────────────────────────────────────────────

testPatch("official-gpt-fallback · sets default max_tokens when absent", () => {
  registerPatch(officialGPTFallbackPatch.id, officialGPTFallbackPatch);
  const ctx = { provider: { id: "codex" }, model: { id: "codex/gpt-5.5" } };

  const body = { model: "gpt-5.5", messages: [] };
  const out = applyOutbound(body, ctx);
  assert.equal(out.max_tokens, 4096);
});

testPatch("official-gpt-fallback · strips GPT-unsupported parameters", () => {
  registerPatch(officialGPTFallbackPatch.id, officialGPTFallbackPatch);
  const ctx = { provider: { id: "codex" }, model: { id: "codex/gpt-5.5" } };

  const body = {
    model: "gpt-5.5",
    messages: [],
    max_tokens: 8000,
    top_k: 40,
    min_p: 0.1
  };
  const out = applyOutbound(body, ctx);
  assert.equal(out.max_tokens, 8000, "max_tokens preserved");
  assert.equal(out.top_k, undefined, "top_k stripped");
  assert.equal(out.min_p, undefined, "min_p stripped");
});

// ── Cross-patch isolation ──────────────────────────────────────────────────

test("v0.4-patches · all 5 patches registered simultaneously do not interfere", () => {
  resetPatches();
  const patches = [
    kimiToolSchemaPatch,
    deepseekReasoningPatch,
    glmContentTextPatch,
    opencodeToolHistoryPatch,
    officialGPTFallbackPatch
  ];
  for (const p of patches) registerPatch(p.id, p);

  const ids = listPatchIds().sort();
  assert.deepEqual(ids, [
    "deepseek-reasoning",
    "glm-content-text",
    "kimi-tool-schema",
    "official-gpt-fallback",
    "opencode-tool-history"
  ]);

  // Each patch activates ONLY on its own provider
  function check(providerId, modelId, field, value) {
    const ctx = { provider: { id: providerId }, model: { id: modelId } };
    const out = applyOutbound({ model: modelId, messages: [{ role: "user", content: "hi" }], top_k: 0 }, ctx);
    if (field) return out[field];
    return out;
  }

  // Kimi gets sanitizer (tools stripped correctly)
  const kimi = applyOutbound({ model: "kimi/k2", tools: [{ type: "function", function: { name: "f", parameters: { $schema: "x", type: "object" } } }], messages: [] }, { provider: { id: "kimi" }, model: { id: "kimi/k2" } });
  assert.equal(kimi.tools[0].function.parameters.$schema, undefined);

  // DeepSeek gets reasoning strip (inbound)
  const dsIn = applyInbound({ choices: [{ message: { content: "hi", reasoning_content: "..." } }] }, { provider: { id: "deepseek" }, model: { id: "deepseek/v4" } });
  assert.equal(dsIn.choices[0].message.reasoning_content, undefined);

  // GLM gets content wrapping
  const glm = applyOutbound({ model: "glm-5.2", messages: [{ role: "user", content: "hi" }] }, { provider: { id: "coding-plan" }, model: { id: "coding-plan/glm-5.2" } });
  assert.ok(Array.isArray(glm.messages[0].content));

  // OpenCode gets reordering (verify tool messages ordered)
  const oc = applyOutbound({
    model: "m",
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "42" },
      { role: "assistant", content: "prev", tool_calls: [{ id: "c1" }] }
    ]
  }, { provider: { id: "opencode-go" }, model: { id: "opencode-go/m" } });
  const ai = oc.messages.findLastIndex((m) => m.role === "assistant");
  const ti = oc.messages.findIndex((m) => m.role === "tool");
  assert.ok(ai < ti, "opencode: tool result after assistant");

  // GPT gets max_tokens default
  const gpt = applyOutbound({ model: "gpt-5.5", messages: [] }, { provider: { id: "codex" }, model: { id: "codex/gpt-5.5" } });
  assert.equal(gpt.max_tokens, 4096);

  // A non-matching provider gets no patches
  const vanilla = applyOutbound({ model: "other/m", messages: [{ role: "user", content: "hi" }], top_k: 0, max_tokens: 0 }, { provider: { id: "other" }, model: { id: "other/m" } });
  assert.equal(vanilla.top_k, 0, "non-matching keeps top_k");
  assert.equal(vanilla.max_tokens, 0, "non-matching keeps max_tokens");

  resetPatches();
});

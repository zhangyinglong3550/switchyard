import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPatch, applyOutbound, applyInbound, applyStreamLine, resetPatches, listPatchIds } from "../src/compat/index.mjs";
import { kimiToolSchemaPatch } from "../src/compat/patches/kimi-tool-schema.mjs";
import { deepseekReasoningPatch } from "../src/compat/patches/deepseek-reasoning.mjs";
import { glmContentTextPatch } from "../src/compat/patches/glm-content-text.mjs";
import { opencodeToolHistoryPatch } from "../src/compat/patches/opencode-tool-history.mjs";
import { opencodeGlmNoToolsPatch } from "../src/compat/patches/opencode-glm-no-tools.mjs";
import { officialGPTFallbackPatch } from "../src/compat/patches/official-gpt-fallback.mjs";
import { chatReasoningPatch } from "../src/compat/patches/chat-reasoning.mjs";
import { reasoningOptionsPatch } from "../src/compat/patches/reasoning-options.mjs";
import { toolHistoryAdjacentPatch } from "../src/compat/patches/tool-history-adjacent.mjs";

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
  assert.equal(out.choices[0].message._switchyardAnthropicThinking[0].thinking, "I'm thinking...");
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

// ── 2b. Generic Chat reasoning ────────────────────────────────────────────

testPatch("chat-reasoning · maps MiniMax reasoning_details into internal thinking", () => {
  registerPatch(chatReasoningPatch.id, chatReasoningPatch);
  const payload = {
    choices: [{
      message: {
        role: "assistant",
        content: "Done",
        reasoning_details: [{ type: "reasoning_text", text: "Need to inspect code." }]
      }
    }]
  };
  const out = applyInbound(payload, { provider: { id: "minimax" }, model: { id: "minimax/MiniMax-M2.7" } });
  assert.equal(out.choices[0].message.reasoning_details, undefined);
  assert.equal(out.choices[0].message._switchyardAnthropicThinking[0].thinking, "Need to inspect code.");
});

testPatch("reasoning-options · maps Codex reasoning to DashScope enable_thinking", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "high" } },
    { provider: { id: "bailian", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }, model: { id: "bailian/qwen3-coder-plus" } }
  );
  assert.equal(out.enable_thinking, true);
  assert.equal(out.reasoning, undefined);
});

testPatch("reasoning-options · maps Codex reasoning to MiniMax reasoning_split", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "medium" } },
    { provider: { id: "minimax" }, model: { id: "minimax/MiniMax-M2.7" } }
  );
  assert.equal(out.reasoning_split, true);
  assert.equal(out.reasoning, undefined);
});

testPatch("reasoning-options · maps Codex reasoning to OpenRouter native effort", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "max" } },
    { provider: { id: "openrouter" }, model: { id: "openrouter/openai/gpt-5" } }
  );
  assert.deepEqual(out.reasoning, { effort: "xhigh" });
});

testPatch("reasoning-options · OpenRouter platform overrides DeepSeek model names", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "max" } },
    {
      provider: { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
      model: { id: "openrouter/deepseek/deepseek-chat-v3.1", upstreamModel: "deepseek/deepseek-chat-v3.1" }
    }
  );
  assert.deepEqual(out.reasoning, { effort: "xhigh" });
  assert.equal(out.thinking, undefined);
  assert.equal(out.reasoning_effort, undefined);
});

testPatch("reasoning-options · SiliconFlow platform overrides MiniMax model names", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "medium" } },
    {
      provider: { id: "siliconflow", baseUrl: "https://api.siliconflow.cn/v1" },
      model: { id: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.7", upstreamModel: "Pro/MiniMaxAI/MiniMax-M2.7" }
    }
  );
  assert.equal(out.enable_thinking, true);
  assert.equal(out.reasoning_split, undefined);
  assert.equal(out.reasoning, undefined);
});

testPatch("reasoning-options · explicit provider metadata overrides heuristics", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "high" } },
    {
      provider: {
        id: "deepseek",
        codexChatReasoning: {
          supportsThinking: false,
          supportsEffort: false,
          thinkingParam: "none",
          effortParam: "none"
        }
      },
      model: { id: "deepseek/deepseek-v4-pro" }
    }
  );
  assert.equal(out.reasoning, undefined);
  assert.equal(out.thinking, undefined);
  assert.equal(out.reasoning_effort, undefined);
});

testPatch("reasoning-options · explicit model metadata overrides provider metadata", () => {
  registerPatch(reasoningOptionsPatch.id, reasoningOptionsPatch);
  const out = applyOutbound(
    { messages: [], reasoning: { effort: "medium" } },
    {
      provider: {
        id: "siliconflow",
        codexChatReasoning: {
          supportsThinking: true,
          thinkingParam: "enable_thinking",
          effortParam: "none"
        }
      },
      model: {
        id: "custom/minimax",
        codexChatReasoning: {
          supportsThinking: true,
          thinkingParam: "reasoning_split",
          effortParam: "none"
        }
      }
    }
  );
  assert.equal(out.reasoning_split, true);
  assert.equal(out.enable_thinking, undefined);
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

testPatch("tool-history-adjacent · preserves already-adjacent parallel tool results", () => {
  registerPatch(toolHistoryAdjacentPatch.id, toolHistoryAdjacentPatch);
  const ctx = { provider: { id: "deepseek" }, model: { id: "deepseek/deepseek-v4-pro" } };
  const body = {
    messages: [
      { role: "user", content: "read" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "Read", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "Read", arguments: "{}" } }
        ]
      },
      { role: "tool", tool_call_id: "call_a", content: "A" },
      { role: "tool", tool_call_id: "call_b", content: "B" },
      { role: "user", content: "continue" }
    ]
  };

  const out = applyOutbound(body, ctx);
  assert.deepEqual(out.messages.map((message) => message.role), ["user", "assistant", "tool", "tool", "user"]);
  assert.equal(out.messages[2].tool_call_id, "call_a");
  assert.equal(out.messages[3].tool_call_id, "call_b");
});

// ── 5. Official GPT fallback ───────────────────────────────────────────────

testPatch("opencode-glm-no-tools · strips tools only for OpenCode Go GLM models", () => {
  registerPatch(opencodeGlmNoToolsPatch.id, opencodeGlmNoToolsPatch);
  const ctx = { provider: { id: "opencode-go" }, model: { id: "opencode-go/glm-5.2" } };
  const body = {
    model: "glm-5.2",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "auto"
  };

  const out = applyOutbound(body, ctx);
  assert.equal(out.tools, undefined);
  assert.equal(out.tool_choice, undefined);
  assert.deepEqual(out.messages, body.messages);
});

testPatch("opencode-glm-no-tools · does NOT affect OpenCode Go Kimi models", () => {
  registerPatch(opencodeGlmNoToolsPatch.id, opencodeGlmNoToolsPatch);
  const body = {
    model: "kimi-k2.7-code",
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "auto"
  };
  const out = applyOutbound(body, { provider: { id: "opencode-go" }, model: { id: "opencode-go/kimi-k2.7-code" } });
  assert.equal(out.tools.length, 1);
  assert.equal(out.tool_choice, "auto");
});

testPatch("opencode-glm-no-tools · does NOT affect non-OpenCode GLM providers", () => {
  registerPatch(opencodeGlmNoToolsPatch.id, opencodeGlmNoToolsPatch);
  const body = {
    model: "glm-5.2",
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }]
  };
  const out = applyOutbound(body, { provider: { id: "coding-plan" }, model: { id: "coding-plan/glm-5.2" } });
  assert.equal(out.tools.length, 1);
});

// ── 6. Official GPT fallback ───────────────────────────────────────────────

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

test("v0.4-patches · all builtin patches registered simultaneously do not interfere", () => {
  resetPatches();
  const patches = [
    kimiToolSchemaPatch,
    deepseekReasoningPatch,
    glmContentTextPatch,
    opencodeToolHistoryPatch,
    opencodeGlmNoToolsPatch,
    officialGPTFallbackPatch,
    chatReasoningPatch,
    reasoningOptionsPatch
  ];
  for (const p of patches) registerPatch(p.id, p);

  const ids = listPatchIds().sort();
  assert.deepEqual(ids, [
    "chat-reasoning",
    "deepseek-reasoning",
    "glm-content-text",
    "kimi-tool-schema",
    "official-gpt-fallback",
    "opencode-glm-no-tools",
    "opencode-tool-history",
    "reasoning-options"
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

  const ocGlm = applyOutbound({
    model: "glm-5.2",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    tool_choice: "auto"
  }, { provider: { id: "opencode-go" }, model: { id: "opencode-go/glm-5.2" } });
  assert.equal(ocGlm.tools, undefined, "opencode GLM tools stripped");
  assert.equal(ocGlm.tool_choice, undefined, "opencode GLM tool_choice stripped");

  // GPT gets max_tokens default
  const gpt = applyOutbound({ model: "gpt-5.5", messages: [] }, { provider: { id: "codex" }, model: { id: "codex/gpt-5.5" } });
  assert.equal(gpt.max_tokens, 4096);

  // A non-matching provider gets no patches
  const vanilla = applyOutbound({ model: "other/m", messages: [{ role: "user", content: "hi" }], top_k: 0, max_tokens: 0 }, { provider: { id: "other" }, model: { id: "other/m" } });
  assert.equal(vanilla.top_k, 0, "non-matching keeps top_k");
  assert.equal(vanilla.max_tokens, 0, "non-matching keeps max_tokens");

  resetPatches();
});

import test from "node:test";
import assert from "node:assert/strict";
import { listProviderPresets, providerPresetFor, presetModelHints } from "../src/provider-presets.mjs";

test("provider presets · expose defaults including high-risk Codex OAuth", () => {
  const presets = listProviderPresets();
  const ids = presets.map((preset) => preset.id);
  assert.ok(ids.includes("codex-oauth"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("deepseek"));

  const codex = presets.find((preset) => preset.id === "codex-oauth");
  assert.equal(codex.label, "OpenAI Codex（OAuth）");
  assert.equal(codex.defaultAuthMode, "codex_oauth");
  assert.deepEqual(codex.authModes, ["codex_oauth"]);
  assert.equal(codex.apiFormat, "openai_responses");
  assert.equal(codex.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(codex.experimental, true);
  assert.equal(codex.riskLevel, "high");
  assert.match(codex.riskNote, /官方文档|账号风险|封号|限制/);

  const opencode = presets.find((preset) => preset.id === "opencode-go");
  assert.equal(opencode.baseUrl, "https://opencode.ai/zen/go/v1");

  const xiaomi = presets.find((preset) => preset.id === "xiaomi-mimo");
  assert.equal(xiaomi.apiFormat, "openai_chat");
  assert.equal(xiaomi.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.ok(presetModelHints(xiaomi).has("mimo-v2.5-pro"));
});

test("provider presets · can resolve Codex OAuth metadata for existing configs", () => {
  const preset = providerPresetFor({ id: "codex", presetId: "codex-oauth" });
  assert.equal(preset.id, "codex-oauth");
  assert.equal(preset.experimental, true);
  assert.equal(preset.riskLevel, "high");
  assert.match(preset.riskNote, /官方文档|账号风险|封号|限制/);
  const hints = presetModelHints(preset);
  assert.ok(hints.has("gpt-5.5"));
});

test("provider presets · cover mainstream CN and US OpenAI-compatible providers with compat defaults", () => {
  const presets = listProviderPresets();
  const ids = new Set(presets.map((preset) => preset.id));
  for (const id of [
    "alibaba-bailian",
    "baidu-qianfan",
    "doubao-seed",
    "zhipu-glm",
    "kimi-coding",
    "minimax",
    "siliconflow",
    "xai",
    "groq",
    "together",
    "perplexity",
    "fireworks",
    "mistral",
    "cerebras"
  ]) {
    assert.ok(ids.has(id), `missing provider preset: ${id}`);
  }
  assert.ok(presets.find((preset) => preset.id === "alibaba-bailian").compatPacks.includes("reasoning-chat"));
  assert.ok(presets.find((preset) => preset.id === "zhipu-glm").compatPacks.includes("glm"));
  assert.ok(presets.find((preset) => preset.id === "kimi-coding").compatPacks.includes("kimi"));
  assert.equal(presets.find((preset) => preset.id === "deepseek").codexChatReasoning.effortParam, "reasoning_effort");
  assert.equal(presets.find((preset) => preset.id === "openrouter").codexChatReasoning.effortParam, "reasoning.effort");
  assert.equal(presets.find((preset) => preset.id === "siliconflow").codexChatReasoning.thinkingParam, "enable_thinking");
  assert.ok(presetModelHints("minimax").has("MiniMax-M2.7"));
});

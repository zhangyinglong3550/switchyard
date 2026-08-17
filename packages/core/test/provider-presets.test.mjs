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

test("provider presets · expose balance and coding-plan usage checks", () => {
  const presets = listProviderPresets();
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  assert.deepEqual(byId.get("deepseek").usage_check, { templateType: "balance", balanceProvider: "deepseek" });
  assert.deepEqual(byId.get("openrouter").usage_check, { templateType: "balance", balanceProvider: "openrouter" });
  assert.deepEqual(byId.get("siliconflow").usage_check, { templateType: "balance", balanceProvider: "siliconflow" });
  assert.deepEqual(byId.get("novita").usage_check, { templateType: "balance", balanceProvider: "novita" });
  assert.deepEqual(byId.get("stepfun").usage_check, { templateType: "balance", balanceProvider: "stepfun" });
  assert.deepEqual(byId.get("kimi-coding").usage_check, { templateType: "coding_plan", codingPlanProvider: "kimi" });
  assert.deepEqual(byId.get("zhipu-glm").usage_check, { templateType: "coding_plan", codingPlanProvider: "zhipu" });
  assert.deepEqual(byId.get("zai").usage_check, { templateType: "coding_plan", codingPlanProvider: "zhipu" });
  assert.deepEqual(byId.get("minimax").usage_check, { templateType: "coding_plan", codingPlanProvider: "minimax" });
  assert.deepEqual(byId.get("volcengine-ark-agentplan").usage_check, { templateType: "coding_plan", codingPlanProvider: "volcengine" });
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

test("provider presets · KE uses OpenAI chat and preset models without /models", () => {
  const presets = listProviderPresets();
  const ke = presets.find((preset) => preset.id === "ke");
  assert.ok(ke, "missing ke preset");
  assert.equal(ke.name, "KE");
  assert.equal(ke.providerId, "ke");
  assert.equal(ke.label, "KE");
  assert.equal(ke.apiFormat, "openai_chat");
  assert.equal(ke.baseUrl, "https://openapi-ait.ke.com/v1");
  assert.equal(ke.preferPresetModels, true);
  assert.equal(ke.defaultAuthMode, "api_key");
  assert.ok(ke.authModes.includes("api_key"));
  assert.ok(Array.isArray(ke.models));
  assert.equal(ke.models.length, 13);
  const byId = new Map(ke.models.map((m) => [m.id, m]));
  for (const id of [
    "claude-sonnet-5",
    "claude-4.6-sonnet",
    "claude-opus-4-8",
    "claude-opus-4.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "Deepseek-V4-Pro",
    "Deepseek-V4-Flash",
    "GLM-5.2",
    "GLM-5.1"
  ]) {
    assert.ok(byId.has(id), `missing model ${id}`);
  }
  // Claude / GPT：能力全开
  const allOn = { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true };
  for (const id of [
    "claude-sonnet-5",
    "claude-4.6-sonnet",
    "claude-opus-4-8",
    "claude-opus-4.6",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra"
  ]) {
    assert.deepEqual(byId.get(id).capabilities, allOn, id);
  }
  // DeepSeek / GLM 仍按目录
  assert.equal(byId.get("Deepseek-V4-Pro").capabilities.images, false);
  assert.equal(byId.get("GLM-5.2").capabilities.tools, true);
  assert.equal(byId.get("GLM-5.2").capabilities.stream, true);
  assert.equal(byId.get("GLM-5.2").capabilities.images, false);
});

test("provider presets · Antigravity CLI2API and Sub2API native import integrations", () => {
  const presets = listProviderPresets();
  const byId = new Map(presets.map((preset) => [preset.id, preset]));

  const anti = byId.get("antigravity-cli2api");
  assert.ok(anti, "missing antigravity-cli2api preset");
  assert.equal(anti.apiFormat, "openai_chat");
  assert.equal(anti.baseUrl, "http://127.0.0.1:8317/v1");
  assert.equal(anti.defaultAuthMode, "api_key");
  assert.ok(presetModelHints(anti).has("gemini-3.1-flash-lite"));
  assert.ok(presetModelHints(anti).has("claude-sonnet-4-6"));

  const sub = byId.get("sub2api-codex");
  assert.ok(sub, "missing sub2api-codex preset");
  assert.equal(sub.apiFormat, "openai_responses");
  assert.equal(sub.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(sub.defaultAuthMode, "account_pool");
  assert.equal(sub.poolKind, "codex_oauth");
  assert.ok(presetModelHints(sub).has("gpt-5.5"));
  assert.ok(presetModelHints(sub).has("gpt-5.4"));
});

test("provider presets · enable Cursor subscription bridge by default with explicit local-only warning", () => {
  const cursor = providerPresetFor("cursor-subscription");
  assert.ok(cursor);
  assert.equal(cursor.providerType, "cursor_subscription");
  assert.equal(cursor.apiFormat, "cursor_subscription");
  assert.equal(cursor.defaultAuthMode, "cursor_subscription");
  assert.equal(cursor.enabled, true);
  assert.equal(cursor.maxConcurrentRequests, 2);
  assert.equal(cursor.label, "Cursor 订阅桥接");
  assert.equal(cursor.experimental, undefined);
  assert.match(cursor.riskNote, /仅个人本机使用/);
  assert.ok(cursor.models.length >= 8);
  assert.ok(cursor.models.some((model) => model.id === "grok-4.5"));
  assert.ok(cursor.models.some((model) => model.id === "gpt-5.6-sol"));
});

test("provider presets · cursor subscription account pool preset uses account_pool auth", () => {
  const pool = providerPresetFor("cursor-subscription-account-pool");
  assert.ok(pool);
  assert.equal(pool.providerType, "cursor_subscription");
  assert.equal(pool.apiFormat, "cursor_subscription");
  assert.equal(pool.defaultAuthMode, "account_pool");
  assert.deepEqual(pool.authModes, ["account_pool"]);
  assert.equal(pool.poolKind, "cursor_subscription");
  assert.equal(pool.baseUrl, "https://agentn.api5.cursor.sh");
  assert.equal(pool.enabled, true);
  assert.ok(pool.models.length >= 8);
});

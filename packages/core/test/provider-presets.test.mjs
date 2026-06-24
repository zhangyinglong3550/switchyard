import test from "node:test";
import assert from "node:assert/strict";
import { listProviderPresets, providerPresetFor, presetModelHints } from "../src/provider-presets.mjs";

test("provider presets · expose default providers and Codex OAuth", () => {
  const presets = listProviderPresets();
  const ids = presets.map((preset) => preset.id);
  assert.ok(ids.includes("codex-oauth"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("deepseek"));

  const codex = presets.find((preset) => preset.id === "codex-oauth");
  assert.equal(codex.defaultAuthMode, "codex_oauth");
  assert.ok(codex.authModes.includes("api_key"));
  assert.equal(codex.apiFormat, "openai_responses");

  const opencode = presets.find((preset) => preset.id === "opencode-go");
  assert.equal(opencode.baseUrl, "https://opencode.ai/zen/go/v1");

  const xiaomi = presets.find((preset) => preset.id === "xiaomi-mimo");
  assert.equal(xiaomi.apiFormat, "openai_chat");
  assert.equal(xiaomi.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.ok(presetModelHints(xiaomi).has("mimo-v2.5-pro"));
});

test("provider presets · can be resolved from saved provider metadata", () => {
  const preset = providerPresetFor({ id: "codex", presetId: "codex-oauth" });
  assert.equal(preset.id, "codex-oauth");
  const hints = presetModelHints(preset);
  assert.ok(hints.has("gpt-5.5"));
});

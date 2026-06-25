import test from "node:test";
import assert from "node:assert/strict";

test("diagnostics · classifies common gateway failures with repair hints", async () => {
  const mod = await import("../../../apps/desktop/src/diagnostics.mjs");
  assert.equal(mod.classifyGatewayError("401 invalid api key").category, "auth");
  assert.equal(mod.classifyGatewayError("fetch failed ECONNREFUSED 127.0.0.1:9999").category, "network");
  assert.equal(mod.classifyGatewayError("Model `switchyard:xiaomi/foo` was not found in this provider's model listing").category, "model_not_found");
  assert.equal(mod.classifyGatewayError("Extra inputs are not permitted, field: '_modelId'").category, "schema");
  assert.equal(mod.classifyGatewayError("This model does not support image input").category, "capability");
  assert.equal(mod.classifyGatewayError("The `content[].thinking` in the thinking mode must be passed back to the API.").category, "protocol_state");
  assert.equal(mod.classifyGatewayError("400 due to tool use concurrency issues").category, "tool_result_order");
  assert.equal(mod.classifyGatewayError("unsupported role: developer").category, "role_compat");
  assert.equal(mod.classifyGatewayError("unexpected boom").category, "unknown");
  assert.match(mod.classifyGatewayError("401 invalid api key").hint, /密钥|Key/i);
});

test("diagnostics · suggests capabilities from probe outcomes without mutating model", async () => {
  const mod = await import("../../../apps/desktop/src/diagnostics.mjs");
  const model = { id: "p/a", capabilities: { text: true, tools: false } };
  const suggestion = mod.suggestCapabilitiesFromProbeResults(model, {
    text: { ok: true },
    stream: { ok: true },
    tools: { ok: true },
    vision: { ok: false },
    reasoning: { ok: true }
  });
  assert.deepEqual(suggestion.capabilities, {
    text: true,
    stream: true,
    tools: true,
    images: false,
    multimodal: false,
    reasoning: true
  });
  assert.equal(model.capabilities.tools, false);
});

test("diagnostics · builds a safe replay draft from request log summaries", async () => {
  const mod = await import("../../../apps/desktop/src/diagnostics.mjs");
  const draft = mod.buildReplayDraft({
    id: 12,
    model_id: "p/a",
    requested_model: "alias-a",
    request_summary: JSON.stringify({
      params: { stream: true, temperature: 0.2, maxTokens: 32 },
      messages: {
        system: [{ text: "system prompt" }],
        user: [{ text: "hello" }]
      },
      tools: [{ name: "read_file", description: "Read file", propertyCount: 1 }]
    })
  });
  assert.equal(draft.modelId, "p/a");
  assert.equal(draft.messages[0].role, "system");
  assert.equal(draft.messages[1].content, "hello");
  assert.equal(draft.stream, true);
  assert.equal(draft.temperature, 0.2);
  assert.equal(JSON.stringify(draft).includes("Authorization"), false);
});

test("diagnostics · detects client configuration drift from config contents", async () => {
  const mod = await import("../../../apps/desktop/src/diagnostics.mjs");
  const ok = mod.doctorClientConfigContents({
    host: "127.0.0.1",
    port: 17888,
    codexText: [
      'model_provider = "custom"',
      "[model_providers.custom]",
      'base_url = "http://127.0.0.1:17888/codex/v1"',
      'wire_api = "responses"'
    ].join("\n"),
    claudeSettings: { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:17888/claude-code" } },
    hermesJson: { baseUrl: "http://127.0.0.1:17888/hermes/v1" },
    hermesYamlText: "provider: switchyard\nbase_url: http://127.0.0.1:17888/hermes/v1\n"
  });
  assert.equal(ok.codex.status, "ok");
  assert.equal(ok["claude-code"].status, "ok");
  assert.equal(ok.hermes.status, "ok");

  const drifted = mod.doctorClientConfigContents({
    host: "127.0.0.1",
    port: 17888,
    codexText: 'model_provider = "openai"',
    claudeSettings: { env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } },
    hermesJson: { baseUrl: "https://example.com/v1" },
    hermesYamlText: ""
  });
  assert.equal(drifted.codex.status, "drifted");
  assert.equal(drifted["claude-code"].status, "drifted");
  assert.equal(drifted.hermes.status, "drifted");
});

test("diagnostics · builds compatibility profile and rule recommendations from probes", async () => {
  const mod = await import("../../../apps/desktop/src/diagnostics.mjs");
  const profile = mod.buildCompatibilityProfile({
    provider: { id: "custom", apiFormat: "anthropic_messages" },
    model: { id: "custom/model", providerId: "custom" },
    results: {
      text: { ok: true },
      stream: { ok: true },
      tools: { ok: true },
      "tool-thinking": { ok: false, error: "The `content[].thinking` in the thinking mode must be passed back to the API." },
      "parallel-tools": { ok: false, error: "tool use concurrency issues" },
      "developer-role": { ok: false, error: "unsupported role: developer" },
      "schema-strictness": { ok: false, error: "Extra inputs are not permitted, field: '$schema'" }
    },
    activeRules: [{ id: "anthropic-thinking-roundtrip", source: "adapter", label: "Thinking round-trip" }]
  });
  assert.equal(profile.protocol, "anthropic_messages");
  assert.equal(profile.flags.requiresThinkingRoundtrip, true);
  assert.equal(profile.flags.requiresToolResultsTogether, true);
  assert.equal(profile.flags.supportsDeveloperRole, false);
  assert.equal(profile.flags.schemaStrictness, "high");
  assert.ok(profile.recommendations.some((item) => item.ruleId === "developer-to-system"));
  assert.ok(profile.activeRules[0].source === "adapter");
});

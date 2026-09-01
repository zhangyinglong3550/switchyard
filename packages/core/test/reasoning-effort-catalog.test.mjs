import test from "node:test";
import assert from "node:assert/strict";
import {
  EFFORT_ORDER,
  clampEffort,
  mapEffortForWire,
  resolveReasoningCapability,
  applyReasoningEffortCatalog
} from "../src/reasoning-effort-catalog.mjs";
import { PROVIDER_PRESETS } from "../src/provider-presets.mjs";

test("EFFORT_ORDER is stable low-to-high", () => {
  assert.deepEqual(EFFORT_ORDER, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("clampEffort picks nearest supported", () => {
  assert.equal(clampEffort("xhigh", ["low", "medium", "high"]), "high");
  assert.equal(clampEffort("none", ["low", "medium", "high"]), "low");
  assert.equal(clampEffort("ultra", ["low", "medium", "high", "xhigh", "max"], { allowUltra: false }), "max");
});

test("deepseek mapEffortForWire", () => {
  assert.deepEqual(mapEffortForWire("none", { effortValueMode: "deepseek" }), {
    enabled: false,
    wireParam: "reasoning_effort",
    wireValue: null,
    thinking: { type: "disabled" }
  });
  assert.equal(mapEffortForWire("medium", { effortValueMode: "deepseek" }).wireValue, "high");
  assert.equal(mapEffortForWire("xhigh", { effortValueMode: "deepseek" }).wireValue, "high");
  assert.equal(mapEffortForWire("max", { effortValueMode: "deepseek" }).wireValue, "max");
});

test("resolveReasoningCapability prefers model override then preset", () => {
  const cap = resolveReasoningCapability({
    provider: { id: "deepseek", presetId: "deepseek" },
    model: {
      id: "deepseek/v4",
      reasoningEffort: {
        supportedEfforts: ["high", "max"],
        defaultEffort: "high",
        wire: { effortParam: "reasoning_effort", thinkingParam: "thinking", effortValueMode: "deepseek" }
      }
    }
  });
  assert.deepEqual(cap.supportedEfforts, ["high", "max"]);
});

test("applyReasoningEffortCatalog writes body and trace", () => {
  const { body, trace } = applyReasoningEffortCatalog(
    { messages: [], reasoning: { effort: "xhigh", summary: "detailed" } },
    {
      provider: { id: "deepseek", presetId: "deepseek", apiFormat: "openai_chat", baseUrl: "https://api.deepseek.com" },
      model: { id: "deepseek/deepseek-v4-flash", upstreamModel: "deepseek-v4-flash" }
    }
  );
  assert.equal(body.thinking?.type, "enabled");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(trace.requested, "xhigh");
  assert.equal(trace.mapped, "high");
  assert.equal(trace.clamped, true);
  assert.equal(trace.wireValue, "high");
  assert.equal(body._switchyardReasoningEffortTrace?.wireValue, "high");
});

test("every provider preset resolves a reasoning capability", () => {
  for (const preset of PROVIDER_PRESETS) {
    const cap = resolveReasoningCapability({
      provider: {
        id: preset.providerId || preset.id,
        presetId: preset.id,
        apiFormat: preset.apiFormat,
        baseUrl: preset.baseUrl
      },
      model: { id: `${preset.id}/sample`, providerId: preset.providerId || preset.id }
    });
    assert.ok(cap, `missing capability for preset ${preset.id}`);
    assert.ok(cap.wire?.effortValueMode || cap.unsupported, `preset ${preset.id} needs mode or unsupported`);
  }
});

test("GLM family falls back to thinkingWithEffort when the preset has no group", () => {
  const ctx = {
    provider: { id: "ke", presetId: "ke", apiFormat: "openai_chat", baseUrl: "https://openapi-ait.ke.com/v1" },
    model: { id: "ke/GLM-5.3-Flash", providerId: "ke", upstreamModel: "GLM-5.3-Flash" }
  };
  const cap = resolveReasoningCapability(ctx);
  assert.equal(cap.wire.effortValueMode, "deepseek");
  assert.equal(cap.wire.thinkingParam, "none");
  assert.ok(!cap.supportedEfforts.includes("none"), "强制思考模型不能暴露 none");

  for (const [requested, expected] of [["medium", "high"], ["xhigh", "high"], ["low", "low"], ["max", "max"]]) {
    const { body, trace } = applyReasoningEffortCatalog(
      { model: "ke/GLM-5.3-Flash", input: "hi", reasoning: { effort: requested } }, ctx);
    assert.equal(body.reasoning_effort, expected, requested);
    assert.equal(body.thinking, undefined, `${requested} 不能产出 thinking 开关`);
    assert.equal(trace.clamped, expected !== requested, requested);
  }
});

test("non-GLM chat providers keep passthrough behaviour", () => {
  const cap = resolveReasoningCapability({
    provider: { id: "ke", presetId: "ke", apiFormat: "openai_chat" },
    model: { id: "ke/qwen3.8-flash", providerId: "ke", upstreamModel: "qwen3.8-flash" }
  });
  assert.equal(cap.wire.effortValueMode, "passthrough_chat");
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveManualModelId,
  isManualPlaceholderModelId,
  modelIdConflict
} from "../../../apps/desktop/renderer/model-form-utils.mjs";

const config = {
  models: [
    { id: "glm-5.2", providerId: "火山Coding plan", upstreamModel: "glm-5.2" },
    { id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" }
  ]
};

test("model form utils · reports duplicate model id with provider and suggested local id", () => {
  const conflict = modelIdConflict(config, {
    id: "glm-5.2",
    providerId: "火山Agent plan",
    upstreamModel: "glm-5.2"
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.existingProviderId, "火山Coding plan");
  assert.equal(conflict.suggestedId, "agent-plan/glm-5.2");
  assert.match(conflict.message, /glm-5\.2/);
  assert.match(conflict.message, /火山Coding plan/);
});

test("model form utils · ignores the current model while editing", () => {
  assert.deepEqual(
    modelIdConflict(config, { id: "glm-5.2", providerId: "火山Coding plan", upstreamModel: "glm-5.2" }, "glm-5.2"),
    { ok: true }
  );
});

test("model form utils · detects the manual placeholder model id only", () => {
  assert.equal(isManualPlaceholderModelId("myprov/new-model-1758293847123"), true);
  assert.equal(isManualPlaceholderModelId("myprov/gpt-5.5"), false);
  assert.equal(isManualPlaceholderModelId(""), false);
  assert.equal(isManualPlaceholderModelId(null), false);
});

test("model form utils · derives manual model id from provider id and upstream name", () => {
  assert.equal(deriveManualModelId("myprov", "gpt-5.6-sol"), "myprov/gpt-5.6-sol");
  // 与发现流程一致：上游名里的非常规字符替换为下划线
  assert.equal(deriveManualModelId("myprov", "my model v1"), "myprov/my_model_v1");
  assert.equal(deriveManualModelId("myprov", "deepseek-ai/DeepSeek-V3"), "myprov/deepseek-ai/DeepSeek-V3");
  assert.equal(deriveManualModelId("  myprov  ", "  gpt  "), "myprov/gpt");
  assert.equal(deriveManualModelId("", "gpt"), "provider/gpt");
  assert.equal(deriveManualModelId("myprov", ""), "myprov/new-model");
});

import test from "node:test";
import assert from "node:assert/strict";
import { modelIdConflict } from "../../../apps/desktop/renderer/model-form-utils.mjs";

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

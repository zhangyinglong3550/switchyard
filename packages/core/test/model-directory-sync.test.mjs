import test from "node:test";
import assert from "node:assert/strict";
import { mergeDiscoveredModelsIntoConfig } from "../src/model-directory-sync.mjs";

test("model directory sync adds new upstream models without overwriting manually managed models", () => {
  const config = {
    providers: [{ id: "p", name: "Provider" }],
    models: [{
      id: "p/existing",
      providerId: "p",
      upstreamModel: "existing",
      enabled: true,
      displayName: "我的显示名",
      aliases: ["mine"],
      capabilities: { tools: false }
    }]
  };
  const result = mergeDiscoveredModelsIntoConfig(config, "p", [
    { id: "existing", displayName: "Upstream Existing", capabilities: { tools: true } },
    { id: "new-model", displayName: "New model", capabilities: { tools: true, reasoning: true } }
  ], { now: "2026-07-28T12:00:00.000Z" });

  assert.equal(result.added, 1);
  assert.equal(result.known, 1);
  assert.equal(result.config.models.length, 2);
  assert.deepEqual(result.config.models.find((model) => model.upstreamModel === "existing"), config.models[0]);
  assert.deepEqual(result.config.models.find((model) => model.upstreamModel === "new-model"), {
    id: "p/new-model",
    providerId: "p",
    upstreamModel: "new-model",
    displayName: "New model",
    aliases: ["new-model"],
    enabled: false,
    allowedClients: ["*"],
    capabilities: { text: true, tools: true, reasoning: true, images: false, stream: true, multimodal: false },
    discoverySource: "provider_sync",
    discoveredAt: "2026-07-28T12:00:00.000Z"
  });
  assert.equal(result.config.providers[0].modelsDiscoveredAt, "2026-07-28T12:00:00.000Z");
});

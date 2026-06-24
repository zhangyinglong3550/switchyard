import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDiscoveredModelForProvider,
  selectedImportResult
} from "../../../apps/desktop/renderer/import-selection-utils.mjs";

test("import selection utils · selected models carry their providers", () => {
  const result = {
    importMeta: {
      providers: [
        { slug: "p1", name: "P1" },
        { slug: "p2", name: "P2" }
      ]
    },
    config: {
      providers: [
        { id: "p1", name: "P1" },
        { id: "p2", name: "P2" }
      ],
      models: [
        { id: "p1/a", providerId: "p1", upstreamModel: "a" },
        { id: "p2/b", providerId: "p2", upstreamModel: "b" }
      ]
    }
  };

  const filtered = selectedImportResult(result, {
    providers: new Set(["p1"]),
    models: new Set(["p2/b"])
  });

  assert.deepEqual(filtered.config.providers.map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(filtered.config.models.map((m) => m.id), ["p2/b"]);
  assert.deepEqual(filtered.importMeta.providers.map((p) => p.slug), ["p1", "p2"]);
});

test("import selection utils · normalizes discovered provider models", () => {
  const model = normalizeDiscoveredModelForProvider(
    { id: "opencode go" },
    {
      id: "glm 5.2 / preview",
      displayName: "GLM 5.2 Preview",
      contextWindow: 128000,
      maxOutputTokens: 8192,
      capabilities: { reasoning: true, images: false, tools: true }
    }
  );

  assert.equal(model.id, "opencode go/glm_5.2_/_preview");
  assert.equal(model.providerId, "opencode go");
  assert.equal(model.upstreamModel, "glm 5.2 / preview");
  assert.deepEqual(model.aliases, ["glm 5.2 / preview"]);
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxOutputTokens, 8192);
  assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.stream, true);
});

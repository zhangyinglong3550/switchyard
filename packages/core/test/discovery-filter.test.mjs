import test from "node:test";
import assert from "node:assert/strict";
import { filterDiscoveryModels } from "../../../apps/desktop/renderer/discovery-filter.mjs";

const models = [
  {
    id: "openai/gpt-4.1-mini",
    upstreamModel: "gpt-4.1-mini",
    displayName: "GPT 4.1 Mini",
    aliases: ["fast-gpt"],
    capabilities: { text: true, tools: true }
  },
  {
    id: "openai/text-embedding-3-large",
    upstreamModel: "text-embedding-3-large",
    displayName: "Embedding Large",
    aliases: ["embed"],
    capabilities: { text: true }
  },
  {
    id: "openai/o3",
    upstreamModel: "o3",
    displayName: "Reasoning",
    aliases: [],
    capabilities: { reasoning: true }
  }
];

test("discovery filter · empty query keeps original order and indexes", () => {
  assert.deepEqual(
    filterDiscoveryModels(models, "").map((item) => item.index),
    [0, 1, 2]
  );
});

test("discovery filter · matches id, upstream, display name, aliases and capabilities", () => {
  assert.deepEqual(filterDiscoveryModels(models, "mini").map((item) => item.index), [0]);
  assert.deepEqual(filterDiscoveryModels(models, "embedding").map((item) => item.index), [1]);
  assert.deepEqual(filterDiscoveryModels(models, "fast").map((item) => item.index), [0]);
  assert.deepEqual(filterDiscoveryModels(models, "reasoning").map((item) => item.index), [2]);
});

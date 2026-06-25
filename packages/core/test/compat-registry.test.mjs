import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadCompatRegistry,
  normalizeCompatRegistry,
  parseCompatRegistryJson,
  recommendCompatRules,
  registryRecommendationsForConfig
} from "../src/compat/registry.mjs";

test("builtin compat registry loads JSON-only rules", () => {
  const registry = loadCompatRegistry();
  assert.equal(registry.version, 1);
  assert.ok(registry.rules.length >= 6);
  assert.ok(registry.rules.every((rule) => Array.isArray(rule.recommendedCompatPacks)));
});

test("registry recommends provider-level packs by host and api format", () => {
  const result = recommendCompatRules({
    provider: {
      id: "custom-deepseek",
      apiFormat: "openai_chat",
      baseUrl: "https://api.deepseek.com/v1"
    }
  });
  const rule = result.recommendations.find((item) => item.id === "registry.deepseek.reasoning");
  assert.ok(rule);
  assert.deepEqual(rule.recommendedCompatPacks, ["deepseek"]);
  assert.match(rule.reason, /DeepSeek/i);
});

test("registry can target model family inside generic provider", () => {
  const result = recommendCompatRules({
    provider: {
      id: "opencode-go",
      apiFormat: "openai_chat",
      baseUrl: "https://gateway.example.test/v1"
    },
    model: {
      id: "opencode-go/glm-5.2",
      providerId: "opencode-go",
      upstreamModel: "glm-5.2"
    }
  });
  const ids = result.recommendations.map((item) => item.id);
  assert.ok(ids.includes("registry.opencode.glm"));
  const packs = result.recommendations.find((item) => item.id === "registry.opencode.glm").recommendedCompatPacks;
  assert.deepEqual(packs, ["opencode-go", "glm"]);
});

test("registry keeps provider recommendations separate from model-only rules", () => {
  const result = recommendCompatRules({
    provider: {
      id: "opencode-go",
      apiFormat: "openai_chat",
      baseUrl: "https://gateway.example.test/v1"
    }
  });
  assert.equal(result.recommendations.some((item) => item.id === "registry.opencode.glm"), false);
});

test("registry filters unknown compat packs without executing untrusted data", () => {
  const registry = normalizeCompatRegistry({
    version: 1,
    rules: [
      {
        id: "remote.bad-pack",
        providerIdPattern: "x",
        recommendedCompatPacks: ["deepseek", "missing-pack"],
        reason: "remote JSON"
      }
    ]
  });
  const result = recommendCompatRules({ provider: { id: "x" }, registry });
  assert.deepEqual(result.recommendations[0].recommendedCompatPacks, ["deepseek"]);
  assert.deepEqual(result.recommendations[0].unknownCompatPacks, ["missing-pack"]);
});

test("registry snapshot returns provider and model recommendation maps", () => {
  const snapshot = registryRecommendationsForConfig({
    providers: [
      { id: "deepseek", apiFormat: "openai_chat", baseUrl: "https://api.deepseek.com/v1" },
      { id: "opencode-go", apiFormat: "openai_chat", baseUrl: "https://gateway.example.test/v1" }
    ],
    models: [
      { id: "opencode-go/glm-5.2", providerId: "opencode-go", upstreamModel: "glm-5.2" }
    ]
  });
  assert.ok(snapshot.providers.deepseek.some((item) => item.id === "registry.deepseek.reasoning"));
  assert.ok(snapshot.models["opencode-go/glm-5.2"].some((item) => item.id === "registry.opencode.glm"));
});

test("registry parser rejects non-json input", () => {
  assert.throws(() => parseCompatRegistryJson("export default {}"), /Unexpected token|Unexpected identifier/);
});

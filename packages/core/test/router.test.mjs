import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWithDefaults, validateConfig } from "../src/config.mjs";
import { resolveRoute, buildRouter } from "../src/router.mjs";

function makeConfig() {
  const cfg = mergeWithDefaults({
    defaultModel: "p/main",
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "p/main", providerId: "p", upstreamModel: "main", aliases: ["alpha", "claude-3-sonnet"] },
      { id: "p/other", providerId: "p", upstreamModel: "other" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["p/main"] },
      "claude-code": { enabled: true, allowedModels: ["claude-3-sonnet"] },
      hermes: { enabled: false, allowedModels: ["*"] }
    }
  });
  validateConfig(cfg);
  return cfg;
}

test("resolveRoute resolves alias to upstream", () => {
  const cfg = makeConfig();
  const r = resolveRoute(cfg, "alpha");
  assert.equal(r.model.id, "p/main");
  assert.equal(r.upstreamModel, "main");
});

test("resolveRoute falls back to defaultModel when unknown", () => {
  const cfg = makeConfig();
  const r = resolveRoute(cfg, "nope");
  assert.equal(r.model.id, "p/main");
});

test("resolveRoute respects per-client allowedModels", () => {
  const cfg = makeConfig();
  assert.equal(resolveRoute(cfg, "p/other", { clientId: "codex" }), null);
  assert.equal(resolveRoute(cfg, "p/main", { clientId: "codex" }).model.id, "p/main");
});

test("resolveRoute matches alias filter", () => {
  const cfg = makeConfig();
  const r = resolveRoute(cfg, "claude-3-sonnet", { clientId: "claude-code" });
  assert.equal(r.model.id, "p/main");
});

test("resolveRoute returns null when client disabled", () => {
  const cfg = makeConfig();
  assert.equal(resolveRoute(cfg, "p/main", { clientId: "hermes" }), null);
});

test("resolveRoute ignores disabled models", () => {
  const cfg = mergeWithDefaults({
    defaultModel: "p/disabled",
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "p/enabled", providerId: "p", upstreamModel: "enabled" },
      { id: "p/disabled", providerId: "p", upstreamModel: "disabled", aliases: ["disabled-alias"], enabled: false }
    ]
  });
  assert.equal(resolveRoute(cfg, "p/disabled"), null);
  assert.equal(resolveRoute(cfg, "disabled-alias"), null);
  assert.equal(resolveRoute(cfg, "missing"), null);
});

test("buildRouter dedupes alias keys", () => {
  const cfg = makeConfig();
  const r = buildRouter(cfg);
  assert.equal(r.models.get("alpha").id, "p/main");
  assert.equal(r.models.get("main").id, "p/main");
});

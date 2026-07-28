import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWithDefaults, validateConfig } from "../src/config.mjs";
import { resolveRoute, buildRouter, isDeletedProviderModelRequest } from "../src/router.mjs";

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

test("resolveRoute does not fall back when an explicitly selected qualified model is disabled", () => {
  const cfg = mergeWithDefaults({
    defaultModel: "other/default",
    providers: [
      { id: "sub2api", apiFormat: "openai_responses", baseUrl: "http://sub2api" },
      { id: "other", apiFormat: "openai_chat", baseUrl: "http://other" }
    ],
    models: [
      { id: "sub2api/gpt", providerId: "sub2api", upstreamModel: "gpt", enabled: false },
      { id: "other/default", providerId: "other", upstreamModel: "default" }
    ]
  });

  assert.equal(resolveRoute(cfg, "sub2api/gpt", { clientId: "codex" }), null);
  assert.equal(resolveRoute(cfg, "sub2api/missing", { clientId: "codex" }), null);
  // 短名保持原有的默认模型兜底兼容性。
  assert.equal(resolveRoute(cfg, "missing", { clientId: "codex" }).model.id, "other/default");
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

test("resolveRoute · 双供应商同名模型：完整 id 各自命中，短名不串号", () => {
  const cfg = mergeWithDefaults({
    defaultModel: "provider-a/gpt-5.5",
    providers: [
      { id: "provider-a", name: "A", apiFormat: "openai_chat", baseUrl: "http://a" },
      { id: "provider-b", name: "B", apiFormat: "openai_chat", baseUrl: "http://b" }
    ],
    models: [
      { id: "provider-a/gpt-5.5", providerId: "provider-a", upstreamModel: "gpt-5.5", aliases: ["gpt-5.5"] },
      { id: "provider-b/gpt-5.5", providerId: "provider-b", upstreamModel: "gpt-5.5", aliases: ["gpt-5.5"] }
    ]
  });
  validateConfig(cfg);

  const a = resolveRoute(cfg, "provider-a/gpt-5.5");
  const b = resolveRoute(cfg, "provider-b/gpt-5.5");
  assert.equal(a.provider.id, "provider-a");
  assert.equal(a.model.id, "provider-a/gpt-5.5");
  assert.equal(b.provider.id, "provider-b");
  assert.equal(b.model.id, "provider-b/gpt-5.5");

  // 短名歧义：不再 first-wins 绑死到 A，而是回退 defaultModel（完整 id）
  const short = resolveRoute(cfg, "gpt-5.5");
  assert.equal(short.model.id, "provider-a/gpt-5.5");
  assert.equal(short.provider.id, "provider-a");

  const router = buildRouter(cfg);
  assert.equal(router.models.has("gpt-5.5"), false);
  assert.equal(router.models.get("provider-a/gpt-5.5").providerId, "provider-a");
  assert.equal(router.models.get("provider-b/gpt-5.5").providerId, "provider-b");
  assert.ok(router.ambiguousSecondaryKeys.has("gpt-5.5"));
});

test("resolveRoute · 唯一短名仍可路由（单供应商兼容）", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "only", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [{ id: "only/gpt-5.5", providerId: "only", upstreamModel: "gpt-5.5" }]
  });
  const r = resolveRoute(cfg, "gpt-5.5");
  assert.equal(r.model.id, "only/gpt-5.5");
  assert.equal(r.provider.id, "only");
});

test("deleted provider detection only accepts a qualified id for an absent provider", () => {
  const cfg = makeConfig();
  assert.equal(isDeletedProviderModelRequest(cfg, "removed/gpt-5.6-sol"), true);
  assert.equal(isDeletedProviderModelRequest(cfg, "p/missing"), false);
  assert.equal(isDeletedProviderModelRequest(cfg, "gpt-5.6-sol"), false);
});

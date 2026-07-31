import test from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_BUNDLE_KIND,
  buildConfigBundle,
  mergeConfigBundle,
  parseConfigBundle,
  previewConfigBundleMerge,
  stripProviderSecrets
} from "../src/config-bundle.mjs";

const sampleConfig = {
  host: "127.0.0.1",
  port: 17888,
  providers: [
    {
      id: "openai",
      name: "OpenAI",
      apiFormat: "openai_chat",
      baseUrl: "https://api.openai.com/v1",
      authMode: "api_key",
      apiKey: "sk-live-secret-do-not-leak"
    },
    {
      id: "pool-xai",
      name: "xAI Pool",
      apiFormat: "openai_responses",
      baseUrl: "https://api.x.ai/v1",
      authMode: "account_pool",
      poolKind: "xai_oauth"
    },
    {
      id: "other",
      name: "Other",
      apiFormat: "openai_chat",
      baseUrl: "https://example.com/v1",
      authMode: "keychain",
      keychainAccount: "provider:other"
    }
  ],
  models: [
    { id: "openai/gpt-5", providerId: "openai", upstreamModel: "gpt-5", displayName: "GPT-5" },
    { id: "pool-xai/grok", providerId: "pool-xai", upstreamModel: "grok-4", displayName: "Grok" },
    { id: "other/m1", providerId: "other", upstreamModel: "m1", displayName: "M1" }
  ],
  clients: { codex: { enabled: true } }
};

test("stripProviderSecrets removes inline keys", () => {
  const stripped = stripProviderSecrets({
    id: "x",
    apiKey: "sk-abc",
    usage_check: { apiKey: "sk-usage", url: "https://example.com" }
  });
  assert.equal(stripped.apiKey, undefined);
  assert.equal(stripped.usage_check.apiKey, undefined);
  assert.equal(stripped.usage_check.url, "https://example.com");
});

test("buildConfigBundle selects providers and models without secrets by default", () => {
  const bundle = buildConfigBundle(sampleConfig, { providerIds: ["openai", "pool-xai"] });
  assert.equal(bundle.kind, CONFIG_BUNDLE_KIND);
  assert.equal(bundle.includeSecrets, false);
  assert.deepEqual(bundle.providers.map((row) => row.id), ["openai", "pool-xai"]);
  assert.deepEqual(bundle.models.map((row) => row.id), ["openai/gpt-5", "pool-xai/grok"]);
  assert.equal(JSON.stringify(bundle).includes("sk-live-secret"), false);
  assert.equal(bundle.secrets.status, "omitted");
  assert.equal(bundle.secrets.byProvider.openai.status, "omitted");
  assert.equal(bundle.secrets.byProvider.openai.hadInlineKey, true);
  assert.match(bundle.secrets.byProvider.openai.mask, /••••/);
});

test("buildConfigBundle can include resolved secrets", () => {
  const bundle = buildConfigBundle(sampleConfig, {
    providerIds: ["openai", "pool-xai", "other"],
    includeSecrets: true,
    secretsResolver(provider) {
      if (provider.id === "openai") return { status: "included", apiKey: "sk-live-secret-do-not-leak" };
      if (provider.id === "pool-xai") {
        return {
          status: "included",
          pool: { providerId: "pool-xai", poolKind: "xai_oauth", accounts: [{ id: "a1", refreshToken: "rt" }] }
        };
      }
      return { status: "unavailable", reason: "keychain empty" };
    }
  });
  assert.equal(bundle.includeSecrets, true);
  assert.equal(bundle.secrets.status, "included");
  assert.equal(bundle.secrets.byProvider.openai.apiKey, "sk-live-secret-do-not-leak");
  assert.equal(bundle.secrets.byProvider["pool-xai"].pool.accounts[0].refreshToken, "rt");
  assert.equal(bundle.secrets.byProvider.other.status, "unavailable");
  // 供应商本体仍不含密钥字段
  assert.equal(bundle.providers.find((row) => row.id === "openai").apiKey, undefined);
});

test("mergeConfigBundle skips existing ids and can apply secrets to new providers", () => {
  const existing = {
    providers: [{ id: "openai", name: "已有 OpenAI", apiFormat: "openai_chat", baseUrl: "https://api.openai.com/v1" }],
    models: [{ id: "openai/gpt-5", providerId: "openai", upstreamModel: "gpt-5" }]
  };
  const bundle = buildConfigBundle(sampleConfig, {
    providerIds: ["openai", "pool-xai"],
    includeSecrets: true,
    secretsResolver(provider) {
      if (provider.id === "pool-xai") {
        return { status: "included", pool: { providerId: "pool-xai", poolKind: "xai_oauth", accounts: [] } };
      }
      return { status: "included", apiKey: "sk-new" };
    }
  });
  const applied = [];
  const merged = mergeConfigBundle(existing, bundle, {
    secretsApplier(provider, entry) {
      applied.push({ id: provider.id, hasPool: Boolean(entry.pool), hasKey: Boolean(entry.apiKey) });
      return { ok: true, mode: entry.pool ? "pool" : "apiKey" };
    }
  });
  assert.equal(merged.addProviders.length, 1);
  assert.equal(merged.addProviders[0].id, "pool-xai");
  assert.equal(merged.skipProviders.map((row) => row.id).join(), "openai");
  assert.equal(merged.addModels.length, 1);
  assert.equal(merged.config.providers.length, 2);
  assert.deepEqual(applied, [{ id: "pool-xai", hasPool: true, hasKey: false }]);
  assert.equal(merged.skippedSecrets[0].providerId, "openai");
});

test("parseConfigBundle rejects foreign payloads", () => {
  assert.throws(() => parseConfigBundle({ kind: "other", version: 1, providers: [], models: [] }), /不是 Switchyard/);
  const preview = previewConfigBundleMerge({ providers: [], models: [] }, {
    kind: CONFIG_BUNDLE_KIND,
    version: 1,
    providers: [{ id: "p1", name: "P1" }],
    models: [{ id: "p1/m1", providerId: "p1" }]
  });
  assert.equal(preview.addProviders.length, 1);
});

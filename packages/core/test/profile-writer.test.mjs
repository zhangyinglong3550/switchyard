import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-profile-"));
process.env.HOME = tmpHome;
process.env.SWITCHYARD_BACKUP_DIR = path.join(tmpHome, ".switchyard", "backups");

const pw = await import("../src/profile-writer.mjs");

test("codex profile · merges with existing TOML without losing user blocks", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[mcp]\nfoo = "bar"\n', "utf8");
  fs.writeFileSync(pw.codexModelsCachePath(), JSON.stringify({
    fetched_at: "2026-01-01T00:00:00Z",
    etag: "old",
    client_version: "0.142.0",
    models: [{ slug: "gpt-5.5" }]
  }, null, 2), "utf8");

  const r = pw.applyCodex({ host: "127.0.0.1", port: 17888, defaultModel: "kimi/k2" });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\[mcp\]/);
  assert.match(text, /foo = "bar"/);
  assert.match(text, /model_provider = "custom"/);
  assert.match(text, /\[model_providers\.custom\]/);
  assert.match(text, /wire_api = "responses"/);
  assert.match(text, /requires_openai_auth = true/);
  assert.match(text, /supports_websockets = false/);
  assert.match(text, /experimental_bearer_token = "dummy"/);
  assert.match(text, /request_max_retries = 5/);
  assert.match(text, /stream_max_retries = 5/);
  assert.match(text, /model = "kimi\/k2"/);
  assert.match(text, /model_reasoning_effort = "low"/);
  assert.match(text, /model_catalog_json = ".*codex-model-catalog\.json"/);
  assert.ok(
    text.indexOf("model_catalog_json") < text.indexOf("[mcp]"),
    "model_catalog_json must stay at TOML top level before any table"
  );
  assert.ok(
    text.indexOf('model_provider = "custom"') < text.indexOf("[mcp]"),
    "model_provider must stay at TOML top level before any table"
  );
  assert.ok(
    text.indexOf('model = "kimi/k2"') < text.indexOf("[mcp]"),
    "default model must stay at TOML top level before any table"
  );
  assert.ok(r.backup, "backup created");
});

test("codex profile · official direct removes Switchyard routing without touching user blocks", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# managed-by: managed-by-switchyard',
    'model_provider = "custom"',
    `model_catalog_json = "${pw.codexModelCatalogPath()}"`,
    'openai_base_url = "http://127.0.0.1:17888/v1"',
    'model_reasoning_effort = "low"',
    'model = "deepseek/deepseek-v4-pro"',
    '',
    '[mcp]',
    'foo = "bar"',
    '',
    '[model_providers.custom]',
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join("\n"), "utf8");

  const result = pw.applyCodexOfficialDirect();
  const text = fs.readFileSync(file, "utf8");

  assert.equal(result.mode, "official_direct");
  assert.equal(result.path, file);
  assert.ok(result.backup, "backup created");
  assert.doesNotMatch(text, /managed-by-switchyard/);
  assert.doesNotMatch(text, /model_provider\s*=\s*"custom"/);
  assert.doesNotMatch(text, /model_catalog_json/);
  assert.doesNotMatch(text, /openai_base_url\s*=\s*"http:\/\/127\.0\.0\.1:17888\/v1"/);
  assert.doesNotMatch(text, /\[model_providers\.custom\]/);
  assert.doesNotMatch(text, /\/codex\/v1/);
  assert.match(text, /\[mcp\]/);
  assert.match(text, /foo = "bar"/);
});

test("codex profile · official direct strips provider_direct leftovers", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "# managed-by: switchyard-provider-direct",
    'model_provider = "custom"',
    'model_reasoning_effort = "high"',
    "disable_response_storage = true",
    'model = "gpt-5.5"',
    "",
    "[mcp]",
    'foo = "bar"',
    "",
    "[model_providers.custom]",
    'name = "AI Go"',
    'base_url = "https://aigo.example/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = true",
    'experimental_bearer_token = "sk-xxx"',
    ""
  ].join("\n"), "utf8");

  pw.applyCodexOfficialDirect();
  const text = fs.readFileSync(file, "utf8");

  assert.doesNotMatch(text, /switchyard-provider-direct/);
  assert.doesNotMatch(text, /model_provider\s*=/);
  assert.doesNotMatch(text, /disable_response_storage/);
  assert.doesNotMatch(text, /model_reasoning_effort/);
  assert.doesNotMatch(text, /\[model_providers\.custom\]/);
  assert.doesNotMatch(text, /aigo\.example/);
  assert.doesNotMatch(text, /experimental_bearer_token/);
  assert.doesNotMatch(text, /model = "gpt-5\.5"/);
  assert.match(text, /\[mcp\]/);
  assert.match(text, /foo = "bar"/);
});

test("codex profile · provider_direct requires_openai_auth = true", () => {
  const block = pw.renderCodexProviderDirectBlock({
    name: "AI Go",
    baseUrl: "https://aigo.example/v1",
    apiKey: "sk-test",
    model: "gpt-5.5"
  });
  assert.match(block, /requires_openai_auth = true/);
  assert.doesNotMatch(block, /requires_openai_auth = false/);

  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[mcp]\nfoo = \"bar\"\n", "utf8");
  pw.applyCodexProviderDirect({
    provider: { id: "aigo", name: "AI Go", baseUrl: "https://aigo.example/v1", apiKey: "sk-test" },
    model: { upstreamModel: "gpt-5.5" }
  });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /requires_openai_auth = true/);
  assert.match(text, /experimental_bearer_token = "sk-test"/);
  assert.match(text, /\[mcp\]/);
});

test("codex profile · official direct preserves non-Switchyard custom provider", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    'model_provider = "custom"',
    'model = "gpt-4.1"',
    '',
    '[model_providers.custom]',
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join("\n"), "utf8");

  pw.applyCodexOfficialDirect();
  const text = fs.readFileSync(file, "utf8");

  assert.match(text, /model_provider = "custom"/);
  assert.match(text, /model = "gpt-4\.1"/);
  assert.match(text, /\[model_providers\.custom\]/);
  assert.match(text, /name = "OpenAI"/);
  assert.match(text, /base_url = "https:\/\/api\.openai\.com\/v1"/);
});

test("backupFile · uses parent.basename so Codex/Grok config.toml do not collide", () => {
  const codexFile = pw.codexConfigPath();
  const grokFile = pw.grokConfigPath();
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.mkdirSync(path.dirname(grokFile), { recursive: true });
  fs.writeFileSync(codexFile, 'model_provider = "custom"\n[model_providers.custom]\nname = "Switchyard"\n', "utf8");
  fs.writeFileSync(grokFile, [
    "[cli]",
    'installer = "internal"',
    "",
    "[marketplace]",
    "official_marketplace_auto_installed = true",
    "",
    "[[marketplace.sources]]",
    'name = "xAI Official"',
    "",
    "[ui]",
    'fork_secondary_model = "grok-build"',
    "",
    "[models]",
    'default = "sy-grok-pool--grok-4.5"',
    ""
  ].join("\n"), "utf8");

  const codexBak = pw.backupFile(codexFile);
  const grokBak = pw.backupFile(grokFile);
  assert.ok(codexBak.includes("codex.config.toml."));
  assert.ok(grokBak.includes("grok.config.toml."));
  assert.notEqual(path.basename(codexBak), path.basename(grokBak));

  const codexList = pw.listBackups(codexFile).map((e) => e.name);
  const grokList = pw.listBackups(grokFile).map((e) => e.name);
  assert.ok(codexList.some((n) => n.startsWith("codex.config.toml.")));
  assert.ok(grokList.some((n) => n.startsWith("grok.config.toml.")));
  assert.ok(!codexList.some((n) => n.startsWith("grok.config.toml.")));
  assert.ok(!grokList.some((n) => n.startsWith("codex.config.toml.")));
});

test("listBackups · legacy config.toml backups exclude foreign client content", () => {
  const codexFile = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  fs.writeFileSync(codexFile, "current-codex\n", "utf8");
  fs.mkdirSync(process.env.SWITCHYARD_BACKUP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.SWITCHYARD_BACKUP_DIR, "config.toml.2099-02-01T00-00-00-000Z.bak"),
    'model_provider = "custom"\n[model_providers.custom]\nname = "Switchyard"\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(process.env.SWITCHYARD_BACKUP_DIR, "config.toml.2099-02-01T00-00-01-000Z.bak"),
    [
      "[cli]",
      'installer = "internal"',
      "[marketplace]",
      "official_marketplace_auto_installed = true",
      "[[marketplace.sources]]",
      'name = "xAI Official"',
      "[ui]",
      'fork_secondary_model = "grok-build"',
      "[models]",
      'default = "sy-x"'
    ].join("\n"),
    "utf8"
  );

  const names = pw.listBackups(codexFile).map((e) => e.name);
  assert.ok(names.includes("config.toml.2099-02-01T00-00-00-000Z.bak"));
  assert.ok(!names.includes("config.toml.2099-02-01T00-00-01-000Z.bak"), "Grok-shaped legacy backup must not appear in Codex list");
});

test("codex profile · writes model catalog for Codex App model picker", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[mcp]\nfoo = "bar"\n', "utf8");

  const models = [
    {
      id: "codex/gpt-5.5",
      providerId: "codex",
      upstreamModel: "gpt-5.5",
      displayName: "GPT-5.5 via Switchyard",
      capabilities: { images: true }
    },
    {
      id: "deepseek/deepseek-v4-flash",
      providerId: "deepseek",
      upstreamModel: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash"
    }
  ];

  const r = pw.applyCodex({ host: "127.0.0.1", port: 17888, defaultModel: "codex/gpt-5.5", models });
  assert.equal(r.catalogPath, pw.codexModelCatalogPath());
  assert.equal(r.cachePath, pw.codexModelsCachePath());
  assert.equal(r.ccSwitchCatalogPath, pw.ccSwitchCodexModelCatalogPath());
  assert.equal(r.ccSwitchProfilePath, pw.ccSwitchGatewayProfilePath());
  assert.equal(r.modelCount, 2);
  const catalog = JSON.parse(fs.readFileSync(r.catalogPath, "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-5.5", "deepseek/deepseek-v4-flash"]);
  assert.equal(catalog.models[0].display_name, "GPT-5.5 via Switchyard · codex");
  assert.equal(catalog.models[0]["x-switchyard-model-id"], "codex/gpt-5.5");
  assert.equal(catalog.models[0]["x-switchyard-upstream-model"], "gpt-5.5");
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[0].default_reasoning_level, "medium");
  assert.ok(catalog.models[0].supported_reasoning_levels.every((item) => ["low", "medium", "high", "xhigh"].includes(item.effort)));
  assert.deepEqual(catalog.models[0].additional_speed_tiers, ["fast"]);
  assert.deepEqual(catalog.models[0].service_tiers, [{
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage"
  }]);
  assert.equal(catalog.models[1].display_name, "DeepSeek V4 Flash · deepseek");
  assert.equal(catalog.models[1].supported_in_api, true);
  assert.deepEqual(catalog.models[1].additional_speed_tiers, []);
  assert.deepEqual(catalog.models[1].service_tiers, []);
  const profile = fs.readFileSync(r.path, "utf8");
  assert.match(profile, /model = "gpt-5\.5"/);
  const cache = JSON.parse(fs.readFileSync(r.cachePath, "utf8"));
  assert.equal(cache.client_version, "0.142.0");
  assert.equal(cache.etag, 'W/"switchyard-2"');
  assert.deepEqual(cache.models.map((model) => model.slug), ["gpt-5.5", "deepseek/deepseek-v4-flash"]);
  const ccSwitchCatalog = JSON.parse(fs.readFileSync(r.ccSwitchCatalogPath, "utf8"));
  assert.deepEqual(ccSwitchCatalog.models.map((model) => model.slug), ["gpt-5.5", "deepseek/deepseek-v4-flash"]);
  const ccSwitchProfile = fs.readFileSync(r.ccSwitchProfilePath, "utf8");
  assert.match(ccSwitchProfile, /model_provider = "custom"/);
  assert.match(ccSwitchProfile, /model_catalog_json = ".*cc-switch-model-catalog\.json"/);
  assert.match(ccSwitchProfile, /base_url = "http:\/\/127\.0\.0\.1:17888\/codex\/v1"/);
  assert.match(ccSwitchProfile, /requires_openai_auth = true/);
  assert.match(ccSwitchProfile, /request_max_retries = 5/);
});

test("codex profile · model catalog exposes image input when a vision fallback is configured", () => {
  const catalog = pw.buildCodexModelCatalog({
    models: [{
      id: "deepseek/deepseek-v4-flash",
      providerId: "deepseek",
      upstreamModel: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      capabilities: { text: true, images: false, multimodal: false },
      visionFallbackModelId: "codex/gpt-5.5"
    }]
  });

  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[0]["x-switchyard-vision-fallback-model"], "codex/gpt-5.5");
});

test("codex profile · gpt-5.6 family exposes max/ultra reasoning levels", () => {
  const catalog = pw.buildCodexModelCatalog({
    models: [
      {
        id: "codex/gpt-5.6-sol",
        providerId: "codex",
        upstreamModel: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol"
      },
      {
        id: "codex/gpt-5.6-luna",
        providerId: "codex",
        upstreamModel: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna"
      }
    ]
  });
  const sol = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
  const luna = catalog.models.find((model) => model.slug === "gpt-5.6-luna");
  assert.equal(sol.default_reasoning_level, "low");
  assert.ok(sol.supported_reasoning_levels.some((item) => item.effort === "max"));
  assert.ok(sol.supported_reasoning_levels.some((item) => item.effort === "ultra"));
  assert.equal(luna.default_reasoning_level, "medium");
  assert.ok(luna.supported_reasoning_levels.some((item) => item.effort === "max"));
  assert.equal(luna.supported_reasoning_levels.some((item) => item.effort === "ultra"), false);
});

test("codex profile · Cursor models expose Agent-selected fast tier without model variants", () => {
  const catalog = pw.buildCodexModelCatalog({
    models: [{
      id: "cursor-subscription/grok-4.5",
      providerId: "cursor-subscription",
      providerApiFormat: "cursor_subscription",
      upstreamModel: "grok-4.5",
      displayName: "Cursor Grok 4.5",
      capabilities: { text: true, reasoning: true, tools: true, stream: true }
    }]
  });
  assert.equal(catalog.models[0].slug, "cursor-subscription/grok-4.5");
  assert.deepEqual(catalog.models[0].additional_speed_tiers, ["fast"]);
  assert.deepEqual(catalog.models[0].service_tiers, [{
    id: "priority",
    name: "Fast",
    description: "1.5x speed, increased usage"
  }]);
  assert.ok(catalog.models[0].supported_reasoning_levels.some((item) => item.effort === "high"));
});

test("codex profile · repairs model cache drift when Switchyard custom provider is active", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    'model_provider = "custom"',
    `model_catalog_json = "${pw.codexModelCatalogPath()}"`,
    'model = "codex/gpt-5.5"',
    "",
    "[model_providers.custom]",
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    ""
  ].join("\n"), "utf8");
  fs.writeFileSync(pw.codexModelsCachePath(), JSON.stringify({
    fetched_at: "2026-01-01T00:00:00Z",
    etag: "official",
    client_version: "0.142.0",
    models: [{ slug: "gpt-5.5" }, { slug: "gpt-5.4" }]
  }, null, 2), "utf8");

  const result = pw.syncCodexModelArtifacts({
    defaultModel: "codex/gpt-5.5",
    models: [
      { id: "codex/gpt-5.5", providerId: "codex", providerName: "Codex", upstreamModel: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", providerName: "DeepSeek", upstreamModel: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" }
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.cacheChanged, true);
  const cache = JSON.parse(fs.readFileSync(pw.codexModelsCachePath(), "utf8"));
  assert.deepEqual(cache.models.map((model) => model.slug), ["gpt-5.5", "deepseek/deepseek-v4-flash"]);
  assert.equal(cache.models[0].display_name, "GPT-5.5 · Codex");
  const catalog = JSON.parse(fs.readFileSync(pw.codexModelCatalogPath(), "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.slug), ["gpt-5.5", "deepseek/deepseek-v4-flash"]);
});

test("codex profile · skips model cache repair when custom provider is not Switchyard", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    'model_provider = "custom"',
    "",
    "[model_providers.custom]",
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    "requires_openai_auth = false",
    ""
  ].join("\n"), "utf8");
  const before = JSON.stringify({
    fetched_at: "2026-01-01T00:00:00Z",
    etag: "official",
    client_version: "0.142.0",
    models: [{ slug: "gpt-5.5" }]
  }, null, 2) + "\n";
  fs.writeFileSync(pw.codexModelsCachePath(), before, "utf8");

  const result = pw.syncCodexModelArtifacts({
    defaultModel: "deepseek/deepseek-v4-flash",
    models: [{ id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash" }]
  });

  assert.equal(result.skipped, true);
  assert.equal(fs.readFileSync(pw.codexModelsCachePath(), "utf8"), before);
});

test("profile artifacts · syncs Codex and Claude Code model caches from visible models", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    'model_provider = "custom"',
    `model_catalog_json = "${pw.codexModelCatalogPath()}"`,
    "",
    "[model_providers.custom]",
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    ""
  ].join("\n"), "utf8");

  const result = pw.syncClientModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    codexDefaultModel: "codex/gpt-5.5",
    codexModels: [
      { id: "codex/gpt-5.5", providerId: "codex", providerName: "Codex", upstreamModel: "gpt-5.5", displayName: "GPT-5.5" }
    ],
    claudeCodeModels: [
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", providerName: "DeepSeek", upstreamModel: "deepseek-v4-pro" }
    ]
  });

  assert.equal(result.codex.ok, true);
  assert.equal(result.claudeCode.modelCount, 1);
  const codexCache = JSON.parse(fs.readFileSync(pw.codexModelsCachePath(), "utf8"));
  assert.deepEqual(codexCache.models.map((model) => model.slug), ["gpt-5.5"]);
  const claudeCache = JSON.parse(fs.readFileSync(pw.claudeCodeGatewayModelsCachePath(), "utf8"));
  assert.equal(claudeCache.baseUrl, "http://127.0.0.1:17888/claude-code");
  assert.equal(claudeCache.models.length, 1);
  assert.equal(claudeCache.models[0].display_name, "deepseek-v4-pro · DeepSeek");
});

test("codex profile · orphaned defaultModel falls back to first live catalog model", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "# managed-by: managed-by-switchyard",
    'model_provider = "custom"',
    `model_catalog_json = "${pw.codexModelCatalogPath()}"`,
    'openai_base_url = "http://127.0.0.1:17888/v1"',
    'model = "codex-pool/gpt-5.6-luna"',
    "",
    "[model_providers.custom]",
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    ""
  ].join("\n"), "utf8");
  fs.mkdirSync(path.dirname(pw.ccSwitchGatewayProfilePath()), { recursive: true });
  fs.writeFileSync(pw.ccSwitchGatewayProfilePath(), [
    "# >>> switchyard-managed ccswitch-gateway >>>",
    'model_provider = "custom"',
    'model = "codex-pool/gpt-5.6-luna"',
    'openai_base_url = "http://127.0.0.1:17888/v1"',
    ""
  ].join("\n"), "utf8");

  const models = [
    {
      id: "wecode-gpt/gpt-5.6-luna",
      providerId: "wecode-gpt",
      providerName: "WeCode GPT",
      upstreamModel: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna"
    },
    {
      id: "token-gpt/gpt-5.6-sol",
      providerId: "token-gpt",
      providerName: "Token GPT",
      upstreamModel: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol"
    }
  ];

  const applied = pw.applyCodex({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "codex-pool/gpt-5.6-luna",
    models
  });
  const profile = fs.readFileSync(applied.path, "utf8");
  assert.match(profile, /model = "wecode-gpt\/gpt-5\.6-luna"/);
  assert.doesNotMatch(profile, /codex-pool/);

  // Re-seed orphan model line then sync (catalog path used on config:save)
  fs.writeFileSync(file, [
    "# managed-by: managed-by-switchyard",
    'model_provider = "custom"',
    `model_catalog_json = "${pw.codexModelCatalogPath()}"`,
    'openai_base_url = "http://127.0.0.1:17888/v1"',
    'model = "codex-pool/gpt-5.6-sol"',
    "",
    "[model_providers.custom]",
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    ""
  ].join("\n"), "utf8");

  const synced = pw.syncCodexModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "codex-pool/gpt-5.6-luna",
    models
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.profileModelChanged, true);
  assert.equal(synced.profileDefaultModel, "wecode-gpt/gpt-5.6-luna");
  const afterSync = fs.readFileSync(file, "utf8");
  assert.match(afterSync, /model = "wecode-gpt\/gpt-5\.6-luna"/);
  assert.doesNotMatch(afterSync, /codex-pool/);
  const cc = fs.readFileSync(pw.ccSwitchGatewayProfilePath(), "utf8");
  assert.match(cc, /model = "wecode-gpt\/gpt-5\.6-luna"/);
});

test("codex profile · model catalog display names include provider to disambiguate duplicates", () => {
  const catalog = pw.buildCodexModelCatalog({
    models: [
      { id: "opencode-go/glm-5.2", providerId: "opencode-go", upstreamModel: "glm-5.2", displayName: "GLM 5.2" },
      { id: "z-ai/glm-5.2", providerId: "z-ai", upstreamModel: "glm-5.2", displayName: "GLM 5.2" },
      { id: "deepseek/deepseek-v4", providerId: "deepseek", upstreamModel: "deepseek-v4", displayName: "DeepSeek V4" }
    ]
  });

  assert.deepEqual(catalog.models.map((model) => model.display_name), [
    "GLM 5.2 · opencode-go",
    "GLM 5.2 · z-ai",
    "DeepSeek V4 · deepseek"
  ]);
});

test("codex profile · 双供应商同名模型 catalog slug 全部保留且唯一", () => {
  const catalog = pw.buildCodexModelCatalog({
    models: [
      { id: "provider-a/gpt-5.5", providerId: "codex", providerName: "A", upstreamModel: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "provider-b/gpt-5.5", providerId: "aigo-gpt", providerName: "B", upstreamModel: "gpt-5.5", displayName: "GPT-5.5" }
    ]
  });
  const slugs = catalog.models.map((m) => m.slug);
  assert.deepEqual(slugs, ["provider-a/gpt-5.5", "provider-b/gpt-5.5"]);
  assert.equal(catalog.models[0]["x-switchyard-provider"], "codex");
  assert.equal(catalog.models[1]["x-switchyard-provider"], "aigo-gpt");
  // 显示名仍带供应商，方便在 Codex 里区分
  assert.equal(catalog.models[0].display_name, "GPT-5.5 · A");
  assert.equal(catalog.models[1].display_name, "GPT-5.5 · B");
});

test("codex profile · model catalog prefers provider display names", () => {
  const catalog = pw.buildCodexModelCatalog({
    models: [
      {
        id: "coding-plan/GLM-5.2",
        providerId: "coding-plan",
        providerName: "火山Coding plan",
        upstreamModel: "GLM-5.2",
        displayName: "GLM-5.2"
      }
    ]
  });

  assert.equal(catalog.models[0].display_name, "GLM-5.2 · 火山Coding plan");
  assert.equal(catalog.models[0].description, "火山Coding plan via Switchyard.");
});

test("codex profile · re-apply replaces custom provider block for Codex session continuity", () => {
  const file = pw.codexConfigPath();
  // already applied once above
  fs.appendFileSync(file, [
    "",
    "[model_providers.switchyard]",
    'name = "Old Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    "",
    "[model_providers.custom]",
    'name = "OpenAI"',
    "requires_openai_auth = false",
    'wire_api = "responses"',
    ""
  ].join("\n"), "utf8");
  pw.applyCodex({ host: "127.0.0.1", port: 18999 });
  const text = fs.readFileSync(file, "utf8");
  const customOccurrences = (text.match(/\[model_providers\.custom\]/g) || []).length;
  const switchyardOccurrences = (text.match(/\[model_providers\.switchyard\]/g) || []).length;
  assert.equal(customOccurrences, 1, "custom block should not duplicate");
  assert.equal(switchyardOccurrences, 0, "legacy switchyard block should be removed");
  assert.match(text, /\[model_providers\.custom\]\nname = "Switchyard"/);
  assert.doesNotMatch(text, /\[model_providers\.custom\]\nname = "OpenAI"/);
  assert.match(text, /:18999/);
});

test("codex profile · repairs managed routing lines that were written inside a TOML table", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "[mcp]",
    'foo = "bar"',
    "# managed-by: managed-by-switchyard",
    'model_provider = "custom"',
    'model_reasoning_effort = "medium"',
    'model = "old/model"',
    "",
    "[unrelated]",
    'model_provider = "keep-me"',
    'model = "keep-model"',
    "",
    "[model_providers.custom]",
    'name = "Old Switchyard"',
    'base_url = "http://127.0.0.1:9999/codex/v1"',
    ""
  ].join("\n"), "utf8");

  pw.applyCodex({ host: "127.0.0.1", port: 17888, defaultModel: "new/model" });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(
    text.indexOf('model_provider = "custom"') < text.indexOf("[mcp]"),
    "managed model_provider should be rewritten at TOML top level"
  );
  assert.ok(
    text.indexOf('model = "new/model"') < text.indexOf("[mcp]"),
    "managed default model should be rewritten at TOML top level"
  );
  assert.match(text, /model_reasoning_effort = "low"/);
  assert.doesNotMatch(text, /model_reasoning_effort = "medium"/);
  assert.doesNotMatch(text, /old\/model/);
  assert.match(text, /\[unrelated\]\nmodel_provider = "keep-me"\nmodel = "keep-model"/);
  assert.match(text, /\[model_providers\.custom\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:17888\/codex\/v1"/);
});

test("claude-code profile · merges into existing settings.json env without dropping unrelated keys", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { OTHER_KEY: "keep" }, theme: "dark" }, null, 2), "utf8");

  pw.applyClaudeCode({ host: "127.0.0.1", port: 17888 });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.env.OTHER_KEY, "keep");
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:17888/claude-code");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, "${SWITCHYARD_KEY}");
  assert.equal(parsed.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, "1");
  assert.equal(parsed["managed-by-switchyard"], true);
});

test("claude-code profile · disables Foundry routing that would bypass Switchyard", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    theme: "dark",
    env: {
      OTHER_KEY: "keep",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://openapi-ait.ke.com",
      ANTHROPIC_FOUNDRY_API_KEY: "secret-key",
      ANTHROPIC_CUSTOM_HEADERS: "email-prefix: user",
      ANTHROPIC_SMALL_FAST_MODEL: "GLM-5.1",
      CLAUDE_CODE_SUBAGENT_MODEL: "GLM-5.1",
      OTEL_LOGS_EXPORTER: "otlp"
    }
  }, null, 2), "utf8");

  pw.applyClaudeCode({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "ke/glm-5.2",
    models: [
      { id: "ke/glm-5.2", providerId: "ke", upstreamModel: "glm-5.2", displayName: "GLM-5.2" },
      { id: "ke/deepseek-v4-flash", providerId: "ke", upstreamModel: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" }
    ]
  });

  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.env.OTHER_KEY, "keep");
  assert.equal(parsed.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(parsed.env.ANTHROPIC_CUSTOM_HEADERS, "email-prefix: user");
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:17888/claude-code");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, "${SWITCHYARD_KEY}");
  assert.equal(parsed.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.equal(parsed.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH, undefined);
  assert.equal(parsed.env.ANTHROPIC_FOUNDRY_BASE_URL, undefined);
  assert.equal(parsed.env.ANTHROPIC_FOUNDRY_API_KEY, undefined);
  assert.equal(parsed.env.ANTHROPIC_SMALL_FAST_MODEL, undefined);
  assert.equal(parsed.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  assert.match(parsed.env.ANTHROPIC_MODEL, /^claude-switchyard-ke-glm-5\.2-/);
});

test("claude-code preview · returns merged settings.json not just the patch", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    theme: "keep-me",
    env: {
      OTHER_KEY: "keep",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_FOUNDRY_BASE_URL: "https://openapi-ait.ke.com"
    }
  }, null, 2), "utf8");

  const text = pw.previewClaudeCodeProfile({ host: "127.0.0.1", port: 17888 });
  const parsed = JSON.parse(text);
  assert.equal(parsed.theme, "keep-me");
  assert.equal(parsed.env.OTHER_KEY, "keep");
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:17888/claude-code");
  assert.equal(parsed.env.CLAUDE_CODE_USE_FOUNDRY, undefined);
  assert.equal(parsed.env.ANTHROPIC_FOUNDRY_BASE_URL, undefined);
  assert.equal(parsed["managed-by-switchyard"], true);
});

test("claude-code profile · replaces stale single-model slots with routed Switchyard models", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    env: {
      OTHER_KEY: "keep",
      ANTHROPIC_MODEL: "glm-5.2",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5.2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1M]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2[1M]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "glm-5.2[1M]"
    }
  }, null, 2), "utf8");

  pw.applyClaudeCode({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "opencode go/glm-5.2",
    models: [
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
      { id: "opencode go/glm-5.2", providerId: "opencode go", upstreamModel: "glm-5.2", displayName: "GLM 5.2" },
      { id: "opencode go/kimi-k2.7-code", providerId: "opencode go", upstreamModel: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" }
    ]
  });

  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.env.OTHER_KEY, "keep");
  assert.match(parsed.env.ANTHROPIC_MODEL, /^claude-switchyard-opencode-go-glm-5.2-/);
  assert.match(parsed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, /^claude-switchyard-deepseek-deepseek-v4-flash-/);
  assert.equal(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL, parsed.env.ANTHROPIC_MODEL);
  assert.match(parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL, /^claude-switchyard-opencode-go-kimi-k2.7-code-/);
  assert.equal(parsed.env.ANTHROPIC_DEFAULT_FABLE_MODEL, parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL);
  assert.equal(parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME, "GLM 5.2");
  assert.ok(!Object.values(parsed.env).some((value) => typeof value === "string" && value.includes("[1M]")));
  const routedSlots = [
    parsed.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    parsed.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    parsed.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    parsed.env.ANTHROPIC_DEFAULT_FABLE_MODEL
  ];
  assert.ok(new Set(routedSlots).size >= 2, "Claude Code should get multiple selectable models when available");
});

test("claude-code profile · writes gateway model cache for full /model picker", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: {} }, null, 2), "utf8");

  const result = pw.applyClaudeCode({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "deepseek/deepseek-v4-pro",
    models: [
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", providerName: "DeepSeek", upstreamModel: "deepseek-v4-flash" },
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", providerName: "DeepSeek", upstreamModel: "deepseek-v4-pro" },
      { id: "opencode-go/glm-5.2", providerId: "opencode-go", providerName: "OpenCode Go", upstreamModel: "glm-5.2", displayName: "GLM 5.2" }
    ]
  });

  assert.equal(result.cachePath, pw.claudeCodeGatewayModelsCachePath());
  assert.equal(result.cacheSkipped, false);
  assert.equal(result.modelCount, 3);

  const cache = JSON.parse(fs.readFileSync(pw.claudeCodeGatewayModelsCachePath(), "utf8"));
  assert.equal(cache.baseUrl, "http://127.0.0.1:17888/claude-code");
  assert.equal(cache.models.length, 3);
  assert.deepEqual(cache.models.map((model) => model.display_name), [
    "deepseek-v4-flash · DeepSeek",
    "deepseek-v4-pro · DeepSeek",
    "GLM 5.2 · OpenCode Go"
  ]);
  assert.ok(cache.models.every((model) => /^claude-switchyard-/.test(model.id)));
});

test("claude-code model slots · keep fast models in Haiku instead of pinning Sonnet", () => {
  const env = pw.claudeCodeModelEnv({
    models: [
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash" },
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro" },
      { id: "opencode go/kimi-k2.7-code", providerId: "opencode go", upstreamModel: "kimi-k2.7-code" },
      { id: "opencode go/glm-5.2", providerId: "opencode go", upstreamModel: "glm-5.2" }
    ]
  });

  assert.match(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, /^claude-switchyard-deepseek-deepseek-v4-flash-/);
  assert.match(env.ANTHROPIC_DEFAULT_SONNET_MODEL, /^claude-switchyard-deepseek-deepseek-v4-pro-/);
  assert.equal(env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  assert.match(env.ANTHROPIC_DEFAULT_OPUS_MODEL, /^claude-switchyard-opencode-go-kimi-k2.7-code-/);
  assert.match(env.ANTHROPIC_DEFAULT_FABLE_MODEL, /^claude-switchyard-opencode-go-glm-5.2-/);
});

test("claude-code model slots · explicit fast agent default becomes the active default", () => {
  const env = pw.claudeCodeModelEnv({
    defaultModel: "deepseek/deepseek-v4-flash",
    models: [
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash" },
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro" }
    ]
  });

  assert.match(env.ANTHROPIC_MODEL, /^claude-switchyard-deepseek-deepseek-v4-flash-/);
  assert.equal(env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  assert.match(env.ANTHROPIC_DEFAULT_SONNET_MODEL, /^claude-switchyard-deepseek-deepseek-v4-pro-/);
});

test("claude-code model slots · ignore Codex GPT default when third-party models exist", () => {
  const env = pw.claudeCodeModelEnv({
    defaultModel: "codex/gpt-5.5",
    models: [
      { id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5" },
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash" },
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro" },
      { id: "opencode-go/glm-5.2", providerId: "opencode-go", upstreamModel: "glm-5.2" }
    ]
  });

  assert.match(env.ANTHROPIC_MODEL, /^claude-switchyard-deepseek-deepseek-v4-pro-/);
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_MODEL);
  assert.match(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, /^claude-switchyard-deepseek-deepseek-v4-flash-/);
  assert.match(env.ANTHROPIC_DEFAULT_OPUS_MODEL, /^claude-switchyard-opencode-go-glm-5.2-/);
  assert.ok(!Object.values(env).includes("codex/gpt-5.5"));
});

test("claude-code model slots · explicit mapping overrides automatic slot picks", () => {
  const env = pw.claudeCodeModelEnv({
    models: [
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash" },
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" },
      { id: "opencode-go/glm-5.2", providerId: "opencode-go", upstreamModel: "glm-5.2", displayName: "GLM 5.2" },
      { id: "opencode-go/qwen3.7-max", providerId: "opencode-go", upstreamModel: "qwen3.7-max", displayName: "Qwen 3.7 Max" },
      { id: "coding-plan/kimi-k2.7-code", providerId: "coding-plan", upstreamModel: "kimi-k2.7-code", displayName: "Kimi K2.7 Code" }
    ],
    modelMapping: {
      default: "opencode-go/qwen3.7-max",
      haiku: "deepseek/deepseek-v4-flash",
      sonnet: "deepseek/deepseek-v4-pro",
      opus: "opencode-go/glm-5.2",
      fable: "coding-plan/kimi-k2.7-code"
    }
  });

  assert.match(env.ANTHROPIC_MODEL, /^claude-switchyard-opencode-go-qwen3.7-max-/);
  assert.match(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, /^claude-switchyard-deepseek-deepseek-v4-flash-/);
  assert.match(env.ANTHROPIC_DEFAULT_SONNET_MODEL, /^claude-switchyard-deepseek-deepseek-v4-pro-/);
  assert.match(env.ANTHROPIC_DEFAULT_OPUS_MODEL, /^claude-switchyard-opencode-go-glm-5.2-/);
  assert.match(env.ANTHROPIC_DEFAULT_FABLE_MODEL, /^claude-switchyard-coding-plan-kimi-k2.7-code-/);
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, "GLM 5.2");
});

test("claude-code model slots · agent default model overrides stale default slot mapping", () => {
  const env = pw.claudeCodeModelEnv({
    defaultModel: "coding-plan/GLM-5.2",
    models: [
      { id: "codex/gpt-5.5", providerId: "codex", upstreamModel: "gpt-5.5", displayName: "GPT-5.5" },
      { id: "coding-plan/GLM-5.2", providerId: "coding-plan", upstreamModel: "GLM-5.2", displayName: "GLM-5.2" },
      { id: "huoshan-agent/glm-5.2", providerId: "huoshan-agent", upstreamModel: "glm-5.2", displayName: "glm-5.2" }
    ],
    modelMapping: {
      default: "codex/gpt-5.5",
      haiku: "huoshan-agent/glm-5.2",
      sonnet: "coding-plan/GLM-5.2"
    }
  });

  assert.match(env.ANTHROPIC_MODEL, /^claude-switchyard-coding-plan-glm-5.2-/);
  assert.equal(env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL);
  assert.ok(!env.ANTHROPIC_MODEL.includes("codex-gpt-5.5"));
});

test("hermes profile · creates YAML config when absent", () => {
  const file = pw.hermesYamlConfigPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  // 不应再写 config.json（Hermes 不读取它）
  const jsonFile = pw.hermesConfigPath();
  if (fs.existsSync(jsonFile)) fs.unlinkSync(jsonFile);

  pw.applyHermes({ host: "127.0.0.1", port: 17888, defaultModel: "deepseek/deepseek-v4-flash" });

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /provider: switchyard/);
  assert.match(text, /base_url: http:\/\/127\.0\.0\.1:17888\/hermes\/v1/);
  assert.match(text, /api_key: switchyard-local/);
  assert.equal(fs.existsSync(jsonFile), false, "不应再创建 config.json");
});

test("hermes profile · switches YAML config to Switchyard without dropping providers", () => {
  const file = pw.hermesYamlConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "model:",
    "  default: glm-5.2",
    "  provider: opencode-go",
    "  base_url: ''",
    "providers:",
    "  opencode-go:",
    "    base_url: https://opencode.ai/zen/go/v1",
    "    name: OpenCode Go",
    "    key_env: OPENCODE_GO_API_KEY",
    "    default_model: glm-5.2",
    "    transport: openai_chat",
    ""
  ].join("\n"), "utf8");

  pw.applyHermes({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "deepseek/deepseek-v4-flash",
    models: [
      { id: "deepseek/deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 1000000 },
      { id: "opencode-go/glm-5.2", displayName: "GLM 5.2", contextWindow: 1000000 }
    ]
  });

  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /provider: switchyard/);
  assert.match(text, /default: deepseek\/deepseek-v4-flash/);
  assert.match(text, /switchyard:/);
  assert.match(text, /base_url: http:\/\/127\.0\.0\.1:17888\/hermes\/v1/);
  assert.match(text, /api_key: switchyard-local/);
  assert.match(text, /deepseek\/deepseek-v4-flash:/);
  assert.match(text, /opencode-go\/glm-5\.2:/);
  assert.match(text, /opencode-go:/);
});

test("restoreProfile · restores from latest backup", () => {
  const file = pw.codexConfigPath();
  const originalText = fs.readFileSync(file, "utf8");
  // create a fresh marker text so we can detect restore
  fs.writeFileSync(file, "# replaced\n", "utf8");
  const r = pw.restoreProfile("codex");
  assert.equal(r.ok, true);
  const restored = fs.readFileSync(file, "utf8");
  assert.notEqual(restored, "# replaced\n");
  assert.match(restored, /model_providers\.custom|mcp/);
});

test("restoreLatest · skips backups identical to current file", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"env":{"ANTHROPIC_BASE_URL":"managed"}}\n', "utf8");
  fs.mkdirSync(process.env.SWITCHYARD_BACKUP_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.SWITCHYARD_BACKUP_DIR, "settings.json.2099-01-01T00-00-01-000Z.bak"), '{"env":{"ANTHROPIC_BASE_URL":"managed"}}\n', "utf8");
  fs.writeFileSync(path.join(process.env.SWITCHYARD_BACKUP_DIR, "settings.json.2099-01-01T00-00-00-000Z.bak"), '{"env":{"ANTHROPIC_BASE_URL":"original"}}\n', "utf8");

  const r = pw.restoreLatest(file);
  assert.equal(r.ok, true);
  assert.match(fs.readFileSync(file, "utf8"), /original/);
});

test("restoreProfileBackup · restores selected backup by name", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "current\n", "utf8");
  fs.mkdirSync(process.env.SWITCHYARD_BACKUP_DIR, { recursive: true });
  // 旧版 basename 备份仍可按名恢复；内容需像 Codex 以免被 listBackups 内容过滤掉
  fs.writeFileSync(
    path.join(process.env.SWITCHYARD_BACKUP_DIR, "config.toml.2099-01-01T00-00-01-000Z.bak"),
    'model_provider = "custom"\nnewer\n',
    "utf8"
  );
  fs.writeFileSync(
    path.join(process.env.SWITCHYARD_BACKUP_DIR, "config.toml.2099-01-01T00-00-00-000Z.bak"),
    'model_provider = "custom"\nselected\n',
    "utf8"
  );

  const r = pw.restoreProfileBackup("codex", "config.toml.2099-01-01T00-00-00-000Z.bak");
  assert.equal(r.ok, true);
  assert.equal(r.backupName, "config.toml.2099-01-01T00-00-00-000Z.bak");
  assert.equal(fs.readFileSync(file, "utf8"), 'model_provider = "custom"\nselected\n');
});

test("restoreProfile · returns no-backup when file never backed up", () => {
  // claude-code file currently has a backup from applyClaudeCode; force the path
  // to a clean file with no backups.
  const fakePath = path.join(tmpHome, "no-backups.json");
  fs.writeFileSync(fakePath, "{}", "utf8");
  const list = pw.listBackups(fakePath);
  assert.equal(list.length, 0);
});

test("profile dry-run · does not write to disk", () => {
  const file = pw.hermesYamlConfigPath();
  const before = fs.readFileSync(file, "utf8");
  const r = pw.applyHermes({ host: "10.0.0.1", port: 99999, dryRun: true });
  const after = fs.readFileSync(file, "utf8");
  assert.equal(before, after, "dry run must not mutate file");
  assert.match(r.preview, /10\.0\.0\.1:99999/);
});

test("opencode profile · merges provider.switchyard and preserves other providers", () => {
  const file = pw.openCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      anthropic: { options: { baseURL: "https://api.anthropic.com/v1" } }
    },
    model: "anthropic/claude-sonnet-4-5"
  }, null, 2) + "\n", "utf8");

  const r = pw.applyOpenCode({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "coding-plan/GLM-5.2",
    models: [
      { id: "coding-plan/GLM-5.2", displayName: "GLM-5.2", contextWindow: 1000000, maxOutputTokens: 8192 },
      { id: "grok-pool/grok-4.5", displayName: "Grok 4.5" }
    ]
  });

  assert.equal(r.modelCount, 2);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(cfg.provider.anthropic, "must keep user providers");
  assert.equal(cfg.provider.switchyard.npm, "@ai-sdk/openai-compatible");
  assert.equal(cfg.provider.switchyard.options.baseURL, "http://127.0.0.1:17888/opencode/v1");
  assert.equal(cfg.provider.switchyard.options.apiKey, "switchyard-local");
  assert.equal(cfg.provider.switchyard["managed-by-switchyard"], true);
  assert.equal(cfg.provider.switchyard.models["coding-plan/GLM-5.2"].name, "GLM-5.2");
  assert.equal(cfg.provider.switchyard.models["coding-plan/GLM-5.2"].limit.context, 1000000);
  assert.equal(cfg.provider.switchyard.models["coding-plan/GLM-5.2"].limit.output, 8192);
  assert.equal(cfg.provider.switchyard.models["grok-pool/grok-4.5"].name, "Grok 4.5");
  // 无 context/output 时也要写全 limit，避免 OpenCode Missing key limit.output
  assert.equal(cfg.provider.switchyard.models["grok-pool/grok-4.5"].limit.context, 128000);
  assert.equal(cfg.provider.switchyard.models["grok-pool/grok-4.5"].limit.output, 32000);
  // 用户默认仍是 anthropic 时不要强行改掉
  assert.equal(cfg.model, "anthropic/claude-sonnet-4-5");
});

test("opencode profile · always writes limit.context + limit.output", () => {
  const map = pw.buildOpenCodeModelsMap([
    { id: "a/only-ctx", displayName: "A", contextWindow: 1000000 },
    { id: "b/only-out", displayName: "B", maxOutputTokens: 4096 },
    { id: "c/none", displayName: "C" },
    { id: "d/both", displayName: "D", contextWindow: 200000, maxOutputTokens: 16000 }
  ]);
  assert.deepEqual(map["a/only-ctx"].limit, { context: 1000000, output: 128000 });
  assert.deepEqual(map["b/only-out"].limit, { context: 128000, output: 4096 });
  assert.deepEqual(map["c/none"].limit, { context: 128000, output: 32000 });
  assert.deepEqual(map["d/both"].limit, { context: 200000, output: 16000 });
});

test("opencode profile · exposes Switchyard image capabilities to ACP and CLI", () => {
  const map = pw.buildOpenCodeModelsMap([
    { id: "vision/model", capabilities: { images: true, multimodal: true } },
    { id: "fallback/model", visionFallbackModelId: "vision/model" },
    { id: "text/model", capabilities: { text: true } }
  ]);
  assert.equal(map["vision/model"].attachment, true);
  assert.deepEqual(map["vision/model"].modalities, { input: ["text", "image"], output: ["text"] });
  assert.equal(map["fallback/model"].attachment, true);
  assert.deepEqual(map["fallback/model"].modalities.input, ["text", "image"]);
  assert.equal(map["text/model"].attachment, false);
  assert.deepEqual(map["text/model"].modalities, { input: ["text"], output: ["text"] });
});

test("opencode profile · emits a capability plugin for OpenCode 1.18 config migration", () => {
  const source = pw.renderOpenCodeCapabilityPlugin([
    { id: "vision/model", capabilities: { tools: true, images: true } },
    { id: "text/model", capabilities: { tools: true } }
  ]);
  assert.match(source, /managed-by-switchyard/);
  assert.match(source, /"vision\/model"/);
  assert.match(source, /"image"/);
  assert.match(source, /models\[id\]\.modalities/);
  assert.match(source, /input\.model\.capabilities\.input\.image/);
});

test("opencode profile · auto-refresh models when already managed", () => {
  const file = pw.openCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 干净起点：无其它默认 model，便于验证 switchyard 默认写入
  fs.writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n", "utf8");
  pw.applyOpenCode({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "a/m1",
    models: [{ id: "a/m1", displayName: "M1" }]
  });

  const refreshed = pw.syncOpenCodeModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    models: [{ id: "a/m1", displayName: "M1" }, { id: "b/m2", displayName: "M2" }],
    defaultModel: "a/m1"
  });
  assert.equal(refreshed.skipped, undefined);
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.modelCount, 2);
  assert.equal(refreshed.capabilityPlugin.changed, true);
  assert.equal(fs.existsSync(pw.openCodeCapabilityPluginPath()), true);

  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(cfg.provider.switchyard.models["b/m2"]);
  assert.equal(cfg.model, "switchyard/a/m1");

  const noop = pw.syncOpenCodeModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    models: [{ id: "a/m1", displayName: "M1" }, { id: "b/m2", displayName: "M2" }],
    defaultModel: "a/m1"
  });
  assert.equal(noop.changed, false);
});

test("opencode sync · skips when not managed", () => {
  const file = pw.openCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2) + "\n", "utf8");
  const r = pw.syncOpenCodeModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    models: [{ id: "x/y", displayName: "Y" }]
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, "not-managed");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.provider, undefined);
});

test("preview · returns plain text suitable for UI", () => {
  const codex = pw.previewCodexProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(codex, /wire_api = "responses"/);
  assert.match(codex, /model_provider = "custom"/);

  const cc = pw.previewClaudeCodeProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(cc, /ANTHROPIC_BASE_URL/);
  assert.match(cc, /managed-by-switchyard/);

  const her = pw.previewHermesProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(her, /\/hermes\/v1/);
});

test("codex preview · merges existing user TOML instead of patch-only", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "model_reasoning_effort = \"low\"",
    "",
    "[unrelated]",
    "model_provider = \"keep-me\"",
    ""
  ].join("\n"), "utf8");

  const text = pw.previewCodexProfile({ host: "127.0.0.1", port: 17888, defaultModel: "a/b" });
  assert.match(text, /model_reasoning_effort = "low"/);
  assert.match(text, /\[unrelated\]\nmodel_provider = "keep-me"/);
  assert.match(text, /model_provider = "custom"/);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:17888\/codex\/v1"/);
});

test("grok profile · writes managed model blocks and preserves user config", () => {
  const file = pw.grokConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "[cli]",
    "auto_update = true",
    "",
    "[models]",
    'default = "grok-4.5"',
    "",
    "[model.my-custom]",
    'model = "local"',
    'base_url = "http://localhost:8000/v1"',
    'name = "Local"',
    ""
  ].join("\n"), "utf8");

  const r = pw.applyGrok({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "coding-plan/GLM-5.2",
    models: [
      { id: "coding-plan/GLM-5.2", displayName: "GLM-5.2", providerName: "Coding Plan", contextWindow: 200000 },
      { id: "grok-pool/grok-4.5", displayName: "Grok 4.5", providerName: "Grok 池" }
    ]
  });
  assert.equal(r.modelCount, 2);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\[cli\]/);
  assert.match(text, /auto_update = true/);
  assert.match(text, /\[model\.my-custom\]/);
  assert.match(text, /switchyard-managed-models begin/);
  // 含点号的模型 id 必须用引号表头，否则 TOML 会嵌套拆坏
  assert.match(text, /\[model\."sy-coding-plan--GLM-5\.2"\]/);
  assert.match(text, /model = "coding-plan\/GLM-5\.2"/);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:17888\/grok\/v1"/);
  assert.match(text, /api_backend = "chat_completions"/);
  assert.match(text, /api_key = "switchyard-local"/);
  assert.match(text, /supports_reasoning_effort = true/);
  assert.match(text, /reasoning_effort = "high"/);
  // 用户默认是官方 grok-4.5，不应被强制改掉
  assert.match(text, /default = "grok-4\.5"/);
});

test("grok profile · openai_responses upstream still uses chat_completions backend for Grok Build", () => {
  // Grok Build 的 Responses 解析不兼容 ChatGPT Codex 后端（response.completed.output 为空，
  // 触发 empty_response 重试），因此 Grok 侧必须写 chat_completions，由网关做 chat->Responses 转换。
  const section = pw.renderGrokModelSection(
    { id: "codex/gpt-5.6-terra", providerId: "codex", upstreamModel: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", providerName: "OpenAI Codex", apiFormat: "openai_responses" },
    { host: "127.0.0.1", port: 17888 }
  );
  assert.match(section, /\[model\."sy-codex--gpt-5\.6-terra"\]/);
  assert.match(section, /model = "codex\/gpt-5\.6-terra"/);
  assert.match(section, /api_backend = "chat_completions"/);
  assert.doesNotMatch(section, /api_backend = "responses"/);
});

test("grok profile · quoted table header parses as flat model key", () => {
  const alias = pw.grokModelAlias("ke/GLM-5.2");
  assert.equal(alias, "sy-ke--GLM-5.2");
  assert.equal(pw.grokModelTableHeader(alias), '[model."sy-ke--GLM-5.2"]');
  const section = pw.renderGrokModelSection(
    { id: "ke/GLM-5.2", displayName: "GLM-5.2", providerName: "KE" },
    { host: "127.0.0.1", port: 17888 }
  );
  assert.match(section, /\[model\."sy-ke--GLM-5\.2"\]/);
  assert.doesNotMatch(section, /^\[model\.sy-ke--GLM-5\.2\]$/m);
  // 未勾选"思考"的模型不写思考等级参数
  const plain = pw.renderGrokModelSection(
    { id: "ke/nothink", displayName: "NoThink", providerName: "KE", capabilities: { reasoning: false } },
    { host: "127.0.0.1", port: 17888 }
  );
  assert.match(plain, /\[model\."sy-ke--nothink"\]/);
  assert.doesNotMatch(plain, /supports_reasoning_effort|reasoning_effort/);
});

test("grok profile · auto-refresh when managed; skip when not", () => {
  const file = pw.grokConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[cli]\nauto_update = true\n", "utf8");
  const skip = pw.syncGrokModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    models: [{ id: "a/m1", displayName: "M1" }]
  });
  assert.equal(skip.skipped, true);

  pw.applyGrok({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "a/m1",
    models: [{ id: "a/m1", displayName: "M1" }]
  });
  const refreshed = pw.syncGrokModelArtifacts({
    host: "127.0.0.1",
    port: 17888,
    defaultModel: "a/m1",
    models: [{ id: "a/m1", displayName: "M1" }, { id: "b/m2", displayName: "M2" }]
  });
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.modelCount, 2);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\[model\."sy-b--m2"\]/);
  assert.match(text, /default = "sy-a--m1"/);
});

test("deepseek harness profile · maps reasoning levels by model family", () => {
  const cases = [
    ["deepseek/deepseek-v4", "deepseek", ["off", "low", "high", "max"]],
    ["openai/gpt-5.2", "gpt", ["off", "minimal", "low", "medium", "high", "xhigh", "max"]],
    ["anthropic/claude-opus", "claude", ["off", "low", "medium", "high"]],
    ["xai/grok-4", "grok", ["off", "low", "high"]],
    ["zhipu/glm-5", "glm", ["off", "high"]],
    ["moonshot/kimi-k3", "kimi", ["off", "low", "medium", "high", "max"]],
    ["qwen/qwen3", "qwen", ["off", "low", "medium", "high", "xhigh"]],
    ["google/gemini-3-pro", "gemini", ["off", "minimal", "low", "medium", "high"]],
    ["minimax/MiniMax-M2.5", "minimax", ["off", "high"]]
  ];
  for (const [id, family, levels] of cases) {
    const model = pw.deepSeekHarnessModelFrom({ id, providerId: family, upstreamModel: id, capabilities: { reasoning: true } });
    assert.deepEqual(Object.keys(model.reasoningEfforts), levels, id);
  }
  const explicit = pw.deepSeekHarnessModelFrom({
    id: "custom/reasoning",
    providerId: "custom",
    reasoningLevels: ["off", "low", "xhigh"],
    capabilities: { reasoning: true }
  });
  assert.deepEqual(Object.keys(explicit.reasoningEfforts), ["off", "low", "xhigh"]);
});

test("deepseek harness profile · writes capability-aware managed provider without losing other settings", () => {
  const previous = process.env.DSH_HOME;
  const dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-dsh-"));
  process.env.DSH_HOME = dshHome;
  try {
    const file = pw.deepSeekHarnessConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "ui-theme:\n  preference: dark\nllm-pi-ai:\n  providers:\n    other:\n      baseURL: https://example.test/v1\n", "utf8");
    const result = pw.applyDeepSeekHarness({
      host: "127.0.0.1",
      port: 17888,
      models: [
        { id: "vision/model", displayName: "Vision", capabilities: { reasoning: true, images: true } },
        { id: "text/model", displayName: "Text", capabilities: { reasoning: false } }
      ]
    });
    assert.equal(result.modelCount, 2);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /preference: dark/);
    assert.match(text, /other:/);
    assert.match(text, /baseURL: http:\/\/127\.0\.0\.1:17888\/deepseek-harness\/v1/);
    assert.match(text, /managed-by-switchyard: true/);
    assert.match(text, /input:\n\s+- text\n\s+- image/);
    assert.match(text, /reasoningEfforts:/);
    const sync = pw.syncDeepSeekHarnessModelArtifacts({
      host: "127.0.0.1",
      port: 17888,
      models: [{ id: "text/model", displayName: "Text" }]
    });
    assert.equal(sync.changed, true);
    assert.equal(sync.modelCount, 1);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("codex profile · reads the active Switchyard model for deleted-task recovery", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# managed-by: managed-by-switchyard',
    'model_provider = "custom"',
    'model = "replacement/gpt-5.6-terra"',
    '',
    '[model_providers.custom]',
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    ''
  ].join("\n"), "utf8");
  assert.equal(pw.activeCodexSwitchyardModel(), "replacement/gpt-5.6-terra");

  fs.writeFileSync(file, 'model_provider = "openai"\nmodel = "other/model"\n', "utf8");
  assert.equal(pw.activeCodexSwitchyardModel(), "");
});

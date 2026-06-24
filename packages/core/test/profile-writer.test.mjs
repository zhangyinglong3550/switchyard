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
  assert.deepEqual(catalog.models.map((model) => model.slug), ["codex/gpt-5.5", "deepseek/deepseek-v4-flash"]);
  assert.equal(catalog.models[0].display_name, "GPT-5.5 via Switchyard · codex");
  assert.equal(catalog.models[0]["x-switchyard-model-id"], "codex/gpt-5.5");
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.equal(catalog.models[0].default_reasoning_level, "low");
  assert.equal(catalog.models[1].display_name, "DeepSeek V4 Flash · deepseek");
  assert.equal(catalog.models[1].supported_in_api, true);
  const profile = fs.readFileSync(r.path, "utf8");
  assert.match(profile, /model = "codex\/gpt-5\.5"/);
  const cache = JSON.parse(fs.readFileSync(r.cachePath, "utf8"));
  assert.equal(cache.client_version, "0.142.0");
  assert.equal(cache.etag, 'W/"switchyard-2"');
  assert.deepEqual(cache.models.map((model) => model.slug), ["codex/gpt-5.5", "deepseek/deepseek-v4-flash"]);
  const ccSwitchCatalog = JSON.parse(fs.readFileSync(r.ccSwitchCatalogPath, "utf8"));
  assert.deepEqual(ccSwitchCatalog.models.map((model) => model.slug), ["codex/gpt-5.5", "deepseek/deepseek-v4-flash"]);
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
    "requires_openai_auth = true",
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
  assert.deepEqual(cache.models.map((model) => model.slug), ["codex/gpt-5.5", "deepseek/deepseek-v4-flash"]);
  assert.equal(cache.models[0].display_name, "GPT-5.5 · Codex");
  const catalog = JSON.parse(fs.readFileSync(pw.codexModelCatalogPath(), "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.slug), ["codex/gpt-5.5", "deepseek/deepseek-v4-flash"]);
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
    "requires_openai_auth = true",
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
    "requires_openai_auth = true",
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
    defaultModel: "deepseek/deepseek-v4-flash",
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

test("hermes profile · creates file when absent", () => {
  const file = pw.hermesConfigPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  pw.applyHermes({ host: "127.0.0.1", port: 17888 });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.baseUrl, "http://127.0.0.1:17888/hermes/v1");
  assert.equal(parsed.apiKey, "switchyard-local");
  assert.equal(parsed.apiKeyEnv, "SWITCHYARD_KEY");
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

test("restoreProfile · returns no-backup when file never backed up", () => {
  // claude-code file currently has a backup from applyClaudeCode; force the path
  // to a clean file with no backups.
  const fakePath = path.join(tmpHome, "no-backups.json");
  fs.writeFileSync(fakePath, "{}", "utf8");
  const list = pw.listBackups(fakePath);
  assert.equal(list.length, 0);
});

test("profile dry-run · does not write to disk", () => {
  const file = pw.hermesConfigPath();
  const before = fs.readFileSync(file, "utf8");
  const r = pw.applyHermes({ host: "10.0.0.1", port: 99999, dryRun: true });
  const after = fs.readFileSync(file, "utf8");
  assert.equal(before, after, "dry run must not mutate file");
  assert.match(r.preview, /10\.0\.0\.1:99999/);
});

test("preview · returns plain text suitable for UI", () => {
  const codex = pw.previewCodexProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(codex, /wire_api = "responses"/);

  const cc = pw.previewClaudeCodeProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(cc, /ANTHROPIC_BASE_URL/);

  const her = pw.previewHermesProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(her, /\/hermes\/v1/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeWithDefaults, validateConfig, listModelsForClient, publicModelsForClient, initConfig, loadConfig, saveConfig, pruneOrphanedModelRefs } from "../src/config.mjs";
import { resolveRoute } from "../src/router.mjs";

test("mergeWithDefaults fills client filters", () => {
  const cfg = mergeWithDefaults({ providers: [], models: [] });
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.clients.codex.enabled, true);
  assert.deepEqual(cfg.clients["claude-code"].allowedModels, ["*"]);
  assert.deepEqual(cfg.clients["claude-code"].modelMapping, {});
});

test("mergeWithDefaults preserves Claude Code model mapping", () => {
  const cfg = mergeWithDefaults({
    providers: [],
    models: [],
    clients: {
      "claude-code": {
        enabled: true,
        allowedModels: ["*"],
        modelMapping: {
          default: "deepseek/deepseek-v4-pro",
          haiku: "deepseek/deepseek-v4-flash",
          ignored: "not-a-slot",
          opus: "  opencode-go/glm-5.2  "
        }
      }
    }
  });

  assert.deepEqual(cfg.clients["claude-code"].modelMapping, {
    default: "deepseek/deepseek-v4-pro",
    haiku: "deepseek/deepseek-v4-flash",
    opus: "opencode-go/glm-5.2"
  });
});

test("mergeWithDefaults preserves per-agent default model", () => {
  const cfg = mergeWithDefaults({
    providers: [],
    models: [],
    clients: {
      codex: { enabled: true, allowedModels: ["*"], defaultModel: "codex/gpt-5.5" },
      "claude-code": { enabled: true, allowedModels: ["*"], defaultModel: "deepseek/deepseek-v4-pro" }
    }
  });

  assert.equal(cfg.clients.codex.defaultModel, "codex/gpt-5.5");
  assert.equal(cfg.clients["claude-code"].defaultModel, "deepseek/deepseek-v4-pro");
});

test("mergeWithDefaults collapses persisted reasoning variants into one Agent-selectable model", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "codex-pool", apiFormat: "openai_responses", authMode: "codex_oauth", baseUrl: "https://chatgpt.com/backend-api/codex" },
      { id: "antigravity", apiFormat: "antigravity", baseUrl: "https://daily-cloudcode-pa.googleapis.com" }
    ],
    models: [
      { id: "codex-pool/gpt-5.4-mini-none", providerId: "codex-pool", upstreamModel: "gpt-5.4-mini-none", enabled: false, capabilities: { stream: true } },
      { id: "codex-pool/gpt-5.4-mini-high", providerId: "codex-pool", upstreamModel: "gpt-5.4-mini-high", capabilities: { reasoning: true } },
      { id: "antigravity/gemini-3.6-flash-low", providerId: "antigravity", upstreamModel: "gemini-3.6-flash-low", capabilities: { stream: true } },
      { id: "antigravity/gemini-3.6-flash-high", providerId: "antigravity", upstreamModel: "gemini-3.6-flash-high", capabilities: { reasoning: true } }
    ]
  });

  assert.deepEqual(cfg.models.map((model) => model.id), [
    "codex-pool/gpt-5.4-mini",
    "antigravity/gemini-3.6-flash"
  ]);
  assert.deepEqual(cfg.models.map((model) => model.upstreamModel), [
    "gpt-5.4-mini",
    "gemini-3.6-flash"
  ]);
  assert.equal(cfg.models[0].enabled, true);
  assert.equal(cfg.models[0].capabilities.reasoning, true);
  assert.ok(cfg.models[0].aliases.includes("codex-pool/gpt-5.4-mini-high"));
  assert.ok(cfg.models[1].aliases.includes("gemini-3.6-flash-low"));
});

test("mergeWithDefaults drops retired Cursor subscription providers and their models", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "cursor", providerType: "cursor_subscription", baseUrl: "https://agentn.api5.cursor.sh", enabled: true },
      { id: "cursor-pool", presetId: "cursor-subscription-account-pool", authMode: "account_pool", poolKind: "cursor_subscription", apiFormat: "cursor_subscription", enabled: true },
      { id: "ok", apiFormat: "openai_chat", baseUrl: "http://x" }
    ],
    models: [
      { id: "cursor/grok-4.5", providerId: "cursor", upstreamModel: "grok-4.5" },
      { id: "cursor-pool/claude-opus-5", providerId: "cursor-pool", upstreamModel: "claude-opus-5" },
      { id: "ok/gpt", providerId: "ok", upstreamModel: "gpt" }
    ]
  });
  assert.deepEqual(cfg.providers.map((provider) => provider.id), ["ok"]);
  assert.deepEqual(cfg.models.map((model) => model.id), ["ok/gpt"]);
});

test("mergeWithDefaults drops retired Antigravity CLIProxyAPI providers and their models", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "antigravity", presetId: "antigravity-cli2api", apiFormat: "openai_chat", baseUrl: "http://127.0.0.1:8317/v1", enabled: true },
      { id: "cliproxy", apiFormat: "openai_chat", baseUrl: "http://localhost:8317/v1", enabled: true },
      { id: "antigravity-pool", presetId: "antigravity-account-pool", apiFormat: "antigravity", baseUrl: "https://daily-cloudcode-pa.googleapis.com", enabled: true },
      { id: "ok", apiFormat: "openai_chat", baseUrl: "http://x" }
    ],
    models: [
      { id: "antigravity/gemini-3-flash", providerId: "antigravity", upstreamModel: "gemini-3-flash" },
      { id: "cliproxy/claude-sonnet-4-6", providerId: "cliproxy", upstreamModel: "claude-sonnet-4-6" },
      { id: "antigravity-pool/gemini-3.6-flash", providerId: "antigravity-pool", upstreamModel: "gemini-3.6-flash" },
      { id: "ok/gpt", providerId: "ok", upstreamModel: "gpt" }
    ]
  });
  assert.deepEqual(cfg.providers.map((provider) => provider.id), ["antigravity-pool", "ok"]);
  assert.deepEqual(cfg.models.map((model) => model.id), ["antigravity-pool/gemini-3.6-flash", "ok/gpt"]);
});

test("validateConfig rejects duplicate provider id", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "p", apiFormat: "openai_chat", baseUrl: "http://x" },
      { id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }
    ]
  });
  assert.throws(() => validateConfig(cfg), /Duplicate provider/);
});

test("validateConfig rejects unsupported apiFormat", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "weird", baseUrl: "http://x" }]
  });
  assert.throws(() => validateConfig(cfg), /unsupported apiFormat/);
});

test("validateConfig rejects unsupported routingMode", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", routingMode: "maybe", baseUrl: "http://x" }]
  });
  assert.throws(() => validateConfig(cfg), /unsupported routingMode/);
});

test("validateConfig rejects model referencing missing provider", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [{ id: "m", providerId: "missing", upstreamModel: "u" }]
  });
  assert.throws(() => validateConfig(cfg), /missing provider/);
});

test("listModelsForClient applies allowedModels filter", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "m1", providerId: "p", upstreamModel: "u", aliases: ["alpha"] },
      { id: "m2", providerId: "p", upstreamModel: "u2" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["m1"] },
      "claude-code": { enabled: true, allowedModels: ["alpha"] },
      hermes: { enabled: false, allowedModels: ["*"] }
    }
  });
  validateConfig(cfg);
  assert.equal(listModelsForClient(cfg, "codex").length, 1);
  assert.equal(listModelsForClient(cfg, "claude-code").length, 1);
  assert.equal(listModelsForClient(cfg, "hermes").length, 0);
});

test("listModelsForClient hides disabled models", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "m1", providerId: "p", upstreamModel: "u" },
      { id: "m2", providerId: "p", upstreamModel: "u2", enabled: false }
    ],
    clients: { codex: { enabled: true, allowedModels: ["*"] } }
  });
  assert.deepEqual(listModelsForClient(cfg, "codex").map((m) => m.id), ["m1"]);
});

test("publicModelsForClient hides disabled models without a client prefix", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "p/enabled", providerId: "p", upstreamModel: "enabled" },
      { id: "p/disabled", providerId: "p", upstreamModel: "disabled", enabled: false }
    ]
  });
  assert.deepEqual(publicModelsForClient(cfg).map((model) => model.id), ["p/enabled"]);
});

test("listModelsForClient inherits provider scope until a model explicitly overrides it", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "p-codex", apiFormat: "openai_chat", baseUrl: "http://x", allowedClients: ["codex"] },
      { id: "p-all", apiFormat: "openai_chat", baseUrl: "http://x" }
    ],
    models: [
      { id: "p-codex/a", providerId: "p-codex", upstreamModel: "a" },
      { id: "p-codex/b", providerId: "p-codex", upstreamModel: "b", allowedClients: ["claude-code"], agentScopeOverride: true },
      { id: "p-all/c", providerId: "p-all", upstreamModel: "c", allowedClients: ["claude-code"], agentScopeOverride: true },
      { id: "p-all/d", providerId: "p-all", upstreamModel: "d" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["*"] },
      "claude-code": { enabled: true, allowedModels: ["*"] }
    }
  });

  assert.deepEqual(listModelsForClient(cfg, "codex").map((m) => m.id), ["p-codex/a", "p-all/d"]);
  assert.deepEqual(listModelsForClient(cfg, "claude-code").map((m) => m.id), ["p-codex/b", "p-all/c", "p-all/d"]);
});

test("model Agent scope explicitly overrides its provider scope", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "p", apiFormat: "openai_chat", baseUrl: "http://x", allowedClients: ["codex"] }
    ],
    models: [
      // Existing models inherit their provider scope.
      { id: "p/inherited", providerId: "p", upstreamModel: "inherited" },
      // Saving a model-level Agent scope makes that setting authoritative.
      { id: "p/claude-only", providerId: "p", upstreamModel: "claude-only", allowedClients: ["claude-code"], agentScopeOverride: true },
      { id: "p/all-agents", providerId: "p", upstreamModel: "all-agents", allowedClients: ["*"], agentScopeOverride: true }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["*"] },
      "claude-code": { enabled: true, allowedModels: ["*"] }
    }
  });

  assert.deepEqual(listModelsForClient(cfg, "codex").map((model) => model.id), ["p/inherited", "p/all-agents"]);
  assert.deepEqual(listModelsForClient(cfg, "claude-code").map((model) => model.id), ["p/claude-only", "p/all-agents"]);
});

test("resolveRoute uses per-agent default model before global default", () => {
  const cfg = mergeWithDefaults({
    defaultModel: "p/global",
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "p/global", providerId: "p", upstreamModel: "global" },
      { id: "p/codex", providerId: "p", upstreamModel: "codex" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["*"], defaultModel: "p/codex" }
    }
  });

  const route = resolveRoute(cfg, "", { clientId: "codex" });
  assert.equal(route.model.id, "p/codex");
});

test("publicModelsForClient returns Anthropic model-list shape for Claude Code", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "deepseek", name: "DeepSeek", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "deepseek/deepseek-v4-pro", providerId: "deepseek", upstreamModel: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro" }
    ]
  });

  const models = publicModelsForClient(cfg, "claude-code");
  assert.equal(models.length, 1);
  assert.match(models[0].id, /^claude-switchyard-deepseek-deepseek-v4-pro-/);
  assert.deepEqual({ ...models[0], id: "<synthetic>" }, {
    type: "model",
    id: "<synthetic>",
    display_name: "DeepSeek V4 Pro · DeepSeek",
    created_at: "1970-01-01T00:00:00Z"
  });
});

test("mergeWithDefaults normalizes known misclassified providers", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "xiaomi-mimo", apiFormat: "openai_responses", baseUrl: "https://api.xiaomimimo.com/v1" },
      { id: "mimo-anthropic", apiFormat: "openai_chat", baseUrl: "https://api.xiaomimimo.com/anthropic" },
      { id: "codex", apiFormat: "anthropic_messages", baseUrl: "https://chatgpt.com/backend-api/codex" }
    ]
  });
  assert.equal(cfg.providers[0].apiFormat, "openai_chat");
  assert.equal(cfg.providers[1].apiFormat, "anthropic_messages");
  assert.equal(cfg.providers[2].apiFormat, "openai_responses");
  assert.equal(cfg.providers[2].authMode, "codex_oauth");
  assert.equal(cfg.providers[2].providerType, "codex_oauth");
  assert.equal(cfg.providers[2].routingMode, "auto");
});

test("mergeWithDefaults forces Codex OAuth preset to the dedicated auth path", () => {
  const cfg = mergeWithDefaults({
    providers: [
      {
        id: "codex",
        presetId: "codex-oauth",
        apiFormat: "openai_chat",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "api_key",
        providerType: "openai"
      }
    ]
  });
  assert.equal(cfg.providers[0].apiFormat, "openai_responses");
  assert.equal(cfg.providers[0].authMode, "codex_oauth");
  assert.equal(cfg.providers[0].providerType, "codex_oauth");
});

test("mergeWithDefaults normalizes provider-specific display model tags", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "opencode-go", apiFormat: "anthropic_messages", baseUrl: "https://opencode.ai/zen/go" },
      { id: "coding-plan", apiFormat: "anthropic_messages", baseUrl: "https://ark.cn-beijing.volces.com/api/coding" },
      { id: "xiaomi-mimo", apiFormat: "anthropic_messages", baseUrl: "https://api.xiaomimimo.com/anthropic" },
      { id: "agnes", apiFormat: "anthropic_messages", baseUrl: "https://apihub.agnes-ai.com/v1" }
    ],
    models: [
      { id: "opencode-go/glm-5.2_1M_", providerId: "opencode-go", upstreamModel: "glm-5.2[1M]" },
      { id: "coding-plan/glm-5.2_1M_", providerId: "coding-plan", upstreamModel: "glm-5.2[1M]" },
      { id: "xiaomi-mimo/mimo-v2.5-pro_1M_", providerId: "xiaomi-mimo", upstreamModel: "mimo-v2.5-pro[1M]" },
      { id: "agnes/agnes-2.0-flash_1M_", providerId: "agnes", upstreamModel: "agnes-2.0-flash[1M]" }
    ]
  });
  assert.equal(cfg.models[0].upstreamModel, "glm-5.2");
  assert.ok(cfg.models[0].aliases.includes("glm-5.2[1M]"));
  assert.equal(cfg.models[1].upstreamModel, "glm-5.2[1M]");
  assert.equal(cfg.models[2].upstreamModel, "mimo-v2.5-pro");
  assert.equal(cfg.models[3].upstreamModel, "agnes-2.0-flash");
});

test("mergeWithDefaults marks Xiaomi MiMo V2.5 as multimodal", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "xiaomi-mimo", apiFormat: "openai_chat", baseUrl: "https://api.xiaomimimo.com/v1" }
    ],
    models: [
      { id: "xiaomi-mimo/mimo-v2.5", providerId: "xiaomi-mimo", upstreamModel: "mimo-v2.5", capabilities: { text: true, stream: true } },
      { id: "xiaomi-mimo/mimo-v2.5-pro", providerId: "xiaomi-mimo", upstreamModel: "mimo-v2.5-pro", capabilities: { text: true, stream: true } }
    ]
  });
  assert.equal(cfg.models[0].capabilities.images, true);
  assert.equal(cfg.models[0].capabilities.multimodal, true);
  assert.equal(cfg.models[1].capabilities.images, undefined);
  assert.equal(cfg.models[1].capabilities.multimodal, undefined);
});

test("mergeWithDefaults corrects known text-only models misclassified as multimodal", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "deepseek", name: "DeepSeek", apiFormat: "openai_chat", baseUrl: "https://api.deepseek.com/v1" },
      { id: "coding-plan", name: "火山Coding plan", apiFormat: "openai_chat", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
      { id: "xiaomi-mimo", name: "Xiaomi MiMo", apiFormat: "openai_chat", baseUrl: "https://api.xiaomimimo.com/v1" }
    ],
    models: [
      { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash", capabilities: { text: true, images: true, multimodal: true } },
      { id: "coding-plan/GLM-5.2", providerId: "coding-plan", upstreamModel: "GLM-5.2", capabilities: { text: true, images: true, multimodal: true } },
      { id: "coding-plan/Kimi-K2.7-Code", providerId: "coding-plan", upstreamModel: "Kimi-K2.7-Code", capabilities: { text: true, images: true, multimodal: true } },
      { id: "coding-plan/minimax-m3", providerId: "coding-plan", upstreamModel: "minimax-m3", capabilities: { text: true, images: true, multimodal: true } },
      { id: "xiaomi-mimo/mimo-v2.5", providerId: "xiaomi-mimo", upstreamModel: "mimo-v2.5", capabilities: { text: true, stream: true } }
    ]
  });
  for (const id of ["deepseek/deepseek-v4-flash", "coding-plan/GLM-5.2", "coding-plan/Kimi-K2.7-Code", "coding-plan/minimax-m3"]) {
    const model = cfg.models.find((item) => item.id === id);
    assert.equal(model.capabilities.images, false);
    assert.equal(model.capabilities.multimodal, false);
    assert.equal(model.visionFallbackModelId, "xiaomi-mimo/mimo-v2.5");
  }
  const vision = cfg.models.find((item) => item.id === "xiaomi-mimo/mimo-v2.5");
  assert.equal(vision.capabilities.images, true);
  assert.equal(vision.capabilities.multimodal, true);
});

test("mergeWithDefaults keeps native image routes for models that already support vision", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "xiaomi-mimo", name: "Xiaomi MiMo", apiFormat: "openai_chat", baseUrl: "https://api.xiaomimimo.com/v1" }
    ],
    models: [
      { id: "xiaomi-mimo/mimo-v2.5", providerId: "xiaomi-mimo", upstreamModel: "mimo-v2.5", capabilities: { text: true, stream: true, images: true } }
    ]
  });
  const vision = cfg.models.find((item) => item.id === "xiaomi-mimo/mimo-v2.5");
  assert.equal(vision.capabilities.images, true);
  assert.equal(vision.visionFallbackModelId, undefined);
});

test("initConfig/loadConfig/saveConfig round trip in tempdir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lls-cfg-"));
  const cfgPath = path.join(tmp, "config.json");
  const prevEnv = process.env.SWITCHYARD_CONFIG;
  process.env.SWITCHYARD_CONFIG = cfgPath;
  try {
    initConfig({ force: true });
    const loaded = loadConfig();
    loaded.providers.push({ id: "x", name: "X", apiFormat: "openai_chat", baseUrl: "http://x" });
    loaded.models.push({ id: "x/m", providerId: "x", upstreamModel: "m" });
    saveConfig(loaded);
    const again = loadConfig();
    assert.equal(again.providers.length, 1);
    assert.equal(again.models.length, 1);
  } finally {
    process.env.SWITCHYARD_CONFIG = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("pruneOrphanedModelRefs clears deleted defaultModel and mapping entries", () => {
  const cfg = mergeWithDefaults({
    defaultModel: "codex-pool/gpt-5.6-luna",
    providers: [
      { id: "wecode-gpt", name: "WeCode", apiFormat: "openai_chat", baseUrl: "http://x" },
      { id: "token-gpt", name: "Token", apiFormat: "openai_chat", baseUrl: "http://y" }
    ],
    models: [
      { id: "wecode-gpt/gpt-5.6-luna", providerId: "wecode-gpt", upstreamModel: "gpt-5.6-luna" },
      { id: "token-gpt/gpt-5.6-sol", providerId: "token-gpt", upstreamModel: "gpt-5.6-sol", enabled: false }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["*"], defaultModel: "codex-pool/gpt-5.6-luna" },
      "claude-code": {
        enabled: true,
        allowedModels: ["*"],
        defaultModel: null,
        modelMapping: {
          default: "wecode-gpt/gpt-5.6-luna",
          fable: "codex-pool/gpt-5.6-sol"
        }
      }
    }
  });
  pruneOrphanedModelRefs(cfg);
  assert.equal(cfg.defaultModel, null);
  assert.equal(cfg.clients.codex.defaultModel, null);
  assert.equal(cfg.clients["claude-code"].modelMapping.default, "wecode-gpt/gpt-5.6-luna");
  assert.equal(cfg.clients["claude-code"].modelMapping.fable, undefined);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lls-cfg-prune-"));
  const cfgPath = path.join(tmp, "config.json");
  const prevEnv = process.env.SWITCHYARD_CONFIG;
  process.env.SWITCHYARD_CONFIG = cfgPath;
  try {
    saveConfig(cfg, cfgPath);
    const again = loadConfig(cfgPath);
    assert.equal(again.clients.codex.defaultModel, null);
    assert.equal(again.defaultModel, null);
    assert.equal(again.clients["claude-code"].modelMapping.fable, undefined);
  } finally {
    process.env.SWITCHYARD_CONFIG = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// Config loading, validation, and persistence for the gateway.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configPath, ensureDir, DEFAULT_CONFIG_PATH } from "./utils.mjs";
import { canonicalCursorSubscriptionModelId, cursorSubscriptionDisplayName, isCursorSubscriptionProvider, normalizeCursorSubscriptionProvider } from "./cursor-subscription/model-catalog.mjs";
import { normalizeSensitiveGuardConfig } from "./sensitive-guard.mjs";
import { normalizeRequestBodyCaptureConfig } from "./request-body-capture.mjs";

export const SUPPORTED_API_FORMATS = new Set([
  "openai_chat",
  "openai_responses",
  "anthropic_messages",
  "antigravity",
  "cursor_subscription"
]);
export const SUPPORTED_ROUTING_MODES = new Set(["auto", "native", "gateway"]);

export const SUPPORTED_CLIENTS = new Set(["codex", "claude-code", "claude-app", "hermes", "opencode", "grok", "deepseek-harness", "generic-openai"]);

export const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 17888,
  defaultModel: null,
  // 出站敏感信息守卫：默认开启，脱敏后发送；审计不落原文。
  sensitiveGuard: normalizeSensitiveGuardConfig({ enabled: true, mode: "redact" }),
  // 完整请求体调试落盘：默认关闭；开启后写入 logs/request-bodies/。
  requestBodyCapture: normalizeRequestBodyCaptureConfig({ enabled: false }),
  providers: [],
  models: [],
  clients: {
    codex: { enabled: true, allowedModels: ["*"], defaultModel: null },
    "claude-code": { enabled: true, allowedModels: ["*"], defaultModel: null, modelMapping: {} },
    hermes: { enabled: true, allowedModels: ["*"], defaultModel: null },
    opencode: { enabled: true, allowedModels: ["*"], defaultModel: null },
    grok: { enabled: true, allowedModels: ["*"], defaultModel: null },
    "deepseek-harness": { enabled: true, allowedModels: ["*"], defaultModel: null },
    "generic-openai": { enabled: true, allowedModels: ["*"], defaultModel: null }
  }
};

export function exampleConfigPath() {
  return path.resolve(process.cwd(), "config", "config.example.json");
}

export function loadRawConfig(file = configPath()) {
  if (!fs.existsSync(file)) {
    throw new Error(`Config not found: ${file}. Run: npm run gateway:init`);
  }
  const text = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(text);
  return mergeWithDefaults(parsed);
}

export function loadConfig(file = configPath()) {
  const config = loadRawConfig(file);
  validateConfig(config);
  return config;
}

/**
 * Drop client/global defaultModel (and Claude modelMapping entries) that no longer
 * point at an enabled model. Prevents stale ids like deleted pool providers from
 * surviving in config.json after the model list was cleaned up.
 */
export function pruneOrphanedModelRefs(config) {
  if (!config || typeof config !== "object") return config;
  const enabled = new Set(
    (config.models || [])
      .filter((model) => model && model.enabled !== false && model.id)
      .map((model) => String(model.id).trim())
  );
  const isLive = (value) => {
    const id = String(value || "").trim();
    return Boolean(id) && enabled.has(id);
  };

  if (config.defaultModel != null && !isLive(config.defaultModel)) {
    config.defaultModel = null;
  }

  if (config.clients && typeof config.clients === "object") {
    for (const client of Object.values(config.clients)) {
      if (!client || typeof client !== "object") continue;
      if (client.defaultModel != null && !isLive(client.defaultModel)) {
        client.defaultModel = null;
      }
      if (client.modelMapping && typeof client.modelMapping === "object") {
        for (const key of Object.keys(client.modelMapping)) {
          if (!isLive(client.modelMapping[key])) delete client.modelMapping[key];
        }
      }
    }
  }
  return config;
}

export function saveConfig(config, file = configPath()) {
  pruneOrphanedModelRefs(config);
  validateConfig(config);
  ensureDir(path.dirname(file));
  const payload = JSON.stringify(config, null, 2);
  fs.writeFileSync(file, payload, "utf8");
  return { ok: true, path: file };
}

export function initConfig({ force = false } = {}) {
  const target = configPath();
  ensureDir(path.dirname(target));
  if (fs.existsSync(target) && !force) {
    return { ok: true, created: false, path: target };
  }
  const seed = mergeWithDefaults({});
  fs.writeFileSync(target, JSON.stringify(seed, null, 2), "utf8");
  return { ok: true, created: true, path: target };
}

export function mergeWithDefaults(input) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (input && typeof input === "object") {
    if (typeof input.host === "string") out.host = input.host;
    if (Number.isFinite(input.port)) out.port = input.port;
    if (typeof input.defaultModel === "string") out.defaultModel = input.defaultModel;
    if (input.sensitiveGuard && typeof input.sensitiveGuard === "object") {
      out.sensitiveGuard = normalizeSensitiveGuardConfig(input.sensitiveGuard);
    }
    if (input.requestBodyCapture && typeof input.requestBodyCapture === "object") {
      out.requestBodyCapture = normalizeRequestBodyCaptureConfig(input.requestBodyCapture);
    }
    if (Array.isArray(input.providers)) out.providers = input.providers.map(normalizeKnownProvider);
    if (Array.isArray(input.models)) {
      out.models = normalizeKnownVisionFallbacks(
        collapseReasoningVariantModels(input.models.map((model) => normalizeKnownModel(model, out.providers)), out.providers),
        out.providers
      );
    }
    if (input.clients && typeof input.clients === "object") {
      out.clients = { ...out.clients };
      for (const [key, value] of Object.entries(input.clients)) {
        if (!value || typeof value !== "object") continue;
        const normalized = {
          enabled: value.enabled !== false,
          allowedModels: normalizeStringList(value.allowedModels, ["*"]),
          defaultModel: typeof value.defaultModel === "string" && value.defaultModel.trim() ? value.defaultModel.trim() : null
        };
        if (value.modelMapping && typeof value.modelMapping === "object") {
          normalized.modelMapping = normalizeClientModelMapping(value.modelMapping);
        } else if (out.clients[key]?.modelMapping) {
          normalized.modelMapping = { ...out.clients[key].modelMapping };
        }
        out.clients[key] = normalized;
      }
    }
  }
  return out;
}

// Reasoning level is a runtime choice made by the Agent (`reasoning_effort`),
// not a distinct model. Earlier builds incorrectly saved virtual rows such as
// `gpt-5.4-mini-high` and `gemini-3.6-flash-low`. Keep their old IDs as
// aliases so existing Agent settings still resolve, but publish one base model
// to every picker.
const REASONING_VARIANT_MODEL_RE = /^(gpt-5\.4-(?:mini|nano))-(none|low|medium|high|xhigh|max)$|^(gemini-3\.6-flash)-(low|medium|high)$/i;

function canonicalReasoningVariant(value) {
  const source = String(value || "").trim();
  const match = source.match(REASONING_VARIANT_MODEL_RE);
  if (!match) return null;
  return {
    base: match[1] || match[3],
    variant: source
  };
}

function modelIdForUpstream(model, upstreamModel) {
  const id = String(model?.id || "");
  const oldUpstream = String(model?.upstreamModel || "");
  if (oldUpstream && id.endsWith(`/${oldUpstream}`)) {
    return `${id.slice(0, -oldUpstream.length)}${upstreamModel}`;
  }
  return id;
}

function mergeModelCapabilities(left = {}, right = {}) {
  const out = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    out[key] = Boolean(out[key] || value);
  }
  return out;
}

export function collapseReasoningVariantModels(models = [], providers = []) {
  const providerById = new Map((providers || []).map((provider) => [provider.id, provider]));
  const out = [];
  const byRoute = new Map();
  for (const model of models || []) {
    const provider = providerById.get(model?.providerId);
    const isSupportedProvider = provider?.apiFormat === "antigravity" ||
      provider?.apiFormat === "cursor_subscription" ||
      provider?.authMode === "codex_oauth" ||
      provider?.providerType === "codex_oauth" ||
      String(provider?.baseUrl || "").includes("chatgpt.com/backend-api/codex");
    const cursorVariant = isCursorSubscriptionProvider(provider)
      ? canonicalCursorSubscriptionModelId(model?.upstreamModel || model?.id)
      : "";
    const normalized = isSupportedProvider && canonicalReasoningVariant(model?.upstreamModel || model?.id);
    const upstreamModel = cursorVariant || normalized?.base || model?.upstreamModel;
    const next = cursorVariant && cursorVariant !== (model?.upstreamModel || model?.id)
      ? {
          ...model,
          id: modelIdForUpstream(model, upstreamModel),
          upstreamModel,
          displayName: cursorSubscriptionDisplayName(model?.displayName, upstreamModel),
          aliases: Array.from(new Set([...(model?.aliases || []), model.id, model.upstreamModel].filter(Boolean)))
        }
      : normalized
      ? {
          ...model,
          id: modelIdForUpstream(model, upstreamModel),
          upstreamModel,
          displayName: String(model?.displayName || "").replace(/[\s·-]+(?:none|low|medium|high|xhigh|max)\s*$/i, "").trim() || upstreamModel,
          aliases: Array.from(new Set([...(model?.aliases || []), model.id, model.upstreamModel, normalized.variant].filter(Boolean)))
        }
      : model;
    const routeKey = `${next?.providerId || ""}\u0000${next?.upstreamModel || next?.id || ""}`;
    const existing = byRoute.get(routeKey);
    if (!existing) {
      byRoute.set(routeKey, next);
      out.push(next);
      continue;
    }
    existing.enabled = existing.enabled !== false || next?.enabled !== false;
    existing.aliases = Array.from(new Set([...(existing.aliases || []), ...(next?.aliases || []), next?.id, next?.upstreamModel].filter(Boolean)));
    existing.capabilities = mergeModelCapabilities(existing.capabilities, next?.capabilities);
    existing.allowedClients = Array.from(new Set([...(existing.allowedClients || []), ...(next?.allowedClients || [])].filter(Boolean)));
    if (!existing.contextWindow && next?.contextWindow) existing.contextWindow = next.contextWindow;
    if (!existing.maxOutputTokens && next?.maxOutputTokens) existing.maxOutputTokens = next.maxOutputTokens;
  }
  return out;
}

export function normalizeClientModelMapping(modelMapping = {}) {
  const out = {};
  for (const key of ["default", "haiku", "sonnet", "opus", "fable"]) {
    const value = modelMapping?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function normalizeStringList(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  const out = value.map((item) => String(item || "").trim()).filter(Boolean);
  return out.length ? Array.from(new Set(out)) : [...fallback];
}

function normalizeKnownProvider(provider) {
  if (!provider || typeof provider !== "object") return provider;
  const withRouting = {
    ...provider,
    routingMode: provider.routingMode || "auto",
    allowedClients: normalizeStringList(provider.allowedClients, ["*"])
  };
  const baseUrl = String(withRouting.baseUrl || "").toLowerCase();
  const id = String(withRouting.id || "").toLowerCase();
  const name = String(withRouting.name || "").toLowerCase();
  const looksLikeAccountPool =
    withRouting.authMode === "account_pool" ||
    withRouting.providerType === "account_pool" ||
    String(withRouting.presetId || "").includes("account-pool") ||
    ["xai_oauth", "antigravity_oauth", "codex_oauth"].includes(withRouting.poolKind);
  if (looksLikeAccountPool) {
    let poolKind = withRouting.poolKind || "xai_oauth";
    if (withRouting.presetId === "antigravity-account-pool") poolKind = "antigravity_oauth";
    if (withRouting.presetId === "codex-account-pool") poolKind = "codex_oauth";
    if (withRouting.presetId === "xai-account-pool") poolKind = "xai_oauth";
    const defaults = {
      xai_oauth: { baseUrl: "https://api.x.ai/v1", apiFormat: "openai_chat" },
      antigravity_oauth: { baseUrl: "https://daily-cloudcode-pa.googleapis.com", apiFormat: "antigravity" },
      codex_oauth: { baseUrl: "https://chatgpt.com/backend-api/codex", apiFormat: "openai_responses" }
    };
    const d = defaults[poolKind] || defaults.xai_oauth;
    return {
      ...withRouting,
      authMode: "account_pool",
      providerType: "account_pool",
      poolKind,
      poolStrategy: withRouting.poolStrategy || "weighted_round_robin",
      baseUrl: withRouting.baseUrl || d.baseUrl,
      apiFormat: withRouting.apiFormat || d.apiFormat
    };
  }
  const looksLikeCodexOAuth = withRouting.presetId === "codex-oauth" || baseUrl.includes("chatgpt.com/backend-api/codex");
  if (looksLikeCodexOAuth) {
    return {
      ...withRouting,
      apiFormat: "openai_responses",
      authMode: "codex_oauth",
      providerType: "codex_oauth"
    };
  }
  const looksLikeAnthropicOAuth =
    withRouting.presetId === "anthropic-oauth" ||
    withRouting.authMode === "anthropic_oauth" ||
    withRouting.providerType === "anthropic_oauth";
  if (looksLikeAnthropicOAuth) {
    return {
      ...withRouting,
      apiFormat: "anthropic_messages",
      authMode: "anthropic_oauth",
      providerType: "anthropic_oauth",
      baseUrl: withRouting.baseUrl || "https://api.anthropic.com"
    };
  }
  const looksLikeCursorSubscription = withRouting.providerType === "cursor_subscription" || withRouting.apiFormat === "cursor_subscription" || withRouting.presetId === "cursor-subscription";
  if (looksLikeCursorSubscription) {
    return normalizeCursorSubscriptionProvider(withRouting);
  }
  const looksLikeXiaomiMiMo = baseUrl.includes("xiaomimimo.com") || id.includes("xiaomi") || id.includes("mimo") || name.includes("xiaomi") || name.includes("mimo");
  if (looksLikeXiaomiMiMo && baseUrl.endsWith("/anthropic")) {
    return { ...withRouting, apiFormat: "anthropic_messages" };
  }
  if (looksLikeXiaomiMiMo && withRouting.apiFormat === "openai_responses") {
    return { ...withRouting, apiFormat: "openai_chat" };
  }
  return withRouting;
}

function normalizeKnownModel(model, providers = []) {
  if (!model || typeof model !== "object") return model;
  const provider = providers.find((item) => item.id === model.providerId);
  const haystack = [
    model.id,
    model.providerId,
    model.upstreamModel,
    provider?.id,
    provider?.name,
    provider?.baseUrl
  ].filter(Boolean).join(" ").toLowerCase();
  let next = {
    ...model,
    allowedClients: normalizeStringList(model.allowedClients, ["*"]),
    // Provider scope remains the default for existing configurations. A model
    // edited in the desktop form explicitly sets this flag, making its Agent
    // scope an override rather than an additional restriction.
    agentScopeOverride: model.agentScopeOverride === true
  };
  if ((haystack.includes("xiaomimimo.com") || haystack.includes("xiaomi") || haystack.includes("mimo")) && /\bmimo-v2\.5(?!-pro)\b/.test(haystack)) {
    next = {
      ...next,
      capabilities: {
        ...(next.capabilities || {}),
        images: true,
        multimodal: true
      }
    };
  }
  const looksLikeCodexOAuth = String(provider?.baseUrl || "").toLowerCase().includes("chatgpt.com/backend-api/codex") ||
    provider?.authMode === "codex_oauth" ||
    provider?.providerType === "codex_oauth";
  const modelName = String(next.upstreamModel || next.id || "").toLowerCase();
  if (looksLikeCodexOAuth && /^(gpt-5\.5|gpt-5\.4|gpt-5\.4-mini|codex-auto-review)\b/.test(modelName)) {
    next = {
      ...next,
      capabilities: {
        ...(next.capabilities || {}),
        images: true,
        multimodal: true
      }
    };
  }
  const stripsSizeTag = haystack.includes("xiaomimimo.com") || haystack.includes("opencode") || haystack.includes("agnes-ai.com") || haystack.includes("agnes");
  if (!stripsSizeTag) return next;
  const upstreamModel = String(next.upstreamModel || "");
  const normalized = upstreamModel.replace(/\[[^\]]+\]$/, "");
  if (!normalized || normalized === upstreamModel) return next;
  const aliases = Array.from(new Set([...(next.aliases || []), upstreamModel, normalized]));
  return { ...next, upstreamModel: normalized, aliases };
}

function providerText(provider) {
  return [
    provider?.id,
    provider?.name,
    provider?.displayName,
    provider?.baseUrl
  ].filter(Boolean).join(" ").toLowerCase();
}

function modelText(model) {
  return [
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(model?.aliases || [])
  ].filter(Boolean).join(" ").toLowerCase();
}

function looksLikeKnownTextOnlyModel(model, provider) {
  const providerHaystack = providerText(provider);
  const modelHaystack = modelText(model);
  if (/vision|image|multimodal|janus|vl\b/.test(modelHaystack)) return false;
  if (providerHaystack.includes("deepseek") || modelHaystack.includes("deepseek")) return true;
  if (/\bglm-5\.2\b/.test(modelHaystack)) return true;
  if (/\bkimi-k2\.7-code\b/.test(modelHaystack)) return true;
  if (/\bminimax-m3\b/.test(modelHaystack)) return true;
  return false;
}

function defaultVisionFallbackModelId(models) {
  const preferred = models.find((model) => model.id === "xiaomi-mimo/mimo-v2.5" && (model.capabilities?.images || model.capabilities?.multimodal));
  if (preferred) return preferred.id;
  return "";
}

function normalizeKnownVisionFallbacks(models, providers = []) {
  const providerMap = new Map((providers || []).map((provider) => [provider.id, provider]));
  const fallbackModelId = defaultVisionFallbackModelId(models);
  return models.map((model) => {
    const provider = providerMap.get(model.providerId);
    if (!looksLikeKnownTextOnlyModel(model, provider)) return model;
    const next = {
      ...model,
      capabilities: {
        ...(model.capabilities || {}),
        images: false,
        multimodal: false
      }
    };
    if (!next.visionFallbackModelId && fallbackModelId && next.id !== fallbackModelId) {
      next.visionFallbackModelId = fallbackModelId;
    }
    return next;
  });
}

export function validateConfig(config) {
  if (!Array.isArray(config.providers)) throw new Error("config.providers must be an array");
  if (!Array.isArray(config.models)) throw new Error("config.models must be an array");
  const providerIds = new Set();
  for (const provider of config.providers) {
    if (!provider.id) throw new Error("Every provider needs id");
    if (providerIds.has(provider.id)) throw new Error(`Duplicate provider id: ${provider.id}`);
    providerIds.add(provider.id);
    if (!provider.apiFormat || !SUPPORTED_API_FORMATS.has(provider.apiFormat)) {
      throw new Error(`Provider ${provider.id} has unsupported apiFormat: ${provider.apiFormat}`);
    }
    if (provider.routingMode && !SUPPORTED_ROUTING_MODES.has(provider.routingMode)) {
      throw new Error(`Provider ${provider.id} has unsupported routingMode: ${provider.routingMode}`);
    }
    if (!provider.baseUrl) throw new Error(`Provider ${provider.id} requires baseUrl`);
    if (provider.providerType === "cursor_subscription") {
      if (provider.enabled !== false && config.host !== "127.0.0.1") throw new Error("Cursor subscription bridge requires config.host to be 127.0.0.1");
      const concurrency = Number(provider.maxConcurrentRequests || 2);
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("Cursor subscription bridge supports 1 to 3 concurrent requests");
    }
  }
  const modelIds = new Set();
  for (const model of config.models) {
    if (!model.id) throw new Error("Every model needs id");
    if (modelIds.has(model.id)) throw new Error(`Duplicate model id: ${model.id}`);
    modelIds.add(model.id);
    if (!providerIds.has(model.providerId)) {
      throw new Error(`Model ${model.id} references missing provider ${model.providerId}`);
    }
    if (!model.upstreamModel) throw new Error(`Model ${model.id} requires upstreamModel`);
    const aliases = model.aliases || [];
    if (!Array.isArray(aliases)) throw new Error(`Model ${model.id} aliases must be an array`);
  }
  return true;
}

function scopeAllows(scope, clientId) {
  const allow = new Set(normalizeStringList(scope, ["*"]));
  return allow.has("*") || allow.has(clientId);
}

function clientConfig(config, clientId) {
  if (clientId === "claude-app") return config.clients?.["claude-app"] || config.clients?.["claude-code"] || { enabled: true, allowedModels: ["*"] };
  return config.clients?.[clientId] || { enabled: true, allowedModels: ["*"] };
}

function clientScopeAllows(scope, clientId) {
  if (scopeAllows(scope, clientId)) return true;
  return clientId === "claude-app" && scopeAllows(scope, "claude-code");
}

export function modelVisibleToClient(config, model, clientId) {
  if (!model || model.enabled === false) return false;
  if (!clientId) return true;
  const filter = clientConfig(config, clientId);
  if (filter.enabled === false) return false;
  const provider = (config.providers || []).find((item) => item.id === model.providerId);
  // Provider visibility is a default. Model-level configuration is the
  // explicit exception, so a model can be exposed to an Agent even when its
  // provider is otherwise hidden from that Agent.
  const effectiveScope = model.agentScopeOverride === true
    ? model.allowedClients
    : provider?.allowedClients;
  if (!clientScopeAllows(effectiveScope, clientId)) return false;
  const allow = new Set(filter.allowedModels || ["*"]);
  const keys = [model.id, model.upstreamModel, claudeCodeDiscoveryModelId(model), claudeAppDiscoveryModelId(model), ...(model.aliases || [])].filter(Boolean);
  return allow.has("*") || keys.some((key) => allow.has(key));
}

export function claudeCodeDiscoveryModelId(model) {
  const raw = String(model?.id || model?.upstreamModel || "").trim();
  if (!raw) return "";
  // For claude/anthropic prefixed IDs, use the raw ID only if there's no providerId prefix.
  // If the model comes from a Switchyard provider (has providerId in id like "provider/claude-xxx"),
  // still add a hash suffix to avoid collision when two providers both have "claude-sonnet-4-6".
  const slashIndex = raw.indexOf("/");
  const hasProviderPrefix = slashIndex > 0 && slashIndex < raw.length - 1;
  if (/^(claude|anthropic)/i.test(raw) && !hasProviderPrefix) return raw;
  // Use a claude/anthropic alias directly (alias has no provider prefix)
  const displayAlias = (model?.aliases || []).find((alias) => /^(claude|anthropic)/i.test(String(alias || "")));
  if (displayAlias) return displayAlias;
  const slug = raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `claude-switchyard-${slug || "model"}-${hash}`;
}

const CLAUDE_APP_BLOCKED_MODEL_RE = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/i;
const CLAUDE_APP_ALLOWED_MODEL_RE = /claude|anthropic|sonnet|opus|haiku|fable|mythos/i;

function claudeAppAcceptsModelId(value) {
  const id = String(value || "").trim();
  return Boolean(id && CLAUDE_APP_ALLOWED_MODEL_RE.test(id) && !CLAUDE_APP_BLOCKED_MODEL_RE.test(id));
}

export function claudeAppDiscoveryModelId(model) {
  const raw = String(model?.id || model?.upstreamModel || "").trim();
  if (!raw) return "";
  const displayAlias = (model?.aliases || []).find((alias) => claudeAppAcceptsModelId(alias));
  if (displayAlias) return displayAlias;
  if (claudeAppAcceptsModelId(raw)) return raw;
  const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
  return `claude-sonnet-4-5-switchyard-${hash}`;
}

export function publicModel(model, { idOverride } = {}) {
  const id = idOverride || model.id;
  return {
    id,
    object: "model",
    created: 0,
    owned_by: model.providerId,
    display_name: model.displayName || model.id,
    capabilities: model.capabilities || {},
    aliases: Array.from(new Set([...(model.aliases || []), ...(id !== model.id ? [model.id] : [])]))
  };
}

function displayNameWithProvider(model, providerName) {
  const base = String(model?.displayName || model?.upstreamModel || model?.id || "").trim() || model.id;
  const provider = String(providerName || model?.providerId || "").trim();
  if (!provider) return base;
  const escapedProvider = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:·|\\(|\\[)\\s*${escapedProvider}\\s*(?:\\)|\\])?$`, "i").test(base)) return base;
  return `${base} · ${provider}`;
}

export function anthropicModelInfo(model, providerName, { idOverride, anthropicFamilyTier, isFamilyDefault } = {}) {
  const out = {
    type: "model",
    id: idOverride || model.id,
    display_name: displayNameWithProvider(model, providerName),
    created_at: "1970-01-01T00:00:00Z"
  };
  if (anthropicFamilyTier) out.anthropic_family_tier = anthropicFamilyTier;
  if (isFamilyDefault) out.is_family_default = true;
  return out;
}

export function publicModelsForClient(config, clientId) {
  // 未带 client 前缀的通用 /v1/models 也只能发布实际可路由的模型。
  // 否则 UI 会展示已禁用模型，用户选中后又被路由到默认供应商。
  const models = clientId
    ? listModelsForClient(config, clientId)
    : (config.models || []).filter((model) => model?.enabled !== false);
  if (clientId === "claude-code" || clientId === "claude-app") {
    const providerNames = new Map((config.providers || []).map((provider) => [provider.id, provider.name || provider.id]));
    // Deduplicate discovery IDs: if two models produce the same ID (e.g. both have alias "claude-sonnet-4-6"),
    // keep the first as-is and add a hash suffix to subsequent ones.
    const seenIds = new Set();
    return models.map((model, index) => {
      let idOverride = clientId === "claude-app" ? claudeAppDiscoveryModelId(model) : claudeCodeDiscoveryModelId(model);
      if (seenIds.has(idOverride)) {
        // Fall back to the hashed slug form to avoid collision
        const raw = String(model.id || model.upstreamModel || "").trim();
        const slug = raw.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
        const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
        idOverride = `claude-switchyard-${slug || "model"}-${hash}`;
      }
      seenIds.add(idOverride);
      return anthropicModelInfo(model, providerNames.get(model.providerId) || model.providerId, {
        idOverride,
        ...(clientId === "claude-app" ? { anthropicFamilyTier: "sonnet", isFamilyDefault: index === 0 } : {})
      });
    });
  }
  return models.map(publicModel);
}

export function configLocation() {
  return configPath() || DEFAULT_CONFIG_PATH;
}

export function listModelsForClient(config, clientId) {
  const filter = clientConfig(config, clientId);
  if (filter.enabled === false) return [];
  const enabledModels = config.models.filter((model) => model.enabled !== false);
  return enabledModels.filter((model) => modelVisibleToClient(config, model, clientId));
}

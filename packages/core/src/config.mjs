// Config loading, validation, and persistence for the gateway.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { configPath, ensureDir, DEFAULT_CONFIG_PATH } from "./utils.mjs";

export const SUPPORTED_API_FORMATS = new Set([
  "openai_chat",
  "openai_responses",
  "anthropic_messages"
]);
export const SUPPORTED_ROUTING_MODES = new Set(["auto", "native", "gateway"]);

export const SUPPORTED_CLIENTS = new Set(["codex", "claude-code", "hermes", "generic-openai"]);

export const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 17888,
  defaultModel: null,
  providers: [],
  models: [],
  clients: {
    codex: { enabled: true, allowedModels: ["*"] },
    "claude-code": { enabled: true, allowedModels: ["*"], modelMapping: {} },
    hermes: { enabled: true, allowedModels: ["*"] },
    "generic-openai": { enabled: true, allowedModels: ["*"] }
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

export function saveConfig(config, file = configPath()) {
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
    if (Array.isArray(input.providers)) out.providers = input.providers.map(normalizeKnownProvider);
    if (Array.isArray(input.models)) out.models = input.models.map((model) => normalizeKnownModel(model, out.providers));
    if (input.clients && typeof input.clients === "object") {
      out.clients = { ...out.clients };
      for (const [key, value] of Object.entries(input.clients)) {
        if (!value || typeof value !== "object") continue;
        const normalized = {
          enabled: value.enabled !== false,
          allowedModels: Array.isArray(value.allowedModels) ? value.allowedModels : ["*"]
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

export function normalizeClientModelMapping(modelMapping = {}) {
  const out = {};
  for (const key of ["default", "haiku", "sonnet", "opus", "fable"]) {
    const value = modelMapping?.[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function normalizeKnownProvider(provider) {
  if (!provider || typeof provider !== "object") return provider;
  const withRouting = {
    ...provider,
    routingMode: provider.routingMode || "auto"
  };
  const baseUrl = String(withRouting.baseUrl || "").toLowerCase();
  const id = String(withRouting.id || "").toLowerCase();
  const name = String(withRouting.name || "").toLowerCase();
  if (baseUrl.includes("chatgpt.com/backend-api/codex")) {
    return {
      ...withRouting,
      apiFormat: "openai_responses",
      authMode: withRouting.authMode || "codex_oauth",
      providerType: withRouting.providerType || "codex_oauth"
    };
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
  let next = model;
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

export function claudeCodeDiscoveryModelId(model) {
  const raw = String(model?.id || model?.upstreamModel || "").trim();
  if (!raw) return "";
  if (/^(claude|anthropic)/i.test(raw)) return raw;
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

export function anthropicModelInfo(model, providerName, { idOverride } = {}) {
  return {
    type: "model",
    id: idOverride || model.id,
    display_name: displayNameWithProvider(model, providerName),
    created_at: "1970-01-01T00:00:00Z"
  };
}

export function publicModelsForClient(config, clientId) {
  const models = clientId ? listModelsForClient(config, clientId) : config.models;
  if (clientId === "claude-code") {
    const providerNames = new Map((config.providers || []).map((provider) => [provider.id, provider.name || provider.id]));
    return models.map((model) => anthropicModelInfo(model, providerNames.get(model.providerId) || model.providerId, {
      idOverride: claudeCodeDiscoveryModelId(model)
    }));
  }
  return models.map(publicModel);
}

export function configLocation() {
  return configPath() || DEFAULT_CONFIG_PATH;
}

export function listModelsForClient(config, clientId) {
  const filter = (config.clients && config.clients[clientId]) || { enabled: true, allowedModels: ["*"] };
  if (filter.enabled === false) return [];
  const allow = new Set(filter.allowedModels || ["*"]);
  const enabledModels = config.models.filter((model) => model.enabled !== false);
  if (allow.has("*")) return enabledModels.slice();
  return enabledModels.filter((model) => allow.has(model.id) || (model.aliases || []).some((alias) => allow.has(alias)));
}

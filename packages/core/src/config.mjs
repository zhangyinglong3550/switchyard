// Config loading, validation, and persistence for the gateway.
import fs from "node:fs";
import path from "node:path";
import { configPath, ensureDir, DEFAULT_CONFIG_PATH } from "./utils.mjs";

export const SUPPORTED_API_FORMATS = new Set([
  "openai_chat",
  "openai_responses",
  "anthropic_messages"
]);

export const SUPPORTED_CLIENTS = new Set(["codex", "claude-code", "hermes", "generic-openai"]);

export const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 17888,
  defaultModel: null,
  providers: [],
  models: [],
  clients: {
    codex: { enabled: true, allowedModels: ["*"] },
    "claude-code": { enabled: true, allowedModels: ["*"] },
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
    if (Array.isArray(input.providers)) out.providers = input.providers;
    if (Array.isArray(input.models)) out.models = input.models;
    if (input.clients && typeof input.clients === "object") {
      out.clients = { ...out.clients };
      for (const [key, value] of Object.entries(input.clients)) {
        if (!value || typeof value !== "object") continue;
        out.clients[key] = {
          enabled: value.enabled !== false,
          allowedModels: Array.isArray(value.allowedModels) ? value.allowedModels : ["*"]
        };
      }
    }
  }
  return out;
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

export function publicModel(model) {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: model.providerId,
    display_name: model.displayName || model.id,
    capabilities: model.capabilities || {},
    aliases: model.aliases || []
  };
}

export function configLocation() {
  return configPath() || DEFAULT_CONFIG_PATH;
}

export function listModelsForClient(config, clientId) {
  const filter = (config.clients && config.clients[clientId]) || { enabled: true, allowedModels: ["*"] };
  if (filter.enabled === false) return [];
  const allow = new Set(filter.allowedModels || ["*"]);
  if (allow.has("*")) return config.models.slice();
  return config.models.filter((model) => allow.has(model.id) || (model.aliases || []).some((alias) => allow.has(alias)));
}

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { listCompatPacks } from "./index.mjs";

export const BUILTIN_COMPAT_REGISTRY_PATH = fileURLToPath(new URL("./compat-registry.json", import.meta.url));

export function loadCompatRegistry(file = BUILTIN_COMPAT_REGISTRY_PATH) {
  const text = fs.readFileSync(file, "utf8");
  return parseCompatRegistryJson(text);
}

export function parseCompatRegistryJson(text) {
  const parsed = JSON.parse(String(text || "{}"));
  return normalizeCompatRegistry(parsed);
}

export function normalizeCompatRegistry(input = {}) {
  const version = Number.isFinite(input.version) ? input.version : 1;
  const rules = Array.isArray(input.rules) ? input.rules : [];
  return {
    version,
    rules: rules.map(normalizeRule).filter(Boolean)
  };
}

export function recommendCompatRules({ provider = null, model = null, clientId = "", registry = null } = {}) {
  const normalizedRegistry = registry ? normalizeCompatRegistry(registry) : loadCompatRegistry();
  const knownPacks = new Set(listCompatPacks().map((pack) => pack.id));
  const recommendations = [];
  const seen = new Set();
  for (const rule of normalizedRegistry.rules) {
    if (!ruleMatches(rule, { provider, model, clientId })) continue;
    const key = rule.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const recommendedCompatPacks = rule.recommendedCompatPacks.filter((pack) => knownPacks.has(pack));
    recommendations.push({
      ...rule,
      recommendedCompatPacks,
      unknownCompatPacks: rule.recommendedCompatPacks.filter((pack) => !knownPacks.has(pack))
    });
  }
  return {
    version: normalizedRegistry.version,
    recommendations
  };
}

export function registryRecommendationsForConfig(config = {}, { registry = null } = {}) {
  const providers = {};
  const models = {};
  const providerById = new Map((config.providers || []).map((provider) => [provider.id, provider]));
  for (const provider of config.providers || []) {
    providers[provider.id] = recommendCompatRules({ provider, registry }).recommendations;
  }
  for (const model of config.models || []) {
    const provider = providerById.get(model.providerId) || { id: model.providerId };
    models[model.id] = recommendCompatRules({ provider, model, registry }).recommendations;
  }
  return { providers, models };
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== "object" || rule.enabled === false) return null;
  const id = cleanString(rule.id);
  if (!id) return null;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  const recommendedCompatPacks = cleanStringList(rule.recommendedCompatPacks || rule.compatPacks || rule.packs);
  if (!recommendedCompatPacks.length) return null;
  return {
    id,
    providerIdPattern: cleanString(rule.providerIdPattern || match.providerIdPattern || match.providerId),
    providerNamePattern: cleanString(rule.providerNamePattern || match.providerNamePattern || match.providerName),
    providerHostPattern: cleanString(rule.providerHostPattern || match.providerHostPattern || match.providerHost),
    providerPattern: cleanString(rule.providerPattern || match.providerPattern || match.provider),
    modelPattern: cleanString(rule.modelPattern || match.modelPattern || match.model),
    apiFormat: normalizeMatchList(rule.apiFormat || match.apiFormat),
    clientIdPattern: cleanString(rule.clientIdPattern || match.clientIdPattern || match.clientId),
    recommendedCompatPacks,
    reason: cleanString(rule.reason),
    impact: cleanString(rule.impact || rule.scope),
    risk: cleanString(rule.risk),
    fixtures: cleanStringList(rule.fixtures),
    source: cleanString(rule.source) || "builtin"
  };
}

function ruleMatches(rule, ctx) {
  const provider = ctx.provider || {};
  const model = ctx.model || null;
  if (rule.apiFormat.length && !rule.apiFormat.includes(String(provider.apiFormat || ""))) return false;
  if (!providerSelectorMatches(rule, provider)) return false;
  if (rule.modelPattern && !model) return false;
  if (!matchesPattern(modelText(model), rule.modelPattern)) return false;
  if (!matchesPattern(ctx.clientId, rule.clientIdPattern)) return false;
  return true;
}

function providerSelectorMatches(rule, provider) {
  const selectors = [
    [provider.id, rule.providerIdPattern],
    [[provider.name, provider.displayName].filter(Boolean).join(" "), rule.providerNamePattern],
    [providerHostText(provider), rule.providerHostPattern],
    [providerText(provider), rule.providerPattern]
  ].filter(([_value, pattern]) => pattern);
  if (!selectors.length) return true;
  return selectors.some(([value, pattern]) => matchesPattern(value, pattern));
}

function providerHostText(provider = {}) {
  const baseUrl = String(provider.baseUrl || provider.url || "");
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  return [host, baseUrl].filter(Boolean).join(" ");
}

function providerText(provider = {}) {
  return [
    provider.id,
    provider.name,
    provider.displayName,
    provider.baseUrl,
    provider.url
  ].filter(Boolean).join(" ");
}

function modelText(model = {}) {
  return [
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(Array.isArray(model?.aliases) ? model.aliases : [])
  ].filter(Boolean).join(" ");
}

function matchesPattern(value, pattern) {
  if (!pattern) return true;
  const text = String(value || "");
  if (!text) return false;
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 1000);
}

function cleanStringList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return Array.from(new Set(list.map((item) => cleanString(String(item || ""))).filter(Boolean)));
}

function normalizeMatchList(value) {
  if (!value) return [];
  return cleanStringList(value);
}

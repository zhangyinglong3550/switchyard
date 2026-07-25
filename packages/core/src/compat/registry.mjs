import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { listCompatPacks } from "./packs.mjs";
import { normalizeCompatRegistry, normalizeRule, ruleMatches } from "./matcher.mjs";

export { normalizeCompatRegistry, normalizeRule };

export const BUILTIN_COMPAT_REGISTRY_PATH = fileURLToPath(new URL("./compat-registry.json", import.meta.url));

export function loadCompatRegistry(file = BUILTIN_COMPAT_REGISTRY_PATH) {
  const text = fs.readFileSync(file, "utf8");
  return parseCompatRegistryJson(text);
}

export function parseCompatRegistryJson(text) {
  const parsed = JSON.parse(String(text || "{}"));
  return normalizeCompatRegistry(parsed);
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

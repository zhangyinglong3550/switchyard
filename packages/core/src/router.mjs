// Resolve a requested model id (or alias) to a concrete provider+upstream model.
import { claudeAppDiscoveryModelId, claudeCodeDiscoveryModelId, modelVisibleToClient } from "./config.mjs";

export function buildRouter(config) {
  const providers = new Map(config.providers.map((p) => [p.id, p]));
  const models = new Map();
  for (const model of config.models) {
    if (model?.enabled === false) continue;
    const keys = [model.id, model.upstreamModel, claudeCodeDiscoveryModelId(model), claudeAppDiscoveryModelId(model), ...(model.aliases || [])].filter(Boolean);
    for (const key of keys) {
      if (!models.has(key)) models.set(key, model);
    }
  }
  return { providers, models };
}

export function resolveRoute(config, requestedModel, { clientId } = {}) {
  const router = buildRouter(config);
  const clientDefaultModel = clientId && config.clients?.[clientId]?.defaultModel;
  const candidate =
    router.models.get(requestedModel) ||
    (clientDefaultModel ? router.models.get(clientDefaultModel) : null) ||
    (config.defaultModel ? router.models.get(config.defaultModel) : null);
  if (!candidate) return null;
  if (clientId && !modelVisibleToClient(config, candidate, clientId)) return null;
  const provider = router.providers.get(candidate.providerId);
  if (!provider) return null;
  return { provider, model: candidate, upstreamModel: candidate.upstreamModel || candidate.id };
}

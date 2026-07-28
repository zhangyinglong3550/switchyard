function modelIdFor(providerId, upstreamModel) {
  return `${providerId}/${String(upstreamModel || "").replace(/[^a-zA-Z0-9_./@+-]/g, "_")}`;
}

function normalizedCapabilities(value = {}) {
  return {
    text: true,
    tools: value.tools !== false,
    reasoning: Boolean(value.reasoning),
    images: Boolean(value.images),
    stream: value.stream !== false,
    multimodal: Boolean(value.multimodal)
  };
}

/**
 * Safely adds new models discovered from an upstream provider. Existing models
 * remain untouched so user overrides (names, aliases, enabled state, routing)
 * always win over a later directory refresh.
 */
export function mergeDiscoveredModelsIntoConfig(config, providerId, discovered = [], { now = new Date().toISOString() } = {}) {
  const id = String(providerId || "").trim();
  if (!id) throw new Error("providerId is required");
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  if (!providers.some((provider) => provider.id === id)) throw new Error(`Provider not found: ${id}`);
  const models = Array.isArray(config?.models) ? config.models : [];
  const knownUpstreamModels = new Set(models.filter((model) => model.providerId === id).map((model) => String(model.upstreamModel || "")));
  const seen = new Set();
  const additions = [];
  let known = 0;
  for (const item of discovered || []) {
    const upstreamModel = String(item?.id || item?.upstreamModel || "").trim();
    if (!upstreamModel || seen.has(upstreamModel)) continue;
    seen.add(upstreamModel);
    if (knownUpstreamModels.has(upstreamModel)) {
      known += 1;
      continue;
    }
    additions.push({
      id: modelIdFor(id, upstreamModel),
      providerId: id,
      upstreamModel,
      displayName: String(item?.displayName || upstreamModel),
      aliases: [upstreamModel],
      enabled: false,
      allowedClients: ["*"],
      capabilities: normalizedCapabilities(item?.capabilities),
      discoverySource: "provider_sync",
      discoveredAt: now
    });
  }
  return {
    config: {
      ...config,
      providers: providers.map((provider) => provider.id === id ? { ...provider, modelsDiscoveredAt: now } : provider),
      models: [...models, ...additions]
    },
    added: additions.length,
    known,
    models: additions
  };
}


export function listPendingDiscoveredModels(config, providerId = "") {
  return (config?.models || []).filter((model) => model?.discoverySource === "provider_sync" && model?.enabled === false && (!providerId || model.providerId === providerId));
}

export function approveDiscoveredModels(config, modelIds = [], { allowedClients } = {}) {
  const wanted = new Set((modelIds || []).map(String));
  let approved = 0;
  const models = (config?.models || []).map((model) => {
    if (!wanted.has(model.id) || model.discoverySource !== "provider_sync" || model.enabled !== false) return model;
    approved += 1;
    return { ...model, enabled: true, ...(Array.isArray(allowedClients) && allowedClients.length ? { allowedClients } : {}), approvedAt: new Date().toISOString() };
  });
  return { config: { ...config, models }, approved };
}

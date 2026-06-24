export function modelSafeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_./@+-]/g, "_");
}

export function normalizeDiscoveredModelForProvider(provider, item) {
  return {
    id: `${provider.id}/${modelSafeId(item.id)}`,
    providerId: provider.id,
    upstreamModel: item.id,
    displayName: item.displayName || item.id,
    aliases: [item.id],
    contextWindow: item.contextWindow,
    maxOutputTokens: item.maxOutputTokens,
    capabilities: {
      text: true,
      tools: item.capabilities?.tools !== false,
      reasoning: !!item.capabilities?.reasoning,
      images: !!item.capabilities?.images,
      stream: true,
      multimodal: !!item.capabilities?.multimodal
    }
  };
}

function toSet(value) {
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.filter(Boolean));
  return new Set();
}

export function selectedImportResult(result, selection = {}) {
  if (!result) return null;
  const selectedProviders = toSet(selection.providers);
  const selectedModels = toSet(selection.models);
  const providerIdsFromModels = new Set();
  const models = (result.config?.models || []).filter((model) => {
    const keep = selectedModels.has(model.id);
    if (keep) providerIdsFromModels.add(model.providerId);
    return keep;
  });
  const keepProviders = new Set([...selectedProviders, ...providerIdsFromModels]);
  const providers = (result.config?.providers || []).filter((provider) => keepProviders.has(provider.id));
  const providerIds = new Set(providers.map((provider) => provider.id));
  return {
    ...result,
    importMeta: {
      ...(result.importMeta || {}),
      providers: (result.importMeta?.providers || []).filter((meta) => providerIds.has(meta.slug))
    },
    config: {
      ...(result.config || {}),
      providers,
      models: models.filter((model) => providerIds.has(model.providerId))
    }
  };
}

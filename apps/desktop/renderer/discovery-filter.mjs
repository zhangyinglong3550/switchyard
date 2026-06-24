export function filterDiscoveryModels(models, query) {
  const q = String(query || "").trim().toLowerCase();
  return (models || []).reduce((items, model, index) => {
    if (!q || discoverySearchText(model).includes(q)) items.push({ model, index });
    return items;
  }, []);
}

function discoverySearchText(model) {
  const capabilities = Object.entries(model?.capabilities || {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
  return [
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(model?.aliases || []),
    ...capabilities
  ].filter(Boolean).join(" ").toLowerCase();
}

export const CLIENT_SCOPE_OPTIONS = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["hermes", "Hermes"],
  ["generic-openai", "通用 OpenAI"]
];

export function normalizeClientScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return ["*"];
  const out = Array.from(new Set(scope.map((item) => String(item || "").trim()).filter(Boolean)));
  return out.length ? out : ["*"];
}

export function clientScopeLabel(scope) {
  const normalized = normalizeClientScope(scope);
  if (normalized.includes("*")) return "全部 Agent";
  const labels = new Map(CLIENT_SCOPE_OPTIONS);
  return normalized.map((id) => labels.get(id) || id).join(", ");
}

export function scopeAllowsClient(scope, clientId) {
  const normalized = normalizeClientScope(scope);
  return normalized.includes("*") || normalized.includes(clientId);
}

function modelMatchesAllowed(model, allowedModels) {
  const allowed = normalizeClientScope(allowedModels);
  if (allowed.includes("*")) return true;
  const allowedSet = new Set(allowed);
  const keys = [model.id, model.upstreamModel, ...(model.aliases || [])].filter(Boolean);
  return keys.some((key) => allowedSet.has(key));
}

export function modelsForClient(config, clientId) {
  const providers = new Map((config?.providers || []).map((provider) => [provider.id, provider]));
  const filter = config?.clients?.[clientId] || { enabled: true, allowedModels: ["*"] };
  if (filter.enabled === false) return [];
  return (config?.models || []).filter((model) => {
    if (model.enabled === false) return false;
    const provider = providers.get(model.providerId);
    if (!scopeAllowsClient(provider?.allowedClients, clientId)) return false;
    if (!scopeAllowsClient(model.allowedClients, clientId)) return false;
    return modelMatchesAllowed(model, filter.allowedModels);
  });
}

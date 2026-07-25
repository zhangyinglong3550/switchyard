// Resolve a requested model id (or alias) to a concrete provider+upstream model.
import { claudeAppDiscoveryModelId, claudeCodeDiscoveryModelId, modelVisibleToClient } from "./config.mjs";

/**
 * 除 model.id 外、可用于“短名路由”的键（upstream / aliases / 发现名）。
 * 当多个模型共享同一短名时，这些键不得注册，避免双供应商同名串号。
 */
export function secondaryRouteKeysForModel(model) {
  if (!model) return [];
  const id = String(model.id || "").trim();
  const keys = [
    model.upstreamModel,
    claudeCodeDiscoveryModelId(model),
    claudeAppDiscoveryModelId(model),
    ...(Array.isArray(model.aliases) ? model.aliases : [])
  ];
  const out = [];
  const seen = new Set();
  for (const raw of keys) {
    const key = String(raw || "").trim();
    if (!key || key === id || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * 统计配置中各短名被多少个启用模型占用。
 * count > 1 的短名视为歧义，路由时只认完整 model.id。
 */
export function ambiguousSecondaryRouteKeys(models = []) {
  const counts = new Map();
  for (const model of models) {
    if (!model || model.enabled === false) continue;
    for (const key of secondaryRouteKeysForModel(model)) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const ambiguous = new Set();
  for (const [key, count] of counts) {
    if (count > 1) ambiguous.add(key);
  }
  return ambiguous;
}

export function buildRouter(config) {
  const providers = new Map((config.providers || []).map((p) => [p.id, p]));
  const enabledModels = (config.models || []).filter((model) => model && model.enabled !== false);
  const ambiguous = ambiguousSecondaryRouteKeys(enabledModels);
  const models = new Map();

  for (const model of enabledModels) {
    const id = String(model.id || "").trim();
    // 完整 id 永远优先、永不因冲突被跳过
    if (id) models.set(id, model);
    for (const key of secondaryRouteKeysForModel(model)) {
      // 短名仅在全局唯一时才注册；多供应商同名时强制用户选完整 id
      if (ambiguous.has(key)) continue;
      if (!models.has(key)) models.set(key, model);
    }
  }

  return { providers, models, ambiguousSecondaryKeys: ambiguous };
}

/**
 * A Codex task keeps sending its old full provider/model id after that provider
 * has been removed.  This is intentionally narrow: only a qualified id whose
 * provider no longer exists is eligible for recovery.  Unknown short names or
 * models belonging to a live provider remain normal routing errors.
 */
export function isDeletedProviderModelRequest(config, requestedModel) {
  const requested = String(requestedModel || "").trim();
  const slash = requested.indexOf("/");
  if (slash <= 0 || slash === requested.length - 1) return false;
  const providerId = requested.slice(0, slash);
  return !(config.providers || []).some((provider) => provider?.id === providerId);
}

export function resolveRoute(config, requestedModel, { clientId } = {}) {
  const router = buildRouter(config);
  const requested = String(requestedModel || "").trim();
  const clientDefaultModel = clientId && config.clients?.[clientId]?.defaultModel;

  // 1) 精确命中（完整 id 或唯一短名）
  // 2) 客户端默认
  // 3) 全局默认
  let candidate =
    (requested ? router.models.get(requested) : null) ||
    (clientDefaultModel ? router.models.get(String(clientDefaultModel).trim()) : null) ||
    (config.defaultModel ? router.models.get(String(config.defaultModel).trim()) : null);

  // 默认模型也可能是短名且已歧义：再按 model.id 精确找一次
  if (!candidate && clientDefaultModel) {
    candidate = (config.models || []).find((m) => m?.enabled !== false && m.id === clientDefaultModel) || null;
  }
  if (!candidate && config.defaultModel) {
    candidate = (config.models || []).find((m) => m?.enabled !== false && m.id === config.defaultModel) || null;
  }

  if (!candidate) return null;
  if (clientId && !modelVisibleToClient(config, candidate, clientId)) return null;
  const provider = router.providers.get(candidate.providerId);
  if (!provider) return null;
  return { provider, model: candidate, upstreamModel: candidate.upstreamModel || candidate.id };
}

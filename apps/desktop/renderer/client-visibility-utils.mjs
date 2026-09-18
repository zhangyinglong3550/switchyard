/**
 * 客户端接入清单的唯一真源。
 * 顺序 = 面板卡片顺序 = 各处筛选项顺序；新增客户端只改这里。
 * 任何「按客户端列选项 / 显示客户端名」的地方都必须从本表派生，不要再手抄副本。
 */
export const CLIENT_SCOPE_OPTIONS = [
  ["codex", "Codex"],
  ["claude-code", "Claude Code"],
  ["hermes", "Hermes"],
  ["opencode", "OpenCode"],
  ["grok", "Grok Build"],
  ["deepseek-harness", "DeepSeek Harness"],
  ["zcode", "ZCode"],
  ["generic-openai", "通用 OpenAI"]
];

/** id → 展示名（由真源派生） */
export const CLIENT_LABELS = new Map(CLIENT_SCOPE_OPTIONS);

/** 不是可配置客户端、但会出现在请求日志 / 用量里的伪 clientId */
const NON_CLIENT_LABELS = new Map([[ "model-test", "模型测试" ]]);

/**
 * 「按数据筛选」用的列表（用量 / 请求日志）：真实客户端 + 数据里会出现的伪 clientId。
 * 不能用于「选接入目标」（测试台、脱敏放行）——那些只能选真实客户端。
 */
export const CLIENT_FILTER_OPTIONS = [...CLIENT_SCOPE_OPTIONS, ...NON_CLIENT_LABELS];

/** 任意 clientId → 展示名；未收录时回退原值，空值回退 "-" */
export function clientDisplayLabel(clientId) {
  const id = String(clientId ?? "").trim();
  if (!id) return "-";
  return CLIENT_LABELS.get(id) || NON_CLIENT_LABELS.get(id) || id;
}

export function normalizeClientScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) return ["*"];
  const out = Array.from(new Set(scope.map((item) => String(item || "").trim()).filter(Boolean)));
  return out.length ? out : ["*"];
}

export function clientScopeLabel(scope) {
  const normalized = normalizeClientScope(scope);
  if (normalized.includes("*")) return "全部 Agent";
  return normalized.map((id) => CLIENT_LABELS.get(id) || id).join(", ");
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
    const effectiveScope = model.agentScopeOverride === true
      ? model.allowedClients
      : provider?.allowedClients;
    if (!scopeAllowsClient(effectiveScope, clientId)) return false;
    return modelMatchesAllowed(model, filter.allowedModels);
  });
}

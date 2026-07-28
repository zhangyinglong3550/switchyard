import { modelVisibleToClient } from "./config.mjs";
import { resolveRoute } from "./router.mjs";
import { isAccountPoolProvider, listEligibleAccounts, poolKindOf } from "./account-pool/picker.mjs";
import { loadPool } from "./account-pool/store.mjs";

const FORMATS = new Set(["openai_chat", "openai_responses", "anthropic_messages", "antigravity"]);
export function preflightRoute(config = {}, { modelId = "", clientId = "generic-openai", home } = {}) {
  const errors = [], warnings = [];
  const requested = String(modelId || "").trim();
  const model = (config.models || []).find((item) => item?.id === requested) || null;
  if (!model) errors.push({ code: "MODEL_NOT_FOUND", message: `未找到模型：${requested || "(空)"}` });
  else {
    if (model.enabled === false) errors.push({ code: "MODEL_DISABLED", message: "模型尚未启用" });
    if (clientId && !modelVisibleToClient(config, model, clientId)) errors.push({ code: "MODEL_HIDDEN_FOR_CLIENT", message: `模型不对客户端 ${clientId} 可见` });
  }
  const provider = model ? (config.providers || []).find((item) => item?.id === model.providerId) : null;
  if (model && !provider) errors.push({ code: "PROVIDER_NOT_FOUND", message: `未找到供应商：${model.providerId}` });
  if (provider && !FORMATS.has(String(provider.apiFormat || "openai_chat"))) errors.push({ code: "PROVIDER_FORMAT_INVALID", message: `不支持的 API 格式：${provider.apiFormat}` });
  if (provider && isAccountPoolProvider(provider)) {
    const pool = loadPool(provider.id, { poolKind: poolKindOf(provider), home });
    const enabled = (pool.accounts || []).filter((account) => account?.enabled !== false && account?.health !== "disabled");
    const eligible = listEligibleAccounts(pool);
    if (!enabled.length) errors.push({ code: "POOL_EMPTY", message: "账号池没有可用账号" });
    else if (!eligible.length) warnings.push({ code: "POOL_COOLDOWN", message: "账号池当前都在冷却、过期或不可用；请求会等待下一次恢复" });
  }
  const route = model && provider ? resolveRoute(config, model.id, { clientId }) : null;
  if (model?.capabilities?.stream === false) warnings.push({ code: "STREAM_DISABLED", message: "该模型标记为不支持流式输出" });
  return { ok: !errors.length, errors, warnings, route: route ? { modelId: route.model.id, providerId: route.provider.id, upstreamModel: route.upstreamModel, apiFormat: route.provider.apiFormat } : null };
}

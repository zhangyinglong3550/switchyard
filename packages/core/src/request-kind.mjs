/**
 * 请求分类：区分真实模型调用 vs 客户端协议探测（列模型 / Ollama tags / props 等）。
 * 探测请求通常无 body.model，用量里不宜显示成「未知」。
 */

/** 用量聚合与落库使用的哨兵 model_id（展示名） */
export const DISCOVERY_PROBE_MODEL_ID = "(发现探测)";

function trimmed(value) {
  return String(value ?? "").trim();
}

function upperMethod(method) {
  return String(method || "").trim().toUpperCase();
}

/**
 * 是否为「发现/探测」类请求（不消耗上游推理配额的协议握手）。
 * 规则：无有效 model，且不是 chat/completions · responses · messages 推理入口。
 */
export function isDiscoveryProbeRequest({
  method,
  path,
  modelId,
  requestedModel,
  model_id,
  requested_model
} = {}) {
  const model = trimmed(modelId ?? model_id ?? requestedModel ?? requested_model);
  // 已有真实/哨兵模型名：仅当已是哨兵时仍算探测
  if (model && model !== DISCOVERY_PROBE_MODEL_ID && model !== "(unknown)") {
    return false;
  }
  if (model === DISCOVERY_PROBE_MODEL_ID) return true;

  const m = upperMethod(method);
  const p = String(path || "");

  // 推理入口即使缺 model 也算业务请求（会 400），不归入探测
  if (/\/chat\/completions\/?$/i.test(p) || /\/responses\/?$/i.test(p) || /\/messages\/?$/i.test(p)) {
    return false;
  }
  if (/\/messages\/count_tokens/i.test(p)) {
    return true;
  }

  if (m === "GET" || m === "HEAD") {
    // 列模型、单模型详情、Ollama、props、version、models-v2、客户端根探测等
    if (
      /\/v1\/models(\/|$)/i.test(p) ||
      /\/models(\/|$)/i.test(p) ||
      /\/api\/tags\/?$/i.test(p) ||
      /\/api\/v1\/models/i.test(p) ||
      /\/props\/?$/i.test(p) ||
      /\/version\/?$/i.test(p) ||
      /models-v2/i.test(p) ||
      /\/health\/?$/i.test(p)
    ) {
      return true;
    }
    // 其余无 model 的 GET：客户端兼容扫描（多数 404），也标为探测
    return true;
  }

  if (m === "POST" && /\/api\/show\/?$/i.test(p)) return true;

  return false;
}

/**
 * 用量/列表用的展示 model 键：探测 → (发现探测)；否则 model 或 (unknown)
 */
export function resolveUsageModelKey({
  method,
  path,
  modelId,
  requestedModel,
  model_id,
  requested_model
} = {}) {
  const explicit = trimmed(modelId ?? model_id) || trimmed(requestedModel ?? requested_model);
  if (explicit === DISCOVERY_PROBE_MODEL_ID) return DISCOVERY_PROBE_MODEL_ID;
  if (explicit && explicit !== "(unknown)") return explicit;
  if (isDiscoveryProbeRequest({ method, path, modelId: explicit, requestedModel: explicit })) {
    return DISCOVERY_PROBE_MODEL_ID;
  }
  return explicit || "(unknown)";
}

/**
 * SQLite 聚合用表达式：空 model 的 GET/HEAD、Ollama show、count_tokens → 发现探测；
 * 已写入哨兵 model_id 的新日志直接命中第一支。
 */
export function usageModelKeySql(alias = "") {
  const c = alias ? `${alias}.` : "";
  const label = DISCOVERY_PROBE_MODEL_ID.replace(/'/g, "''");
  return `
    CASE
      WHEN TRIM(COALESCE(${c}model_id, '')) = '${label}' THEN '${label}'
      WHEN TRIM(COALESCE(${c}requested_model, '')) = '${label}' THEN '${label}'
      WHEN NULLIF(TRIM(COALESCE(${c}model_id, '')), '') IS NOT NULL
        AND TRIM(${c}model_id) NOT IN ('(unknown)', '')
        THEN TRIM(${c}model_id)
      WHEN NULLIF(TRIM(COALESCE(${c}requested_model, '')), '') IS NOT NULL
        AND TRIM(${c}requested_model) NOT IN ('(unknown)', '')
        THEN TRIM(${c}requested_model)
      WHEN UPPER(COALESCE(${c}method, '')) IN ('GET', 'HEAD') THEN '${label}'
      WHEN UPPER(COALESCE(${c}method, '')) = 'POST'
        AND (
          COALESCE(${c}path, '') LIKE '%/api/show%'
          OR COALESCE(${c}path, '') LIKE '%count_tokens%'
        )
        THEN '${label}'
      ELSE '(unknown)'
    END
  `.replace(/\s+/g, " ").trim();
}

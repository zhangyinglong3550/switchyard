// 从流式 SSE JSON 中提取 token usage（Responses / Chat / Anthropic 形状）
// 缓存字段对齐 CC Switch：cache_read_tokens / cache_creation_tokens

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return Number(value);
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/**
 * 从 usage 对象提取 cache_read（命中量）。
 * 路径对齐 CC Switch proxy usage parser。
 */
export function extractCacheReadTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const detailsIn = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details
    : null;
  const detailsPrompt = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details
    : null;
  return firstNumber(
    usage.cache_read_input_tokens,
    usage.cache_read_tokens,
    usage.cacheReadTokens,
    usage.cacheReadInputTokens,
    detailsIn?.cached_tokens,
    detailsIn?.cache_read_tokens,
    detailsPrompt?.cached_tokens,
    detailsPrompt?.cache_read_tokens,
    usage.cached_tokens,
    usage.cachedContentTokenCount,
    usage.cached_content_token_count
  );
}

/**
 * 从 usage 对象提取 cache_creation / cache_write（写入量）。
 */
export function extractCacheCreationTokens(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const detailsIn = usage.input_tokens_details && typeof usage.input_tokens_details === "object"
    ? usage.input_tokens_details
    : null;
  const detailsPrompt = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
    ? usage.prompt_tokens_details
    : null;
  const creationDetails = usage.cache_creation && typeof usage.cache_creation === "object"
    ? usage.cache_creation
    : null;
  return firstNumber(
    usage.cache_creation_input_tokens,
    usage.cache_creation_tokens,
    usage.cacheCreationTokens,
    usage.cacheCreationInputTokens,
    usage.cache_write_tokens,
    usage.cacheWriteTokens,
    detailsIn?.cache_write_tokens,
    detailsIn?.cache_creation_tokens,
    detailsPrompt?.cache_write_tokens,
    detailsPrompt?.cache_creation_tokens,
    creationDetails?.ephemeral_5m_input_tokens,
    creationDetails?.ephemeral_1h_input_tokens,
    // Anthropic 有时只给 cache_creation 嵌套对象的合计字段
    typeof usage.cache_creation === "number" ? usage.cache_creation : 0
  );
}

/**
 * 从任意 usage 对象归一化为
 * { prompt_tokens, completion_tokens, total_tokens, cache_read_tokens, cache_creation_tokens }
 * 无有效字段时返回 null
 */
export function normalizeUsageObject(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = firstNumber(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens
  );
  const completion = firstNumber(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens
  );
  const total = firstNumber(
    usage.total_tokens,
    usage.totalTokens,
    prompt + completion
  );
  const cache_read_tokens = extractCacheReadTokens(usage);
  const cache_creation_tokens = extractCacheCreationTokens(usage);
  if (!prompt && !completion && !total && !cache_read_tokens && !cache_creation_tokens) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion,
    cache_read_tokens,
    cache_creation_tokens
  };
}

/**
 * 从 SSE data 的 JSON 对象中提取 usage（覆盖常见上游形状）
 */
export function extractUsageFromSseJson(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  // OpenAI Chat stream final chunk: { usage: {...}, choices: [] }
  // OpenAI Responses: { type: "response.completed", response: { usage } }
  // Anthropic: { type: "message_delta", usage: { input_tokens, output_tokens } }
  //            { type: "message_start", message: { usage } }
  const candidates = [
    parsed.usage,
    parsed.response?.usage,
    parsed.message?.usage,
    parsed.data?.usage,
    parsed.delta?.usage
  ];
  for (const raw of candidates) {
    const normalized = normalizeUsageObject(raw);
    if (normalized) return normalized;
  }
  return null;
}

/** 解析 SSE data 行文本（可能是 JSON 或 [DONE]） */
export function extractUsageFromSseDataLine(data) {
  const text = String(data || "").trim();
  if (!text || text === "[DONE]") return null;
  try {
    return extractUsageFromSseJson(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * 合并 usage：保留非零更大的 total（流中可能先到部分 usage 再完整）。
 * 选中完整一侧后，若另一侧 cache 更大则保留较大 cache（避免 partial 覆盖）。
 */
export function mergeUsage(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const prevTotal = firstNumber(prev.total_tokens);
  const nextTotal = firstNumber(next.total_tokens);
  const primary = nextTotal >= prevTotal ? next : prev;
  const secondary = primary === next ? prev : next;
  return {
    prompt_tokens: firstNumber(primary.prompt_tokens),
    completion_tokens: firstNumber(primary.completion_tokens),
    total_tokens: firstNumber(primary.total_tokens),
    cache_read_tokens: Math.max(
      firstNumber(primary.cache_read_tokens),
      firstNumber(secondary.cache_read_tokens)
    ),
    cache_creation_tokens: Math.max(
      firstNumber(primary.cache_creation_tokens),
      firstNumber(secondary.cache_creation_tokens)
    )
  };
}

/** 写入 requestRecord 的顶层 token 字段（供 request_logs 入库） */
export function applyUsageToRequestRecord(record, usageLike) {
  if (!record) return;
  const usage = normalizeUsageObject(usageLike) ||
    normalizeUsageObject({
      prompt_tokens: usageLike?.prompt_tokens ?? usageLike?.promptTokens,
      completion_tokens: usageLike?.completion_tokens ?? usageLike?.completionTokens,
      total_tokens: usageLike?.total_tokens ?? usageLike?.totalTokens,
      cache_read_tokens: usageLike?.cache_read_tokens ?? usageLike?.cacheReadTokens,
      cache_creation_tokens: usageLike?.cache_creation_tokens ?? usageLike?.cacheCreationTokens,
      cache_read_input_tokens: usageLike?.cache_read_input_tokens,
      cache_creation_input_tokens: usageLike?.cache_creation_input_tokens,
      input_tokens_details: usageLike?.input_tokens_details,
      prompt_tokens_details: usageLike?.prompt_tokens_details
    });
  if (!usage) return;
  record.promptTokens = usage.prompt_tokens;
  record.completionTokens = usage.completion_tokens;
  record.totalTokens = usage.total_tokens;
  record.cacheReadTokens = usage.cache_read_tokens;
  record.cacheCreationTokens = usage.cache_creation_tokens;
}

/**
 * 缓存命中率（%）：cache_read / prompt，与 CC Switch input_token_semantics≈0 口径一致。
 * prompt<=0 时返回 null；结果 cap 在 100。
 */
export function cacheHitRatePercent(cacheReadTokens, promptTokens) {
  const prompt = firstNumber(promptTokens);
  const read = firstNumber(cacheReadTokens);
  if (prompt <= 0) return null;
  const rate = Math.round((read / prompt) * 1000) / 10;
  return Math.min(100, Math.max(0, rate));
}

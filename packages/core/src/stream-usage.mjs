// 从流式 SSE JSON 中提取 token usage（Responses / Chat / Anthropic 形状）

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return Number(value);
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/**
 * 从任意 usage 对象归一化为 { prompt_tokens, completion_tokens, total_tokens }
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
  if (!prompt && !completion && !total) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total || prompt + completion
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
 * 合并 usage：保留非零更大的 total（流中可能先到部分 usage 再完整）
 */
export function mergeUsage(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const prevTotal = firstNumber(prev.total_tokens);
  const nextTotal = firstNumber(next.total_tokens);
  if (nextTotal >= prevTotal) return next;
  return prev;
}

/** 写入 requestRecord 的顶层 token 字段（供 request_logs 入库） */
export function applyUsageToRequestRecord(record, usageLike) {
  if (!record) return;
  const usage = normalizeUsageObject(usageLike) ||
    normalizeUsageObject({
      prompt_tokens: usageLike?.prompt_tokens ?? usageLike?.promptTokens,
      completion_tokens: usageLike?.completion_tokens ?? usageLike?.completionTokens,
      total_tokens: usageLike?.total_tokens ?? usageLike?.totalTokens
    });
  if (!usage) return;
  record.promptTokens = usage.prompt_tokens;
  record.completionTokens = usage.completion_tokens;
  record.totalTokens = usage.total_tokens;
}

// 供应商余额/用量查询的标准化类型定义。

// 模板类型枚举——对应不同供应商的余额查询方式。
export const USAGE_TEMPLATE_TYPES = Object.freeze({
  CUSTOM: "custom", // 自定义 request + extractor 配置
  BALANCE: "balance", // 直接余额 API（OpenAI credits、DeepSeek user/info 等）
  USER_INFO: "user_info", // 用户信息接口，从中提取余额字段
  CODING_PLAN: "coding_plan", // 套餐/配额 API（火山方舟、智谱、Kimi、MiniMax 等）
  SUBSCRIPTION: "subscription", // 订阅额度（Codex OAuth / ChatGPT Plus/Pro）
});

// 构建标准化的用量查询结果（不冻结，由调用方在附加 status 后统一冻结）。
// - success: 查询是否成功
// - data: 数据数组（支持多套餐），每个元素包含 planName / total / used / remaining / unit
// - error: 失败时的错误信息
export function createUsageResult({ success, data, error } = {}) {
  const normalized = Array.isArray(data)
    ? data.filter((item) => item && typeof item === "object")
    : data && typeof data === "object"
      ? [data]
      : [];
  return {
    success: Boolean(success),
    data: normalized,
    error: String(error || ""),
  };
}

// 冻结 UsageResult 及其 data 数组，返回同一对象。
export function freezeUsageResult(result) {
  if (!result || typeof result !== "object") return result;
  if (Array.isArray(result.data)) Object.freeze(result.data);
  return Object.freeze(result);
}

// 从 UsageResult 派生余额状态标记。
// available — 有余额且 > 0
// insufficient — 余额为 0 或负数
// error — 查询失败
// unknown — 成功但无余额数值
export function deriveBalanceStatus(result) {
  if (!result) return "unknown";
  if (!result.success) return "error";
  const remaining = result.data?.[0]?.remaining;
  if (remaining == null) return "unknown";
  const num = Number(remaining);
  return Number.isFinite(num) && num <= 0 ? "insufficient" : "available";
}

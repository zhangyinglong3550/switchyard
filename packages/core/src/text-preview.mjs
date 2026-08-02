/**
 * 日志/调用可视化用的文本预览：超长时保留开头 + 结尾，避免只看到历史开头、看不到本轮最新内容。
 */

export function contentToPlainText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => contentToPlainText(item)).filter(Boolean).join("\n");
  }
  if (typeof value !== "object") return String(value);
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return contentToPlainText(value.content);
  if (typeof value.output_text === "string") return value.output_text;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {unknown} value
 * @param {number} [max=1200]
 * @param {{ strategy?: "head" | "head-tail", headRatio?: number }} [options]
 */
export function previewText(value, max = 1200, options = {}) {
  const strategy = options.strategy === "head" ? "head" : "head-tail";
  const headRatio = Number.isFinite(options.headRatio) ? Math.min(0.8, Math.max(0.15, options.headRatio)) : 0.35;
  let text = contentToPlainText(value)
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[图片]")
    .trim();
  const limit = Math.max(80, Math.trunc(Number(max) || 1200));
  if (text.length <= limit) return text;
  if (strategy === "head") return `${text.slice(0, limit)}…`;

  const markerBudget = 48;
  const usable = Math.max(64, limit - markerBudget);
  const headLen = Math.max(40, Math.floor(usable * headRatio));
  const tailLen = Math.max(40, usable - headLen);
  const omitted = text.length - headLen - tailLen;
  const marker = `\n…[中间已省略 ${Math.max(0, omitted)} 字]…\n`;
  return `${text.slice(0, headLen)}${marker}${text.slice(-tailLen)}`;
}

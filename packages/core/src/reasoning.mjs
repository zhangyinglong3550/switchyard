import { contentToText } from "./utils.mjs";

export const SWITCHYARD_THINKING_KEY = "_switchyardAnthropicThinking";
export const ANTHROPIC_THINKING_PREFIX = "switchyard:anthropic-thinking:v1:";

const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";

export function cloneAnthropicThinkingBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((block) => block && (block.type === "thinking" || block.type === "redacted_thinking"))
    .map((block) => ({ ...block }));
}

export function encodeAnthropicThinkingBlocks(blocks) {
  const normalized = cloneAnthropicThinkingBlocks(blocks);
  if (!normalized.length) return "";
  return `${ANTHROPIC_THINKING_PREFIX}${Buffer.from(JSON.stringify(normalized), "utf8").toString("base64url")}`;
}

export function decodeAnthropicThinkingBlocks(value) {
  const text = String(value || "");
  if (!text.startsWith(ANTHROPIC_THINKING_PREFIX)) return [];
  try {
    const raw = Buffer.from(text.slice(ANTHROPIC_THINKING_PREFIX.length), "base64url").toString("utf8");
    return cloneAnthropicThinkingBlocks(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function thinkingSummaryText(blocks) {
  return cloneAnthropicThinkingBlocks(blocks)
    .map((block) => {
      if (block.type === "thinking") return block.thinking || block.text || "";
      if (block.type === "redacted_thinking") return "[redacted thinking]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function splitLeadingThinkBlock(text) {
  const value = String(text || "");
  const leadingWsLen = value.length - value.trimStart().length;
  const afterWs = value.slice(leadingWsLen);
  if (!afterWs.startsWith(THINK_OPEN_TAG)) return null;
  const bodyStart = leadingWsLen + THINK_OPEN_TAG.length;
  const closeOffset = value.slice(bodyStart).indexOf(THINK_CLOSE_TAG);
  if (closeOffset < 0) return null;
  const closeStart = bodyStart + closeOffset;
  const answerStart = closeStart + THINK_CLOSE_TAG.length;
  return {
    reasoning: value.slice(bodyStart, closeStart).trim(),
    answer: value.slice(answerStart).trimStart()
  };
}

function extractReasoningDetailsText(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map(extractReasoningDetailsText)
      .filter(Boolean)
      .join("\n\n");
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "content", "summary", "reasoning_content"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  if (Array.isArray(value.parts)) return extractReasoningDetailsText(value.parts);
  if (Array.isArray(value.summary)) return extractReasoningDetailsText(value.summary);
  return "";
}

export function extractReasoningFieldText(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["reasoning_content", "reasoning"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  if (value.reasoning && typeof value.reasoning === "object") {
    for (const key of ["content", "text", "summary"]) {
      if (typeof value.reasoning[key] === "string" && value.reasoning[key].trim()) {
        return value.reasoning[key].trim();
      }
    }
    const nested = extractReasoningDetailsText(value.reasoning);
    if (nested) return nested;
  }
  const details = extractReasoningDetailsText(value.reasoning_details);
  if (details) return details;
  return "";
}

export function extractReasoningSummaryText(item) {
  if (!item || typeof item !== "object") return "";
  const direct = extractReasoningFieldText(item);
  if (direct) return direct;
  if (typeof item.summary === "string") return item.summary.trim();
  if (Array.isArray(item.summary)) return extractReasoningDetailsText(item.summary);
  return "";
}

export function reasoningBlocksFromMessage(message) {
  const blocks = cloneAnthropicThinkingBlocks(message?.[SWITCHYARD_THINKING_KEY] || message?.reasoning_blocks);
  const reasoning = extractReasoningFieldText(message);
  if (reasoning && !blocks.some((block) => (block.thinking || block.text || "") === reasoning)) {
    blocks.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message?.content === "string") {
    const split = splitLeadingThinkBlock(message.content);
    if (split?.reasoning && !blocks.some((block) => (block.thinking || block.text || "") === split.reasoning)) {
      blocks.push({ type: "thinking", thinking: split.reasoning });
    }
  }
  return blocks;
}

export function contentWithoutLeadingThink(content) {
  if (typeof content !== "string") return content;
  return splitLeadingThinkBlock(content)?.answer ?? content;
}

export function attachReasoningToMessage(message, reasoning) {
  const text = String(reasoning || "").trim();
  if (!message || typeof message !== "object" || !text) return message;
  const blocks = cloneAnthropicThinkingBlocks(message[SWITCHYARD_THINKING_KEY] || message.reasoning_blocks);
  if (!blocks.some((block) => (block.thinking || block.text || "") === text)) {
    blocks.push({ type: "thinking", thinking: text });
  }
  return { ...message, [SWITCHYARD_THINKING_KEY]: blocks };
}

export function stripRawReasoningFields(message) {
  if (!message || typeof message !== "object") return message;
  const {
    reasoning_content,
    reasoning_details,
    reasoning,
    ...rest
  } = message;
  return rest;
}

export function chatReasoningText(message) {
  const blocks = reasoningBlocksFromMessage(message);
  const summary = thinkingSummaryText(blocks);
  if (summary) return summary;
  return contentToText(extractReasoningFieldText(message));
}

// ── 请求级思考档位：Anthropic ↔ Chat/Responses ──────────────────────────────
// 对齐 CC Switch resolve_reasoning_effort：
// 1. output_config.effort（max → xhigh）
// 2. thinking.type + budget_tokens（adaptive → xhigh；enabled 按 budget 分档）
// 未知值不注入，避免严格上游 400。

const EFFORT_OFF_RE = /^(none|off|disabled|false|0)$/i;

function normalizeEffortToken(value) {
  const effort = String(value || "").trim().toLowerCase();
  return effort || "";
}

function isEffortOff(value) {
  return EFFORT_OFF_RE.test(normalizeEffortToken(value));
}

/**
 * Anthropic Messages 请求 → Chat/Responses 使用的 effort 字符串。
 * @returns {string|null} 如 "low"/"medium"/"high"/"xhigh"；无法解析时 null
 */
export function resolveReasoningEffortFromAnthropic(body) {
  if (!body || typeof body !== "object") return null;

  const outputEffort = body.output_config && typeof body.output_config === "object"
    ? body.output_config.effort
    : undefined;
  if (outputEffort !== undefined && outputEffort !== null && outputEffort !== "") {
    const token = normalizeEffortToken(outputEffort);
    if (isEffortOff(token)) return "none";
    if (token === "max") return "xhigh"; // OpenAI xhigh ≈ Claude max
    if (token === "minimal") return "low";
    if (token === "low" || token === "medium" || token === "high" || token === "xhigh") return token;
    // 未知 output_config.effort：不注入，避免严格上游 400
    return null;
  }

  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object") return null;
  const thinkingType = normalizeEffortToken(thinking.type);
  if (thinkingType === "adaptive") return "xhigh";
  if (thinkingType === "enabled") {
    const budget = Number(thinking.budget_tokens);
    if (Number.isFinite(budget) && budget > 0) {
      if (budget < 4000) return "low";
      if (budget < 16000) return "medium";
      return "high";
    }
    return "high";
  }
  // disabled / 其它 → 不注入
  return null;
}

/**
 * Chat/Responses 请求体上的 effort（reasoning / reasoning_effort）。
 * @returns {string|null}
 */
export function resolveReasoningEffortFromChat(body) {
  if (!body || typeof body !== "object") return null;

  if (Object.prototype.hasOwnProperty.call(body, "reasoning") && body.reasoning !== undefined) {
    const reasoning = body.reasoning;
    if (reasoning == null || reasoning === false) return "none";
    if (typeof reasoning === "string") {
      const token = normalizeEffortToken(reasoning);
      if (!token) return null;
      if (isEffortOff(token)) return "none";
      if (token === "max") return "xhigh";
      if (token === "minimal") return "low";
      if (token === "true" || token === "on" || token === "enabled") return "high";
      return token;
    }
    if (typeof reasoning === "object" && !Array.isArray(reasoning)) {
      if (reasoning.effort !== undefined && reasoning.effort !== null && reasoning.effort !== "") {
        const token = normalizeEffortToken(reasoning.effort);
        if (isEffortOff(token)) return "none";
        if (token === "max") return "xhigh";
        if (token === "minimal") return "low";
        return token;
      }
      // reasoning 对象存在但无 effort：视为显式开启，默认 high
      return "high";
    }
    if (reasoning === true) return "high";
  }

  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null && body.reasoning_effort !== "") {
    const token = normalizeEffortToken(body.reasoning_effort);
    if (!token) return null;
    if (isEffortOff(token)) return "none";
    if (token === "max") return "xhigh";
    if (token === "minimal") return "low";
    return token;
  }

  return null;
}

/** Chat effort → Anthropic output_config.effort（xhigh → max） */
export function chatEffortToAnthropicOutputEffort(effort) {
  const token = normalizeEffortToken(effort);
  if (!token || isEffortOff(token)) return null;
  if (token === "xhigh" || token === "max") return "max";
  if (token === "minimal") return "low";
  if (token === "low" || token === "medium" || token === "high") return token;
  // 未知档位不写入 output_config，避免 Claude 400
  return null;
}

/** Chat effort → Anthropic thinking.budget_tokens */
export function chatEffortToThinkingBudget(effort) {
  const token = normalizeEffortToken(effort);
  if (!token || isEffortOff(token)) return null;
  if (token === "low" || token === "minimal") return 2048;
  if (token === "medium") return 8192;
  if (token === "high") return 16384;
  if (token === "xhigh" || token === "max") return 32000;
  return null;
}

/**
 * 把 Chat 侧 reasoning 档位写回 Anthropic Messages 请求。
 * 仅在显式有 effort 且非 none 时写入；不覆盖调用方已提供的 thinking / output_config。
 * 写入 budget 时同步抬高 max_tokens，避免 Anthropic「budget > max_tokens」400。
 */
export function applyChatReasoningToAnthropic(out, body) {
  if (!out || typeof out !== "object" || !body || typeof body !== "object") return out;

  const hasThinking = out.thinking && typeof out.thinking === "object";
  const hasOutputConfig = out.output_config && typeof out.output_config === "object"
    && out.output_config.effort !== undefined && out.output_config.effort !== null && out.output_config.effort !== "";

  // 已有完整 Anthropic 原生字段则不覆盖
  if (hasThinking && hasOutputConfig) return out;

  const effort = resolveReasoningEffortFromChat(body);
  if (effort == null) return out;
  if (effort === "none") {
    // 显式关闭：仅在尚未声明时写入 disabled，避免误开 thinking
    if (!hasThinking) out.thinking = { type: "disabled" };
    return out;
  }

  const outputEffort = chatEffortToAnthropicOutputEffort(effort);
  const budget = chatEffortToThinkingBudget(effort);

  if (!hasOutputConfig && outputEffort) {
    out.output_config = {
      ...(out.output_config && typeof out.output_config === "object" ? out.output_config : {}),
      effort: outputEffort
    };
  }
  if (!hasThinking && budget != null) {
    out.thinking = { type: "enabled", budget_tokens: budget };
    ensureMaxTokensAboveThinkingBudget(out, budget);
  }
  return out;
}

function ensureMaxTokensAboveThinkingBudget(out, budget) {
  const need = Number(budget) + 1024;
  const current = Number(out.max_tokens || 0);
  if (!Number.isFinite(need) || need <= 0) return;
  if (!Number.isFinite(current) || current < need) out.max_tokens = need;
}

/** tool_call 消息缺 reasoning 时的占位（Kimi/DeepSeek 等多轮硬要求非空） */
export const TOOL_CALL_REASONING_PLACEHOLDER = " ";

/**
 * 给带 tool_calls 且无任何 reasoning 的 assistant 消息补非空占位。
 * 仅在「thinking 已启用」场景调用，避免无端注入污染请求。
 */
export function ensureToolCallReasoningPlaceholder(message) {
  if (!message || typeof message !== "object" || message.role !== "assistant") return message;
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return message;

  const contentReasoning = typeof message.reasoning_content === "string" && message.reasoning_content.trim();
  const fieldReasoning = typeof message.reasoning === "string" && message.reasoning.trim();
  const blocks = reasoningBlocksFromMessage(message);
  if (contentReasoning || fieldReasoning || blocks.length) return message;

  return {
    ...message,
    reasoning_content: message.reasoning_content || TOOL_CALL_REASONING_PLACEHOLDER,
    reasoning: message.reasoning || TOOL_CALL_REASONING_PLACEHOLDER
  };
}

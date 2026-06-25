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

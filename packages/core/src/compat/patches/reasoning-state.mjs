import {
  SWITCHYARD_THINKING_KEY,
  thinkingSummaryText,
  reasoningBlocksFromMessage
} from "../../reasoning.mjs";

const TARGET_RE = /deepseek|glm|zhipu|z-ai|zai|kimi|moonshot|xiaomi|mimo|qwen|dashscope|bailian|aliyun|modelscope|openrouter/i;

function haystack({ provider, model }) {
  return [
    provider?.id,
    provider?.name,
    provider?.displayName,
    provider?.baseUrl,
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(model?.aliases || [])
  ].filter(Boolean).join(" ");
}

function targeted(ctx) {
  return TARGET_RE.test(haystack(ctx));
}

/**
 * 把客户端送来的思考块转成 Chat 上游可回传的字段名。
 *
 * 只做形态转换：客户端送了什么就转什么。不生成摘要、不补占位、不改写档位、
 * 也不替客户端决定是否开启 thinking —— 那些都是 Agent 的决定，网关不该代劳。
 * 客户端没送思考就不写字段；上游若因此拒绝，如实把错误交回客户端。
 */
function attachReasoningContent(message) {
  if (!message || message.role !== "assistant") return { message, attached: false };
  // 客户端已经用了上游字段名（reasoning_content / reasoning），原样透传。
  if (message.reasoning_content || message.reasoning) return { message, attached: true };
  const blocks = reasoningBlocksFromMessage(message);
  const summary = thinkingSummaryText(blocks);
  if (!summary) return { message, attached: false };
  return {
    message: {
      ...message,
      reasoning_content: summary,
      [SWITCHYARD_THINKING_KEY]: message[SWITCHYARD_THINKING_KEY]
    },
    attached: true
  };
}

export const reasoningStatePatch = {
  id: "reasoning-state",
  label: "Thinking 历史字段转换",
  description: "把客户端送来的 thinking 块转成 Chat 上游可回传的 reasoning_content。只做字段名/形态转换，不生成内容、不决定 thinking 开关。",
  trigger: "provider/model/baseUrl 命中 DeepSeek、GLM、Kimi、MiMo、Qwen/DashScope、OpenRouter 等 reasoning 模型，或手动启用。",
  changes: [
    "客户端 thinking 块 -> reasoning_content（仅转换，不生成内容）",
    "客户端已带 reasoning_content / reasoning 时原样透传",
    "不补占位 reasoning、不改写推理档位、不替客户端开关 thinking"
  ],
  risk: "客户端未回传思考时不再兜底回填。上游若因此报 reasoning_content_missing，由客户端自行决定是否回传思考，而不是网关代它拼。",
  tests: [
    "reasoning-state · 已回传的思考不再以别名复制第二份",
    "reasoning-state · 客户端未回传思考时不写入任何字段",
    "reasoning-state · 客户端 thinking 块转换为 reasoning_content"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    return {
      ...body,
      messages: body.messages.map((message) => attachReasoningContent(message).message)
    };
  }
};

import { SWITCHYARD_THINKING_KEY, thinkingSummaryText, reasoningBlocksFromMessage } from "../../reasoning.mjs";

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

function hasEnabledThinking(body) {
  if (body?.thinking && typeof body.thinking === "object") return body.thinking.type !== "disabled";
  if (body?.enable_thinking !== undefined) return Boolean(body.enable_thinking);
  if (body?.reasoning_split !== undefined) return Boolean(body.reasoning_split);
  if (body?.reasoning && typeof body.reasoning === "object") return body.reasoning.effort !== "none";
  return false;
}

function disableThinking(body) {
  const out = { ...body };
  if (out.thinking && typeof out.thinking === "object") out.thinking = { ...out.thinking, type: "disabled" };
  if (out.enable_thinking !== undefined) out.enable_thinking = false;
  if (out.reasoning_split !== undefined) out.reasoning_split = false;
  if (out.reasoning && typeof out.reasoning === "object") out.reasoning = { ...out.reasoning, effort: "none" };
  return out;
}

function attachReasoningContent(message) {
  if (!message || message.role !== "assistant") return { message, attached: false };
  const blocks = reasoningBlocksFromMessage(message);
  const summary = thinkingSummaryText(blocks);
  if (!summary) return { message, attached: false };
  return {
    message: {
      ...message,
      reasoning_content: message.reasoning_content || summary,
      reasoning: message.reasoning || summary,
      [SWITCHYARD_THINKING_KEY]: message[SWITCHYARD_THINKING_KEY]
    },
    attached: true
  };
}

export const reasoningStatePatch = {
  id: "reasoning-state",
  label: "Thinking 历史回传",
  description: "把内部 thinking/reasoning 历史转成常见 Chat 上游可回传字段；缺少可回传 thinking 历史时禁用 provider thinking。",
  trigger: "provider/model/baseUrl 命中 DeepSeek、GLM、Kimi、MiMo、Qwen/DashScope、OpenRouter 等 reasoning 模型，或手动启用。",
  changes: [
    "assistant thinking block -> reasoning_content / reasoning",
    "thinking 已启用但历史里没有可回传 thinking 时，自动降级为 disabled",
    "减少 DeepSeek/GLM 等上游要求 thinking passback 时的 400"
  ],
  risk: "在多轮历史缺失 thinking 块时会关闭上游 thinking，以换取稳定性；可能降低该轮推理能力。",
  tests: [
    "reasoning-state · attaches internal thinking to assistant history",
    "reasoning-state · disables thinking when history cannot pass it back"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    let attachedAny = false;
    let assistantCount = 0;
    const messages = body.messages.map((message) => {
      if (message?.role === "assistant") assistantCount += 1;
      const result = attachReasoningContent(message);
      attachedAny = attachedAny || result.attached;
      return result.message;
    });
    const next = { ...body, messages };
    if (assistantCount > 0 && hasEnabledThinking(next) && !attachedAny) {
      return disableThinking(next);
    }
    return next;
  }
};


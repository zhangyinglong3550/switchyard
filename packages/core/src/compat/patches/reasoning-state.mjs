import {
  SWITCHYARD_THINKING_KEY,
  thinkingSummaryText,
  reasoningBlocksFromMessage,
  ensureToolCallReasoningPlaceholder
} from "../../reasoning.mjs";
import { resolveReasoningCapability } from "../../reasoning-effort-catalog.mjs";

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

function requiresToolCallReasoningPlaceholder(ctx) {
  // DeepSeek's multi-turn tool path validates historical assistant tool calls
  // more strictly than its normal text path. In particular, OpenCode Go's
  // DeepSeek bridge can turn the missing field into a generic Console Go 400.
  // Keep the placeholder narrowly scoped: other Chat-compatible providers
  // should not receive synthetic reasoning unless thinking is enabled.
  return /deepseek/i.test(haystack(ctx));
}

function hasEnabledThinking(body) {
  if (body?.thinking && typeof body.thinking === "object") return body.thinking.type !== "disabled";
  if (body?.enable_thinking !== undefined) return Boolean(body.enable_thinking);
  if (body?.reasoning_split !== undefined) return Boolean(body.reasoning_split);
  if (body?.reasoning && typeof body.reasoning === "object") return body.reasoning.effort !== "none";
  return false;
}

/**
 * 请求是否显式要求开启推理。
 *
 * 若客户端在请求体上显式携带了一个「已开启」的推理等级
 * （reasoning_effort 或 reasoning.effort 为非 off/none），说明用户明确选择了推理，
 * 那么无论历史里能否回传 thinking，都不应擅自降级为 none —— 否则会违背用户选择，
 * 且对强制推理模型（如 OpenRouter stealth）直接触发 upstream 400。
 */
function requestExplicitlyEnablesReasoning(body) {
  if (!body || typeof body !== "object") return false;

  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null && body.reasoning_effort !== "") {
    const effort = String(body.reasoning_effort).trim().toLowerCase();
    return !/^(none|off|disabled|false|0)$/i.test(effort);
  }

  if (!Object.prototype.hasOwnProperty.call(body, "reasoning") || body.reasoning === undefined) {
    return false;
  }
  const reasoning = body.reasoning;
  if (reasoning == null || reasoning === false) return false;
  if (typeof reasoning === "string") {
    const effort = String(reasoning).trim().toLowerCase();
    return Boolean(effort) && !/^(none|off|disabled|false|0)$/i.test(effort);
  }
  if (typeof reasoning === "object" && !Array.isArray(reasoning)) {
    if (reasoning.effort !== undefined && reasoning.effort !== null && reasoning.effort !== "") {
      const effort = String(reasoning.effort).trim().toLowerCase();
      return !/^(none|off|disabled|false|0)$/i.test(effort);
    }
    // reasoning 对象存在但无 effort：视为显式开启（默认 high）
    return true;
  }
  if (reasoning === true) return true;
  return false;
}

/**
 * 该模型是否允许关闭 thinking/reasoning。
 *
 * 返回 false（禁止关闭）的场景：
 * 1. 能力表的 supportedEfforts 明确不含 "none"（即上游不支持关闭推理）。
 * 2. OpenRouter stealth 系列（如 openrouter/stealth/ox-alpha）——上游强制开启 reasoning。
 */
function modelForbidsDisabling(ctx) {
  const capability = resolveReasoningCapability(ctx);
  const supported = Array.isArray(capability?.supportedEfforts)
    ? capability.supportedEfforts
    : null;
  if (supported && supported.length && !supported.includes("none")) {
    return true;
  }
  return /openrouter\/stealth\//i.test(haystack(ctx));
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
  description: "把内部 thinking/reasoning 历史转成常见 Chat 上游可回传字段；仅当请求未显式选择推理且模型允许关闭推理时，才在缺少可回传 thinking 历史时禁用 provider thinking。",
  trigger: "provider/model/baseUrl 命中 DeepSeek、GLM、Kimi、MiMo、Qwen/DashScope、OpenRouter 等 reasoning 模型，或手动启用。",
  changes: [
    "assistant thinking block -> reasoning_content / reasoning",
    "用户显式选择了推理等级（reasoning_effort / reasoning.effort 非 off）时，绝不做降级，原样传给上游",
    "模型禁止关闭推理（能力表不含 none / OpenRouter stealth）不做降级，避免 upstream 400",
    "仅「未显式选推理」且「可关闭推理」的模型，才在历史缺 thinking 时降级为 disabled",
    "带 tool_calls 且无 reasoning 的 assistant 补非空占位（Kimi/DeepSeek 硬要求）",
    "减少 DeepSeek/GLM 等上游要求 thinking passback 时的 400"
  ],
  risk: "在多轮历史缺失 thinking 块且用户未显式选推理时，会关闭上游 thinking 以换取稳定性；可能降低该轮推理能力。占位 reasoning 仅为通过校验，不含真实思考。",
  tests: [
    "reasoning-state · attaches internal thinking to assistant history",
    "reasoning-state · disables thinking when history cannot pass it back and no explicit effort",
    "reasoning-state · keeps reasoning on force-reasoning (OpenRouter stealth) models",
    "reasoning-state · keeps explicit user reasoning level even without passable thinking history"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body, ctx) {
    if (!body || !Array.isArray(body.messages)) return body;
    let attachedAny = false;
    let assistantCount = 0;
    let messages = body.messages.map((message) => {
      if (message?.role === "assistant") assistantCount += 1;
      const result = attachReasoningContent(message);
      attachedAny = attachedAny || result.attached;
      return result.message;
    });
    let next = { ...body, messages };
    // 仅当「请求未显式选择推理」且「模型允许关闭推理」时才做稳定性降级：
    // - 用户明确选了推理等级（requestExplicitlyEnablesReasoning）→ 必须原样传，不得降成 none；
    // - 模型禁止关闭推理（modelForbidsDisabling）→ 一旦降成 reasoning.effort="none" 会触发 upstream 400。
    if (
      assistantCount > 0
      && hasEnabledThinking(next)
      && !attachedAny
      && !requestExplicitlyEnablesReasoning(next)
      && !modelForbidsDisabling(ctx)
    ) {
      next = disableThinking(next);
    }
    // DeepSeek 的多轮 tool-call 历史即使当前轮已为“无法回传历史思考”
    // 而关闭 thinking，也要求每个 assistant tool_call 带非空 reasoning。
    // 这正是 OpenCode Go / Console Go 在第二次工具结果后间歇性泛化为
    // 400 的路径；无需暴露任何兼容选项给用户。
    if (hasEnabledThinking(next) || requiresToolCallReasoningPlaceholder(ctx)) {
      next = {
        ...next,
        messages: next.messages.map((message) => ensureToolCallReasoningPlaceholder(message))
      };
    }
    return next;
  }
};

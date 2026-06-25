import { contentToText } from "../../utils.mjs";

const TARGET_RE = /deepseek|opencode|anthropic|claude|kimi|moonshot/i;

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
  if (ctx?.provider?.apiFormat === "anthropic_messages") return false;
  return TARGET_RE.test(haystack(ctx));
}

function toolCallIds(message) {
  return new Set((message?.tool_calls || []).map((call) => call?.id).filter(Boolean));
}

function textifyToolMessage(message) {
  const id = message?.tool_call_id ? ` (${message.tool_call_id})` : "";
  const text = contentToText(message?.content || "");
  return {
    role: "user",
    content: `Previous tool result${id}:\n${text}`
  };
}

function flushOrphanTools(out, pending) {
  for (const message of pending) out.push(textifyToolMessage(message));
  pending.length = 0;
}

export function normalizeToolHistory(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const out = [];
  const pendingTools = [];
  let openToolCallIds = null;

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "tool") {
      if (openToolCallIds && (!openToolCallIds.size || !message.tool_call_id || openToolCallIds.has(message.tool_call_id))) {
        out.push(message);
        continue;
      }
      pendingTools.push(message);
      continue;
    }

    const isAssistantWithTools = message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (isAssistantWithTools) {
      out.push(message);
      const ids = toolCallIds(message);
      const stillPending = [];
      for (const tool of pendingTools) {
        if (!ids.size || !tool.tool_call_id || ids.has(tool.tool_call_id)) out.push(tool);
        else stillPending.push(tool);
      }
      pendingTools.length = 0;
      pendingTools.push(...stillPending);
      openToolCallIds = ids;
      continue;
    }

    if (pendingTools.length) flushOrphanTools(out, pendingTools);
    out.push(message);
    openToolCallIds = null;
  }

  if (pendingTools.length) flushOrphanTools(out, pendingTools);
  return out;
}

export const toolHistoryAdjacentPatch = {
  id: "tool-history-adjacent",
  label: "工具历史邻接修复",
  description: "让 tool result 紧跟产生它的 assistant tool_calls；无法匹配的孤立工具结果降级为 user 文本上下文。",
  trigger: "provider/model 命中 DeepSeek、Claude/Anthropic-compatible、OpenCode、Kimi，或手动启用。",
  changes: [
    "把提前出现的 tool result 移到对应 assistant tool_calls 后",
    "无法匹配的 tool result 转成 Previous tool result 文本",
    "避免严格上游因工具结果顺序不合法返回 400"
  ],
  risk: "会重排或文本化部分工具历史；只对工具历史严格的上游启用。",
  tests: [
    "tool-history-adjacent · moves matching orphan tool result after assistant tool_calls",
    "tool-history-adjacent · textifies unmatched tool result"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    return { ...body, messages: normalizeToolHistory(body.messages) };
  }
};

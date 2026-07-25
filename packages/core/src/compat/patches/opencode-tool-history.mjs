// OpenCode Go multi-turn tool-history fix.
// OpenCode Go's proxy layer sometimes rejects tool_result messages that appear
// before an assistant message with tool_calls in the history. It also returns
// a generic Console Go 400 when DeepSeek receives a very large shell/browser
// tool result (for example a raw `curl` HTML page) after an otherwise valid
// tool turn. Keep the transcript structurally valid and bounded.
//
// Scope: provider.id === "opencode-go" || upstreamModel/aliases contains "opencode"

import { contentToText } from "../../utils.mjs";
import { normalizeToolHistory } from "./tool-history-adjacent.mjs";

const PROVIDER_IDS = new Set(["opencode-go", "opencode"]);
const NAME_RE = /opencode/i;
const DEEPSEEK_RE = /deepseek/i;
const MAX_DEEPSEEK_TOOL_RESULT_CHARS = 12_000;
const MAX_DEEPSEEK_TOOL_HISTORY_CHARS = 48_000;

function targeted({ provider, model }) {
  if (!provider) return false;
  if (PROVIDER_IDS.has(provider.id)) return true;
  if (model?.providerId && PROVIDER_IDS.has(model.providerId)) return true;
  return NAME_RE.test(model?.id || "");
}

function isDeepSeek(ctx) {
  return DEEPSEEK_RE.test([
    ctx?.provider?.id,
    ctx?.provider?.name,
    ctx?.model?.id,
    ctx?.model?.upstreamModel,
    ctx?.model?.displayName
  ].filter(Boolean).join(" "));
}

function truncateToolResult(value, limit) {
  const text = contentToText(value);
  if (text.length <= limit) return text;
  if (limit <= 0) return "[Switchyard: earlier tool result omitted to keep the DeepSeek tool transcript within its safe size.]";
  const head = Math.max(1, Math.floor(limit * 0.72));
  const tail = Math.max(1, limit - head);
  return `${text.slice(0, head)}\n\n[Switchyard: tool result truncated from ${text.length} characters for OpenCode Go DeepSeek compatibility.]\n\n${text.slice(-tail)}`;
}

function boundDeepSeekToolResults(messages, ctx) {
  if (!isDeepSeek(ctx)) return messages;
  let remaining = MAX_DEEPSEEK_TOOL_HISTORY_CHARS;
  const out = [...messages];

  // Budget newest results first: the current tool output is most useful to
  // the next model turn, while older shell/browser pages can be abbreviated.
  for (let index = out.length - 1; index >= 0; index -= 1) {
    const message = out[index];
    if (!message || message.role !== "tool") continue;
    const original = contentToText(message.content);
    const allowance = Math.min(MAX_DEEPSEEK_TOOL_RESULT_CHARS, Math.max(0, remaining));
    const content = truncateToolResult(original, allowance);
    remaining -= Math.min(original.length, allowance);
    if (content !== message.content) out[index] = { ...message, content };
  }
  return out;
}

export const opencodeToolHistoryPatch = {
  id: "opencode-tool-history",
  label: "OpenCode 工具历史排序",
  description: "修复 OpenCode Go 工具结果顺序；为 DeepSeek 自动压缩过大的 shell/browser 工具结果。",
  trigger: "provider/model 名称命中 OpenCode，或手动启用 opencode-go 规则。",
  changes: [
    "把 pending tool_result 移到对应 assistant tool_calls 后面",
    "DeepSeek 自动保留最近工具输出并压缩超大 HTML/命令输出"
  ],
  risk: "会重排工具结果；DeepSeek 的超大工具输出会变为带标记的头尾摘要。",
  tests: [
    "opencode-tool-history · reorders tool_results after their assistant message",
    "opencode-tool-history · bounds oversized DeepSeek tool results"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body, ctx) {
    if (!body || !Array.isArray(body.messages)) return body;
    const normalized = normalizeToolHistory(body.messages);
    return { ...body, messages: boundDeepSeekToolResults(normalized, ctx) };
  }
};

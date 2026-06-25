// DeepSeek reasoning_content handler.
// DeepSeek chat completions returns `reasoning_content` alongside `content`
// in both normal and stream (delta) responses. Preserve it as Switchyard
// internal thinking so Codex/Claude Code can display reasoning, then remove
// the provider-specific raw field before it reaches clients.
//
// Scope: provider.id === "deepseek" || upstreamModel/aliases includes /deepseek/i

const NAME_RE = /deepseek/i;
import { attachReasoningToMessage, extractReasoningFieldText, stripRawReasoningFields } from "../../reasoning.mjs";

function targeted({ provider, model }) {
  if (!provider) return false;
  if (provider.id === "deepseek") return true;
  if (model?.providerId === "deepseek") return true;
  return NAME_RE.test(model?.id || "");
}

export const deepseekReasoningPatch = {
  id: "deepseek-reasoning",
  label: "DeepSeek reasoning_content 保真",
  description: "DeepSeek Chat 响应会带 reasoning_content；先转为内部 thinking，再移除原始字段。",
  trigger: "provider/model 名称命中 DeepSeek，且方向为 inbound 或 stream。",
  changes: [
    "把非流式 Chat 响应 choices[].message.reasoning_content 转为内部 thinking",
    "从非流式 Chat 响应 choices[].message 移除原始 reasoning_content",
    "从流式 Chat SSE choices[].delta 移除 reasoning_content"
  ],
  risk: "客户端不再看到 DeepSeek 私有字段名，但 Codex/Claude Code 会收到标准 reasoning/thinking。",
  tests: [
    "deepseek-reasoning · strips reasoning_content from non-stream response",
    "deepseek-reasoning · strips reasoning_content from stream delta"
  ],
  match(ctx) { return targeted(ctx); },
  inbound(payload) {
    if (!payload || !Array.isArray(payload.choices)) return payload;
    const choices = payload.choices.map((c) => {
      if (!c) return c;
      const msg = c.message;
      if (!msg) return c;
      const reasoning = extractReasoningFieldText(msg);
      if (reasoning) return { ...c, message: stripRawReasoningFields(attachReasoningToMessage(msg, reasoning)) };
      return c;
    });
    return { ...payload, choices };
  },
  streamLine(line) {
    const data = line.startsWith("data: ") ? line.slice(6) : line;
    if (!data || data === "[DONE]") return line;
    try {
      const parsed = JSON.parse(data);
      const choices = parsed.choices;
      if (!Array.isArray(choices)) return line;
      let changed = false;
      for (const c of choices) {
        if (c?.delta?.reasoning_content !== undefined) {
          const { reasoning_content, ...rest } = c.delta;
          c.delta = rest;
          changed = true;
        }
      }
      if (changed) return "data: " + JSON.stringify(parsed);
      return line;
    } catch {
      return line;
    }
  }
};

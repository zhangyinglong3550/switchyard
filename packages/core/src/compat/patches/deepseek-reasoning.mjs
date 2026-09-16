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
    "流式 Chat SSE 的 delta 原样透传（reasoning_content 是 chat 客户端的标准思考字段）"
  ],
  risk: "客户端不再看到 DeepSeek 私有字段名，但 Codex/Claude Code 会收到标准 reasoning/thinking。",
  tests: [
    "deepseek-reasoning · strips reasoning_content from non-stream response",
    "deepseek-reasoning · leaves stream deltas untouched",
    "deepseek-reasoning · keeps reasoning-only stream delta on reasoning_content"
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
  }
  // 流式方向不注册 patch：思考阶段的 delta 天然只有 reasoning_content、没有 content，
  // 原样透传即可。回填成 content 会让整段思考混进正文（ZCode 等 chat 客户端的思考就是
  // 这么变成正文的），剥离 reasoning_content 又会让思考彻底消失（KE GLM 的 delta 带
  // role，剥完剩下 {role} 非空，连「吞掉空 delta」的兜底都触发不了，思考凭空不见）。
  // reasoning_content 本就是 chat 客户端的标准思考字段——网关自身合成 SSE 也用它。
};

import {
  attachReasoningToMessage,
  extractReasoningFieldText,
  stripRawReasoningFields
} from "../../reasoning.mjs";

const KNOWN_REASONING_RE = /deepseek|kimi|moonshot|glm|zhipu|z-ai|zai|qwen|dashscope|bailian|aliyun|modelscope|minimax|xiaomi|mimo|openrouter|novita|nvidia|longcat|stepfun|qianfan|doubao|volc|ark|byteplus|bailing|ling/i;

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
  return KNOWN_REASONING_RE.test(haystack(ctx));
}

function normalizeChoices(payload) {
  if (!payload || !Array.isArray(payload.choices)) return payload;
  let changed = false;
  const choices = payload.choices.map((choice) => {
    const msg = choice?.message;
    if (!msg || typeof msg !== "object") return choice;
    const reasoning = extractReasoningFieldText(msg);
    if (!reasoning) return choice;
    changed = true;
    return {
      ...choice,
      message: stripRawReasoningFields(attachReasoningToMessage(msg, reasoning))
    };
  });
  return changed ? { ...payload, choices } : payload;
}

function stripReasoningFromStreamLine(line) {
  const data = line.startsWith("data: ") ? line.slice(6) : line;
  if (!data || data === "[DONE]") return line;
  try {
    const parsed = JSON.parse(data);
    const choices = parsed.choices;
    if (!Array.isArray(choices)) return line;
    let changed = false;
    for (const choice of choices) {
      if (!choice?.delta || typeof choice.delta !== "object") continue;
      const reasoning = extractReasoningFieldText(choice.delta);
      if (!reasoning) continue;
      choice.delta = stripRawReasoningFields(choice.delta);
      changed = true;
    }
    if (changed) return "data: " + JSON.stringify(parsed);
  } catch {
    return line;
  }
  return line;
}

export const chatReasoningPatch = {
  id: "chat-reasoning",
  label: "Chat reasoning 字段保真",
  description: "把常见 OpenAI-compatible Chat 上游的 reasoning_content / reasoning_details / reasoning 转成 Switchyard 内部 thinking。",
  trigger: "provider/model/baseUrl 命中 DeepSeek、Kimi、GLM、Qwen、MiniMax、OpenRouter、小米、ModelScope 等 reasoning 模型。",
  changes: [
    "非流式响应：提取 reasoning_content、reasoning、reasoning_details",
    "把提取结果转成 Codex Responses reasoning 或 Claude thinking 可显示的内部块",
    "对直通 Chat SSE 删除供应商私有 reasoning 字段，避免客户端协议误判"
  ],
  risk: "如果某个聚合商把 reasoning 字段用于非思考语义，可能被当作思考展示；可在模型上关闭该规则。",
  tests: [
    "chat-reasoning · maps MiniMax reasoning_details into Codex reasoning output",
    "chat-reasoning · maps Kimi reasoning_content into Anthropic thinking"
  ],
  match(ctx) { return targeted(ctx); },
  inbound(payload) {
    return normalizeChoices(payload);
  },
  streamLine(line) {
    return stripReasoningFromStreamLine(line);
  }
};

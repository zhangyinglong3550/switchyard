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

function normalizeStreamDelta(delta) {
  if (!delta || typeof delta !== "object") return null;
  const standard = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
  const aliasText = extractReasoningFieldText(delta);
  if (!standard && !aliasText) return null;
  // 只删别名（reasoning / reasoning_details 是供应商私有写法，部分客户端会误判），
  // 保留 reasoning_content —— 它是 chat 客户端的标准思考字段，网关自身合成 SSE 也用它。
  const { reasoning, reasoning_details, ...rest } = delta;
  // 上游只给别名、没给标准字段时提升为标准字段，保证思考在客户端可见；
  // 绝不回填进 content（思考会混进正文），也绝不丢弃（思考会凭空消失）。
  if (!rest.reasoning_content && aliasText) rest.reasoning_content = aliasText;
  return rest;
}

function stripReasoningFromStreamLine(line) {
  if (typeof line !== "string" || !line.startsWith("data:")) return line;
  let payload = line.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  const data = payload;
  if (!data || data === "[DONE]") return line;
  try {
    const parsed = JSON.parse(data);
    const choices = parsed.choices;
    if (!Array.isArray(choices)) return line;
    let changed = false;
    for (const choice of choices) {
      if (!choice?.delta || typeof choice.delta !== "object") continue;
      const next = normalizeStreamDelta(choice.delta);
      if (!next) continue;
      choice.delta = next;
      changed = true;
    }
    if (!changed) return line;
    return "data: " + JSON.stringify(parsed);
  } catch {
    return line;
  }
}

export const chatReasoningPatch = {
  id: "chat-reasoning",
  label: "Chat reasoning 字段保真",
  description: "把常见 OpenAI-compatible Chat 上游的 reasoning_content / reasoning_details / reasoning 转成 Switchyard 内部 thinking。",
  trigger: "provider/model/baseUrl 命中 DeepSeek、Kimi、GLM、Qwen、MiniMax、OpenRouter、小米、ModelScope 等 reasoning 模型。",
  changes: [
    "非流式响应：提取 reasoning_content、reasoning、reasoning_details",
    "把提取结果转成 Codex Responses reasoning 或 Claude thinking 可显示的内部块",
    "对直通 Chat SSE 删除供应商私有 reasoning 字段（思考文本原样透传，不回填进 content，也不丢弃）"
  ],
  risk: "如果某个聚合商把 reasoning 字段用于非思考语义，可能被当作思考展示；可在模型上关闭该规则。",
  tests: [
    "chat-reasoning · maps MiniMax reasoning_details into Codex reasoning output",
    "chat-reasoning · maps Kimi reasoning_content into Anthropic thinking",
    "chat-reasoning · keeps reasoning-only stream delta on reasoning_content",
    "chat-reasoning · keeps reasoning_content when delta also carries role"
  ],
  match(ctx) { return targeted(ctx); },
  inbound(payload) {
    return normalizeChoices(payload);
  },
  streamLine(line) {
    return stripReasoningFromStreamLine(line);
  }
};

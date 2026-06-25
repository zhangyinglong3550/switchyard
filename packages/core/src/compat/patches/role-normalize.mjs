import { contentToText } from "../../utils.mjs";

const TARGET_RE = /volc|ark|doubao|byteplus|dashscope|bailian|aliyun|qwen|qianfan|baidu|minimax|stepfun|longcat|bailing|ling|glm|zhipu|z-ai|zai|deepseek|kimi|moonshot|opencode/i;

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

function normalizeMessage(message) {
  if (!message || typeof message !== "object") return message;
  const role = message.role || "user";
  if (role === "developer") return { ...message, role: "system" };
  if (["system", "user", "assistant", "tool"].includes(role)) return message;
  return {
    ...message,
    role: "user",
    content: `Previous ${role} message:\n${contentToText(message.content || "")}`
  };
}

export const roleNormalizePatch = {
  id: "role-normalize",
  label: "Chat 角色归一",
  description: "把 Codex/Claude 历史里部分 OpenAI-compatible 上游不接受的角色归一为 Chat Completions 常见角色。",
  trigger: "provider/model/baseUrl 命中火山、DashScope、千帆、MiniMax、StepFun、GLM、DeepSeek、Kimi 等严格 Chat 上游，或手动启用。",
  changes: [
    "developer -> system",
    "未知角色 -> user，并保留原角色文本前缀"
  ],
  risk: "未知角色会从结构化角色降级为普通上下文文本；只用于严格 Chat 上游。",
  tests: [
    "role-normalize · maps developer to system",
    "role-normalize · textifies unknown roles"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    return { ...body, messages: body.messages.map(normalizeMessage) };
  }
};


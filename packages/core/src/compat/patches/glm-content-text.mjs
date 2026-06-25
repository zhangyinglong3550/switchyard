// GLM content.text normalizer.
// GLM (Zhipu AI / ChatGLM) requires `content` to be an array of typed blocks.
// When a client sends `content: "string"` directly, GLM may reject with 400.
// This patch wraps bare string content into `[{"type": "text", "text": "..."}]`.
//
// Scope: provider.id includes "glm" or "zhipu" or "coding-plan" or "agentplan"
//        OR upstreamModel includes "glm" (case-insensitive)

const PROVIDER_IDS = new Set(["glm", "zhipu", "coding-plan", "agentplan"]);
const NAME_RE = /glm|zhipu/i;

function targeted({ provider, model }) {
  if (!provider) return false;
  if (PROVIDER_IDS.has(provider.id)) return true;
  if (model?.providerId && PROVIDER_IDS.has(model.providerId)) return true;
  return NAME_RE.test(model?.id || provider.id || "");
}

function wrapContent(content) {
  if (typeof content === "string" && content.length > 0) {
    return [{ type: "text", text: content }];
  }
  if (Array.isArray(content)) return content.map((c) => wrapContent(c));
  return content;
}

export const glmContentTextPatch = {
  id: "glm-content-text",
  label: "GLM 文本块格式化",
  description: "部分 GLM 兼容接口不接受裸字符串 content，要求 typed text block。",
  trigger: "provider/model 名称命中 GLM、Zhipu、Coding Plan 或手动启用 glm 规则。",
  changes: ["把 message.content: string 改为 [{ type: \"text\", text }]"],
  risk: "只改写文本消息结构；如果上游只接受裸字符串，可能需要关闭该规则。",
  tests: ["glm-content-text · wraps bare string content into array for GLM providers"],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    const messages = body.messages.map((msg) => {
      if (!msg || !msg.content) return msg;
      if (typeof msg.content === "string") {
        return { ...msg, content: [{ type: "text", text: msg.content }] };
      }
      return msg;
    });
    return { ...body, messages };
  }
};

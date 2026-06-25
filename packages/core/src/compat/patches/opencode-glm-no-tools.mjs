// OpenCode Go GLM tool-disable patch.
// OpenCode Go can list and complete GLM models through its Anthropic-compatible
// endpoint, but its GLM route rejects any Anthropic `tools` payload with a 1210
// invalid-parameter error. Keep the workaround scoped to OpenCode Go + GLM so
// Kimi/DeepSeek/Qwen on the same provider can keep their native behavior.

const PROVIDER_IDS = new Set(["opencode-go", "opencode"]);
const GLM_RE = /glm/i;

function targeted({ provider, model }) {
  if (!provider) return false;
  const providerId = provider.id || model?.providerId || "";
  if (!PROVIDER_IDS.has(providerId)) return false;
  return GLM_RE.test(model?.id || "");
}

export const opencodeGlmNoToolsPatch = {
  id: "opencode-glm-no-tools",
  label: "OpenCode GLM 禁用 tools 投递",
  description: "OpenCode Go 的 GLM 路由会拒绝 Anthropic tools payload。",
  trigger: "provider 命中 OpenCode 且模型命中 GLM，或手动启用 opencode-go 规则。",
  changes: ["移除请求中的 tools 和 tool_choice"],
  risk: "该模型在此供应商路径下无法使用工具调用。",
  tests: ["opencode-glm-no-tools · strips tools only for OpenCode Go GLM models"],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || (!Array.isArray(body.tools) && body.tool_choice === undefined)) return body;
    const { tools, tool_choice, ...rest } = body;
    return rest;
  }
};

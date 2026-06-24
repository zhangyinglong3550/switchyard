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
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || (!Array.isArray(body.tools) && body.tool_choice === undefined)) return body;
    const { tools, tool_choice, ...rest } = body;
    return rest;
  }
};

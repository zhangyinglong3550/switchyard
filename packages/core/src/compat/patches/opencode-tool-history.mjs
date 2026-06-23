// OpenCode Go multi-turn tool-history fix.
// OpenCode Go's proxy layer sometimes rejects tool_result messages that appear
// before an assistant message with tool_calls in the history. This patch
// reorders messages so that tool_result immediately follows the assistant
// message that produced the tool_calls.
//
// Scope: provider.id === "opencode-go" || upstreamModel/aliases contains "opencode"

const PROVIDER_IDS = new Set(["opencode-go", "opencode"]);
const NAME_RE = /opencode/i;

function targeted({ provider, model }) {
  if (!provider) return false;
  if (PROVIDER_IDS.has(provider.id)) return true;
  if (model?.providerId && PROVIDER_IDS.has(model.providerId)) return true;
  return NAME_RE.test(model?.id || "");
}

function reorderMessages(messages) {
  if (!Array.isArray(messages) || messages.length <= 2) return messages;
  const out = [];
  let pendingToolResults = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "tool") {
      pendingToolResults.push(msg);
      continue;
    }
    out.push(msg);
    if (msg.role === "assistant" && msg.tool_calls && pendingToolResults.length > 0) {
      out.push(...pendingToolResults);
      pendingToolResults = [];
    }
  }
  out.push(...pendingToolResults);
  return out;
}

export const opencodeToolHistoryPatch = {
  id: "opencode-tool-history",
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    return { ...body, messages: reorderMessages(body.messages) };
  }
};

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
  label: "OpenCode 工具历史排序",
  description: "OpenCode Go 代理层对工具结果位置更敏感，可能拒绝乱序历史。",
  trigger: "provider/model 名称命中 OpenCode，或手动启用 opencode-go 规则。",
  changes: ["把 pending tool_result 移到对应 assistant tool_calls 后面"],
  risk: "会重排历史消息；只用于 OpenCode 兼容路径。",
  tests: ["opencode-tool-history · reorders tool_results after their assistant message"],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.messages)) return body;
    return { ...body, messages: reorderMessages(body.messages) };
  }
};

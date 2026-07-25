// Builtin compatibility pack metadata. Kept separate from the dispatcher so
// registry matching can be reused without creating an import cycle.

export const BUILTIN_COMPAT_PACKS = [
  {
    id: "tool-name-normalize",
    label: "工具名安全化",
    description: "把工具名归一为常见 OpenAI-compatible 上游可接受的 function name，并在响应中恢复原名。",
    patchIds: ["tool-name-normalize"]
  },
  {
    id: "tool-history-adjacent",
    label: "工具历史邻接",
    description: "修复 tool result 与 assistant tool_calls 的邻接关系，孤立工具结果降级为文本上下文。",
    patchIds: ["tool-history-adjacent"]
  },
  {
    id: "strict-tools",
    label: "严格工具 Schema",
    description: "同时启用工具名安全化和严格 JSON Schema 清理。",
    patchIds: ["tool-name-normalize", "strict-tool-schema"]
  },
  {
    id: "role-normalize",
    label: "Chat 角色归一",
    description: "把 developer/未知角色归一为严格 Chat 上游更容易接受的角色。",
    patchIds: ["role-normalize"]
  },
  {
    id: "reasoning-state",
    label: "Thinking 历史回传",
    description: "回传 assistant thinking/reasoning 历史，必要时禁用不完整 thinking 状态。",
    patchIds: ["reasoning-state"]
  },
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    description: "清理 Moonshot/Kimi 更严格的工具 JSON Schema 字段。",
    patchIds: ["tool-name-normalize", "strict-tool-schema", "kimi-tool-schema"]
  },
  {
    id: "deepseek",
    label: "DeepSeek reasoning",
    description: "适配 DeepSeek reasoning 请求和返回的 reasoning_content。",
    patchIds: ["role-normalize", "tool-history-adjacent", "reasoning-options", "reasoning-state", "chat-reasoning", "deepseek-reasoning"]
  },
  {
    id: "reasoning-chat",
    label: "通用 Chat Reasoning",
    description: "适配常见 Chat Completions 供应商的 reasoning 请求和响应字段。",
    patchIds: ["reasoning-options", "reasoning-state", "chat-reasoning"]
  },
  {
    id: "glm",
    label: "GLM / 智谱",
    description: "把纯文本消息包装成 GLM 更容易接受的 typed content，并适配 thinking 字段。",
    patchIds: ["role-normalize", "reasoning-options", "reasoning-state", "chat-reasoning", "glm-content-text"]
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    description: "修复 OpenCode Go 工具历史顺序，并清理严格工具 Schema。",
    patchIds: ["tool-name-normalize", "strict-tool-schema", "tool-history-adjacent", "opencode-tool-history"]
  },
  {
    id: "official-gpt",
    label: "官方 GPT / Codex",
    description: "清理非 OpenAI 参数，并补齐 GPT 请求需要的默认字段。",
    patchIds: ["official-gpt-fallback"]
  },
  {
    id: "aigo-chat",
    label: "AIGoCode Chat",
    description: "针对 AIGoCode 中转的 Claude Code openai_chat 请求，做更保守的消息压平与工具参数规范化。",
    patchIds: ["role-normalize", "tool-name-normalize", "strict-tool-schema", "tool-history-adjacent", "aigo-chat"]
  }
];

export function listCompatPacks() {
  return BUILTIN_COMPAT_PACKS.map((pack) => ({ ...pack, patchIds: [...pack.patchIds] }));
}

// Compat dispatcher. Each patch is provider/model targeted; no global schema downgrade.
// Call registerBuiltinPatches() from app entry points (server.mjs and CLI) to
// activate provider/model-targeted compatibility patches.

const PATCHES = new Map();

export function registerPatch(id, patch) {
  if (!id || typeof id !== "string") throw new Error("patch id required");
  if (!patch || typeof patch !== "object") throw new Error("patch must be an object");
  if (typeof patch.match !== "function") throw new Error("patch.match must be a function");
  PATCHES.set(id, patch);
}

export function unregisterPatch(id) {
  PATCHES.delete(id);
}

export function listPatchIds() {
  return Array.from(PATCHES.keys());
}

function supportsDirection(patch, direction) {
  if (direction === "outbound") return typeof patch.outbound === "function";
  if (direction === "inbound") return typeof patch.inbound === "function";
  if (direction === "stream") return typeof patch.streamLine === "function";
  return true;
}

function activePatchEntries({ provider, model, direction }) {
  const active = [];
  const forcedPatchIds = patchIdsFromCompatPacks(provider, model);
  for (const [id, patch] of PATCHES.entries()) {
    try {
      const forced = forcedPatchIds.has(id);
      if (supportsDirection(patch, direction) && (forced || patch.match({ provider, model, direction }))) {
        active.push({ id, patch, source: forced ? "manual" : "auto" });
      }
    } catch {
      // A misbehaving patch must never break routing.
    }
  }
  return active;
}

export function activePatches({ provider, model, direction }) {
  return activePatchEntries({ provider, model, direction }).map(({ id, patch }) => ({ id, patch }));
}

export function activePatchDescriptors({ provider, model, direction }) {
  return activePatchEntries({ provider, model, direction }).map(({ id, patch, source }) => ({
    id,
    source,
    direction,
    label: patch.label || id,
    description: patch.description || "",
    trigger: patch.trigger || "",
    changes: Array.isArray(patch.changes) ? [...patch.changes] : [],
    risk: patch.risk || "",
    tests: Array.isArray(patch.tests) ? [...patch.tests] : []
  }));
}

export function applyOutbound(chatBody, ctx) {
  let body = chatBody;
  for (const { patch } of activePatches({ ...ctx, direction: "outbound" })) {
    if (typeof patch.outbound === "function") {
      body = patch.outbound(body, ctx) || body;
    }
  }
  return body;
}

export function applyInbound(payload, ctx) {
  let next = payload;
  for (const { patch } of activePatches({ ...ctx, direction: "inbound" })) {
    if (typeof patch.inbound === "function") {
      next = patch.inbound(next, ctx) || next;
    }
  }
  return next;
}

export function applyStreamLine(line, ctx) {
  let next = line;
  for (const { patch } of activePatches({ ...ctx, direction: "stream" })) {
    if (typeof patch.streamLine === "function") {
      next = patch.streamLine(next, ctx);
      if (next == null) return null;
    }
  }
  return next;
}

export function resetPatches() {
  PATCHES.clear();
}

import { kimiToolSchemaPatch } from "./patches/kimi-tool-schema.mjs";
import { deepseekReasoningPatch } from "./patches/deepseek-reasoning.mjs";
import { glmContentTextPatch } from "./patches/glm-content-text.mjs";
import { opencodeToolHistoryPatch } from "./patches/opencode-tool-history.mjs";
import { opencodeGlmNoToolsPatch } from "./patches/opencode-glm-no-tools.mjs";
import { officialGPTFallbackPatch } from "./patches/official-gpt-fallback.mjs";
import { chatReasoningPatch } from "./patches/chat-reasoning.mjs";
import { reasoningOptionsPatch } from "./patches/reasoning-options.mjs";
import { toolNameNormalizePatch } from "./patches/tool-name-normalize.mjs";
import { toolHistoryAdjacentPatch } from "./patches/tool-history-adjacent.mjs";
import { roleNormalizePatch } from "./patches/role-normalize.mjs";
import { reasoningStatePatch } from "./patches/reasoning-state.mjs";
import { strictToolSchemaPatch } from "./patches/strict-tool-schema.mjs";

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
    description: "修复 OpenCode Go 工具历史顺序，并禁用 GLM tools 误投递。",
    patchIds: ["tool-name-normalize", "strict-tool-schema", "tool-history-adjacent", "opencode-tool-history", "opencode-glm-no-tools"]
  },
  {
    id: "official-gpt",
    label: "官方 GPT / Codex",
    description: "清理非 OpenAI 参数，并补齐 GPT 请求需要的默认字段。",
    patchIds: ["official-gpt-fallback"]
  }
];

export const BUILTIN_PATCHES = [
  toolNameNormalizePatch,
  toolHistoryAdjacentPatch,
  roleNormalizePatch,
  strictToolSchemaPatch,
  kimiToolSchemaPatch,
  deepseekReasoningPatch,
  glmContentTextPatch,
  opencodeToolHistoryPatch,
  opencodeGlmNoToolsPatch,
  officialGPTFallbackPatch,
  chatReasoningPatch,
  reasoningOptionsPatch,
  reasoningStatePatch
];

export function registerBuiltinPatches() {
  for (const patch of BUILTIN_PATCHES) {
    registerPatch(patch.id, patch);
  }
}

export function listCompatPacks() {
  return BUILTIN_COMPAT_PACKS.map((pack) => ({ ...pack, patchIds: [...pack.patchIds] }));
}

function normalizeCompatPackIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function patchIdsFromCompatPacks(provider, model) {
  const selected = [
    ...normalizeCompatPackIds(provider?.compatPacks),
    ...normalizeCompatPackIds(model?.compatPacks)
  ];
  const out = new Set();
  for (const packId of selected) {
    const pack = BUILTIN_COMPAT_PACKS.find((item) => item.id === packId);
    if (pack) {
      for (const patchId of pack.patchIds) out.add(patchId);
    } else {
      out.add(packId);
    }
  }
  return out;
}

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

export function activePatches({ provider, model, direction }) {
  const active = [];
  const forcedPatchIds = patchIdsFromCompatPacks(provider, model);
  for (const [id, patch] of PATCHES.entries()) {
    try {
      if (forcedPatchIds.has(id) || patch.match({ provider, model, direction })) active.push({ id, patch });
    } catch {
      // A misbehaving patch must never break routing.
    }
  }
  return active;
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

export const BUILTIN_COMPAT_PACKS = [
  {
    id: "kimi",
    label: "Kimi / Moonshot",
    description: "清理 Moonshot/Kimi 更严格的工具 JSON Schema 字段。",
    patchIds: ["kimi-tool-schema"]
  },
  {
    id: "deepseek",
    label: "DeepSeek reasoning",
    description: "隐藏 DeepSeek reasoning_content，避免客户端协议误判。",
    patchIds: ["deepseek-reasoning"]
  },
  {
    id: "glm",
    label: "GLM / 智谱",
    description: "把纯文本消息包装成 GLM 更容易接受的 typed content。",
    patchIds: ["glm-content-text"]
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    description: "修复 OpenCode Go 工具历史顺序，并禁用 GLM tools 误投递。",
    patchIds: ["opencode-tool-history", "opencode-glm-no-tools"]
  },
  {
    id: "official-gpt",
    label: "官方 GPT / Codex",
    description: "清理非 OpenAI 参数，并补齐 GPT 请求需要的默认字段。",
    patchIds: ["official-gpt-fallback"]
  }
];

export const BUILTIN_PATCHES = [
  kimiToolSchemaPatch,
  deepseekReasoningPatch,
  glmContentTextPatch,
  opencodeToolHistoryPatch,
  opencodeGlmNoToolsPatch,
  officialGPTFallbackPatch
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

// Compat dispatcher. Each patch is provider/model targeted; no global schema downgrade.
// V0.4: ships 5 builtin patches under ./patches/. Call registerBuiltinPatches()
// from app entry points (server.mjs and CLI) to activate them.

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
  for (const [id, patch] of PATCHES.entries()) {
    try {
      if (patch.match({ provider, model, direction })) active.push({ id, patch });
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
import { officialGPTFallbackPatch } from "./patches/official-gpt-fallback.mjs";

export const BUILTIN_PATCHES = [
  kimiToolSchemaPatch,
  deepseekReasoningPatch,
  glmContentTextPatch,
  opencodeToolHistoryPatch,
  officialGPTFallbackPatch
];

export function registerBuiltinPatches() {
  for (const patch of BUILTIN_PATCHES) {
    registerPatch(patch.id, patch);
  }
}

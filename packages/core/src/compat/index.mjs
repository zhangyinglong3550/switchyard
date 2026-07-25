// Compat dispatcher. Each patch is provider/model targeted; no global schema downgrade.
// Call registerBuiltinPatches() from app entry points (server.mjs and CLI) to
// activate provider/model-targeted compatibility patches.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_COMPAT_PACKS, listCompatPacks } from "./packs.mjs";
import { normalizeCompatRegistry, recommendedCompatPackIds } from "./matcher.mjs";
import { providerPresetFor } from "../provider-presets.mjs";

export { listCompatPacks };

const PATCHES = new Map();
const BUILTIN_REGISTRY_PATH = fileURLToPath(new URL("./compat-registry.json", import.meta.url));
let cachedAutoRegistry = null;

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

function activePatchEntries({ provider, model, direction, clientId }) {
  const active = [];
  const manualPatchIds = patchIdsFromCompatPacks(provider, model);
  const autoPatchIds = patchIdsFromAutoRegistry({ provider, model, clientId });
  for (const [id, patch] of PATCHES.entries()) {
    try {
      const forced = manualPatchIds.has(id);
      const recommended = autoPatchIds.has(id);
      if (supportsDirection(patch, direction) && (forced || recommended || patch.match({ provider, model, direction, clientId }))) {
        active.push({ id, patch, source: forced ? "manual" : "auto" });
      }
    } catch {
      // A misbehaving patch must never break routing.
    }
  }
  return active;
}

export function activePatches({ provider, model, direction, clientId }) {
  return activePatchEntries({ provider, model, direction, clientId }).map(({ id, patch }) => ({ id, patch }));
}

export function activePatchDescriptors({ provider, model, direction, clientId = "" }) {
  return activePatchEntries({ provider, model, direction, clientId }).map(({ id, patch, source }) => ({
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
  cachedAutoRegistry = null;
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
import { aigoChatPatch } from "./patches/aigo-chat.mjs";
import { grokProtocolStrictPatch } from "./patches/grok-protocol-strict.mjs";

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
  reasoningStatePatch,
  grokProtocolStrictPatch
];

export function registerBuiltinPatches() {
  for (const patch of BUILTIN_PATCHES) {
    registerPatch(patch.id, patch);
  }
}

function normalizeCompatPackIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  return [];
}

function patchIdsFromAutoRegistry({ provider, model, clientId }) {
  const registry = loadAutoRegistry();
  // Presets are product-owned metadata, not user-selected configuration. This
  // keeps a newly added preset provider safe even before a narrower registry
  // rule is added for it. Explicit compatPacks below remain legacy-only.
  const preset = providerPresetFor(provider);
  const presetPackIds = !preset?.apiFormat || preset.apiFormat === provider?.apiFormat
    ? normalizeCompatPackIds(preset?.compatPacks)
    : [];
  const packIds = Array.from(new Set([
    ...recommendedCompatPackIds({ provider, model, clientId, registry }),
    ...presetPackIds
  ]));
  const out = new Set();
  for (const packId of packIds) {
    const pack = BUILTIN_COMPAT_PACKS.find((item) => item.id === packId);
    if (pack) {
      for (const patchId of pack.patchIds) out.add(patchId);
    } else {
      out.add(packId);
    }
  }
  return out;
}

function loadAutoRegistry() {
  if (cachedAutoRegistry) return cachedAutoRegistry;
  try {
    cachedAutoRegistry = normalizeCompatRegistry(JSON.parse(fs.readFileSync(BUILTIN_REGISTRY_PATH, "utf8")));
  } catch {
    cachedAutoRegistry = { version: 1, rules: [] };
  }
  return cachedAutoRegistry;
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

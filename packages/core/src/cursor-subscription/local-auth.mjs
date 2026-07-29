import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { cursorSubscriptionDisplayName } from "./model-catalog.mjs";

const CURSOR_TOKEN_SERVICE = "cursor-access-token";
const CURSOR_TOKEN_ACCOUNT = "cursor-user";

const CURSOR_REACTIVE_STORAGE_KEY = "src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser";

function cursorStateDbCandidates(home = os.homedir(), platform = process.platform) {
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
      path.join(home, "Library", "Application Support", "cursor", "User", "globalStorage", "state.vscdb")
    ];
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")];
  }
  return [path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")];
}

function readCursorReactiveStorageValue(file, { fsImpl = fs, sqliteFactory, sqliteRunner = execFileSync } = {}) {
  if (!fsImpl.existsSync(file)) return "";
  try {
    const BetterSqlite = sqliteFactory || createRequire(import.meta.url)("better-sqlite3");
    const db = new BetterSqlite(file, { readonly: true, fileMustExist: true });
    try {
      return String(db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(CURSOR_REACTIVE_STORAGE_KEY)?.value || "");
    } finally {
      db.close();
    }
  } catch {
    // During local development better-sqlite3 may be rebuilt for Electron
    // rather than the current Node process. macOS ships sqlite3, so use it as
    // a read-only fallback. Windows simply falls back to the preset catalog.
    if (process.platform === "win32") return "";
    try {
      return String(sqliteRunner(
        "sqlite3",
        [file, `SELECT value FROM ItemTable WHERE key = '${CURSOR_REACTIVE_STORAGE_KEY}';`],
        { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }
      ) || "").trim();
    } catch {
      return "";
    }
  }
}

function plainText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickerDisplayName(value, variant) {
  const plain = plainText(value);
  const parameterIds = new Set((variant?.parameterValues || []).map((item) => String(item?.id || "")));
  // Cursor's picker appends the currently selected `High` / `Fast` values to
  // the display string. They are parameter values, not part of model identity.
  if (!parameterIds.has("effort") && !parameterIds.has("thinking") && !parameterIds.has("fast")) {
    // Some current Cursor picker rows omit parameter metadata but still
    // suffix the selected mode in their label (for example “Kimi K3 Max”).
    return cursorSubscriptionDisplayName(plain);
  }
  return cursorSubscriptionDisplayName(plain);
}

function contextWindowFromTooltip(model) {
  const text = String(model?.tooltipData?.markdownContent || "");
  const match = text.match(/(\d+(?:\.\d+)?)\s*(k|m)\s+context window/i);
  if (!match) return undefined;
  const factor = match[2].toLowerCase() === "m" ? 1000000 : 1000;
  return Math.round(Number(match[1]) * factor);
}

function selectedVariant(model, selectedByModel) {
  const selected = selectedByModel.get(String(model?.serverModelName || ""));
  const parameterValues = Array.isArray(selected?.parameters) ? selected.parameters : [];
  const variants = Array.isArray(model?.variants) ? model.variants : [];
  const matches = (variant) => {
    const values = Array.isArray(variant?.parameterValues) ? variant.parameterValues : [];
    return values.length === parameterValues.length && values.every((value) =>
      parameterValues.some((selectedValue) => selectedValue?.id === value?.id && String(selectedValue?.value) === String(value?.value))
    );
  };
  return variants.find(matches) || variants.find((variant) => variant?.isDefaultNonMaxConfig) || variants[0] || null;
}

function selectedModelConfig(state, modelId) {
  const selectedByModel = new Map();
  for (const mode of Object.values(state?.aiSettings?.modelConfig || {})) {
    for (const selected of mode?.selectedModels || []) {
      if (selected?.modelId) selectedByModel.set(String(selected.modelId), {
        maxMode: mode?.maxMode === true,
        parameters: Array.isArray(selected.parameters) ? selected.parameters : []
      });
    }
  }
  return selectedByModel.get(String(modelId || "")) || null;
}

function requestedReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  if (!effort) return "";
  if (["none", "off", "false", "disabled"].includes(effort)) return "none";
  return effort;
}

function requestedSpeedTier(value) {
  const tier = String(value || "").trim().toLowerCase();
  if (!tier) return "";
  if (["priority", "fast", "turbo", "true"].includes(tier)) return "fast";
  if (["default", "standard", "normal", "slow", "false"].includes(tier)) return "standard";
  return "";
}

function supportedParameterValues(model, id) {
  const definition = (model?.parameterDefinitions || []).find((item) => item?.id === id);
  const type = definition?.parameterType || {};
  const candidates = [
    ...(type?.enumParameter?.values || []),
    ...(type?.booleanParameter?.values || [])
  ];
  return candidates.map((item) => String(item?.value || "")).filter(Boolean);
}

function closestSupportedEffort(value, supported) {
  if (!supported.length || supported.includes(value)) return value;
  const fallbacks = {
    minimal: ["low", "medium"],
    low: ["minimal", "medium"],
    medium: ["high", "low"],
    high: ["xhigh", "max", "medium"],
    xhigh: ["max", "high"],
    max: ["xhigh", "high"]
  };
  return (fallbacks[value] || []).find((candidate) => supported.includes(candidate)) || supported[0];
}

function applyRequestedReasoning(model, parameters, reasoningEffort) {
  const effort = requestedReasoningEffort(reasoningEffort);
  if (!effort) return parameters;
  const next = parameters.map((parameter) => ({ ...parameter }));
  const upsert = (id, value) => {
    const existing = next.find((parameter) => parameter.id === id);
    if (existing) existing.value = value;
    else next.push({ id, value });
  };
  const parameterIds = new Set((model?.parameterDefinitions || []).map((definition) => String(definition?.id || "")));
  if (parameterIds.has("thinking")) upsert("thinking", effort === "none" ? "false" : "true");
  for (const id of ["effort", "reasoning"]) {
    if (!parameterIds.has(id) || effort === "none") continue;
    upsert(id, closestSupportedEffort(effort, supportedParameterValues(model, id)));
  }
  return next;
}

function applyRequestedSpeed(model, parameters, speedTier) {
  const requested = requestedSpeedTier(speedTier);
  if (!requested) return parameters;
  const next = parameters.map((parameter) => ({ ...parameter }));
  const hasExistingFast = next.some((parameter) => parameter.id === "fast");
  const parameterIds = new Set((model?.parameterDefinitions || []).map((definition) => String(definition?.id || "")));
  if (!hasExistingFast && !parameterIds.has("fast")) return next;
  const supported = supportedParameterValues(model, "fast");
  const candidates = requested === "fast"
    ? ["true", "fast", "priority"]
    : ["false", "standard", "normal"];
  const value = candidates.find((candidate) => !supported.length || supported.includes(candidate)) || supported[0] || (requested === "fast" ? "true" : "false");
  const existing = next.find((parameter) => parameter.id === "fast");
  if (existing) existing.value = value;
  else next.push({ id: "fast", value });
  return next;
}

/**
 * Builds the same parameterized RequestedModel shape Cursor Desktop submits
 * for a model selected in its Composer picker. This is deliberately read-only:
 * it never changes the user's Cursor model choice or touches credentials.
 */
export function cursorRequestedModelFromApplicationStorage(value, modelId, { reasoningEffort = "", speedTier = "" } = {}) {
  let state;
  try { state = typeof value === "string" ? JSON.parse(value) : value; } catch { return null; }
  const requested = String(modelId || "").trim();
  if (!requested || requested === "auto" || requested === "default") return {
    modelId: "default",
    maxMode: false,
    parameters: [],
    builtInModel: true,
    isVariantStringRepresentation: false
  };
  const model = (state?.availableDefaultModels2 || []).find((item) => String(item?.serverModelName || "") === requested);
  if (!model || model?.supportsAgent === false || Number(model?.degradationStatus || 0) !== 0) return null;
  const selected = selectedModelConfig(state, requested);
  const variant = selectedVariant(model, new Map(selected ? [[requested, selected]] : []));
  const parameters = selected?.parameters?.length
    ? selected.parameters
    : (Array.isArray(variant?.parameterValues) ? variant.parameterValues : []);
  return {
    modelId: requested,
    maxMode: selected?.maxMode === true || variant?.isMaxMode === true,
    parameters: applyRequestedSpeed(model, applyRequestedReasoning(model, parameters
      .filter((parameter) => parameter?.id && parameter?.value !== undefined)
      .map((parameter) => ({ id: String(parameter.id), value: String(parameter.value) })), reasoningEffort), speedTier),
    builtInModel: true,
    isVariantStringRepresentation: false
  };
}

/**
 * Converts Cursor's locally cached model-picker state into Switchyard model
 * entries. This is read-only and contains no credentials. `defaultOn` mirrors
 * Cursor's named picker; previously used models are also retained so models
 * explicitly added through Cursor's “Add Models” remain visible.
 */
export function cursorModelCatalogFromApplicationStorage(value) {
  let state;
  try { state = typeof value === "string" ? JSON.parse(value) : value; } catch { return []; }
  const available = Array.isArray(state?.availableDefaultModels2) ? state.availableDefaultModels2 : [];
  const recent = state?.aiSettings?.modelLastUsedAt && typeof state.aiSettings.modelLastUsedAt === "object"
    ? Object.keys(state.aiSettings.modelLastUsedAt)
    : [];
  const active = new Set([...available.filter((model) => model?.defaultOn === true).map((model) => model.serverModelName), ...recent]);
  const selectedByModel = new Map();
  for (const mode of Object.values(state?.aiSettings?.modelConfig || {})) {
    for (const selected of mode?.selectedModels || []) {
      if (selected?.modelId) selectedByModel.set(String(selected.modelId), selected);
    }
  }
  const seen = new Set();
  const models = [];
  for (const model of available) {
    const upstreamModel = String(model?.serverModelName || "").trim();
    if (!upstreamModel || seen.has(upstreamModel) || !active.has(upstreamModel) || model?.supportsAgent === false || Number(model?.degradationStatus || 0) !== 0) continue;
    seen.add(upstreamModel);
    const variant = selectedVariant(model, selectedByModel);
    const displayName = pickerDisplayName(variant?.displayNameOutsidePicker || variant?.displayName || model?.inputboxShortModelName || model?.clientDisplayName || upstreamModel, variant);
    models.push({
      id: upstreamModel === "default" ? "auto" : upstreamModel,
      displayName: displayName || (upstreamModel === "default" ? "Auto" : upstreamModel),
      contextWindow: contextWindowFromTooltip(model),
      capabilities: {
        text: true,
        tools: true,
        reasoning: model?.supportsThinking === true,
        images: model?.supportsImages === true,
        stream: true,
        multimodal: model?.supportsImages === true
      }
    });
  }
  return models;
}

export function readLocalCursorModelCatalog({ home = os.homedir(), platform = process.platform, fsImpl = fs, sqliteFactory, sqliteRunner } = {}) {
  for (const file of cursorStateDbCandidates(home, platform)) {
    const value = readCursorReactiveStorageValue(file, { fsImpl, sqliteFactory, sqliteRunner });
    const models = cursorModelCatalogFromApplicationStorage(value);
    if (models.length) return { ok: true, models, source: "cursor-local-model-picker" };
  }
  return { ok: false, reason: "local_cursor_model_catalog_not_found", models: [] };
}

export function readLocalCursorRequestedModel(modelId, { home = os.homedir(), platform = process.platform, fsImpl = fs, sqliteFactory, sqliteRunner, reasoningEffort = "", speedTier = "" } = {}) {
  for (const file of cursorStateDbCandidates(home, platform)) {
    const value = readCursorReactiveStorageValue(file, { fsImpl, sqliteFactory, sqliteRunner });
    const requestedModel = cursorRequestedModelFromApplicationStorage(value, modelId, { reasoningEffort, speedTier });
    if (requestedModel) return { ok: true, requestedModel, source: "cursor-local-model-picker" };
  }
  return { ok: false, reason: "local_cursor_model_selection_not_found" };
}

const CURSOR_PRODUCT_PATHS = [
  "/Applications/Cursor.app/Contents/Resources/app/product.json",
  path.join(os.homedir(), "Applications", "Cursor.app", "Contents", "Resources", "app", "product.json")
];

function readJson(file, fsImpl = fs) {
  try { return JSON.parse(fsImpl.readFileSync(file, "utf8")); } catch { return null; }
}

function cursorStorageCandidates(home = os.homedir(), platform = process.platform) {
  if (platform === "darwin") {
    return [
      path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "storage.json"),
      path.join(home, "Library", "Application Support", "cursor", "User", "globalStorage", "storage.json")
    ];
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return [path.join(appData, "Cursor", "User", "globalStorage", "storage.json")];
  }
  return [path.join(home, ".config", "Cursor", "User", "globalStorage", "storage.json")];
}

export function cursorMachineIdFromStorage(value = {}) {
  const candidates = [
    value?.["storage.serviceMachineId"],
    value?.storage?.serviceMachineId,
    value?.["telemetry.machineId"],
    value?.telemetry?.machineId
  ];
  return String(candidates.find((item) => typeof item === "string" && item.trim()) || "").trim();
}

export function readCursorMachineId({ home = os.homedir(), platform = process.platform, fsImpl = fs } = {}) {
  for (const file of cursorStorageCandidates(home, platform)) {
    const machineId = cursorMachineIdFromStorage(readJson(file, fsImpl));
    if (machineId) return { ok: true, machineId, source: "cursor-local-storage" };
  }
  return { ok: false, reason: "machine_id_not_found" };
}

export function readCursorAccessToken({ platform = process.platform, runner = execFileSync } = {}) {
  if (platform !== "darwin") return { ok: false, reason: "unsupported_platform" };
  try {
    const token = String(runner(
      "security",
      ["find-generic-password", "-a", CURSOR_TOKEN_ACCOUNT, "-s", CURSOR_TOKEN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }
    ) || "").trim();
    return token ? { ok: true, accessToken: token, source: "cursor-keychain" } : { ok: false, reason: "access_token_not_found" };
  } catch {
    return { ok: false, reason: "access_token_not_found" };
  }
}

export function readLocalCursorDesktopVersion({ platform = process.platform, fsImpl = fs, productPaths = CURSOR_PRODUCT_PATHS } = {}) {
  if (platform !== "darwin") return "";
  for (const productPath of productPaths) {
    const version = String(readJson(productPath, fsImpl)?.version || "").trim();
    if (version) return version;
  }
  return "";
}

/**
 * Reads an already logged-in Cursor desktop session locally. Credentials are
 * returned only to Electron main so callers can immediately place them in the
 * Switchyard Keychain entry; do not send this result to a renderer or logger.
 */
export function readLocalCursorSubscriptionCredentials(options = {}) {
  const token = readCursorAccessToken(options);
  if (!token.ok) return { ok: false, reason: token.reason };
  const machine = readCursorMachineId(options);
  if (!machine.ok) return { ok: false, reason: machine.reason };
  return { ok: true, accessToken: token.accessToken, machineId: machine.machineId };
}

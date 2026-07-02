// Writes/restores client profiles (Codex / Claude Code / Hermes).
// V0.3: real read/write with timestamped backups under ~/.switchyard/backups,
// plus restore from latest backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupDir, ensureDir, nowIso, DEFAULT_HOME } from "./utils.mjs";
import { claudeCodeDiscoveryModelId } from "./config.mjs";

export function codexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function claudeCodeConfigPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function claudeCodeGatewayModelsCachePath() {
  return path.join(os.homedir(), ".claude", "cache", "gateway-models.json");
}

export function hermesConfigPath() {
  return path.join(os.homedir(), ".hermes", "config.json");
}

export function hermesYamlConfigPath() {
  return path.join(os.homedir(), ".hermes", "config.yaml");
}

export function codexModelCatalogPath() {
  return process.env.SWITCHYARD_CODEX_MODEL_CATALOG || path.join(DEFAULT_HOME, "codex-model-catalog.json");
}

export function codexModelsCachePath() {
  return path.join(os.homedir(), ".codex", "models_cache.json");
}

export function ccSwitchCodexModelCatalogPath() {
  return process.env.SWITCHYARD_CCSWITCH_CODEX_MODEL_CATALOG || path.join(os.homedir(), ".codex", "cc-switch-model-catalog.json");
}

export function ccSwitchGatewayProfilePath() {
  return process.env.SWITCHYARD_CCSWITCH_GATEWAY_PROFILE || path.join(os.homedir(), ".codex", "ccswitch-gateway.config.toml");
}

export function profileTargets() {
  return {
    codex: codexConfigPath(),
    "claude-code": claudeCodeConfigPath(),
    hermes: hermesYamlConfigPath()
  };
}

const CODEX_PROVIDER = "custom";
const SWITCHYARD_ENV_KEY = "SWITCHYARD_KEY";
const MARKER = "managed-by-switchyard";

export const CODEX_ACCESS_MODES = Object.freeze({
  SWITCHYARD_PROXY: "switchyard_proxy",
  OFFICIAL_DIRECT: "official_direct"
});

const CODEX_MODEL_TEMPLATE = {
  slug: "switchyard/default",
  display_name: "Switchyard Default",
  description: "Routed by Switchyard.",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth" },
    { effort: "high", description: "Greater reasoning depth" },
    { effort: "xhigh", description: "Extra high reasoning depth" }
  ],
  additional_speed_tiers: [],
  service_tiers: [],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 100,
  base_instructions: "You are Codex, a coding agent. You help the user complete software engineering tasks in their local workspace.",
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: true,
  context_window: 128000,
  max_context_window: 128000,
  effective_context_window_percent: 95,
  experimental_supported_tools: []
};

// ---------- Codex (TOML) ----------

function stripSwitchyardCodexBlock(text, { replaceModel = false } = {}) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let seenTable = false;
  let afterManagedMarker = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const providerMatch = /^\[model_providers\.(switchyard|custom)\]/.exec(trimmed);
    if (providerMatch) {
      const block = [line];
      let next = index + 1;
      while (next < lines.length && !/^\[[^\]]+\]/.test(lines[next].trim())) {
        block.push(lines[next]);
        next += 1;
      }
      seenTable = true;
      afterManagedMarker = false;
      index = next - 1;
      continue;
    }
    if (/^\[[^\]]+\]/.test(trimmed)) {
      seenTable = true;
      afterManagedMarker = false;
      out.push(line);
      continue;
    }
    const isManagedMarker =
      /^#\s*managed-by:\s*switchyard/.test(trimmed) ||
      /^#\s*managed-by:\s*managed-by-switchyard/.test(trimmed);
    if (isManagedMarker) {
      afterManagedMarker = true;
      continue;
    }
    const isTopLevel = !seenTable;
    const isManagedProvider = /^model_provider\s*=\s*["']?(switchyard|custom)["']?\s*(?:#.*)?$/.test(trimmed);
    if (/^model_provider\s*=/.test(trimmed) && (isTopLevel || afterManagedMarker || isManagedProvider)) continue;
    if (/^model_catalog_json\s*=/.test(trimmed) && (isTopLevel || afterManagedMarker)) continue;
    if (/^openai_base_url\s*=/.test(trimmed) && (isTopLevel || afterManagedMarker)) continue;
    if (/^model_reasoning_effort\s*=/.test(trimmed) && (isTopLevel || afterManagedMarker)) continue;
    if (/^model\s*=/.test(trimmed) && (replaceModel || afterManagedMarker) && isTopLevel) continue;
    if (/^model\s*=/.test(trimmed) && afterManagedMarker) continue;
    if (trimmed !== "") afterManagedMarker = false;
    out.push(line);
  }
  // Collapse trailing blank lines
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

function stripSwitchyardManagedCodexBlock(text, { replaceModel = false } = {}) {
  if (!text) return "";
  const customBlock = tomlSectionText(text, "model_providers.custom");
  const hasSwitchyardMarker = /managed-by-switchyard|switchyard-managed/i.test(text);
  const customIsSwitchyard =
    /\bname\s*=\s*["']Switchyard["']/i.test(customBlock) ||
    /\bbase_url\s*=\s*["'][^"']*\/codex\/v1\/?["']/i.test(customBlock);
  const lines = text.split(/\r?\n/);
  const out = [];
  let seenTable = false;
  let afterManagedMarker = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const providerMatch = /^\[model_providers\.(switchyard|custom)\]/.exec(trimmed);
    if (providerMatch) {
      const block = [line];
      let next = index + 1;
      while (next < lines.length && !/^\[[^\]]+\]/.test(lines[next].trim())) {
        block.push(lines[next]);
        next += 1;
      }
      const blockText = block.join("\n");
      const isSwitchyardBlock =
        providerMatch[1] === "switchyard" ||
        /\bname\s*=\s*["']Switchyard["']/i.test(blockText) ||
        /\bbase_url\s*=\s*["'][^"']*\/codex\/v1\/?["']/i.test(blockText);
      seenTable = true;
      afterManagedMarker = false;
      if (!isSwitchyardBlock) out.push(...block);
      index = next - 1;
      continue;
    }
    if (/^\[[^\]]+\]/.test(trimmed)) {
      seenTable = true;
      afterManagedMarker = false;
      out.push(line);
      continue;
    }
    const isManagedMarker =
      /^#\s*managed-by:\s*switchyard/.test(trimmed) ||
      /^#\s*managed-by:\s*managed-by-switchyard/.test(trimmed);
    if (isManagedMarker) {
      afterManagedMarker = true;
      continue;
    }
    const isTopLevel = !seenTable;
    const isManagedProvider = /^model_provider\s*=\s*["']?switchyard["']?\s*(?:#.*)?$/.test(trimmed) ||
      (/^model_provider\s*=\s*["']?custom["']?\s*(?:#.*)?$/.test(trimmed) && (customIsSwitchyard || hasSwitchyardMarker || afterManagedMarker));
    const shouldStripManagedTopLevel = isTopLevel && (customIsSwitchyard || hasSwitchyardMarker || afterManagedMarker);
    if (/^model_provider\s*=/.test(trimmed) && (afterManagedMarker || isManagedProvider)) continue;
    if (/^model_catalog_json\s*=/.test(trimmed) && (shouldStripManagedTopLevel || afterManagedMarker)) continue;
    if (/^openai_base_url\s*=/.test(trimmed) && (shouldStripManagedTopLevel || afterManagedMarker)) continue;
    if (/^model_reasoning_effort\s*=/.test(trimmed) && (shouldStripManagedTopLevel || afterManagedMarker)) continue;
    if (/^model\s*=/.test(trimmed) && replaceModel && shouldStripManagedTopLevel) continue;
    if (/^model\s*=/.test(trimmed) && afterManagedMarker) continue;
    if (trimmed !== "") afterManagedMarker = false;
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

export function renderCodexProfile({ host, port, defaultModel } = {}) {
  return `${renderCodexTopLevel({ host, port, defaultModel })}\n${renderCodexProviderBlock({ host, port })}`;
}

export function renderCcSwitchGatewayProfile({ host, port, defaultModel } = {}) {
  const catalogPath = ccSwitchCodexModelCatalogPath();
  const base = `http://${host || "127.0.0.1"}:${port || 17888}`;
  const lines = [
    "# >>> switchyard-managed ccswitch-gateway >>>",
    `model_provider = "${CODEX_PROVIDER}"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    `openai_base_url = ${tomlString(`${base}/v1`)}`,
    `model_reasoning_effort = "low"`
  ];
  if (defaultModel) lines.push(`model = ${tomlString(defaultModel)}`);
  lines.push(
    "",
    `[model_providers.${CODEX_PROVIDER}]`,
    `name = "Switchyard"`,
    `base_url = "${base}/codex/v1"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `supports_websockets = false`,
    `experimental_bearer_token = "dummy"`,
    `request_max_retries = 5`,
    `stream_max_retries = 5`,
    `stream_idle_timeout_ms = 600000`,
    "# <<< switchyard-managed ccswitch-gateway <<<"
  );
  return lines.join("\n") + "\n";
}

function renderCodexTopLevel({ host, port, defaultModel } = {}) {
  const catalogPath = codexModelCatalogPath();
  const base = `http://${host || "127.0.0.1"}:${port || 17888}/v1`;
  const lines = [
    `# managed-by: ${MARKER}`,
    `model_provider = "${CODEX_PROVIDER}"`,
    `model_catalog_json = ${tomlString(catalogPath)}`,
    `openai_base_url = ${tomlString(base)}`,
    `model_reasoning_effort = "low"`
  ];
  if (defaultModel) lines.push(`model = ${tomlString(defaultModel)}`);
  return lines.join("\n") + "\n";
}

function renderCodexProviderBlock({ host, port } = {}) {
  const base = `http://${host || "127.0.0.1"}:${port || 17888}/codex/v1`;
  const lines = [
    `[model_providers.${CODEX_PROVIDER}]`,
    `name = "Switchyard"`,
    `base_url = "${base}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = true`,
    `supports_websockets = false`,
    `experimental_bearer_token = "dummy"`,
    `request_max_retries = 5`,
    `stream_max_retries = 5`,
    `stream_idle_timeout_ms = 600000`
  ];
  return lines.join("\n") + "\n";
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function codexCatalogDisplayName(model, slug) {
  const base = String(model?.displayName || model?.upstreamModel || slug || "").trim() || slug;
  const provider = String(model?.providerName || model?.providerId || "").trim();
  if (!provider) return base;
  const escapedProvider = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:·|\\(|\\[)\\s*${escapedProvider}\\s*(?:\\)|\\])?$`, "i").test(base)) return base;
  return `${base} · ${provider}`;
}

const CODEX_PRIORITY_SERVICE_TIER = {
  id: "priority",
  name: "Fast",
  description: "1.5x speed, increased usage"
};

function isOfficialCodexModel({ providerId, upstreamModel }) {
  if (!/^(codex|official-gpt)$/i.test(String(providerId || ""))) return false;
  return /^gpt-5(?:$|[._-])/.test(String(upstreamModel || "").toLowerCase());
}

function supportsCodexPriorityTier({ providerId, upstreamModel }) {
  if (!/^(codex|openai|official-gpt)$/i.test(String(providerId || ""))) return false;
  const model = String(upstreamModel || "").toLowerCase();
  if (!/^gpt-5(?:$|[._-])/.test(model)) return false;
  return !/(mini|spark|auto-review)/.test(model);
}

function codexCatalogSlugForModel(model) {
  const id = String(model?.id || model?.upstreamModel || "").trim();
  const upstreamModel = String(model?.upstreamModel || id).trim();
  const providerId = String(model?.providerId || "").trim();
  if (isOfficialCodexModel({ providerId, upstreamModel })) return upstreamModel;
  return id;
}

function modelMatchesId(model, id) {
  const value = String(id || "").trim();
  if (!value) return false;
  return model?.id === value || model?.upstreamModel === value || (model?.aliases || []).includes(value);
}

function codexDefaultModelForCatalog({ models = [], defaultModel } = {}) {
  const value = String(defaultModel || "").trim();
  if (!value) return null;
  const match = (Array.isArray(models) ? models : []).find((model) => modelMatchesId(model, value));
  return match ? codexCatalogSlugForModel(match) : value;
}

function codexCatalogModelFrom(model, index = 0) {
  const slug = codexCatalogSlugForModel(model);
  if (!slug) return null;
  const contextWindow = Number.isFinite(model?.contextWindow) ? model.contextWindow : CODEX_MODEL_TEMPLATE.context_window;
  const hasVisionFallback = Boolean(model?.visionFallbackModelId);
  const supportsImages = Boolean(model?.capabilities?.images || model?.capabilities?.multimodal || hasVisionFallback);
  const providerId = String(model?.providerId || "").trim();
  const upstreamModel = String(model?.upstreamModel || slug).trim();
  const isOfficialGpt = /^(codex|openai|official-gpt)$/i.test(providerId) || /\bgpt[-_\w.]*/i.test(upstreamModel);
  const supportsPriority = supportsCodexPriorityTier({ providerId, upstreamModel });
  return {
    ...CODEX_MODEL_TEMPLATE,
    slug,
    display_name: codexCatalogDisplayName(model, slug),
    description: `${model?.providerName || model?.providerId || "Switchyard"} via Switchyard.`,
    default_reasoning_level: isOfficialGpt ? "low" : CODEX_MODEL_TEMPLATE.default_reasoning_level,
    additional_speed_tiers: supportsPriority ? ["fast"] : [],
    service_tiers: supportsPriority ? [{ ...CODEX_PRIORITY_SERVICE_TIER }] : [],
    priority: 100 + index,
    input_modalities: supportsImages ? ["text", "image"] : ["text"],
    context_window: contextWindow,
    max_context_window: contextWindow,
    "x-switchyard-model-id": String(model?.id || "").trim(),
    "x-switchyard-provider": providerId,
    "x-switchyard-upstream-model": upstreamModel,
    "x-switchyard-vision-fallback-model": model?.visionFallbackModelId || ""
  };
}

export function buildCodexModelCatalog({ models = [], defaultModel } = {}) {
  const out = [];
  const seen = new Set();
  const source = Array.isArray(models) ? models : [];
  for (const model of source) {
    if (!model || model.enabled === false) continue;
    const item = codexCatalogModelFrom(model, out.length);
    if (!item || seen.has(item.slug)) continue;
    seen.add(item.slug);
    out.push(item);
  }
  if (!out.length && defaultModel) {
    const item = codexCatalogModelFrom({ id: defaultModel, displayName: defaultModel }, 0);
    if (item) out.push(item);
  }
  return {
    generated_at: nowIso(),
    source: "switchyard",
    models: out
  };
}

export function writeCodexModelCatalog({ catalog, models, defaultModel } = {}, outPath = codexModelCatalogPath()) {
  const nextCatalog = catalog || buildCodexModelCatalog({ models, defaultModel });
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(nextCatalog, null, 2) + "\n", "utf8");
  return { path: outPath, catalog: nextCatalog };
}

function codexCacheClientVersion(cachePath = codexModelsCachePath()) {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (cached?.client_version) return String(cached.client_version);
  } catch {}
  try {
    const version = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".codex", "version.json"), "utf8"));
    if (version?.latest_version) return String(version.latest_version);
  } catch {}
  return "switchyard";
}

export function buildCodexModelsCache({ catalog, models, defaultModel, clientVersion } = {}) {
  const source = catalog || buildCodexModelCatalog({ models, defaultModel });
  return {
    fetched_at: nowIso(),
    etag: `W/"switchyard-${source.models.length}"`,
    client_version: clientVersion || codexCacheClientVersion(),
    models: source.models
  };
}

export function writeCodexModelsCache({ catalog, models, defaultModel, clientVersion } = {}, outPath = codexModelsCachePath()) {
  const cache = buildCodexModelsCache({ catalog, models, defaultModel, clientVersion });
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(cache, null, 2) + "\n", "utf8");
  return { path: outPath, cache };
}

function tomlStringValue(raw) {
  const value = String(raw || "").trim().replace(/\s+#.*$/, "");
  if (!value) return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    try { return JSON.parse(value); } catch {}
    return value.slice(1, -1);
  }
  return value;
}

function topLevelTomlValue(text, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]/.test(trimmed)) return "";
    const match = pattern.exec(line);
    if (match) return tomlStringValue(match[1]);
  }
  return "";
}

function tomlSectionText(text, sectionName) {
  const lines = String(text || "").split(/\r?\n/);
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return "";
  const out = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\[[^\]]+\]/.test(lines[index].trim())) break;
    out.push(lines[index]);
  }
  return out.join("\n");
}

function expandHome(filePath) {
  const text = String(filePath || "").trim();
  if (!text) return "";
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function jsonText(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function writeJsonIfChanged(filePath, value) {
  const next = jsonText(value);
  try {
    if (fs.readFileSync(filePath, "utf8") === next) return false;
  } catch {}
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

function catalogSlugs(catalog) {
  return Array.isArray(catalog?.models) ? catalog.models.map((model) => String(model?.slug || "")) : [];
}

function cacheMatchesCatalog(cache, catalog) {
  const cached = catalogSlugs(cache);
  const expected = catalogSlugs(catalog);
  if (!expected.length || cached.length !== expected.length) return false;
  return expected.every((slug, index) => slug && slug === cached[index]);
}

export function inspectCodexSwitchyardProfile(configPath = codexConfigPath()) {
  let text = "";
  try { text = fs.readFileSync(configPath, "utf8"); } catch {
    return { active: false, reason: "missing-config", configPath };
  }
  const provider = topLevelTomlValue(text, "model_provider");
  const catalogPath = expandHome(topLevelTomlValue(text, "model_catalog_json") || codexModelCatalogPath());
  const customBlock = tomlSectionText(text, "model_providers.custom");
  const hasSwitchyardMarker = /managed-by-switchyard|switchyard-managed/i.test(text);
  const customIsSwitchyard =
    /\bname\s*=\s*["']Switchyard["']/i.test(customBlock) ||
    /\bbase_url\s*=\s*["'][^"']*\/codex\/v1\/?["']/i.test(customBlock);
  const active = provider === CODEX_PROVIDER && (customIsSwitchyard || hasSwitchyardMarker);
  return {
    active,
    reason: active ? "managed-switchyard-custom" : "not-switchyard-custom",
    configPath,
    provider,
    catalogPath,
    customIsSwitchyard,
    hasSwitchyardMarker
  };
}

export function syncCodexModelArtifacts({ models = [], defaultModel, force = false } = {}) {
  const profile = inspectCodexSwitchyardProfile();
  if (!force && !profile.active) {
    return { ok: false, skipped: true, reason: profile.reason, profile };
  }
  const catalog = buildCodexModelCatalog({ models, defaultModel });
  if (!catalog.models.length) {
    return { ok: false, skipped: true, reason: "no-models", profile, modelCount: 0 };
  }

  const catalogTargets = new Set([
    codexModelCatalogPath(),
    ccSwitchCodexModelCatalogPath()
  ]);
  if (profile.catalogPath) catalogTargets.add(profile.catalogPath);

  const catalogResults = [];
  for (const target of catalogTargets) {
    const changed = writeJsonIfChanged(target, catalog);
    catalogResults.push({ path: target, changed });
  }

  const cachePath = codexModelsCachePath();
  const currentCache = readJsonFile(cachePath);
  const cache = buildCodexModelsCache({ catalog });
  const cacheNeedsRewrite =
    !cacheMatchesCatalog(currentCache, catalog) ||
    JSON.stringify(currentCache?.models || []) !== JSON.stringify(catalog.models);
  const cacheChanged = cacheNeedsRewrite ? writeJsonIfChanged(cachePath, cache) : false;

  return {
    ok: true,
    profile,
    modelCount: catalog.models.length,
    catalogPaths: catalogResults.map((item) => item.path),
    catalogChanged: catalogResults.some((item) => item.changed),
    cachePath,
    cacheChanged,
    cache
  };
}

export function mergeCodexProfile(existing, { host, port, defaultModel } = {}) {
  const stripped = stripSwitchyardCodexBlock(existing || "", { replaceModel: Boolean(defaultModel) });
  const topLevel = renderCodexTopLevel({ host, port, defaultModel }).trimEnd();
  const providerBlock = renderCodexProviderBlock({ host, port }).trimEnd();
  if (!stripped) return `${topLevel}\n\n${providerBlock}\n`;
  return `${topLevel}\n\n${stripped.replace(/\s+$/, "")}\n\n${providerBlock}\n`;
}

export function mergeCodexOfficialDirectProfile(existing) {
  const stripped = stripSwitchyardManagedCodexBlock(existing || "", { replaceModel: true });
  return stripped.replace(/\s+$/, "") + "\n";
}

// ---------- Claude Code (JSON) ----------

const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL_NAME"
];

function modelLabel(model) {
  return model?.displayName || model?.upstreamModel || model?.id || "";
}

function modelSearchText(model) {
  return [model?.id, model?.providerId, model?.upstreamModel, model?.displayName]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function distinctModels(models = []) {
  const out = [];
  const seen = new Set();
  for (const model of models || []) {
    if (!model || model.enabled === false || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

function pickModel(models, predicate, excluded = new Set()) {
  return models.find((model) => !excluded.has(model.id) && predicate(model));
}

function claudeCodeModelId(model) {
  return claudeCodeDiscoveryModelId(model) || model?.id || "";
}

function findMappedClaudeCodeModel(models, modelMapping, slot) {
  const id = String(modelMapping?.[slot] || "").trim();
  if (!id) return null;
  return models.find((model) => {
    if (model.id === id || model.upstreamModel === id || claudeCodeModelId(model) === id) return true;
    return (model.aliases || []).includes(id);
  }) || null;
}

function claudeCodeGatewayModelFrom(model) {
  const id = claudeCodeModelId(model);
  if (!id) return null;
  return {
    id,
    display_name: codexCatalogDisplayName(model, id)
  };
}

export function buildClaudeCodeGatewayModelsCache({ host, port, models = [], fetchedAt } = {}) {
  const out = [];
  const seen = new Set();
  for (const model of distinctModels(models)) {
    const item = claudeCodeGatewayModelFrom(model);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return {
    baseUrl: `http://${host || "127.0.0.1"}:${port || 17888}/claude-code`,
    fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),
    models: out
  };
}

export function writeClaudeCodeGatewayModelsCache({ host, port, models, fetchedAt } = {}, outPath = claudeCodeGatewayModelsCachePath()) {
  const cache = buildClaudeCodeGatewayModelsCache({ host, port, models, fetchedAt });
  if (!cache.models.length) return { path: outPath, skipped: true, modelCount: 0 };
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, JSON.stringify(cache, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(outPath, 0o600); } catch {}
  return { path: outPath, modelCount: cache.models.length };
}

export function syncClaudeCodeModelArtifacts({ host, port, models = [] } = {}) {
  const cache = buildClaudeCodeGatewayModelsCache({ host, port, models });
  const cachePath = claudeCodeGatewayModelsCachePath();
  if (!cache.models.length) return { ok: false, skipped: true, reason: "no-models", cachePath, modelCount: 0 };
  const cacheChanged = writeJsonIfChanged(cachePath, cache);
  try { fs.chmodSync(cachePath, 0o600); } catch {}
  return { ok: true, cachePath, cacheChanged, modelCount: cache.models.length, cache };
}

export function syncClientModelArtifacts({
  host,
  port,
  codexModels = [],
  codexDefaultModel,
  claudeCodeModels = [],
  forceCodex = false
} = {}) {
  return {
    codex: syncCodexModelArtifacts({
      models: codexModels,
      defaultModel: codexDefaultModel,
      force: forceCodex
    }),
    claudeCode: syncClaudeCodeModelArtifacts({
      host,
      port,
      models: claudeCodeModels
    })
  };
}

export function claudeCodeModelEnv({ models = [], defaultModel, modelMapping } = {}) {
  const all = distinctModels(models);
  if (!all.length) return {};
  const nonCodex = all.filter((model) => !/\bcodex\b/i.test(String(model.providerId || "")));
  const pool = nonCodex.length ? nonCodex : all;
  const isFast = (model) => /\b(haiku|mini|flash|lite|small|air|fast)\b/i.test(modelSearchText(model));
  const explicitDefault = findMappedClaudeCodeModel(all, { default: defaultModel }, "default");
  const usableExplicitDefault = explicitDefault && (!/\bcodex\b/i.test(String(explicitDefault.providerId || "")) || !nonCodex.length)
    ? explicitDefault
    : null;
  const defaultCandidate = usableExplicitDefault && !isFast(usableExplicitDefault) ? usableExplicitDefault : null;
  const isStrong = (model) => {
    const text = modelSearchText(model);
    if (/\b(haiku|mini|flash|lite|small|air|fast)\b/i.test(text)) return false;
    return /\b(opus|pro|max|ultra|glm|kimi|sonnet|coder|code)\b|gpt-5\.[45]/i.test(text);
  };
  const mapped = {
    default: findMappedClaudeCodeModel(all, modelMapping, "default"),
    haiku: findMappedClaudeCodeModel(all, modelMapping, "haiku"),
    sonnet: findMappedClaudeCodeModel(all, modelMapping, "sonnet"),
    opus: findMappedClaudeCodeModel(all, modelMapping, "opus"),
    fable: findMappedClaudeCodeModel(all, modelMapping, "fable")
  };
  const haiku = mapped.haiku || pickModel(pool, isFast) || pool[0];
  const sonnet = mapped.sonnet || defaultCandidate || pickModel(pool, (model) => !isFast(model), new Set([haiku?.id])) || pool[0];
  const opus = mapped.opus || pickModel(pool, isStrong, new Set([haiku?.id, sonnet?.id])) || sonnet;
  const fable = mapped.fable || pickModel(pool, isStrong, new Set([haiku?.id, sonnet?.id, opus?.id])) || opus || sonnet;
  const defaultSlot = usableExplicitDefault || mapped.default || sonnet;
  const slot = (name, model) => ({
    [`ANTHROPIC_DEFAULT_${name}_MODEL`]: claudeCodeModelId(model),
    [`ANTHROPIC_DEFAULT_${name}_MODEL_NAME`]: modelLabel(model)
  });
  return {
    ANTHROPIC_MODEL: claudeCodeModelId(defaultSlot),
    ...slot("HAIKU", haiku),
    ...slot("SONNET", sonnet),
    ...slot("OPUS", opus),
    ...slot("FABLE", fable)
  };
}

export function renderClaudeCodeProfile({ host, port, models, defaultModel, modelMapping } = {}) {
  return {
    [MARKER]: true,
    env: {
      ANTHROPIC_BASE_URL: `http://${host || "127.0.0.1"}:${port || 17888}/claude-code`,
      ANTHROPIC_AUTH_TOKEN: `\${${SWITCHYARD_ENV_KEY}}`,
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      ...claudeCodeModelEnv({ models, defaultModel, modelMapping })
    }
  };
}

export function mergeClaudeCodeProfile(existing, { host, port, models, defaultModel, modelMapping } = {}) {
  const next = existing && typeof existing === "object" ? { ...existing } : {};
  const patch = renderClaudeCodeProfile({ host, port, models, defaultModel, modelMapping });
  next[MARKER] = true;
  next.env = { ...(next.env || {}) };
  if (models?.length) {
    for (const key of CLAUDE_MODEL_ENV_KEYS) delete next.env[key];
  }
  next.env = { ...next.env, ...patch.env };
  return next;
}

// ---------- Hermes (JSON) ----------

export function renderHermesProfile({ host, port } = {}) {
  return {
    [MARKER]: true,
    baseUrl: `http://${host || "127.0.0.1"}:${port || 17888}/hermes/v1`,
    apiKey: "switchyard-local",
    apiKeyEnv: SWITCHYARD_ENV_KEY
  };
}

export function mergeHermesProfile(existing, { host, port } = {}) {
  const next = existing && typeof existing === "object" ? { ...existing } : {};
  const patch = renderHermesProfile({ host, port });
  return { ...next, ...patch };
}

// ---------- Preview adapters ----------

export function previewCodexProfile(target) {
  if (target?.mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) {
    return mergeCodexOfficialDirectProfile(readText(codexConfigPath()));
  }
  return renderCodexProfile(target);
}
export function previewClaudeCodeProfile(target) {
  return JSON.stringify(renderClaudeCodeProfile(target), null, 2);
}
export function previewHermesProfile(target) {
  // 预览真正会写入的 config.yaml 内容（Hermes 只读 YAML）。
  return mergeHermesYamlProfile(readText(hermesYamlConfigPath()), target);
}

function yamlScalar(value) {
  const s = String(value ?? "");
  if (/^[A-Za-z0-9_./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function distinctEnabledModels(models = []) {
  const out = [];
  const seen = new Set();
  for (const model of models || []) {
    if (!model || model.enabled === false || !model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push(model);
  }
  return out;
}

export function renderHermesYamlModelBlock({ defaultModel } = {}) {
  return [
    "model:",
    `  default: ${yamlScalar(defaultModel || "deepseek/deepseek-v4-flash")}`,
    "  provider: switchyard",
    "  base_url: ''"
  ].join("\n");
}

export function renderHermesYamlProviderBlock({ host, port, models, defaultModel } = {}) {
  const visible = distinctEnabledModels(models);
  const selectedDefault = defaultModel || visible[0]?.id || "deepseek/deepseek-v4-flash";
  const lines = [
    "  switchyard:",
    `    base_url: http://${host || "127.0.0.1"}:${port || 17888}/hermes/v1`,
    "    name: Switchyard",
    "    api_key: switchyard-local",
    "    models:"
  ];
  for (const model of visible.length ? visible : [{ id: selectedDefault, displayName: selectedDefault, contextWindow: 1000000 }]) {
    lines.push(
      `      ${yamlScalar(model.id)}:`,
      `        context_length: ${Number.isFinite(model.contextWindow) ? model.contextWindow : 1000000}`,
      `        name: ${yamlScalar(model.displayName || model.upstreamModel || model.id)}`
    );
  }
  lines.push(
    `    default_model: ${yamlScalar(selectedDefault)}`,
    "    transport: openai_chat"
  );
  return lines.join("\n");
}

function removeTopLevelBlock(lines, key) {
  const out = [];
  let skip = false;
  for (const line of lines) {
    if (new RegExp(`^${key}:\\s*$`).test(line)) {
      skip = true;
      continue;
    }
    if (skip && /^[^ \t#][^:]*:/.test(line)) skip = false;
    if (!skip) out.push(line);
  }
  return out;
}

function upsertSwitchyardProviderBlock(lines, providerBlock) {
  const providersIndex = lines.findIndex((line) => /^providers:\s*$/.test(line));
  if (providersIndex === -1) {
    const base = lines.slice();
    if (base.length && base[base.length - 1].trim() !== "") base.push("");
    base.push("providers:", providerBlock);
    return base;
  }

  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    if (i !== providersIndex) continue;
    out.push(providerBlock);
    i += 1;
    while (i < lines.length) {
      if (/^  switchyard:\s*$/.test(lines[i])) {
        i += 1;
        while (i < lines.length && !/^  [^ \t#][^:]*:/.test(lines[i]) && !/^[^ \t#][^:]*:/.test(lines[i])) {
          i += 1;
        }
        continue;
      }
      i -= 1;
      break;
    }
  }
  return out;
}

export function mergeHermesYamlProfile(existing, { host, port, models, defaultModel } = {}) {
  const modelBlock = renderHermesYamlModelBlock({ defaultModel });
  const providerBlock = renderHermesYamlProviderBlock({ host, port, models, defaultModel });
  const stripped = removeTopLevelBlock(String(existing || "").split(/\r?\n/), "model");
  const withModel = [modelBlock, ...stripped.filter((line, idx) => idx !== 0 || line.trim() !== "")];
  const merged = upsertSwitchyardProviderBlock(withModel, providerBlock).join("\n");
  return merged.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

// ---------- Backup / Restore ----------

export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = backupDir();
  ensureDir(dir);
  const stamp = nowIso().replace(/[:.]/g, "-");
  const target = path.join(dir, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, target);
  return target;
}

export function listBackups(filePath) {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  const prefix = `${path.basename(filePath)}.`;
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .map((name) => {
      const full = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(full); } catch {}
      return {
        name,
        full,
        mtimeMs: stat?.mtimeMs || 0,
        size: stat?.size || 0
      };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function restoreBackup(filePath, backupName) {
  const selected = listBackups(filePath).find((entry) => entry.name === backupName || entry.full === backupName);
  if (!selected) return { ok: false, reason: "backup-not-found" };
  fs.copyFileSync(selected.full, filePath);
  return { ok: true, restoredFrom: selected.full, backupName: selected.name };
}

export function restoreLatest(filePath) {
  const list = listBackups(filePath);
  if (!list.length) return { ok: false, reason: "no-backup" };
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  const selected = list.find((entry) => {
    if (current == null) return true;
    try { return fs.readFileSync(entry.full, "utf8") !== current; }
    catch { return false; }
  });
  if (!selected) return { ok: false, reason: "no-distinct-backup" };
  fs.copyFileSync(selected.full, filePath);
  return { ok: true, restoredFrom: selected.full };
}

// ---------- High-level apply ----------

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }
}

function readJsonSafe(file) {
  try {
    const t = fs.readFileSync(file, "utf8");
    return t ? JSON.parse(t) : {};
  } catch { return {}; }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  const backup = backupFile(file);
  fs.writeFileSync(file, text, "utf8");
  return { path: file, backup };
}

export function applyCodex({ host, port, defaultModel, models, dryRun } = {}) {
  const file = codexConfigPath();
  const existing = readText(file);
  const profileDefaultModel = codexDefaultModelForCatalog({ models, defaultModel });
  const next = mergeCodexProfile(existing, { host, port, defaultModel: profileDefaultModel });
  const catalog = buildCodexModelCatalog({ models, defaultModel });
  const catalogPath = codexModelCatalogPath();
  const cachePath = codexModelsCachePath();
  const ccSwitchCatalogPath = ccSwitchCodexModelCatalogPath();
  const ccSwitchProfilePath = ccSwitchGatewayProfilePath();
  const ccSwitchProfile = renderCcSwitchGatewayProfile({ host, port, defaultModel: profileDefaultModel });
  const cache = buildCodexModelsCache({ catalog });
  if (dryRun) {
    return {
      path: file,
      preview: next,
      existing,
      catalogPath,
      catalogPreview: JSON.stringify(catalog, null, 2) + "\n",
      cachePath,
      cachePreview: JSON.stringify(cache, null, 2) + "\n",
      ccSwitchCatalogPath,
      ccSwitchCatalogPreview: JSON.stringify(catalog, null, 2) + "\n",
      ccSwitchProfilePath,
      ccSwitchProfilePreview: ccSwitchProfile,
      modelCount: catalog.models.length
    };
  }
  const result = writeText(file, next);
  writeCodexModelCatalog({ catalog }, catalogPath);
  writeCodexModelCatalog({ catalog }, ccSwitchCatalogPath);
  writeCodexModelsCache({ catalog }, cachePath);
  const ccSwitchProfileResult = writeText(ccSwitchProfilePath, ccSwitchProfile);
  return {
    ...result,
    catalogPath,
    cachePath,
    ccSwitchCatalogPath,
    ccSwitchProfilePath,
    ccSwitchProfileBackup: ccSwitchProfileResult.backup || null,
    modelCount: catalog.models.length
  };
}

export function applyCodexOfficialDirect({ dryRun } = {}) {
  const file = codexConfigPath();
  const existing = readText(file);
  const next = mergeCodexOfficialDirectProfile(existing);
  if (dryRun) {
    return {
      mode: CODEX_ACCESS_MODES.OFFICIAL_DIRECT,
      path: file,
      preview: next,
      existing,
      auth: "codex_official_login",
      note: "Switchyard removed its managed Codex proxy config. Codex official auth remains owned by Codex App/CLI."
    };
  }
  const result = writeText(file, next);
  return { ...result, mode: CODEX_ACCESS_MODES.OFFICIAL_DIRECT, auth: "codex_official_login" };
}

export function applyClaudeCode({ host, port, defaultModel, models, dryRun, modelMapping } = {}) {
  const file = claudeCodeConfigPath();
  const existing = readJsonSafe(file);
  const merged = mergeClaudeCodeProfile(existing, { host, port, defaultModel, models, modelMapping });
  const text = JSON.stringify(merged, null, 2) + "\n";
  const cache = buildClaudeCodeGatewayModelsCache({ host, port, models });
  const cacheText = JSON.stringify(cache, null, 2) + "\n";
  const cachePath = claudeCodeGatewayModelsCachePath();
  if (dryRun) return { path: file, preview: text, existing, cachePath, cachePreview: cacheText };
  const result = writeText(file, text);
  const cacheResult = writeClaudeCodeGatewayModelsCache({ host, port, models }, cachePath);
  return {
    ...result,
    cachePath,
    cacheSkipped: Boolean(cacheResult.skipped),
    modelCount: cacheResult.modelCount || 0
  };
}

export function applyHermes({ host, port, defaultModel, models, dryRun } = {}) {
  // Hermes 只读取 ~/.hermes/config.yaml，不读 config.json，
  // 因此这里只写 YAML，避免产生 Hermes 永远不会读取的死文件。
  const yamlFile = hermesYamlConfigPath();
  const existingYaml = readText(yamlFile);
  const yamlText = mergeHermesYamlProfile(existingYaml, { host, port, defaultModel, models });
  if (dryRun) return { path: yamlFile, preview: yamlText, existing: existingYaml };
  const yamlResult = writeText(yamlFile, yamlText);
  return { ...yamlResult, yamlPath: yamlResult.path, yamlBackup: yamlResult.backup };
}

export function applyProfile(id, opts = {}) {
  if (id === "codex") {
    if (opts.mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) return applyCodexOfficialDirect(opts);
    return applyCodex(opts);
  }
  if (id === "claude-code") return applyClaudeCode(opts);
  if (id === "hermes") return applyHermes(opts);
  throw new Error(`Unknown profile id: ${id}`);
}

export function restoreProfile(id) {
  if (id === "codex") return restoreLatest(codexConfigPath());
  if (id === "claude-code") return restoreLatest(claudeCodeConfigPath());
  if (id === "hermes") return restoreLatest(hermesYamlConfigPath());
  throw new Error(`Unknown profile id: ${id}`);
}

export function restoreProfileBackup(id, backupName) {
  if (id === "codex") return restoreBackup(codexConfigPath(), backupName);
  if (id === "claude-code") return restoreBackup(claudeCodeConfigPath(), backupName);
  if (id === "hermes") return restoreBackup(hermesConfigPath(), backupName);
  throw new Error(`Unknown profile id: ${id}`);
}

export function writeProfile(filePath, contents) {
  return writeText(filePath, contents);
}

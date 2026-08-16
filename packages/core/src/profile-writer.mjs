// Writes/restores client profiles (Codex / Claude Code / Hermes / OpenCode).
// V0.3: real read/write with timestamped backups under ~/.switchyard/backups,
// plus restore from latest backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupDir, ensureDir, nowIso, DEFAULT_HOME, atomicWriteFileSync } from "./utils.mjs";
import { claudeCodeDiscoveryModelId } from "./config.mjs";
import crypto from "node:crypto";
import yaml from "js-yaml";

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

/** OpenCode 全局配置：~/.config/opencode/opencode.json（可用 XDG_CONFIG_HOME 覆盖） */
export function openCodeConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && String(xdg).trim()
    ? String(xdg).trim()
    : path.join(os.homedir(), ".config");
  return path.join(base, "opencode", "opencode.json");
}

export function openCodeCapabilityPluginPath() {
  return path.join(path.dirname(openCodeConfigPath()), "plugin", "switchyard-capabilities.mjs");
}

/** Grok Build：~/.grok/config.toml（可用 GROK_HOME 覆盖） */
export function grokConfigPath() {
  const home = process.env.GROK_HOME && String(process.env.GROK_HOME).trim()
    ? String(process.env.GROK_HOME).trim()
    : path.join(os.homedir(), ".grok");
  return path.join(home, "config.toml");
}

/** DeepSeek Harness user configuration (DSH_HOME may override ~/.dsh). */
export function deepSeekHarnessConfigPath() {
  const home = process.env.DSH_HOME && String(process.env.DSH_HOME).trim()
    ? String(process.env.DSH_HOME).trim()
    : path.join(os.homedir(), ".dsh");
  return path.join(home, "settings.yaml");
}

export const OPENCODE_PROVIDER_ID = "switchyard";
export const OPENCODE_LOCAL_API_KEY = "switchyard-local";
export const GROK_LOCAL_API_KEY = "switchyard-local";
export const GROK_MANAGED_BEGIN = "# --- switchyard-managed-models begin ---";
export const GROK_MANAGED_END = "# --- switchyard-managed-models end ---";
export const GROK_MODEL_PREFIX = "sy-";
export const GROK_DEFAULT_REASONING_EFFORT = "high";

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
    hermes: hermesYamlConfigPath(),
    opencode: openCodeConfigPath(),
    grok: grokConfigPath(),
    "deepseek-harness": deepSeekHarnessConfigPath()
  };
}

const CODEX_PROVIDER = "custom";
const SWITCHYARD_ENV_KEY = "SWITCHYARD_KEY";
const MARKER = "managed-by-switchyard";

export const CODEX_ACCESS_MODES = Object.freeze({
  SWITCHYARD_PROXY: "switchyard_proxy",
  OFFICIAL_DIRECT: "official_direct",
  /** 像 CC Switch：把某个供应商 baseUrl+key 写入 config，App 直连上游、不经 17888 */
  PROVIDER_DIRECT: "provider_direct"
});

function reasoningLevel(effort, description) {
  return { effort, description };
}

const CODEX_BASE_REASONING_LEVELS = [
  reasoningLevel("low", "Fast responses with lighter reasoning"),
  reasoningLevel("medium", "Balances speed and reasoning depth"),
  reasoningLevel("high", "Greater reasoning depth"),
  reasoningLevel("xhigh", "Extra high reasoning depth")
];

function supportedReasoningLevelsForCodexModel(slug, upstreamModel) {
  const id = `${slug || ""} ${upstreamModel || ""}`.toLowerCase();
  if (/gpt-5\.6-(sol|terra)/.test(id)) {
    return {
      default_reasoning_level: /sol/.test(id) ? "low" : "medium",
      supported_reasoning_levels: [
        ...CODEX_BASE_REASONING_LEVELS,
        reasoningLevel("max", "Maximum reasoning depth for the hardest problems"),
        reasoningLevel("ultra", "Codex-only orchestration tier; not a generic API effort")
      ]
    };
  }
  if (/gpt-5\.6-luna|\bgpt-5\.6\b/.test(id)) {
    return {
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        ...CODEX_BASE_REASONING_LEVELS,
        reasoningLevel("max", "Maximum reasoning depth for the hardest problems")
      ]
    };
  }
  return {
    default_reasoning_level: "medium",
    supported_reasoning_levels: [...CODEX_BASE_REASONING_LEVELS]
  };
}

const CODEX_MODEL_TEMPLATE = {
  slug: "switchyard/default",
  display_name: "Switchyard Default",
  description: "Routed by Switchyard.",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [...CODEX_BASE_REASONING_LEVELS],
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
    if (/^disable_response_storage\s*=/.test(trimmed) && (shouldStripManagedTopLevel || afterManagedMarker)) continue;
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

function supportsCodexPriorityTier({ providerId, providerApiFormat, upstreamModel }) {
  // Cursor exposes its acceleration as the `fast` picker parameter. Codex's
  // Agent UI calls the equivalent choice `priority`; the subscription bridge
  // maps it back to Cursor's local parameter without creating fake model IDs.
  if (providerApiFormat === "cursor_subscription") return true;
  if (!/^(codex|openai|official-gpt)$/i.test(String(providerId || ""))) return false;
  const model = String(upstreamModel || "").toLowerCase();
  if (!/^gpt-5(?:$|[._-])/.test(model)) return false;
  return !/(mini|spark|auto-review)/.test(model);
}

/**
 * Codex 目录 slug：必须全局唯一，否则多供应商同名模型会互相覆盖。
 * - 上游名全局唯一时：官方 Codex 仍可用短名 gpt-5.5（兼容旧会话）
 * - 上游名被多个模型共享时：强制用完整 model.id（如 aigo-gpt/gpt-5.5）
 */
function codexCatalogSlugForModel(model, { ambiguousUpstreams = new Set() } = {}) {
  const id = String(model?.id || model?.upstreamModel || "").trim();
  const upstreamModel = String(model?.upstreamModel || id).trim();
  const providerId = String(model?.providerId || "").trim();
  const upstreamAmbiguous =
    ambiguousUpstreams.has(upstreamModel) ||
    ambiguousUpstreams.has(upstreamModel.toLowerCase());
  if (upstreamAmbiguous) return id || upstreamModel;
  if (isOfficialCodexModel({ providerId, upstreamModel })) return upstreamModel || id;
  return id || upstreamModel;
}

function ambiguousUpstreamNames(models = []) {
  // 同一 upstream 名被多个模型占用时视为歧义（大小写敏感，与配置一致）
  const rawCounts = new Map();
  for (const model of models) {
    if (!model || model.enabled === false) continue;
    const upstream = String(model.upstreamModel || model.id || "").trim();
    if (!upstream) continue;
    rawCounts.set(upstream, (rawCounts.get(upstream) || 0) + 1);
  }
  const ambiguous = new Set();
  for (const [key, count] of rawCounts) {
    if (count > 1) {
      ambiguous.add(key);
      ambiguous.add(key.toLowerCase());
    }
  }
  return ambiguous;
}

function modelMatchesId(model, id) {
  const value = String(id || "").trim();
  if (!value) return false;
  return model?.id === value || model?.upstreamModel === value || (model?.aliases || []).includes(value);
}

function enabledCodexModels(models = []) {
  return (Array.isArray(models) ? models : []).filter((model) => model && model.enabled !== false);
}

/**
 * Resolve Codex profile `model =` slug.
 * Prefer the configured default when it still maps to a visible model; otherwise
 * fall back to the first enabled catalog model. Never echo a deleted/orphaned id
 * (that produces gateway "No route for model …" after provider removal).
 */
function codexDefaultModelForCatalog({ models = [], defaultModel } = {}) {
  const list = enabledCodexModels(models);
  const ambiguousUpstreams = ambiguousUpstreamNames(list);
  const value = String(defaultModel || "").trim();
  if (value) {
    // No models context (legacy apply paths / dry-run without catalog) → trust caller.
    if (!list.length) return value;
    const match = list.find((model) => modelMatchesId(model, value));
    if (match) return codexCatalogSlugForModel(match, { ambiguousUpstreams });
    // Orphaned default after provider/model deletion → fall through to first live model.
  }
  if (!list.length) return null;
  return codexCatalogSlugForModel(list[0], { ambiguousUpstreams });
}

/** Read top-level `model = "..."` from a Codex-style TOML (ignores table bodies). */
function readTopLevelTomlModel(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  let seenTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[[^\]]+\]/.test(trimmed)) {
      seenTable = true;
      continue;
    }
    if (seenTable) continue;
    const match = /^model\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(trimmed);
    if (match) return String(match[1] ?? match[2] ?? match[3] ?? "").trim();
  }
  return "";
}

function codexCatalogModelFrom(model, index = 0, options = {}) {
  const slug = codexCatalogSlugForModel(model, options);
  if (!slug) return null;
  const contextWindow = Number.isFinite(model?.contextWindow) ? model.contextWindow : CODEX_MODEL_TEMPLATE.context_window;
  const hasVisionFallback = Boolean(model?.visionFallbackModelId);
  const supportsImages = Boolean(model?.capabilities?.images || model?.capabilities?.multimodal || hasVisionFallback);
  const providerId = String(model?.providerId || "").trim();
  const upstreamModel = String(model?.upstreamModel || slug).trim();
  const supportsPriority = supportsCodexPriorityTier({ providerId, providerApiFormat: model?.providerApiFormat, upstreamModel });
  const reasoningLevels = supportedReasoningLevelsForCodexModel(slug, upstreamModel);
  return {
    ...CODEX_MODEL_TEMPLATE,
    slug,
    display_name: codexCatalogDisplayName(model, slug),
    description: `${model?.providerName || model?.providerId || "Switchyard"} via Switchyard.`,
    default_reasoning_level: reasoningLevels.default_reasoning_level,
    supported_reasoning_levels: reasoningLevels.supported_reasoning_levels,
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
  const ambiguousUpstreams = ambiguousUpstreamNames(source);
  for (const model of source) {
    if (!model || model.enabled === false) continue;
    const item = codexCatalogModelFrom(model, out.length, { ambiguousUpstreams });
    if (!item) continue;
    // 若仍撞 slug（极端：两个模型 id 相同），跳过后者
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    out.push(item);
  }
  if (!out.length && defaultModel) {
    const item = codexCatalogModelFrom({ id: defaultModel, displayName: defaultModel }, 0, { ambiguousUpstreams });
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
  atomicWriteFileSync(outPath, JSON.stringify(nextCatalog, null, 2) + "\n", "utf8");
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
  atomicWriteFileSync(outPath, JSON.stringify(cache, null, 2) + "\n", "utf8");
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
  atomicWriteFileSync(filePath, next, "utf8");
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

/**
 * Return the model currently selected in an active Switchyard-managed Codex
 * profile.  This is deliberately read-only: Codex persists the selected model
 * per task, while config.toml records the current replacement selection.
 */
export function activeCodexSwitchyardModel(configPath = codexConfigPath()) {
  const profile = inspectCodexSwitchyardProfile(configPath);
  if (!profile.active) return "";
  try {
    return readTopLevelTomlModel(fs.readFileSync(configPath, "utf8"));
  } catch {
    return "";
  }
}

function hostPortFromCodexText(text = {}, fallbackHost = "127.0.0.1", fallbackPort = 17888) {
  const source = typeof text === "string" ? text : "";
  const baseUrl = topLevelTomlValue(source, "openai_base_url") || "";
  const match = /https?:\/\/([^/:]+)(?::(\d+))?/i.exec(baseUrl);
  if (!match) return { host: fallbackHost, port: fallbackPort };
  return {
    host: match[1] || fallbackHost,
    port: match[2] ? Number(match[2]) : fallbackPort
  };
}

export function syncCodexModelArtifacts({
  models = [],
  defaultModel,
  force = false,
  host,
  port
} = {}) {
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

  // Keep config.toml / ccswitch profile `model =` aligned with a still-routable slug.
  // Catalog-only sync used to leave a deleted default (e.g. codex-pool/…) stuck in TOML.
  const profileDefaultModel = codexDefaultModelForCatalog({ models, defaultModel });
  let profileModelChanged = false;
  if (profileDefaultModel) {
    const knownSlugs = new Set(catalog.models.map((item) => item.slug));
    const configPath = codexConfigPath();
    const existingConfig = readText(configPath);
    const currentModel = readTopLevelTomlModel(existingConfig);
    const endpoint = hostPortFromCodexText(existingConfig, host || "127.0.0.1", port || 17888);
    const resolvedHost = host || endpoint.host;
    const resolvedPort = port || endpoint.port;
    if (existingConfig && (!currentModel || !knownSlugs.has(currentModel))) {
      const nextConfig = mergeCodexProfile(existingConfig, {
        host: resolvedHost,
        port: resolvedPort,
        defaultModel: profileDefaultModel
      });
      if (nextConfig !== existingConfig) {
        writeText(configPath, nextConfig);
        profileModelChanged = true;
      }
    }
    const ccSwitchPath = ccSwitchGatewayProfilePath();
    const existingCc = readText(ccSwitchPath);
    if (existingCc && /switchyard|17888|codex\/v1/i.test(existingCc)) {
      const ccModel = readTopLevelTomlModel(existingCc);
      if (!ccModel || !knownSlugs.has(ccModel)) {
        const nextCc = renderCcSwitchGatewayProfile({
          host: resolvedHost,
          port: resolvedPort,
          defaultModel: profileDefaultModel
        });
        if (nextCc !== existingCc) {
          writeText(ccSwitchPath, nextCc);
          profileModelChanged = true;
        }
      }
    }
  }

  return {
    ok: true,
    profile,
    modelCount: catalog.models.length,
    catalogPaths: catalogResults.map((item) => item.path),
    catalogChanged: catalogResults.some((item) => item.changed),
    cachePath,
    cacheChanged,
    profileModelChanged,
    profileDefaultModel: profileDefaultModel || null,
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
  const original = existing || "";
  // 供应商直连（provider_direct）残留：marker / custom provider / 顶层路由键都要清掉，
  // 否则「官方直连」会留下 AI Go 等三方 base_url，看起来明显不对。
  const hadProviderDirect = /switchyard-provider-direct/i.test(original);
  let stripped = stripSwitchyardManagedCodexBlock(original, { replaceModel: true });
  if (hadProviderDirect) {
    stripped = stripped
      .split(/\r?\n/)
      .filter((line) => !/^#\s*managed-by:\s*switchyard-provider-direct/i.test(line.trim()))
      .join("\n");
    stripped = stripCustomProviderSection(stripped);
    stripped = stripTopLevelCodexRoutingKeys(stripped);
  }
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

/**
 * 与 Switchyard 本地代理互斥的 Claude Code / Foundry 路由开关。
 * 企业 Foundry 配置常残留 CLAUDE_CODE_USE_FOUNDRY=1，会绕过 ANTHROPIC_BASE_URL，
 * 导致一键写入后仍走 openapi-ait.ke.com 等 Foundry 端点。
 */
const CLAUDE_FOUNDRY_CONFLICT_ENV_KEYS = [
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY"
];

/**
 * 未走 Switchyard discovery id 的旁路模型 env。
 * 例如 ANTHROPIC_SMALL_FAST_MODEL=GLM-5.1 会在子代理/快路径直接请求，本地网关无法识别。
 */
const CLAUDE_BYPASS_MODEL_ENV_KEYS = [
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL"
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
    let item = claudeCodeGatewayModelFrom(model);
    if (!item) continue;
    if (seen.has(item.id)) {
      // Collision: fall back to hashed slug form
      const raw = String(model.id || model.upstreamModel || "").trim();
      const slug = raw.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
      const hash = crypto.createHash("sha1").update(raw).digest("hex").slice(0, 8);
      const fallbackId = `claude-switchyard-${slug || "model"}-${hash}`;
      if (seen.has(fallbackId)) continue;
      item = { id: fallbackId, display_name: item.display_name };
    }
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
  atomicWriteFileSync(outPath, JSON.stringify(cache, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
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
  openCodeModels = [],
  openCodeDefaultModel,
  grokModels = [],
  grokDefaultModel,
  deepSeekHarnessModels = [],
  forceCodex = false,
  forceOpenCode = false,
  forceGrok = false,
  forceDeepSeekHarness = false
} = {}) {
  return {
    codex: syncCodexModelArtifacts({
      models: codexModels,
      defaultModel: codexDefaultModel,
      force: forceCodex,
      host,
      port
    }),
    claudeCode: syncClaudeCodeModelArtifacts({
      host,
      port,
      models: claudeCodeModels
    }),
    openCode: syncOpenCodeModelArtifacts({
      host,
      port,
      models: openCodeModels,
      defaultModel: openCodeDefaultModel,
      force: forceOpenCode
    }),
    grok: syncGrokModelArtifacts({
      host,
      port,
      models: grokModels,
      defaultModel: grokDefaultModel,
      force: forceGrok
    }),
    deepSeekHarness: syncDeepSeekHarnessModelArtifacts({
      host,
      port,
      models: deepSeekHarnessModels,
      force: forceDeepSeekHarness
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
  // 关掉 Foundry 直连，强制走 ANTHROPIC_BASE_URL → Switchyard
  for (const key of CLAUDE_FOUNDRY_CONFLICT_ENV_KEYS) delete next.env[key];
  // 清掉非 discovery id 的旁路模型，避免子代理仍打 GLM-5.1 等裸名
  for (const key of CLAUDE_BYPASS_MODEL_ENV_KEYS) delete next.env[key];
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

// ---------- OpenCode (JSON) ----------

function openCodeBaseUrl({ host, port } = {}) {
  return `http://${host || "127.0.0.1"}:${port || 17888}/opencode/v1`;
}

function openCodeModelLabel(model) {
  const base = String(model?.displayName || model?.upstreamModel || model?.id || "").trim()
    || String(model?.id || "model");
  // 同名模型跨供应商区分：GLM-5.2 · Coding Plan、GLM-5.2 · OpenCode Go
  const provider = String(model?.providerName || model?.providerId || "").trim();
  if (!provider) return base;
  const escapedProvider = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:·|\\(|\\[)\\s*${escapedProvider}\\s*(?:\\)|\\])?$`, "i").test(base)) return base;
  return `${base} · ${provider}`;
}

/** OpenCode 校验要求 limit 同时有 context + output；缺省时用保守默认 */
const OPENCODE_DEFAULT_CONTEXT = 128000;
const OPENCODE_DEFAULT_OUTPUT = 8192;
const OPENCODE_MAX_DEFAULT_OUTPUT = 128000;

function openCodeContextLimit(model) {
  const n = Number(model?.contextWindow || model?.context_window || model?.maxContext || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function openCodeOutputLimit(model) {
  const n = Number(model?.maxOutputTokens || model?.max_output_tokens || model?.maxTokens || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * 从 context 推算默认 output（约 1/4，夹在 [DEFAULT, MAX]）。
 * OpenCode schema：只要有 limit 就必须同时有 context 与 output。
 */
function openCodeDefaultOutputFromContext(context) {
  const ctx = Number(context) || OPENCODE_DEFAULT_CONTEXT;
  const derived = Math.floor(ctx / 4);
  return Math.min(
    OPENCODE_MAX_DEFAULT_OUTPUT,
    Math.max(OPENCODE_DEFAULT_OUTPUT, derived || OPENCODE_DEFAULT_OUTPUT)
  );
}

/** 生成 OpenCode provider.switchyard.models map（key 为 Switchyard 模型 id，可含 /） */
export function buildOpenCodeModelsMap(models = []) {
  const out = {};
  for (const model of distinctModels(models)) {
    const id = String(model?.id || "").trim();
    if (!id) continue;
    const entry = { name: openCodeModelLabel(model) };
    const context = openCodeContextLimit(model) || OPENCODE_DEFAULT_CONTEXT;
    const output = openCodeOutputLimit(model) || openCodeDefaultOutputFromContext(context);
    // OpenCode 要求 limit.context + limit.output 成对出现，缺一即配置无效
    entry.limit = { context, output };
    const supportsImages = Boolean(
      model?.capabilities?.images
      || model?.capabilities?.multimodal
      || model?.visionFallbackModelId
    );
    // OpenCode checks attachment/modalities before it calls the provider. If
    // these fields are omitted it rejects ACP/CLI image attachments locally,
    // even when the Switchyard model itself supports vision.
    entry.attachment = supportsImages;
    entry.modalities = {
      input: supportsImages ? ["text", "image"] : ["text"],
      output: ["text"]
    };
    out[id] = entry;
  }
  return out;
}

export function renderOpenCodeCapabilityPlugin(models = []) {
  const capabilities = {};
  for (const model of distinctModels(models)) {
    const id = String(model?.id || "").trim();
    if (!id) continue;
    const supportsImages = Boolean(
      model?.capabilities?.images
      || model?.capabilities?.multimodal
      || model?.visionFallbackModelId
    );
    capabilities[id] = {
      tools: model?.capabilities?.tools !== false,
      input: supportsImages ? ["text", "image"] : ["text"],
      output: ["text"]
    };
  }
  return `// managed-by-switchyard; regenerated automatically\n`
    + `const capabilities = ${JSON.stringify(capabilities, null, 2)};\n\n`
    + `export const SwitchyardCapabilities = async () => ({\n`
    + `  config: async (config) => {\n`
    + `    const models = config.provider?.switchyard?.models;\n`
    + `    if (!models) return;\n`
    + `    for (const [id, value] of Object.entries(capabilities)) {\n`
    + `      if (!models[id]) continue;\n`
    + `      models[id].tool_call = value.tools;\n`
    + `      models[id].modalities = { input: value.input, output: value.output };\n`
    + `    }\n`
    + `  },\n`
    + `  \"chat.params\": async (input) => {\n`
    + `    const modelId = input.model?.id || input.model?.modelID;\n`
    + `    const value = capabilities[modelId];\n`
    + `    if (!value || !input.model.capabilities) return;\n`
    + `    input.model.capabilities.attachment = value.input.includes(\"image\");\n`
    + `    if (input.model.capabilities.input) {\n`
    + `      input.model.capabilities.input.image = value.input.includes(\"image\");\n`
    + `    }\n`
    + `  }\n`
    + `});\n`;
}

function syncOpenCodeCapabilityPlugin(models = []) {
  const file = openCodeCapabilityPluginPath();
  const nextText = renderOpenCodeCapabilityPlugin(models);
  let prevText = "";
  try { prevText = fs.readFileSync(file, "utf8"); } catch {}
  if (prevText === nextText) return { path: file, changed: false };
  const result = writeText(file, nextText);
  return { path: result.path, backup: result.backup || null, changed: true };
}

export function renderOpenCodeProviderBlock({ host, port, models = [] } = {}) {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Switchyard",
    [MARKER]: true,
    options: {
      baseURL: openCodeBaseUrl({ host, port }),
      apiKey: OPENCODE_LOCAL_API_KEY
    },
    models: buildOpenCodeModelsMap(models)
  };
}

/**
 * 合并写入 OpenCode 配置：只托管 provider.switchyard，保留用户其它 provider / 顶层设置。
 * 若当前默认 model 属于 switchyard/* 且模型已删，则更新或清除顶层 model。
 */
export function mergeOpenCodeProfile(existing, { host, port, models = [], defaultModel } = {}) {
  const next = existing && typeof existing === "object" && !Array.isArray(existing)
    ? { ...existing }
    : {};
  if (!next.$schema) next.$schema = "https://opencode.ai/config.json";

  const providers = next.provider && typeof next.provider === "object" && !Array.isArray(next.provider)
    ? { ...next.provider }
    : {};
  providers[OPENCODE_PROVIDER_ID] = renderOpenCodeProviderBlock({ host, port, models });
  next.provider = providers;

  const modelMap = providers[OPENCODE_PROVIDER_ID].models || {};
  const modelIds = Object.keys(modelMap);
  const preferred = String(defaultModel || "").trim();
  const pickDefault = preferred && modelMap[preferred]
    ? preferred
    : modelIds[0] || "";

  const currentModel = typeof next.model === "string" ? next.model.trim() : "";
  const switchyardPrefix = `${OPENCODE_PROVIDER_ID}/`;
  const currentIsOurs = currentModel.startsWith(switchyardPrefix);
  const currentKey = currentIsOurs ? currentModel.slice(switchyardPrefix.length) : "";
  const currentStillValid = currentIsOurs && Boolean(modelMap[currentKey]);

  if (pickDefault) {
    if (!currentModel || currentIsOurs) {
      // 仅在未设默认、或当前默认已是我们管理的 switchyard 模型时更新
      if (!currentStillValid || (preferred && preferred !== currentKey)) {
        next.model = `${OPENCODE_PROVIDER_ID}/${pickDefault}`;
      }
    }
  } else if (currentIsOurs && !currentStillValid) {
    delete next.model;
  }

  return next;
}

export function previewOpenCodeProfile(target = {}) {
  return JSON.stringify(
    mergeOpenCodeProfile(readJsonSafe(openCodeConfigPath()), target),
    null,
    2
  ) + "\n";
}

/**
 * 若本机已有 managed-by-switchyard 的 OpenCode 配置，则按当前模型列表刷新；
 * 否则跳过（避免未经用户「一键写入」就改写全局 opencode.json）。
 * force=true 时始终写入。
 */
export function syncOpenCodeModelArtifacts({
  host,
  port,
  models = [],
  defaultModel,
  force = false
} = {}) {
  const file = openCodeConfigPath();
  const existing = readJsonSafe(file);
  const managed = Boolean(
    existing?.provider?.[OPENCODE_PROVIDER_ID]?.[MARKER]
    || existing?.provider?.[OPENCODE_PROVIDER_ID]?.options?.baseURL?.includes("/opencode")
  );
  if (!force && !managed) {
    return { ok: true, skipped: true, reason: "not-managed", path: file, modelCount: 0 };
  }
  const merged = mergeOpenCodeProfile(existing, { host, port, models, defaultModel });
  const capabilityPlugin = syncOpenCodeCapabilityPlugin(models);
  const nextText = jsonText(merged);
  let prevText = "";
  try { prevText = fs.readFileSync(file, "utf8"); } catch {}
  if (prevText === nextText) {
    return {
      ok: true,
      path: file,
      changed: false,
      capabilityPlugin,
      modelCount: Object.keys(merged.provider?.[OPENCODE_PROVIDER_ID]?.models || {}).length
    };
  }
  const result = writeText(file, nextText);
  return {
    ok: true,
    path: result.path,
    backup: result.backup || null,
    changed: true,
    capabilityPlugin,
    modelCount: Object.keys(merged.provider?.[OPENCODE_PROVIDER_ID]?.models || {}).length
  };
}

// ---------- DeepSeek Harness (YAML) ----------

export const DEEPSEEK_HARNESS_PROVIDER_ID = "switchyard";
export const DEEPSEEK_HARNESS_MARKER = "managed-by-switchyard";

function deepSeekHarnessBaseUrl({ host, port } = {}) {
  return `http://${host || "127.0.0.1"}:${port || 17888}/deepseek-harness/v1`;
}

function modelSupportsImages(model) {
  return Boolean(model?.capabilities?.images || model?.capabilities?.multimodal || model?.visionFallbackModelId);
}

function modelSupportsReasoning(model) {
  return Boolean(model?.capabilities?.reasoning);
}

/** DSH's pi-ai adapter accepts a per-model capability declaration. */
export function deepSeekHarnessModelFrom(model) {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  const out = {
    id,
    name: String(model?.displayName || model?.upstreamModel || id).trim() || id,
    input: modelSupportsImages(model) ? ["text", "image"] : ["text"]
  };
  if (modelSupportsReasoning(model)) {
    // Switchyard currently exposes a boolean reasoning capability. DSH's
    // native effort picker needs concrete wire values; use the common
    // OpenAI-compatible spellings while still omitting the field entirely
    // for non-reasoning models.
    out.reasoningEfforts = { off: null, high: "high", max: "max" };
  }
  return out;
}

export function renderDeepSeekHarnessProvider({ host, port, models = [], existing = {} } = {}) {
  const current = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const next = {
    ...current,
    displayName: "Switchyard",
    api: "openai-completions",
    baseURL: deepSeekHarnessBaseUrl({ host, port }),
    [DEEPSEEK_HARNESS_MARKER]: true,
    models: distinctModels(models).map(deepSeekHarnessModelFrom).filter(Boolean)
  };
  // A normal DSH API key is optional for Switchyard's local gateway. Preserve
  // an existing credential reference, but do not manufacture a missing one.
  if (!current.apiKeyEnv) delete next.apiKeyEnv;
  return next;
}

/**
 * Merge only the Switchyard-owned DSH provider. All other Harness settings,
 * plugins, credentials, and third-party providers are retained verbatim after
 * YAML parse/serialize.
 */
export function mergeDeepSeekHarnessProfile(existing, opts = {}) {
  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  const llm = next["llm-pi-ai"] && typeof next["llm-pi-ai"] === "object" && !Array.isArray(next["llm-pi-ai"])
    ? { ...next["llm-pi-ai"] }
    : {};
  const providers = llm.providers && typeof llm.providers === "object" && !Array.isArray(llm.providers)
    ? { ...llm.providers }
    : {};
  providers[DEEPSEEK_HARNESS_PROVIDER_ID] = renderDeepSeekHarnessProvider({
    ...opts,
    existing: providers[DEEPSEEK_HARNESS_PROVIDER_ID]
  });
  llm.providers = providers;
  next["llm-pi-ai"] = llm;
  return next;
}

function readYamlSafe(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed = yaml.load(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function yamlText(value) {
  return yaml.dump(value, { noRefs: true, lineWidth: 120, sortKeys: false });
}

export function previewDeepSeekHarnessProfile(target = {}) {
  return yamlText(mergeDeepSeekHarnessProfile(readYamlSafe(deepSeekHarnessConfigPath()), target));
}

/** Refresh only after the user has explicitly enabled the managed provider. */
export function syncDeepSeekHarnessModelArtifacts({ host, port, models = [], force = false } = {}) {
  const file = deepSeekHarnessConfigPath();
  const existing = readYamlSafe(file);
  const managed = Boolean(existing?.["llm-pi-ai"]?.providers?.[DEEPSEEK_HARNESS_PROVIDER_ID]?.[DEEPSEEK_HARNESS_MARKER]);
  if (!force && !managed) return { ok: true, skipped: true, reason: "not-managed", path: file, modelCount: 0 };
  const merged = mergeDeepSeekHarnessProfile(existing, { host, port, models });
  const nextText = yamlText(merged);
  let prevText = "";
  try { prevText = fs.readFileSync(file, "utf8"); } catch {}
  if (prevText === nextText) return { ok: true, path: file, changed: false, modelCount: merged["llm-pi-ai"].providers[DEEPSEEK_HARNESS_PROVIDER_ID].models.length };
  const result = writeText(file, nextText);
  return { ok: true, path: result.path, backup: result.backup || null, changed: true, modelCount: merged["llm-pi-ai"].providers[DEEPSEEK_HARNESS_PROVIDER_ID].models.length };
}

// ---------- Grok Build (TOML) ----------

function grokBaseUrl({ host, port } = {}) {
  return `http://${host || "127.0.0.1"}:${port || 17888}/grok/v1`;
}

/** Grok picker 用的短 id：sy- + 模型 id 安全化（/ → --） */
export function grokModelAlias(modelId) {
  const raw = String(modelId || "").trim();
  if (!raw) return "";
  const safe = raw
    .replace(/\\/g, "/")
    .replace(/\/+/g, "--")
    .replace(/[^A-Za-z0-9._@+-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return `${GROK_MODEL_PREFIX}${safe || "model"}`;
}

function grokModelLabel(model) {
  const name = String(model?.displayName || model?.upstreamModel || model?.id || "").trim();
  const provider = String(model?.providerName || model?.providerId || "").trim();
  if (name && provider && !name.includes(provider)) return `${name} · ${provider}`;
  return name || String(model?.id || "model");
}

function grokContextWindow(model) {
  const n = Number(model?.contextWindow || model?.context_window || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 200000;
}

function grokApiBackend(model) {
  const format = String(model?.apiFormat || model?.providerApiFormat || "").toLowerCase();
  if (format === "anthropic_messages") return "messages";
  // Grok Build 的 Responses 解析器与 ChatGPT Codex 后端不兼容：上游
  // response.completed.response.output 为空，Grok 判定 "empty response from
  // model (no_visible_content)" 并重试最多 15 次。其 chat_completions 解析器
  // 经 Switchyard 的 chat -> Responses 转换验证可用，所以 openai_responses
  // 上游在 Grok 侧一律走 chat_completions，由网关按上游 apiFormat 转换。
  if (format === "openai_responses") return "chat_completions";
  // 默认 chat_completions：与网关 /v1/chat/completions 对齐
  return "chat_completions";
}

/**
 * TOML 表头：模型 id 常含 `.`（如 GLM-5.2），裸写 [model.sy-…GLM-5.2]
 * 会被解析成嵌套表 model.sy-…GLM-5 = { "2" = {...} }，导致 Grok 丢 base_url、
 * 回落到官方 cli-chat-proxy。必须写成 [model."sy-…GLM-5.2"]。
 */
export function grokModelTableHeader(alias) {
  const name = String(alias || "").trim();
  if (!name) return "[model.unknown]";
  // 安全起见一律加引号（无点号也可）
  return `[model.${tomlString(name)}]`;
}

/** 模型是否声明支持思考（"思考"能力勾选）。缺省按 true 处理以匹配默认勾选行为。 */
export function grokSupportsReasoning(model) {
  return model?.capabilities?.reasoning !== false;
}

export function renderGrokModelSection(model, { host, port } = {}) {
  const id = String(model?.id || "").trim();
  if (!id) return "";
  const alias = grokModelAlias(id);
  const lines = [
    grokModelTableHeader(alias),
    `model = ${tomlString(id)}`,
    `base_url = ${tomlString(grokBaseUrl({ host, port }))}`,
    `name = ${tomlString(grokModelLabel(model))}`,
    `description = ${tomlString(MARKER)}`,
    `api_key = ${tomlString(GROK_LOCAL_API_KEY)}`,
    `api_backend = ${tomlString(grokApiBackend(model))}`,
    `context_window = ${grokContextWindow(model)}`
  ];
  // 只有模型支持思考（模型配置里"思考"勾选）时，才写入思考等级控制参数；
  // 未勾选思考的模型不写，避免向不支持推理的后端透传 reasoning_effort。
  if (grokSupportsReasoning(model)) {
    lines.push(`supports_reasoning_effort = true`);
    lines.push(`reasoning_effort = ${tomlString(GROK_DEFAULT_REASONING_EFFORT)}`);
  }
  return lines.join("\n");
}

export function buildGrokManagedBlock({ host, port, models = [] } = {}) {
  const sections = [];
  const aliases = [];
  for (const model of distinctModels(models)) {
    const section = renderGrokModelSection(model, { host, port });
    if (!section) continue;
    sections.push(section);
    aliases.push(grokModelAlias(model.id));
  }
  if (!sections.length) {
    return {
      text: `${GROK_MANAGED_BEGIN}\n# (no models)\n${GROK_MANAGED_END}\n`,
      aliases,
      modelCount: 0
    };
  }
  return {
    text: `${GROK_MANAGED_BEGIN}\n${sections.join("\n\n")}\n${GROK_MANAGED_END}\n`,
    aliases,
    modelCount: aliases.length
  };
}

function stripGrokManagedBlock(text) {
  const src = String(text || "");
  const begin = src.indexOf(GROK_MANAGED_BEGIN);
  if (begin < 0) {
    // 兼容：去掉旧式 sy-* 且 description/base_url 指向 switchyard 的散落段落
    return stripLooseGrokManagedSections(src);
  }
  const end = src.indexOf(GROK_MANAGED_END, begin);
  if (end < 0) return src.slice(0, begin).replace(/\n{3,}$/g, "\n\n");
  const after = src.slice(end + GROK_MANAGED_END.length).replace(/^\r?\n/, "");
  return (src.slice(0, begin) + after).replace(/\n{3,}/g, "\n\n").trimEnd() + (src.endsWith("\n") || after ? "\n" : "");
}

/** 解析 [model.xxx] / [model."xxx"] 表头里的模型名 */
function parseGrokModelTableName(headerLine) {
  const line = String(headerLine || "").trim();
  const quoted = line.match(/^\[model\.(["'])((?:\\.|(?!\1).)*)\1\]$/);
  if (quoted) return quoted[2].replace(/\\(.)/g, "$1");
  const bare = line.match(/^\[model\.([^\]]+)\]$/);
  if (!bare) return "";
  // 裸表头可能是嵌套路径 sy-ke--GLM-5.2 → 取最外层仍以 sy- 开头的前缀判断
  return bare[1];
}

function stripLooseGrokManagedSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const name = parseGrokModelTableName(line);
    if (!name && !/^\s*\[model\./.test(line.trim())) {
      out.push(line);
      i += 1;
      continue;
    }
    if (!name) {
      out.push(line);
      i += 1;
      continue;
    }
    const body = [];
    i += 1;
    while (i < lines.length && !/^\[[^\]]+\]\s*$/.test(lines[i].trim())) {
      body.push(lines[i]);
      i += 1;
    }
    const bodyText = body.join("\n");
    // 兼容旧坏表头：sy-foo--GLM-5.2 被 TOML 拆成 sy-foo--GLM-5（仍以 sy- 开头）
    const managed = name.startsWith(GROK_MODEL_PREFIX)
      || name.includes(GROK_MODEL_PREFIX)
      || bodyText.includes(MARKER)
      || /base_url\s*=\s*["'][^"']*\/grok\/v1\/?["']/.test(bodyText);
    if (managed) continue;
    out.push(line, ...body);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function grokModelsDefault(text) {
  const block = tomlSectionText(text, "models");
  if (!block) return "";
  const match = block.match(/^\s*default\s*=\s*(.+?)\s*$/m);
  return match ? tomlStringValue(match[1]) : "";
}

/** 在 [models] 表内设置/更新 default，保留其它键 */
export function upsertGrokModelsDefault(text, defaultAlias) {
  const src = String(text || "");
  const lines = src.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) => line.trim() === "[models]");
  if (headerIdx < 0) {
    const block = defaultAlias
      ? `\n[models]\ndefault = ${tomlString(defaultAlias)}\n`
      : "";
    return src.replace(/\s*$/, "") + block + (block ? "" : "\n");
  }
  let end = headerIdx + 1;
  while (end < lines.length && !/^\[[^\]]+\]\s*$/.test(lines[end].trim())) end += 1;
  const body = lines.slice(headerIdx + 1, end);
  let found = false;
  const nextBody = body.map((line) => {
    if (/^\s*default\s*=/.test(line)) {
      found = true;
      if (!defaultAlias) return null;
      return `default = ${tomlString(defaultAlias)}`;
    }
    return line;
  }).filter((line) => line != null);
  if (defaultAlias && !found) nextBody.unshift(`default = ${tomlString(defaultAlias)}`);
  if (!defaultAlias && !found) {
    // nothing
  }
  return [...lines.slice(0, headerIdx + 1), ...nextBody, ...lines.slice(end)].join("\n");
}

/**
 * 合并 Grok config.toml：只维护 switchyard 托管块内的 [model.sy-*]，保留用户其它配置与自定义 model。
 */
export function mergeGrokProfile(existingText, { host, port, models = [], defaultModel } = {}) {
  let base = stripGrokManagedBlock(existingText || "");
  const managed = buildGrokManagedBlock({ host, port, models });
  const preferredId = String(defaultModel || "").trim();
  const preferredAlias = preferredId ? grokModelAlias(preferredId) : "";
  const pickDefault = preferredAlias && managed.aliases.includes(preferredAlias)
    ? preferredAlias
    : (managed.aliases[0] || "");

  const currentDefault = grokModelsDefault(base);
  const currentIsOurs = currentDefault.startsWith(GROK_MODEL_PREFIX)
    || managed.aliases.includes(currentDefault);
  // 仅当未设默认、或当前默认是我们托管的 sy-* 时，才改 [models].default
  if (pickDefault && (!currentDefault || currentIsOurs)) {
    if (!managed.aliases.includes(currentDefault) || (preferredAlias && preferredAlias !== currentDefault)) {
      base = upsertGrokModelsDefault(base, pickDefault);
    }
  } else if (currentIsOurs && pickDefault && !managed.aliases.includes(currentDefault)) {
    base = upsertGrokModelsDefault(base, pickDefault);
  }

  const trimmed = base.replace(/\s*$/, "\n");
  const next = `${trimmed}${trimmed.endsWith("\n\n") ? "" : "\n"}${managed.text}`;
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function previewGrokProfile(target = {}) {
  return mergeGrokProfile(readText(grokConfigPath()), target);
}

export function isGrokConfigManaged(text) {
  const src = String(text || "");
  return src.includes(GROK_MANAGED_BEGIN)
    || src.includes(MARKER)
    || /\[model\.sy-/.test(src)
    || /\[model\."sy-/.test(src)
    || /base_url\s*=\s*["'][^"']*\/grok\/v1\/?["']/.test(src);
}

/**
 * 已托管时自动刷新 Grok 模型清单；未托管则跳过。
 */
export function syncGrokModelArtifacts({
  host,
  port,
  models = [],
  defaultModel,
  force = false
} = {}) {
  const file = grokConfigPath();
  let existing = "";
  try { existing = fs.readFileSync(file, "utf8"); } catch {}
  if (!force && !isGrokConfigManaged(existing)) {
    return { ok: true, skipped: true, reason: "not-managed", path: file, modelCount: 0 };
  }
  const nextText = mergeGrokProfile(existing, { host, port, models, defaultModel });
  if (existing === nextText) {
    return {
      ok: true,
      path: file,
      changed: false,
      modelCount: distinctModels(models).length
    };
  }
  const result = writeText(file, nextText);
  return {
    ok: true,
    path: result.path,
    backup: result.backup || null,
    changed: true,
    modelCount: distinctModels(models).length
  };
}

// ---------- Preview adapters ----------
// 所有预览与「一键写入」同一套 merge：展示合并后的完整文件内容。

export function previewCodexProfile(target = {}) {
  const existing = readText(codexConfigPath());
  if (target?.mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) {
    return mergeCodexOfficialDirectProfile(existing);
  }
  if (target?.mode === CODEX_ACCESS_MODES.PROVIDER_DIRECT) {
    return mergeCodexProviderDirectProfile(existing, {
      name: target.provider?.name || target.provider?.id || "Provider Direct",
      baseUrl: target.provider?.baseUrl || "",
      apiKey: target.apiKey || target.provider?.apiKey || "",
      model: target.model?.upstreamModel || target.model?.id || target.defaultModel || "",
      wireApi: target.provider?.apiFormat === "openai_chat" ? "chat" : "responses",
      disableImageGeneration: looksLikeAigoProvider(target.provider || {})
    });
  }
  const profileDefaultModel = codexDefaultModelForCatalog({
    models: target.models,
    defaultModel: target.defaultModel
  });
  return mergeCodexProfile(existing, {
    host: target.host,
    port: target.port,
    defaultModel: profileDefaultModel
  });
}

export function previewClaudeCodeProfile(target = {}) {
  const existing = readJsonSafe(claudeCodeConfigPath());
  const merged = mergeClaudeCodeProfile(existing, target);
  return JSON.stringify(merged, null, 2) + "\n";
}

export function previewHermesProfile(target = {}) {
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

/**
 * 备份文件名前缀：用「父目录.文件名」消歧。
 * 否则 ~/.codex/config.toml 与 ~/.grok/config.toml 都会变成 config.toml.*.bak，
 * 恢复时 Codex 会捞到 Grok 的配置（格式完全不对）。
 * 父目录名去掉前导点：.codex → codex，避免备份名以点开头。
 */
export function backupNamePrefix(filePath) {
  const resolved = path.resolve(filePath);
  const base = path.basename(resolved);
  let parent = path.basename(path.dirname(resolved)).replace(/^\.+/, "");
  if (!parent || parent === path.sep || parent === "/") return base;
  // 只保留安全字符，避免路径分隔符进备份名
  parent = parent.replace(/[^A-Za-z0-9._-]+/g, "_");
  if (!parent) return base;
  return `${parent}.${base}`;
}

function backupClientHint(filePath) {
  const parent = path.basename(path.dirname(path.resolve(filePath))).replace(/^\.+/, "").toLowerCase();
  if (parent === "codex") return "codex";
  if (parent === "grok") return "grok";
  return parent || "";
}

function looksLikeForeignConfigBackup(filePath, content) {
  const client = backupClientHint(filePath);
  const text = String(content || "");
  // Grok Build：典型 [cli]/marketplace/xAI；Codex 恢复列表里要排除
  const looksGrok =
    /^\[cli\]/m.test(text) &&
    (/official_marketplace|plugin-marketplace|xAI Official|grok-build|\[models\]/i.test(text));
  // Codex：model_providers / computer-use notify 等
  const looksCodex =
    /\[model_providers/i.test(text) ||
    /model_provider\s*=/i.test(text) ||
    /computer-use|Codex Computer Use|cc-switch-model-catalog|managed-by-switchyard|switchyard-provider-direct/i.test(text);
  if (client === "codex" && looksGrok && !looksCodex) return true;
  if (client === "grok" && looksCodex && !looksGrok) return true;
  return false;
}

export function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const dir = backupDir();
  ensureDir(dir);
  const stamp = nowIso().replace(/[:.]/g, "-");
  const target = path.join(dir, `${backupNamePrefix(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, target);
  return target;
}

export function listBackups(filePath) {
  const dir = backupDir();
  if (!fs.existsSync(dir)) return [];
  const scopedPrefix = `${backupNamePrefix(filePath)}.`;
  const legacyPrefix = `${path.basename(filePath)}.`;
  // 新格式：codex.config.toml.* / grok.config.toml.*
  // 旧格式：config.toml.*（Codex/Grok 曾混用，按内容排除串台）
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".bak"))
    .filter((name) => {
      if (name.startsWith(scopedPrefix)) return true;
      // 旧版仅 basename：config.toml.*（Codex/Grok 曾混用，按内容排除串台）
      // 新版 scoped 名（codex.config.toml.* / grok.config.toml.*）不会命中对方的 scoped 前缀
      if (!name.startsWith(legacyPrefix)) return false;
      // 避免把「其它父目录.basename.stamp.bak」误当成 legacy：
      // 例如不存在，因为 grok.config.toml 不以 config.toml. 开头；保持简单内容过滤即可
      const full = path.join(dir, name);
      try {
        const content = fs.readFileSync(full, "utf8");
        return !looksLikeForeignConfigBackup(filePath, content);
      } catch {
        return false;
      }
    })
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
  atomicWriteFileSync(file, text, "utf8");
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

/**
 * 像 CC Switch 导入供应商：App 直连 provider.baseUrl，不经 Switchyard 网关。
 * 用于 AI Go 等「只允许 Codex 官方客户端」的号池。
 */
export function renderCodexProviderDirectBlock({
  name,
  baseUrl,
  apiKey,
  model,
  wireApi = "responses",
  disableImageGeneration = false
} = {}) {
  const lines = [
    "# managed-by: switchyard-provider-direct",
    `model_provider = "${CODEX_PROVIDER}"`,
    `model_reasoning_effort = "high"`,
    `disable_response_storage = true`
  ];
  if (model) lines.push(`model = ${tomlString(model)}`);
  lines.push(
    "",
    `[model_providers.${CODEX_PROVIDER}]`,
    `name = ${tomlString(name || "Provider Direct")}`,
    `base_url = ${tomlString(String(baseUrl || "").replace(/\/+$/, ""))}`,
    `wire_api = ${tomlString(wireApi)}`,
    `requires_openai_auth = true`,
    `experimental_bearer_token = ${tomlString(apiKey || "")}`
  );
  if (disableImageGeneration) {
    lines.push("", "[features]", "js_repl = false", "image_generation = false");
  }
  return lines.join("\n") + "\n";
}

function looksLikeAigoProvider(provider = {}) {
  const text = [provider.id, provider.name, provider.baseUrl].filter(Boolean).join(" ").toLowerCase();
  return text.includes("aigo") || text.includes("aigocode") || text.includes("中转gpt");
}

export function mergeCodexProviderDirectProfile(existing, opts = {}) {
  const stripped = stripSwitchyardManagedCodexBlock(existing || "", { replaceModel: true });
  // 去掉旧的 provider-direct 管理块与 custom provider（避免重复）
  const withoutOldDirect = stripped
    .split(/\r?\n/)
    .filter((line) => !/^#\s*managed-by:\s*switchyard-provider-direct/.test(line.trim()))
    .join("\n");
  const withoutCustom = stripCustomProviderSection(withoutOldDirect);
  const withoutTop = stripTopLevelCodexRoutingKeys(withoutCustom);
  const block = renderCodexProviderDirectBlock(opts);
  const rest = withoutTop.trim();
  return rest ? `${block.trimEnd()}\n\n${rest}\n` : `${block.trimEnd()}\n`;
}

function stripCustomProviderSection(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\[model_providers\.custom\]/.test(trimmed)) {
      i += 1;
      while (i < lines.length && !/^\[[^\]]+\]/.test(lines[i].trim())) i += 1;
      i -= 1;
      continue;
    }
    out.push(lines[i]);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

function stripTopLevelCodexRoutingKeys(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let seenTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]/.test(trimmed)) seenTable = true;
    if (!seenTable && (
      /^model_provider\s*=/.test(trimmed) ||
      /^model\s*=/.test(trimmed) ||
      /^model_catalog_json\s*=/.test(trimmed) ||
      /^openai_base_url\s*=/.test(trimmed) ||
      /^model_reasoning_effort\s*=/.test(trimmed) ||
      /^disable_response_storage\s*=/.test(trimmed)
    )) continue;
    // 旧 features.image_generation 由新 block 重写；整段 [features] 若只有 js_repl/image 会重复，保留用户其它 features 表
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

export function applyCodexProviderDirect({
  provider,
  model,
  apiKey,
  dryRun
} = {}) {
  if (!provider?.baseUrl) throw new Error("provider.baseUrl is required for provider_direct");
  const key = apiKey || provider.apiKey || "";
  if (!key && provider.authMode !== "none") throw new Error("provider apiKey is required for provider_direct");
  const upstreamModel = model?.upstreamModel || model?.id || provider.defaultModel || "";
  // 直连时 Codex 侧 model 用上游模型名（如 gpt-5.5），不要带 provider 前缀
  const codexModel = model?.upstreamModel || (String(model?.id || "").includes("/")
    ? String(model.id).split("/").slice(1).join("/")
    : model?.id) || "";
  const wireApi = provider.apiFormat === "openai_chat" ? "chat" : "responses";
  const opts = {
    name: provider.name || provider.id || "Provider Direct",
    baseUrl: provider.baseUrl,
    apiKey: key,
    model: codexModel,
    wireApi: wireApi === "chat" ? "chat" : "responses",
    disableImageGeneration: looksLikeAigoProvider(provider)
  };
  const file = codexConfigPath();
  const existing = readText(file);
  const next = mergeCodexProviderDirectProfile(existing, opts);
  if (dryRun) {
    return {
      mode: CODEX_ACCESS_MODES.PROVIDER_DIRECT,
      path: file,
      preview: next,
      existing,
      providerId: provider.id,
      baseUrl: opts.baseUrl,
      model: opts.model,
      note: "App 将直连该供应商 baseUrl（不经 Switchyard 17888），行为对齐 CC Switch 导入。"
    };
  }
  const result = writeText(file, next);
  return {
    ...result,
    mode: CODEX_ACCESS_MODES.PROVIDER_DIRECT,
    providerId: provider.id,
    baseUrl: opts.baseUrl,
    model: opts.model
  };
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

export function applyOpenCode({ host, port, defaultModel, models, dryRun } = {}) {
  const file = openCodeConfigPath();
  const existing = readJsonSafe(file);
  const merged = mergeOpenCodeProfile(existing, { host, port, defaultModel, models });
  const text = jsonText(merged);
  if (dryRun) return { path: file, preview: text, existing };
  const result = writeText(file, text);
  return {
    ...result,
    modelCount: Object.keys(merged.provider?.[OPENCODE_PROVIDER_ID]?.models || {}).length,
    baseURL: merged.provider?.[OPENCODE_PROVIDER_ID]?.options?.baseURL || null,
    defaultModel: merged.model || null
  };
}

export function applyDeepSeekHarness({ host, port, models, dryRun } = {}) {
  const file = deepSeekHarnessConfigPath();
  const existing = readYamlSafe(file);
  const merged = mergeDeepSeekHarnessProfile(existing, { host, port, models });
  const text = yamlText(merged);
  if (dryRun) return { path: file, preview: text, existing: yamlText(existing) };
  const result = writeText(file, text);
  return {
    ...result,
    modelCount: merged["llm-pi-ai"].providers[DEEPSEEK_HARNESS_PROVIDER_ID].models.length,
    baseURL: deepSeekHarnessBaseUrl({ host, port })
  };
}

export function applyGrok({ host, port, defaultModel, models, dryRun } = {}) {
  const file = grokConfigPath();
  const existing = readText(file);
  const text = mergeGrokProfile(existing, { host, port, defaultModel, models });
  if (dryRun) return { path: file, preview: text, existing };
  const result = writeText(file, text);
  return {
    ...result,
    modelCount: distinctModels(models).length,
    baseURL: grokBaseUrl({ host, port }),
    defaultModel: grokModelsDefault(text) || null
  };
}

export function applyProfile(id, opts = {}) {
  if (id === "codex") {
    if (opts.mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) return applyCodexOfficialDirect(opts);
    if (opts.mode === CODEX_ACCESS_MODES.PROVIDER_DIRECT) return applyCodexProviderDirect(opts);
    return applyCodex(opts);
  }
  if (id === "claude-code") return applyClaudeCode(opts);
  if (id === "hermes") return applyHermes(opts);
  if (id === "opencode") return applyOpenCode(opts);
  if (id === "deepseek-harness") return applyDeepSeekHarness(opts);
  if (id === "grok") return applyGrok(opts);
  throw new Error(`Unknown profile id: ${id}`);
}

export function restoreProfile(id) {
  if (id === "codex") return restoreLatest(codexConfigPath());
  if (id === "claude-code") return restoreLatest(claudeCodeConfigPath());
  if (id === "hermes") return restoreLatest(hermesYamlConfigPath());
  if (id === "opencode") return restoreLatest(openCodeConfigPath());
  if (id === "deepseek-harness") return restoreLatest(deepSeekHarnessConfigPath());
  if (id === "grok") return restoreLatest(grokConfigPath());
  throw new Error(`Unknown profile id: ${id}`);
}

export function restoreProfileBackup(id, backupName) {
  if (id === "codex") return restoreBackup(codexConfigPath(), backupName);
  if (id === "claude-code") return restoreBackup(claudeCodeConfigPath(), backupName);
  if (id === "hermes") return restoreBackup(hermesConfigPath(), backupName);
  if (id === "opencode") return restoreBackup(openCodeConfigPath(), backupName);
  if (id === "deepseek-harness") return restoreBackup(deepSeekHarnessConfigPath(), backupName);
  if (id === "grok") return restoreBackup(grokConfigPath(), backupName);
  throw new Error(`Unknown profile id: ${id}`);
}

export function writeProfile(filePath, contents) {
  return writeText(filePath, contents);
}

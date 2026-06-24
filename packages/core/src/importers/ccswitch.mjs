import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";

const DB_PATH = path.join(os.homedir(), ".cc-switch", "cc-switch.db");

export function findDb() { return fs.existsSync(DB_PATH) ? DB_PATH : null; }

function asciiSlug(name) {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || null;
}

function envName(slug, suffix) {
  return `SWITCHYARD_${slug.replace(/-/g, "_").toUpperCase()}_${suffix}`;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function maskKey(value) {
  if (!value) return "";
  const s = String(value);
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function catalogModelFrom(value) {
  if (!value) return null;
  if (typeof value === "string") return { id: value };
  if (typeof value !== "object") return null;
  const id = value.id || value.model || value.name || value.slug;
  if (!id || typeof id !== "string") return null;
  return {
    id,
    displayName: value.displayName || value.display_name || value.name || id,
    contextWindow: firstNumber(value.contextWindow, value.context_window, value.context_length, value.max_context_window, value.maxContextWindow),
    maxOutputTokens: firstNumber(value.maxOutputTokens, value.max_output_tokens, value.max_completion_tokens, value.output_token_limit),
    capabilities: {
      text: true,
      tools: value.capabilities?.tools !== false,
      reasoning: Boolean(value.capabilities?.reasoning || value.supports_reasoning || value.reasoning),
      images: Boolean(value.capabilities?.images || value.capabilities?.vision),
      stream: value.capabilities?.stream !== false,
      multimodal: Boolean(value.capabilities?.multimodal)
    }
  };
}

function addCatalogModel(list, value) {
  const model = catalogModelFrom(value);
  if (!model) return;
  const existing = list.find((item) => item.id === model.id);
  if (!existing) {
    list.push(model);
    return;
  }
  existing.displayName = model.displayName || existing.displayName;
  existing.contextWindow = model.contextWindow || existing.contextWindow;
  existing.maxOutputTokens = model.maxOutputTokens || existing.maxOutputTokens;
  existing.capabilities = { ...(existing.capabilities || {}), ...(model.capabilities || {}) };
}

function extractInlineKey(appType, parsed) {
  const d = parsed || {};
  if ((appType === "claude" || appType === "claude-desktop") && d.env) {
    return firstString(d.env.ANTHROPIC_AUTH_TOKEN, d.env.ANTHROPIC_API_KEY);
  }
  if (appType === "hermes") {
    return firstString(d.api_key, d.apiKey, d.env?.OPENAI_API_KEY, d.env?.API_KEY);
  }
  if (appType === "codex") {
    return firstString(d.auth?.OPENAI_API_KEY, d.auth?.api_key, d.env?.OPENAI_API_KEY);
  }
  if (appType === "gemini") {
    return firstString(d.env?.GEMINI_API_KEY, d.env?.GOOGLE_API_KEY);
  }
  return firstString(
    d.api_key,
    d.apiKey,
    d.token,
    d.auth?.OPENAI_API_KEY,
    d.env?.OPENAI_API_KEY,
    d.env?.ANTHROPIC_AUTH_TOKEN,
    d.env?.ANTHROPIC_API_KEY,
    d.env?.GEMINI_API_KEY,
    d.env?.API_KEY
  );
}

export function filterImportedConfig(result, selection = {}) {
  if (!result?.ok || !result.config) return result;
  const selectedProviders = Array.isArray(selection.providers) ? new Set(selection.providers.filter(Boolean)) : null;
  const selectedModels = Array.isArray(selection.models) ? new Set(selection.models.filter(Boolean)) : null;
  const modelProviderIds = new Set();
  const models = (result.config.models || []).filter((model) => {
    if (!model?.id || !model?.providerId) return false;
    const providerSelected = !selectedProviders || selectedProviders.has(model.providerId);
    const modelSelected = !selectedModels || selectedModels.has(model.id);
    if (modelSelected && selectedModels?.has(model.id)) modelProviderIds.add(model.providerId);
    if (selectedModels) return modelSelected;
    if (selectedProviders) return providerSelected;
    return true;
  });
  const keepProviders = new Set(modelProviderIds);
  if (selectedProviders) for (const id of selectedProviders) keepProviders.add(id);
  const providers = (result.config.providers || []).filter((provider) => {
    if (!provider?.id) return false;
    return selectedProviders || selectedModels ? keepProviders.has(provider.id) : true;
  });
  const providerIds = new Set(providers.map((provider) => provider.id));
  const finalModels = models.filter((model) => providerIds.has(model.providerId));
  const metaProviders = (result.importMeta?.providers || []).filter((meta) => providerIds.has(meta.slug));
  const dedupedFromAppTypes = (result.importMeta?.dedupedFromAppTypes || []).filter((meta) => providerIds.has(meta.slug));
  return {
    ...result,
    importMeta: {
      ...(result.importMeta || {}),
      providers: metaProviders,
      dedupedFromAppTypes
    },
    config: {
      ...result.config,
      providers,
      models: finalModels
    }
  };
}

export function importProviders({ sqlite3Cli, includeKeys = true, selection } = {}) {
  if (!fs.existsSync(DB_PATH)) return { ok: false, error: "cc-switch db not found", path: DB_PATH };
  const cli = sqlite3Cli || "sqlite3";
  let rows;
  try {
    const out = execSync(`"${cli}" -json "${DB_PATH}" "SELECT id, app_type, name, settings_config, category, provider_type FROM providers"`, { encoding: "utf8", timeout: 5000, maxBuffer: 20 * 1024 * 1024 });
    rows = JSON.parse(out || "[]");
  } catch (err) { return { ok: false, error: `sqlite3 read: ${err.message}`, path: DB_PATH }; }
  if (!rows.length) return { ok: false, error: "no providers", path: DB_PATH };

  // Merge same-name rows across app_types
  const collected = new Map();
  let fallbackIdx = 0;
  for (const row of rows) {
    let cfg = {};
    try { cfg = JSON.parse(row.settings_config || "{}"); } catch {}
    const slug = asciiSlug(row.name) || `imp-${++fallbackIdx}`;
    if (!collected.has(slug)) collected.set(slug, { slug, name: row.name, sources: [] });
    collected.get(slug).sources.push({ ...row, parsed: cfg });
  }

  const providers = [];
  const models = [];
  const importMeta = { dedupedFromAppTypes: [], providers: [], skipped: 0, warnings: [] };

  for (const [slug, entry] of collected.entries()) {
    const appTypes = entry.sources.map((s) => s.app_type);
    importMeta.dedupedFromAppTypes.push({ slug, name: entry.name, appTypes });
    let baseUrl = "";
    let apiFormat = ""; // "" means not yet determined
    let keyEnv = envName(slug, "API_KEY");
    let inlineKey = "";
    const catalogModels = [];
    let hasAnthropicEnv = false;  // true if any claude/ claude-desktop source has ANTHROPIC_BASE_URL
    let codexWireApi = "";       // from codex config TOML

    for (const s of entry.sources) {
      const d = s.parsed || {};
      const at = s.app_type;
      inlineKey = inlineKey || extractInlineKey(at, d);

      // ------ claude / claude-desktop (Anthropic-proxied) ------
      if ((at === "claude" || at === "claude-desktop") && d.env) {
        const url = d.env.ANTHROPIC_BASE_URL || "";
        if (url) {
          baseUrl = baseUrl || url;
          hasAnthropicEnv = true;
        }
        for (const ek of Object.keys(d.env || {})) {
          const v = d.env[ek];
          if (!v || typeof v !== "string") continue;
          if (ek === "ANTHROPIC_MODEL") addCatalogModel(catalogModels, v);
          else if (ek.startsWith("ANTHROPIC_DEFAULT_") && ek.endsWith("_MODEL")) addCatalogModel(catalogModels, v);
          else if (ek === "CLAUDE_CODE_SUBAGENT_MODEL") addCatalogModel(catalogModels, v);
        }
      }

      // ------ hermes (flat schema) ------
      if (at === "hermes" && (d.base_url || d.baseUrl)) {
        baseUrl = baseUrl || d.base_url || d.baseUrl;
        if (apiFormat === "") apiFormat = "openai_chat";
        if (Array.isArray(d.models)) for (const m of d.models) addCatalogModel(catalogModels, m);
        addCatalogModel(catalogModels, d.model);
      }

      // ------ codex (TOML config) ------
      if (at === "codex" && typeof d.config === "string") {
        for (const line of d.config.split("\n")) {
          const t = line.trim();
          if (t.startsWith("base_url") && t.includes("=")) {
            const v = t.split("=", 2)[1].trim().replace(/["']/g, "");
            baseUrl = baseUrl || v;
          }
          if (t.startsWith("wire_api") && t.includes("=")) {
            codexWireApi = t.split("=", 2)[1].trim().replace(/["']/g, "").toLowerCase();
          }
          if (t.startsWith("model ") || (t.startsWith("model") && !t.startsWith("model_") && t.includes("="))) {
            const v = t.split("=", 2)[1].trim().replace(/["']/g, "");
            addCatalogModel(catalogModels, v);
          }
        }
        if (d.modelCatalog && Array.isArray(d.modelCatalog.models)) {
          for (const m of d.modelCatalog.models) {
            if (!m) continue;
            addCatalogModel(catalogModels, m);
          }
        }
      }
    }

    // ------ Determine apiFormat ------
    // Rule 1: From claude/claude-desktop with ANTHROPIC_BASE_URL → anthropic_messages
    if (hasAnthropicEnv) {
      apiFormat = "anthropic_messages";
    }
    // Rule 2: For hermes/codex without anthropic env, use baseUrl inference
    if (apiFormat === "" && baseUrl) {
      const u = baseUrl.toLowerCase();
      if (u.includes("api.openai.com")) apiFormat = "openai_responses";
      else if (u.includes("api.anthropic.com")) apiFormat = "anthropic_messages";
      else apiFormat = "openai_chat";  // default
    }

    // Rule 3: Gemini-type (detect via env keys)
    if (apiFormat === "" && entry.sources.some((s) => s.parsed?.env?.GEMINI_API_KEY)) {
      apiFormat = "openai_chat";
    }

    // Rule 4: codex wire_api = "responses" only overrides when baseUrl is unknown
    // (already handled above since baseUrl infer uses url pattern)

    if (!apiFormat) apiFormat = "openai_chat";
    if (!baseUrl) {
      importMeta.skipped++;
      importMeta.warnings.push(`no baseUrl for "${entry.name}"; skipped`);
      continue;
    }

    // Normalize baseUrl: strip trailing slash
    baseUrl = baseUrl.replace(/\/+$/, "");
    let authMode = "api_key";
    let providerType = "";
    const normalizedBase = baseUrl.toLowerCase();
    if (normalizedBase.includes("chatgpt.com/backend-api/codex")) {
      apiFormat = "openai_responses";
      authMode = "codex_oauth";
      providerType = "codex_oauth";
    }
    if (normalizedBase.includes("xiaomimimo.com") && normalizedBase.endsWith("/anthropic")) {
      apiFormat = "anthropic_messages";
    } else if (normalizedBase.includes("xiaomimimo.com") && apiFormat === "openai_responses") {
      apiFormat = "openai_chat";
    }
    // For anthropic_messages, keep /anthropic suffix (it's part of the correct endpoint)
    // For openai_chat, strip /anthropic suffix since we route to /chat/completions
    if (apiFormat === "openai_chat" && baseUrl.endsWith("/anthropic")) {
      baseUrl = baseUrl.slice(0, -"/anthropic".length);
    }

    const provider = { id: slug, name: entry.name, apiFormat, baseUrl, apiKeyEnv: keyEnv };
    if (authMode !== "api_key") provider.authMode = authMode;
    if (providerType) provider.providerType = providerType;
    if (includeKeys && inlineKey) provider.apiKey = inlineKey;
    providers.push(provider);
    importMeta.providers.push({
      slug,
      name: entry.name,
      appTypes,
      apiFormat,
      baseUrl,
      keySource: inlineKey ? "inline" : keyEnv,
      hasInlineKey: Boolean(inlineKey),
      keyPreview: inlineKey ? maskKey(inlineKey) : ""
    });

    const seen = new Set();
    for (const item of catalogModels) {
      const upstream = item.id;
      if (!upstream || typeof upstream !== "string" || seen.has(upstream) || upstream.startsWith("$") || upstream.length > 80) continue;
      seen.add(upstream);
      const safe = upstream.replace(/[^a-zA-Z0-9_\-\.\/\@\+]/g, "_");
      const modelId = `${slug}/${safe}`;
      if (models.some((md) => md.id === modelId)) continue;
      models.push({
        id: modelId,
        providerId: slug,
        upstreamModel: upstream,
        displayName: item.displayName || safe,
        aliases: [upstream],
        contextWindow: item.contextWindow,
        maxOutputTokens: item.maxOutputTokens,
        capabilities: {
          text: true,
          tools: item.capabilities?.tools !== false,
          reasoning: !!item.capabilities?.reasoning,
          images: !!item.capabilities?.images,
          stream: item.capabilities?.stream !== false,
          multimodal: !!item.capabilities?.multimodal
        }
      });
    }
  }

  const result = {
    ok: true, dbPath: DB_PATH, importMeta,
    config: {
      host: "127.0.0.1", port: 17888, defaultModel: null,
      providers, models,
      clients: {
        codex: { enabled: true, allowedModels: ["*"] },
        "claude-code": { enabled: true, allowedModels: ["*"] },
        hermes: { enabled: true, allowedModels: ["*"] },
        "generic-openai": { enabled: true, allowedModels: ["*"] }
      }
    }
  };
  return filterImportedConfig(result, selection);
}

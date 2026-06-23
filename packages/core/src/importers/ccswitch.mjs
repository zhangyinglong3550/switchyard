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

export function importProviders({ sqlite3Cli } = {}) {
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
  const importMeta = { dedupedFromAppTypes: [], skipped: 0, warnings: [] };

  for (const [slug, entry] of collected.entries()) {
    const appTypes = entry.sources.map((s) => s.app_type);
    importMeta.dedupedFromAppTypes.push({ slug, name: entry.name, appTypes });
    let baseUrl = "";
    let apiFormat = ""; // "" means not yet determined
    let keyEnv = envName(slug, "API_KEY");
    const catalogModels = [];
    let hasAnthropicEnv = false;  // true if any claude/ claude-desktop source has ANTHROPIC_BASE_URL
    let codexWireApi = "";       // from codex config TOML

    for (const s of entry.sources) {
      const d = s.parsed || {};
      const at = s.app_type;

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
          if (ek === "ANTHROPIC_MODEL") { if (!catalogModels.includes(v)) catalogModels.push(v); }
          else if (ek.startsWith("ANTHROPIC_DEFAULT_") && ek.endsWith("_MODEL")) { if (!catalogModels.includes(v)) catalogModels.push(v); }
          else if (ek === "CLAUDE_CODE_SUBAGENT_MODEL") { if (!catalogModels.includes(v)) catalogModels.push(v); }
        }
      }

      // ------ hermes (flat schema) ------
      if (at === "hermes" && (d.base_url || d.baseUrl)) {
        baseUrl = baseUrl || d.base_url || d.baseUrl;
        if (apiFormat === "") apiFormat = "openai_chat";
        if (Array.isArray(d.models)) for (const m of d.models) {
          const mid = m && (m.id || m.name);
          if (mid && !catalogModels.includes(mid)) catalogModels.push(mid);
        }
        if (d.model && typeof d.model === "string" && !catalogModels.includes(d.model)) catalogModels.push(d.model);
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
            if (v && !catalogModels.includes(v)) catalogModels.push(v);
          }
        }
        if (d.modelCatalog && Array.isArray(d.modelCatalog.models)) {
          for (const m of d.modelCatalog.models) {
            if (!m) continue;
            const mid = m.id || m.model || (typeof m === "string" ? m : null);
            if (mid && !catalogModels.includes(mid)) catalogModels.push(mid);
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
    // For anthropic_messages, keep /anthropic suffix (it's part of the correct endpoint)
    // For openai_chat, strip /anthropic suffix since we route to /chat/completions
    if (apiFormat === "openai_chat" && baseUrl.endsWith("/anthropic")) {
      baseUrl = baseUrl.slice(0, -"/anthropic".length);
    }

    providers.push({ id: slug, name: entry.name, apiFormat, baseUrl, apiKeyEnv: keyEnv });

    const seen = new Set();
    for (const m of catalogModels) {
      if (!m || typeof m !== "string" || seen.has(m) || m.startsWith("$") || m.length > 80) continue;
      seen.add(m);
      const safe = m.replace(/[^a-zA-Z0-9_\-\.\/\@\+]/g, "_");
      const modelId = `${slug}/${safe}`;
      if (models.some((md) => md.id === modelId)) continue;
      models.push({
        id: modelId, providerId: slug, upstreamModel: m, displayName: safe,
        aliases: [], capabilities: { text: true, tools: true, reasoning: false, images: false }
      });
    }
  }

  return {
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
}

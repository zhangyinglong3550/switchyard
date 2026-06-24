import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeFixtureDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-ccswitch-"));
  const dbPath = path.join(tmp, "cc-switch.db");
  const sql = `
    CREATE TABLE providers (
      id TEXT NOT NULL,
      app_type TEXT NOT NULL,
      name TEXT NOT NULL,
      settings_config TEXT NOT NULL,
      website_url TEXT, category TEXT, created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
      meta TEXT NOT NULL DEFAULT '{}',
      is_current BOOLEAN DEFAULT 0,
      in_failover_queue BOOLEAN DEFAULT 0,
      cost_multiplier TEXT DEFAULT '1.0',
      limit_daily_usd TEXT, limit_monthly_usd TEXT, provider_type TEXT,
      PRIMARY KEY (id, app_type)
    );
  `;
  execSync(`sqlite3 "${dbPath}" "${sql.replace(/\s+/g, " ")}"`);
  return { tmp, dbPath };
}

function insertProvider(dbPath, row) {
  // safer: use parameterized via temp .sql file
  const sqlFile = path.join(path.dirname(dbPath), `ins-${Math.random().toString(36).slice(2)}.sql`);
  const esc = (s) => String(s).replace(/'/g, "''");
  fs.writeFileSync(sqlFile, `INSERT INTO providers (id, app_type, name, settings_config, category, provider_type) VALUES ('${esc(row.id)}','${esc(row.app_type)}','${esc(row.name)}','${esc(JSON.stringify(row.cfg))}','${esc(row.category || "")}','${esc(row.provider_type || "")}');`);
  execSync(`sqlite3 "${dbPath}" < "${sqlFile}"`);
  fs.unlinkSync(sqlFile);
}

test("importer · anthropic-proxied via claude env produces anthropic_messages", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  insertProvider(dbPath, {
    id: "x1", app_type: "claude", name: "DeepSeek",
    cfg: { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_AUTH_TOKEN: "REDACTED", ANTHROPIC_MODEL: "deepseek-v4-pro", ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash" } },
    category: "cn_official"
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  process.env.HOME_OVERRIDE_FOR_TEST = tmp;
  const fakeHome = tmp;
  // Monkey-patch HOME to point at fixture: importer reads ~/.cc-switch/cc-switch.db
  fs.mkdirSync(path.join(fakeHome, ".cc-switch"), { recursive: true });
  fs.copyFileSync(dbPath, path.join(fakeHome, ".cc-switch", "cc-switch.db"));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
    const r = mod.importProviders();
    assert.equal(r.ok, true);
    const p = r.config.providers.find((p) => p.id === "deepseek");
    assert.equal(p.apiFormat, "anthropic_messages");
    assert.equal(p.baseUrl, "https://api.deepseek.com/anthropic");
    const m = r.config.models.find((m) => m.id === "deepseek/deepseek-v4-pro");
    assert.ok(m);
  } finally { process.env.HOME = prevHome; }
});

test("importer · hermes flat schema produces openai_chat", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  insertProvider(dbPath, {
    id: "h1", app_type: "hermes", name: "Kimi Local",
    cfg: {
      name: "kimi-local",
      base_url: "https://api.moonshot.cn/v1",
      api_key: "REDACTED",
      api_mode: "chat_completions",
      models: [
        { id: "moonshot-v1-32k", name: "Kimi 32k", context_length: 32000, max_output_tokens: 8192 },
        { id: "moonshot-v1-128k", name: "Kimi 128k", context_length: 128000, max_output_tokens: 8192 }
      ]
    }
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".cc-switch"), { recursive: true });
  fs.copyFileSync(dbPath, path.join(tmp, ".cc-switch", "cc-switch.db"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
    const r = mod.importProviders();
    const p = r.config.providers.find((p) => p.id === "kimi-local");
    assert.equal(p.apiFormat, "openai_chat");
    assert.equal(p.baseUrl, "https://api.moonshot.cn/v1");
    assert.equal(p.apiKeyEnv, "SWITCHYARD_KIMI_LOCAL_API_KEY");
    assert.equal(r.config.models.length, 2);
    const model = r.config.models.find((m) => m.id === "kimi-local/moonshot-v1-32k");
    assert.equal(model.displayName, "Kimi 32k");
    assert.deepEqual(model.aliases, ["moonshot-v1-32k"]);
    assert.equal(model.contextWindow, 32000);
    assert.equal(model.maxOutputTokens, 8192);
    assert.equal(model.capabilities.text, true);
    assert.equal(model.capabilities.tools, true);
    assert.equal(model.capabilities.stream, true);
  } finally { process.env.HOME = prevHome; }
});

test("importer · codex TOML config respects wire_api responses", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  const toml = `model_provider = "custom"\nmodel = "z-ai/glm-5.2-free"\n\n[model_providers.custom]\nname = "custom"\nwire_api = "responses"\nbase_url = "https://zenmux.ai/api/v1"\n`;
  insertProvider(dbPath, {
    id: "c1", app_type: "codex", name: "zenmux",
    cfg: {
      auth: { OPENAI_API_KEY: "REDACTED" },
      config: toml,
      modelCatalog: {
        models: [
          {
            displayName: "glm 5.2",
            model: "z-ai/glm-5.2-free",
            contextWindow: 128000,
            maxOutputTokens: 32000,
            capabilities: { reasoning: true, tools: true, stream: true }
          }
        ]
      }
    }
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".cc-switch"), { recursive: true });
  fs.copyFileSync(dbPath, path.join(tmp, ".cc-switch", "cc-switch.db"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
    const r = mod.importProviders();
    const p = r.config.providers.find((p) => p.id === "zenmux");
    // OpenAI api host inference would say openai_responses for api.openai.com; for
    // zenmux URL it falls into the default openai_chat branch. Confirm.
    assert.equal(p.baseUrl, "https://zenmux.ai/api/v1");
    // We expect openai_chat because zenmux base url is not OpenAI itself
    assert.equal(p.apiFormat, "openai_chat");
    const model = r.config.models.find((m) => m.id === "zenmux/z-ai/glm-5.2-free");
    assert.ok(model);
    assert.equal(model.displayName, "glm 5.2");
    assert.deepEqual(model.aliases, ["z-ai/glm-5.2-free"]);
    assert.equal(model.contextWindow, 128000);
    assert.equal(model.maxOutputTokens, 32000);
    assert.equal(model.capabilities.reasoning, true);
  } finally { process.env.HOME = prevHome; }
});

test("importer · known cc-switch providers normalize Codex OAuth and Xiaomi protocols", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  insertProvider(dbPath, {
    id: "codex-claude", app_type: "claude", name: "Codex",
    cfg: {
      env: {
        ANTHROPIC_BASE_URL: "https://chatgpt.com/backend-api/codex",
        ANTHROPIC_MODEL: "gpt-5.5"
      }
    }
  });
  insertProvider(dbPath, {
    id: "mimo-codex", app_type: "codex", name: "Xiaomi MiMo",
    cfg: {
      auth: { OPENAI_API_KEY: "REDACTED" },
      config: 'model_provider = "custom"\nmodel = "mimo-v2.5-pro"\n\n[model_providers.custom]\nname = "xiaomi_mimo"\nwire_api = "responses"\nbase_url = "https://api.xiaomimimo.com/v1"\n',
      modelCatalog: { models: [{ model: "mimo-v2.5-pro", displayName: "MiMo V2.5 Pro", contextWindow: 1048576 }] }
    }
  });
  insertProvider(dbPath, {
    id: "mimo-claude", app_type: "claude", name: "Xiaomi MiMo Anthropic",
    cfg: {
      env: {
        ANTHROPIC_BASE_URL: "https://api.xiaomimimo.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "REDACTED",
        ANTHROPIC_MODEL: "mimo-v2.5-pro"
      }
    }
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".cc-switch"), { recursive: true });
  fs.copyFileSync(dbPath, path.join(tmp, ".cc-switch", "cc-switch.db"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
    const r = mod.importProviders();
    const codex = r.config.providers.find((p) => p.id === "codex");
    assert.equal(codex.apiFormat, "openai_responses");
    assert.equal(codex.authMode, "codex_oauth");
    assert.equal(codex.providerType, "codex_oauth");

    const mimoChat = r.config.providers.find((p) => p.id === "xiaomi-mimo");
    assert.equal(mimoChat.apiFormat, "openai_chat");
    assert.equal(mimoChat.baseUrl, "https://api.xiaomimimo.com/v1");

    const mimoAnthropic = r.config.providers.find((p) => p.id === "xiaomi-mimo-anthropic");
    assert.equal(mimoAnthropic.apiFormat, "anthropic_messages");
    assert.equal(mimoAnthropic.baseUrl, "https://api.xiaomimimo.com/anthropic");
  } finally { process.env.HOME = prevHome; }
});

test("importer · inline api keys are preserved for same-machine import by default", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  insertProvider(dbPath, {
    id: "x", app_type: "claude", name: "VendorX",
    cfg: { env: { ANTHROPIC_BASE_URL: "https://x.example.com", ANTHROPIC_AUTH_TOKEN: "sk-LIVE-KEY-DO-NOT-COMMIT" } }
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".cc-switch"), { recursive: true });
  fs.copyFileSync(dbPath, path.join(tmp, ".cc-switch", "cc-switch.db"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
    const r = mod.importProviders();
    const p = r.config.providers.find((p) => p.id === "vendorx");
    assert.ok(p);
    assert.ok(p.apiKeyEnv);
    assert.equal(p.apiKey, "sk-LIVE-KEY-DO-NOT-COMMIT");
    const meta = r.importMeta.providers.find((p) => p.slug === "vendorx");
    assert.equal(meta.hasInlineKey, true);
    assert.equal(meta.keyPreview, "sk-L••••MMIT");
    assert.equal(JSON.stringify(r.importMeta).includes("sk-LIVE-KEY-DO-NOT-COMMIT"), false);
  } finally { process.env.HOME = prevHome; }
});

test("importer · includeKeys=false keeps previous redacted behavior", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  insertProvider(dbPath, {
    id: "x", app_type: "claude", name: "VendorX",
    cfg: { env: { ANTHROPIC_BASE_URL: "https://x.example.com", ANTHROPIC_AUTH_TOKEN: "sk-LIVE-KEY-DO-NOT-COMMIT" } }
  });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".cc-switch"), { recursive: true });
  fs.copyFileSync(dbPath, path.join(tmp, ".cc-switch", "cc-switch.db"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
    const r = mod.importProviders({ includeKeys: false });
    const dump = JSON.stringify(r);
    assert.equal(dump.includes("sk-LIVE-KEY-DO-NOT-COMMIT"), false);
    const p = r.config.providers.find((p) => p.id === "vendorx");
    assert.ok(p);
    assert.ok(p.apiKeyEnv);
    assert.equal("apiKey" in p, false);
  } finally { process.env.HOME = prevHome; }
});

test("importer · filters parsed cc-switch config to selected providers and models", async () => {
  const mod = await import(`../src/importers/ccswitch.mjs?v=${Date.now()}`);
  const imported = {
    ok: true,
    importMeta: {
      providers: [
        { slug: "p1", name: "Provider 1" },
        { slug: "p2", name: "Provider 2" }
      ],
      dedupedFromAppTypes: [
        { slug: "p1", name: "Provider 1" },
        { slug: "p2", name: "Provider 2" }
      ],
      skipped: 0,
      warnings: []
    },
    config: {
      host: "127.0.0.1",
      port: 17888,
      defaultModel: null,
      providers: [
        { id: "p1", name: "Provider 1", apiFormat: "openai_chat", baseUrl: "https://p1.example.com", apiKey: "secret-1" },
        { id: "p2", name: "Provider 2", apiFormat: "openai_chat", baseUrl: "https://p2.example.com", apiKey: "secret-2" }
      ],
      models: [
        { id: "p1/model-a", providerId: "p1", upstreamModel: "model-a" },
        { id: "p1/model-b", providerId: "p1", upstreamModel: "model-b" },
        { id: "p2/model-c", providerId: "p2", upstreamModel: "model-c" }
      ],
      clients: {
        codex: { enabled: true, allowedModels: ["*"] },
        "claude-code": { enabled: true, allowedModels: ["*"] }
      }
    }
  };

  const filtered = mod.filterImportedConfig(imported, {
    providers: ["p1"],
    models: ["p1/model-b", "p2/model-c"]
  });

  assert.deepEqual(filtered.config.providers.map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(filtered.config.models.map((m) => m.id), ["p1/model-b", "p2/model-c"]);
  assert.deepEqual(filtered.importMeta.providers.map((p) => p.slug), ["p1", "p2"]);
  assert.equal(filtered.config.providers.find((p) => p.id === "p1").apiKey, "secret-1");
});

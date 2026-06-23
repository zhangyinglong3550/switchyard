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
    cfg: { name: "kimi-local", base_url: "https://api.moonshot.cn/v1", api_key: "REDACTED", api_mode: "chat_completions", models: [{ id: "moonshot-v1-32k", name: "Kimi 32k" }, { id: "moonshot-v1-128k", name: "Kimi 128k" }] }
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
  } finally { process.env.HOME = prevHome; }
});

test("importer · codex TOML config respects wire_api responses", async (t) => {
  const { tmp, dbPath } = makeFixtureDb();
  const toml = `model_provider = "custom"\nmodel = "z-ai/glm-5.2-free"\n\n[model_providers.custom]\nname = "custom"\nwire_api = "responses"\nbase_url = "https://zenmux.ai/api/v1"\n`;
  insertProvider(dbPath, {
    id: "c1", app_type: "codex", name: "zenmux",
    cfg: { auth: { OPENAI_API_KEY: "REDACTED" }, config: toml, modelCatalog: { models: [{ displayName: "glm 5.2", model: "z-ai/glm-5.2-free" }] } }
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
    assert.ok(r.config.models.find((m) => m.id === "zenmux/z-ai/glm-5.2-free"));
  } finally { process.env.HOME = prevHome; }
});

test("importer · no inline api keys leak into output", async (t) => {
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
    const dump = JSON.stringify(r);
    assert.equal(dump.includes("sk-LIVE-KEY-DO-NOT-COMMIT"), false);
    const p = r.config.providers.find((p) => p.id === "vendorx");
    assert.ok(p);
    assert.ok(p.apiKeyEnv);
    assert.equal("apiKey" in p, false);
  } finally { process.env.HOME = prevHome; }
});

#!/usr/bin/env node
// Dry-run / apply importer CLI for cc-switch → Switchyard.
//
//   npm run import:ccswitch                # dry-run, print mapped config to stdout
//   npm run import:ccswitch -- --apply     # write to ~/.switchyard/config.json
//   npm run import:ccswitch -- --output X  # write to alternative path
//
// Policy: never prints raw api keys. Only env-var names are emitted.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { importProviders, findDb } from "../packages/core/src/importers/ccswitch.mjs";
import { saveConfig, mergeWithDefaults, validateConfig } from "../packages/core/src/config.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const outIdx = args.indexOf("--output");
const customOutput = outIdx >= 0 ? args[outIdx + 1] : null;

const db = findDb();
if (!db) {
  console.error("[import] cc-switch database not found at ~/.cc-switch/cc-switch.db");
  process.exit(2);
}

const result = importProviders();
if (!result.ok) {
  console.error("[import] failed:", result.error);
  process.exit(3);
}

const cfg = mergeWithDefaults(result.config);
try { validateConfig(cfg); }
catch (err) {
  console.error("[import] validation failed:", err.message);
  console.error(JSON.stringify(cfg, null, 2));
  process.exit(4);
}

const summary = {
  source: db,
  providers: cfg.providers.length,
  models: cfg.models.length,
  skipped: result.importMeta.skipped,
  envVarsToSet: cfg.providers
    .filter((p) => p.apiKeyEnv)
    .map((p) => ({ provider: p.id, env: p.apiKeyEnv }))
};

if (!apply) {
  console.log("# DRY RUN — no files written.\n# Mapped Switchyard config:\n");
  console.log(JSON.stringify(cfg, null, 2));
  console.log("\n# Summary:");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n# To apply: npm run import:ccswitch -- --apply");
  process.exit(0);
}

const target = customOutput || path.join(process.env.HOME || "", ".switchyard", "config.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
const backupTarget = `${target}.before-ccswitch-import.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
if (fs.existsSync(target)) fs.copyFileSync(target, backupTarget);
process.env.SWITCHYARD_CONFIG = target;
saveConfig(cfg, target);

console.log(JSON.stringify({
  ok: true,
  written: target,
  backedUp: fs.existsSync(backupTarget) ? backupTarget : null,
  ...summary
}, null, 2));

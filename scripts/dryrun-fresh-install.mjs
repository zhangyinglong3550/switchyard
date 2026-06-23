// Headless fresh-install dryrun.
// 1) Backup current ~/.switchyard
// 2) Delete it (simulates new machine)
// 3) Run import:ccswitch through the core API (same path the UI uses)
// 4) Persist and verify
// 5) Start gateway and verify /v1/models for each client
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { importProviders } from "../packages/core/src/importers/ccswitch.mjs";
import { ensureConfig, readConfig, saveValidated } from "../apps/desktop/src/config-store.mjs";

const HOME = os.homedir();
const SY_HOME = path.join(HOME, ".switchyard");
const BACKUP_DIR = "/Users/zhangyinglong/file/codex/local-llm-switchboard-v0x-verify/dryrun-backup";

console.log("Step 1: backup current ~/.switchyard");
fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (fs.existsSync(SY_HOME)) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const tgt = path.join(BACKUP_DIR, `switchyard-pre-dryrun-${ts}.tar`);
  await new Promise((r, j) => {
    const ch = spawn("tar", ["-cf", tgt, "-C", HOME, ".switchyard"], { stdio: "inherit" });
    ch.on("exit", (code) => code === 0 ? r() : j(new Error(`tar exit ${code}`)));
  });
  console.log("  → backed up to", tgt);
}

console.log("Step 2: remove ~/.switchyard");
fs.rmSync(SY_HOME, { recursive: true, force: true });

console.log("Step 3: ensureConfig() (simulates first launch)");
ensureConfig();
const empty = readConfig();
console.log("  empty.providers:", empty.providers.length, "  models:", empty.models.length);

console.log("Step 4: import:ccswitch (simulates first-launch onboarding dialog)");
const result = importProviders();
if (!result.ok) {
  console.error("  import failed:", result.error);
  process.exit(1);
}
console.log("  import.providers:", result.config.providers.length);
console.log("  import.models   :", result.config.models.length);
console.log("  import.deduped  :", result.importMeta.dedupedFromAppTypes.length);

let leakedKey = false;
for (const p of result.config.providers) if (p.apiKey) { leakedKey = true; break; }
console.log("  inline API Key leak:", leakedKey ? "YES (BUG!)" : "no");

console.log("Step 5: merge to config and save");
const merged = { ...empty, providers: result.config.providers, models: result.config.models };
saveValidated(merged);
const after = readConfig();
console.log("  merged.providers:", after.providers.length, "  models:", after.models.length);

console.log("Step 6: start gateway and probe /v1/models");
const { startGateway, stopGateway, statusFromServer } = await import("../apps/desktop/src/gateway-host.mjs");
await startGateway();
const status = statusFromServer();
console.log("  gateway port:", status.port);

const base = `http://${status.host}:${status.port}`;
const codex = await (await fetch(`${base}/codex/v1/models`)).json();
const cc = await (await fetch(`${base}/claude-code/v1/models`)).json();
const hermes = await (await fetch(`${base}/hermes/v1/models`)).json();
const generic = await (await fetch(`${base}/v1/models`)).json();
console.log("  codex.models       :", codex.data?.length || 0);
console.log("  claude-code.models :", cc.data?.length || 0);
console.log("  hermes.models      :", hermes.data?.length || 0);
console.log("  generic.models     :", generic.data?.length || 0);

await stopGateway();

console.log("");
console.log("---verification---");
const checks = [
  ["empty.providers === 0", empty.providers.length === 0],
  ["import succeeded", result.ok === true],
  ["import.providers > 0", result.config.providers.length > 0],
  ["import.models > 0", result.config.models.length > 0],
  ["no inline API key leaked", !leakedKey],
  ["merged into config", after.providers.length > 0],
  ["codex sees models", (codex.data?.length || 0) > 0],
  ["claude-code sees models", (cc.data?.length || 0) > 0],
  ["hermes sees models", (hermes.data?.length || 0) > 0],
  ["generic sees models", (generic.data?.length || 0) > 0]
];
let allPass = true;
for (const [name, ok] of checks) {
  console.log(`  [${ok ? "✓" : "✘"}] ${name}`);
  if (!ok) allPass = false;
}

console.log("");
console.log(allPass ? "✓ DRYRUN PASS" : "✘ DRYRUN FAIL");
console.log("Note: ~/.switchyard now contains the imported config from this dryrun.");
console.log("Original backed up to:", BACKUP_DIR);
process.exit(allPass ? 0 : 1);

#!/usr/bin/env node
// Sanity gate before any DMG / Release: lint config, run tests, and confirm
// no sensitive material (api keys, tokens) is committed to config templates.
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function log(step, ok, detail = "") {
  const flag = ok ? "OK " : "FAIL";
  console.log(`[${flag}] ${step}${detail ? " - " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

// 1. Templates must not contain inline keys.
const template = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "config.example.json"), "utf8"));
let inlineKey = false;
for (const provider of template.providers) {
  if (provider.apiKey) inlineKey = true;
}
log("config.example.json contains no inline apiKey", !inlineKey);

// 2. core tests pass.
try {
  execSync("node --test packages/core/test/*.mjs", { cwd: ROOT, stdio: "inherit" });
  log("core unit tests pass", true);
} catch {
  log("core unit tests pass", false);
}

// 3. node --check for runtime files (mirrors npm run check).
const files = [
  "packages/core/src/config.mjs",
  "packages/core/src/router.mjs",
  "packages/core/src/upstream.mjs",
  "packages/core/src/utils.mjs",
  "packages/core/src/server.mjs",
  "packages/core/src/openai-adapter.mjs",
  "packages/core/src/anthropic-adapter.mjs",
  "packages/core/src/profile-writer.mjs",
  "packages/core/src/compat/index.mjs",
  "packages/core/bin/gateway.mjs",
  "apps/desktop/src/main.mjs",
  "apps/desktop/src/preload.cjs",
  "apps/desktop/src/gateway-host.mjs",
  "apps/desktop/src/config-store.mjs",
  "apps/desktop/src/logs.mjs",
  "apps/desktop/renderer/renderer.js"
];
let syntaxOk = true;
for (const file of files) {
  try {
    execSync(`node --check ${JSON.stringify(file)}`, { cwd: ROOT, stdio: "ignore" });
  } catch (err) {
    syntaxOk = false;
    console.error("syntax check failed for", file);
  }
}
log("syntax check (node --check)", syntaxOk);

// 4. macOS DMG prerequisites (informational only, never fatal).
const builderJson = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(builderJson, "utf8"));
log("electron-builder mac config exists", Boolean(pkg.build?.mac));

// 5. renderer assets must exist.
const rendererAssets = [
  "apps/desktop/renderer/index.html",
  "apps/desktop/renderer/styles.css",
  "apps/desktop/renderer/renderer.js"
];
let rendererOk = true;
for (const file of rendererAssets) {
  if (!fs.existsSync(path.join(ROOT, file))) { rendererOk = false; console.error("missing renderer asset:", file); }
}
log("renderer assets present", rendererOk);

// 6. dispatch + matrix + importer + ccswitch importer must be present.
const requiredCore = [
  "packages/core/src/upstream/clients.mjs",
  "packages/core/src/upstream/dispatch.mjs",
  "packages/core/src/openai-adapter-out.mjs",
  "packages/core/src/anthropic-adapter-out.mjs",
  "packages/core/src/importers/ccswitch.mjs"
];
let coreOk = true;
for (const file of requiredCore) {
  if (!fs.existsSync(path.join(ROOT, file))) { coreOk = false; console.error("missing core asset:", file); }
}
log("core dispatch + importer assets present", coreOk);

// 7. V0.5 deliverables.
const v05Assets = [
  "INSTALL.zh-CN.md",
  "README.md",
  "docs/HANDOFF-V0.2.zh-CN.md",
  "docs/HANDOFF-V0.3.zh-CN.md",
  "docs/HANDOFF-V0.4.zh-CN.md"
];
let v05Ok = true;
for (const file of v05Assets) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    v05Ok = false;
    console.error("missing V0.5 asset:", file);
  }
}
log("V0.5 docs present", v05Ok);

// 8. V0.4 compat patches present
const v04Patches = [
  "packages/core/src/compat/patches/kimi-tool-schema.mjs",
  "packages/core/src/compat/patches/deepseek-reasoning.mjs",
  "packages/core/src/compat/patches/glm-content-text.mjs",
  "packages/core/src/compat/patches/opencode-tool-history.mjs",
  "packages/core/src/compat/patches/official-gpt-fallback.mjs"
];
let v04Ok = true;
for (const file of v04Patches) {
  if (!fs.existsSync(path.join(ROOT, file))) { v04Ok = false; console.error("missing V0.4 patch:", file); }
}
log("V0.4 compat patches present", v04Ok);



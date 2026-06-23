// Writes/restores client profiles (Codex / Claude Code / Hermes).
// V0.3: real read/write with timestamped backups under ~/.switchyard/backups,
// plus restore from latest backup.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupDir, ensureDir, nowIso } from "./utils.mjs";

export function codexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function claudeCodeConfigPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function hermesConfigPath() {
  return path.join(os.homedir(), ".hermes", "config.json");
}

export function profileTargets() {
  return {
    codex: codexConfigPath(),
    "claude-code": claudeCodeConfigPath(),
    hermes: hermesConfigPath()
  };
}

const SWITCHYARD_PROVIDER = "switchyard";
const SWITCHYARD_ENV_KEY = "SWITCHYARD_KEY";
const MARKER = "managed-by-switchyard";

// ---------- Codex (TOML) ----------

function stripSwitchyardCodexBlock(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw;
    if (/^\[model_providers\.switchyard\]/.test(line.trim())) { inBlock = true; continue; }
    if (inBlock) {
      // ends at next [section] header or EOF
      if (/^\[[^\]]+\]/.test(line.trim())) { inBlock = false; out.push(line); continue; }
      continue;
    }
    // Drop top-level lines that pin to switchyard so we replace them cleanly.
    if (/^model_provider\s*=/.test(line.trim()) && line.includes("switchyard")) continue;
    if (/^model\s*=/.test(line.trim()) && /switchyard\b/.test(text)) continue;
    if (/^#\s*managed-by:\s*switchyard/.test(line.trim())) continue;
    out.push(line);
  }
  // Collapse trailing blank lines
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

export function renderCodexProfile({ host, port, defaultModel } = {}) {
  const base = `http://${host || "127.0.0.1"}:${port || 17888}/codex/v1`;
  const lines = [
    `# managed-by: ${MARKER}`,
    `model_provider = "${SWITCHYARD_PROVIDER}"`
  ];
  if (defaultModel) lines.push(`model = "${defaultModel}"`);
  lines.push(
    "",
    `[model_providers.${SWITCHYARD_PROVIDER}]`,
    `name = "Switchyard"`,
    `base_url = "${base}"`,
    `wire_api = "responses"`,
    `env_key = "${SWITCHYARD_ENV_KEY}"`
  );
  return lines.join("\n") + "\n";
}

export function mergeCodexProfile(existing, { host, port, defaultModel } = {}) {
  const stripped = stripSwitchyardCodexBlock(existing || "");
  const switchyardBlock = renderCodexProfile({ host, port, defaultModel });
  if (!stripped) return switchyardBlock;
  return stripped.replace(/\s+$/, "") + "\n\n" + switchyardBlock;
}

// ---------- Claude Code (JSON) ----------

export function renderClaudeCodeProfile({ host, port } = {}) {
  return {
    [MARKER]: true,
    env: {
      ANTHROPIC_BASE_URL: `http://${host || "127.0.0.1"}:${port || 17888}/claude-code`,
      ANTHROPIC_AUTH_TOKEN: `\${${SWITCHYARD_ENV_KEY}}`,
      ANTHROPIC_API_KEY: `\${${SWITCHYARD_ENV_KEY}}`
    }
  };
}

export function mergeClaudeCodeProfile(existing, { host, port } = {}) {
  const next = existing && typeof existing === "object" ? { ...existing } : {};
  const patch = renderClaudeCodeProfile({ host, port });
  next[MARKER] = true;
  next.env = { ...(next.env || {}), ...patch.env };
  return next;
}

// ---------- Hermes (JSON) ----------

export function renderHermesProfile({ host, port } = {}) {
  return {
    [MARKER]: true,
    baseUrl: `http://${host || "127.0.0.1"}:${port || 17888}/hermes/v1`,
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
  return renderCodexProfile(target);
}
export function previewClaudeCodeProfile(target) {
  return JSON.stringify(renderClaudeCodeProfile(target), null, 2);
}
export function previewHermesProfile(target) {
  return JSON.stringify(renderHermesProfile(target), null, 2);
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
    .map((name) => ({ name, full: path.join(dir, name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function restoreLatest(filePath) {
  const list = listBackups(filePath);
  if (!list.length) return { ok: false, reason: "no-backup" };
  fs.copyFileSync(list[0].full, filePath);
  return { ok: true, restoredFrom: list[0].full };
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

export function applyCodex({ host, port, defaultModel, dryRun } = {}) {
  const file = codexConfigPath();
  const existing = readText(file);
  const next = mergeCodexProfile(existing, { host, port, defaultModel });
  if (dryRun) return { path: file, preview: next, existing };
  return writeText(file, next);
}

export function applyClaudeCode({ host, port, dryRun } = {}) {
  const file = claudeCodeConfigPath();
  const existing = readJsonSafe(file);
  const merged = mergeClaudeCodeProfile(existing, { host, port });
  const text = JSON.stringify(merged, null, 2) + "\n";
  if (dryRun) return { path: file, preview: text, existing };
  return writeText(file, text);
}

export function applyHermes({ host, port, dryRun } = {}) {
  const file = hermesConfigPath();
  const existing = readJsonSafe(file);
  const merged = mergeHermesProfile(existing, { host, port });
  const text = JSON.stringify(merged, null, 2) + "\n";
  if (dryRun) return { path: file, preview: text, existing };
  return writeText(file, text);
}

export function applyProfile(id, opts) {
  if (id === "codex") return applyCodex(opts);
  if (id === "claude-code") return applyClaudeCode(opts);
  if (id === "hermes") return applyHermes(opts);
  throw new Error(`Unknown profile id: ${id}`);
}

export function restoreProfile(id) {
  if (id === "codex") return restoreLatest(codexConfigPath());
  if (id === "claude-code") return restoreLatest(claudeCodeConfigPath());
  if (id === "hermes") return restoreLatest(hermesConfigPath());
  throw new Error(`Unknown profile id: ${id}`);
}

export function writeProfile(filePath, contents) {
  return writeText(filePath, contents);
}

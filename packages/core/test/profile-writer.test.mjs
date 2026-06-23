import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-profile-"));
process.env.HOME = tmpHome;
process.env.SWITCHYARD_BACKUP_DIR = path.join(tmpHome, ".switchyard", "backups");

const pw = await import("../src/profile-writer.mjs");

test("codex profile · merges with existing TOML without losing user blocks", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[mcp]\nfoo = "bar"\n', "utf8");

  const r = pw.applyCodex({ host: "127.0.0.1", port: 17888, defaultModel: "kimi/k2" });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /\[mcp\]/);
  assert.match(text, /foo = "bar"/);
  assert.match(text, /model_provider = "switchyard"/);
  assert.match(text, /\[model_providers\.switchyard\]/);
  assert.match(text, /wire_api = "responses"/);
  assert.match(text, /env_key = "SWITCHYARD_KEY"/);
  assert.match(text, /model = "kimi\/k2"/);
  assert.ok(r.backup, "backup created");
});

test("codex profile · re-apply replaces old switchyard block, not duplicates", () => {
  const file = pw.codexConfigPath();
  // already applied once above
  pw.applyCodex({ host: "127.0.0.1", port: 18999 });
  const text = fs.readFileSync(file, "utf8");
  const occurrences = (text.match(/\[model_providers\.switchyard\]/g) || []).length;
  assert.equal(occurrences, 1, "switchyard block should not duplicate");
  assert.match(text, /:18999/);
});

test("claude-code profile · merges into existing settings.json env without dropping unrelated keys", () => {
  const file = pw.claudeCodeConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ env: { OTHER_KEY: "keep" }, theme: "dark" }, null, 2), "utf8");

  pw.applyClaudeCode({ host: "127.0.0.1", port: 17888 });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.env.OTHER_KEY, "keep");
  assert.equal(parsed.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:17888/claude-code");
  assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, "${SWITCHYARD_KEY}");
  assert.equal(parsed["managed-by-switchyard"], true);
});

test("hermes profile · creates file when absent", () => {
  const file = pw.hermesConfigPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
  pw.applyHermes({ host: "127.0.0.1", port: 17888 });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.baseUrl, "http://127.0.0.1:17888/hermes/v1");
  assert.equal(parsed.apiKeyEnv, "SWITCHYARD_KEY");
});

test("restoreProfile · restores from latest backup", () => {
  const file = pw.codexConfigPath();
  const originalText = fs.readFileSync(file, "utf8");
  // create a fresh marker text so we can detect restore
  fs.writeFileSync(file, "# replaced\n", "utf8");
  const r = pw.restoreProfile("codex");
  assert.equal(r.ok, true);
  const restored = fs.readFileSync(file, "utf8");
  assert.notEqual(restored, "# replaced\n");
  assert.match(restored, /model_providers\.switchyard|mcp/);
});

test("restoreProfile · returns no-backup when file never backed up", () => {
  // claude-code file currently has a backup from applyClaudeCode; force the path
  // to a clean file with no backups.
  const fakePath = path.join(tmpHome, "no-backups.json");
  fs.writeFileSync(fakePath, "{}", "utf8");
  const list = pw.listBackups(fakePath);
  assert.equal(list.length, 0);
});

test("profile dry-run · does not write to disk", () => {
  const file = pw.hermesConfigPath();
  const before = fs.readFileSync(file, "utf8");
  const r = pw.applyHermes({ host: "10.0.0.1", port: 99999, dryRun: true });
  const after = fs.readFileSync(file, "utf8");
  assert.equal(before, after, "dry run must not mutate file");
  assert.match(r.preview, /10\.0\.0\.1:99999/);
});

test("preview · returns plain text suitable for UI", () => {
  const codex = pw.previewCodexProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(codex, /wire_api = "responses"/);

  const cc = pw.previewClaudeCodeProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(cc, /ANTHROPIC_BASE_URL/);

  const her = pw.previewHermesProfile({ host: "127.0.0.1", port: 17888 });
  assert.match(her, /\/hermes\/v1/);
});

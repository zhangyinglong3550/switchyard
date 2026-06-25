import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HOME, ensureDir } from "./utils.mjs";

const DEFAULT_TARGET_PROVIDER = "custom";
const KNOWN_PROVIDERS = ["custom", "openai", "switchyard", "deepseek", "ccswitch_gateway"];

export function defaultSourceProvidersFor(targetProvider = DEFAULT_TARGET_PROVIDER) {
  return KNOWN_PROVIDERS.filter((p) => p !== targetProvider);
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function codexStateDbPath() {
  return process.env.SWITCHYARD_CODEX_STATE_DB || path.join(codexHome(), "state_5.sqlite");
}

function sqlite3Cli() {
  return process.env.SWITCHYARD_SQLITE3 || "sqlite3";
}

function sqliteJson(dbPath, sql) {
  const out = execFileSync(sqlite3Cli(), ["-json", dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 20 * 1024 * 1024
  });
  return out.trim() ? JSON.parse(out) : [];
}

function sqliteExec(dbPath, sql) {
  execFileSync(sqlite3Cli(), [dbPath, sql], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024
  });
}

function quoteSql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupPathFor(root, filePath) {
  const relative = path.relative(codexHome(), filePath);
  return path.join(root, relative.startsWith("..") ? path.basename(filePath) : relative);
}

function backupFile(root, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const target = backupPathFor(root, filePath);
  ensureDir(path.dirname(target));
  fs.copyFileSync(filePath, target);
  return true;
}

function replaceSessionMetaProvider(filePath, targetProvider) {
  const original = fs.readFileSync(filePath, "utf8");
  const lines = original.split(/\n/);
  let changed = false;
  const next = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      const item = JSON.parse(line);
      if (item.type === "session_meta" && item.payload?.model_provider !== targetProvider) {
        item.payload.model_provider = targetProvider;
        changed = true;
        return JSON.stringify(item);
      }
    } catch {
      return line;
    }
    return line;
  }).join("\n");
  if (changed) fs.writeFileSync(filePath, next, "utf8");
  return changed;
}

export function unifyCodexHistory({
  targetProvider = DEFAULT_TARGET_PROVIDER,
  sourceProviders = defaultSourceProvidersFor(targetProvider),
  dryRun = false
} = {}) {
  const stateDb = codexStateDbPath();
  if (!fs.existsSync(stateDb)) {
    return { ok: false, reason: "missing-state-db", path: stateDb };
  }

  const providers = sourceProviders.filter((provider) => provider && provider !== targetProvider);
  if (!providers.length) {
    return { ok: false, reason: "no-source-providers", targetProvider, sourceProviders: providers };
  }
  const providerList = providers.map(quoteSql).join(", ");
  const rows = sqliteJson(stateDb, `
    SELECT id, rollout_path, model_provider
    FROM threads
    WHERE model_provider IN (${providerList})
      AND rollout_path IS NOT NULL
      AND rollout_path != ''
    ORDER BY COALESCE(updated_at_ms, updated_at, 0) DESC;
  `);

  const counts = rows.reduce((acc, row) => {
    acc[row.model_provider] = (acc[row.model_provider] || 0) + 1;
    return acc;
  }, {});
  const backupRoot = path.join(DEFAULT_HOME, "history-unify-backups", timestamp());

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      targetProvider,
      sourceProviders: providers,
      affectedThreads: rows.length,
      counts,
      backupRoot
    };
  }

  ensureDir(backupRoot);
  backupFile(backupRoot, stateDb);
  backupFile(backupRoot, `${stateDb}-wal`);
  backupFile(backupRoot, `${stateDb}-shm`);

  let backedUpRollouts = 0;
  let updatedRollouts = 0;
  for (const row of rows) {
    if (!fs.existsSync(row.rollout_path)) continue;
    if (backupFile(backupRoot, row.rollout_path)) backedUpRollouts += 1;
    if (replaceSessionMetaProvider(row.rollout_path, targetProvider)) updatedRollouts += 1;
  }

  sqliteExec(stateDb, `
    UPDATE threads
    SET model_provider = ${quoteSql(targetProvider)}
    WHERE model_provider IN (${providerList});
  `);

  return {
    ok: true,
    dryRun: false,
    targetProvider,
    sourceProviders: providers,
    affectedThreads: rows.length,
    counts,
    backedUpRollouts,
    updatedRollouts,
    backupRoot
  };
}

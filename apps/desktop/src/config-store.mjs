// Wraps core config IO so the Electron main process can read/save without
// duplicating validation. All writes go through validateConfig().
import {
  initConfig,
  loadConfig,
  loadRawConfig,
  saveConfig,
  validateConfig,
  mergeWithDefaults,
  configLocation
} from "../../../packages/core/src/config.mjs";
import { snapshotConfig } from "./config-history.mjs";

export function ensureConfig() {
  return initConfig({ force: false });
}

export function readConfig() {
  ensureConfig();
  return loadConfig();
}

export function readRaw() {
  ensureConfig();
  return loadRawConfig();
}

export function saveValidated(next, { reason = "config-save" } = {}) {
  const merged = mergeWithDefaults(next);
  validateConfig(merged);
  const previous = readConfig();
  if (JSON.stringify(previous) !== JSON.stringify(merged)) snapshotConfig(previous, { reason });
  return saveConfig(merged);
}

export function configFile() {
  return configLocation();
}

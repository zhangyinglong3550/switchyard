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
} from "@switchyard/core/config";

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

export function saveValidated(next) {
  const merged = mergeWithDefaults(next);
  validateConfig(merged);
  return saveConfig(merged);
}

export function configFile() {
  return configLocation();
}

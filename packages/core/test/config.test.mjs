import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeWithDefaults, validateConfig, listModelsForClient, initConfig, loadConfig, saveConfig } from "../src/config.mjs";

test("mergeWithDefaults fills client filters", () => {
  const cfg = mergeWithDefaults({ providers: [], models: [] });
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.clients.codex.enabled, true);
  assert.deepEqual(cfg.clients["claude-code"].allowedModels, ["*"]);
});

test("validateConfig rejects duplicate provider id", () => {
  const cfg = mergeWithDefaults({
    providers: [
      { id: "p", apiFormat: "openai_chat", baseUrl: "http://x" },
      { id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }
    ]
  });
  assert.throws(() => validateConfig(cfg), /Duplicate provider/);
});

test("validateConfig rejects unsupported apiFormat", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "weird", baseUrl: "http://x" }]
  });
  assert.throws(() => validateConfig(cfg), /unsupported apiFormat/);
});

test("validateConfig rejects model referencing missing provider", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [{ id: "m", providerId: "missing", upstreamModel: "u" }]
  });
  assert.throws(() => validateConfig(cfg), /missing provider/);
});

test("listModelsForClient applies allowedModels filter", () => {
  const cfg = mergeWithDefaults({
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "http://x" }],
    models: [
      { id: "m1", providerId: "p", upstreamModel: "u", aliases: ["alpha"] },
      { id: "m2", providerId: "p", upstreamModel: "u2" }
    ],
    clients: {
      codex: { enabled: true, allowedModels: ["m1"] },
      "claude-code": { enabled: true, allowedModels: ["alpha"] },
      hermes: { enabled: false, allowedModels: ["*"] }
    }
  });
  validateConfig(cfg);
  assert.equal(listModelsForClient(cfg, "codex").length, 1);
  assert.equal(listModelsForClient(cfg, "claude-code").length, 1);
  assert.equal(listModelsForClient(cfg, "hermes").length, 0);
});

test("initConfig/loadConfig/saveConfig round trip in tempdir", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lls-cfg-"));
  const cfgPath = path.join(tmp, "config.json");
  const prevEnv = process.env.SWITCHYARD_CONFIG;
  process.env.SWITCHYARD_CONFIG = cfgPath;
  try {
    initConfig({ force: true });
    const loaded = loadConfig();
    loaded.providers.push({ id: "x", name: "X", apiFormat: "openai_chat", baseUrl: "http://x" });
    loaded.models.push({ id: "x/m", providerId: "x", upstreamModel: "m" });
    saveConfig(loaded);
    const again = loadConfig();
    assert.equal(again.providers.length, 1);
    assert.equal(again.models.length, 1);
  } finally {
    process.env.SWITCHYARD_CONFIG = prevEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

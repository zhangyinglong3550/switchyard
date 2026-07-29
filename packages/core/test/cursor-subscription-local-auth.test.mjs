import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cursorModelCatalogFromApplicationStorage,
  cursorRequestedModelFromApplicationStorage,
  cursorMachineIdFromStorage,
  readCursorAccessToken,
  readCursorMachineId,
  readLocalCursorSubscriptionCredentials
} from "../src/cursor-subscription/local-auth.mjs";

test("cursor local auth · reads only the local Cursor Keychain entry and service machine id", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-cursor-"));
  const storage = path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(storage, "storage.json"), JSON.stringify({ "storage.serviceMachineId": "12345678-1234-1234-1234-123456789abc" }));
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, args]);
    return "a".repeat(64);
  };
  const result = readLocalCursorSubscriptionCredentials({ home, platform: "darwin", runner });
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, "a".repeat(64));
  assert.equal(result.machineId, "12345678-1234-1234-1234-123456789abc");
  assert.deepEqual(calls, [["security", ["find-generic-password", "-a", "cursor-user", "-s", "cursor-access-token", "-w"]]]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("cursor local auth · exposes no secret when either local source is missing", () => {
  assert.equal(cursorMachineIdFromStorage({ telemetry: { machineId: "fallback-machine" } }), "fallback-machine");
  assert.deepEqual(readCursorAccessToken({ platform: "linux" }), { ok: false, reason: "unsupported_platform" });
  const missingMachine = readCursorMachineId({ home: path.join(os.tmpdir(), "missing-cursor-storage"), platform: "darwin" });
  assert.deepEqual(missingMachine, { ok: false, reason: "machine_id_not_found" });
  const result = readLocalCursorSubscriptionCredentials({
    platform: "darwin",
    runner: () => { throw new Error("not found"); }
  });
  assert.deepEqual(result, { ok: false, reason: "access_token_not_found" });
});


test("cursor local model catalog · mirrors Cursor's enabled picker models and selected variants", () => {
  const models = cursorModelCatalogFromApplicationStorage({
    availableDefaultModels2: [
      { serverModelName: "default", defaultOn: true, supportsAgent: true, supportsThinking: false, supportsImages: true, variants: [{ isDefaultNonMaxConfig: true, displayNameOutsidePicker: "Auto" }] },
      { serverModelName: "grok-4.5", defaultOn: true, supportsAgent: true, supportsThinking: true, supportsImages: false, tooltipData: { markdownContent: "256k context window" }, variants: [
        { isDefaultNonMaxConfig: true, displayNameOutsidePicker: "Cursor Grok 4.5 <span>High Fast</span>", parameterValues: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] }
      ] },
      { serverModelName: "legacy", defaultOn: false, supportsAgent: true, degradationStatus: 0, variants: [{ displayNameOutsidePicker: "Legacy" }] },
      { serverModelName: "disabled", defaultOn: true, supportsAgent: false, variants: [{ displayNameOutsidePicker: "Disabled" }] }
    ],
    aiSettings: {
      modelLastUsedAt: { "gpt-5.6-sol": "2026-07-29T00:00:00.000Z" },
      modelConfig: {
        composer: { selectedModels: [{ modelId: "grok-4.5", parameters: [{ id: "effort", value: "high" }, { id: "fast", value: "true" }] }] }
      }
    }
  });
  assert.deepEqual(models.map((model) => model.id), ["auto", "grok-4.5"]);
  assert.equal(models[1].displayName, "Cursor Grok 4.5");
  assert.equal(models[1].contextWindow, 256000);
  assert.equal(models[1].capabilities.reasoning, true);
});

test("cursor local model catalog · strips picker speed and reasoning suffixes even without parameter metadata", () => {
  const models = cursorModelCatalogFromApplicationStorage({
    availableDefaultModels2: [
      { serverModelName: "composer-2.5", defaultOn: true, supportsAgent: true, variants: [{ isDefaultNonMaxConfig: true, displayNameOutsidePicker: "Composer 2.5 Fast" }] },
      { serverModelName: "kimi-k3", defaultOn: true, supportsAgent: true, variants: [{ isDefaultNonMaxConfig: true, displayNameOutsidePicker: "Kimi K3 Max" }] },
      { serverModelName: "glm-5.2", defaultOn: true, supportsAgent: true, variants: [{ isDefaultNonMaxConfig: true, displayNameOutsidePicker: "GLM 5.2 High" }] }
    ]
  });
  assert.deepEqual(models.map((model) => [model.id, model.displayName]), [
    ["composer-2.5", "Composer 2.5"],
    ["kimi-k3", "Kimi K3"],
    ["glm-5.2", "GLM 5.2"]
  ]);
});

test("cursor local model selection · preserves Cursor Composer parameters for AgentService", () => {
  const selection = cursorRequestedModelFromApplicationStorage({
    availableDefaultModels2: [{
      serverModelName: "grok-4.5",
      defaultOn: true,
      supportsAgent: true,
      variants: [{
        isDefaultNonMaxConfig: true,
        parameterValues: [{ id: "effort", value: "high" }, { id: "fast", value: "false" }]
      }]
    }],
    aiSettings: {
      modelConfig: {
        composer: {
          maxMode: false,
          selectedModels: [{
            modelId: "grok-4.5",
            parameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }]
          }]
        }
      }
    }
  }, "grok-4.5");
  assert.deepEqual(selection, {
    modelId: "grok-4.5",
    maxMode: false,
    parameters: [{ id: "effort", value: "medium" }, { id: "fast", value: "true" }],
    builtInModel: true,
    isVariantStringRepresentation: false
  });
});

test("cursor local model selection · lets the API caller override Cursor reasoning level", () => {
  const state = {
    availableDefaultModels2: [{
      serverModelName: "claude-opus-5",
      defaultOn: true,
      supportsAgent: true,
      parameterDefinitions: [
        { id: "thinking", parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } } },
        { id: "effort", parameterType: { enumParameter: { values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "max" }] } } }
      ],
      variants: [{ isDefaultNonMaxConfig: true, parameterValues: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }] }]
    }],
    aiSettings: { modelConfig: { composer: { selectedModels: [{ modelId: "claude-opus-5", parameters: [{ id: "thinking", value: "true" }, { id: "effort", value: "high" }] }] } } }
  };
  assert.deepEqual(
    cursorRequestedModelFromApplicationStorage(state, "claude-opus-5", { reasoningEffort: "low" }).parameters,
    [{ id: "thinking", value: "true" }, { id: "effort", value: "low" }]
  );
  assert.deepEqual(
    cursorRequestedModelFromApplicationStorage(state, "claude-opus-5", { reasoningEffort: "none" }).parameters,
    [{ id: "thinking", value: "false" }, { id: "effort", value: "high" }]
  );
  assert.deepEqual(
    cursorRequestedModelFromApplicationStorage(state, "claude-opus-5", { reasoningEffort: "xhigh" }).parameters,
    [{ id: "thinking", value: "true" }, { id: "effort", value: "max" }]
  );
});

test("cursor local model selection · maps Agent speed tier to Cursor's fast parameter", () => {
  const state = {
    availableDefaultModels2: [{
      serverModelName: "grok-4.5",
      defaultOn: true,
      supportsAgent: true,
      parameterDefinitions: [
        { id: "fast", parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } } }
      ],
      variants: [{ isDefaultNonMaxConfig: true, parameterValues: [{ id: "fast", value: "false" }] }]
    }]
  };
  assert.deepEqual(
    cursorRequestedModelFromApplicationStorage(state, "grok-4.5", { speedTier: "priority" }).parameters,
    [{ id: "fast", value: "true" }]
  );
  assert.deepEqual(
    cursorRequestedModelFromApplicationStorage(state, "grok-4.5", { speedTier: "standard" }).parameters,
    [{ id: "fast", value: "false" }]
  );
});

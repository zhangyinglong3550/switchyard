import test from "node:test";
import assert from "node:assert/strict";
import {
  clientScopeLabel,
  modelsForClient,
  normalizeClientScope
} from "../../../apps/desktop/renderer/client-visibility-utils.mjs";

const config = {
  providers: [
    { id: "codex-only", name: "Codex Only", allowedClients: ["codex"] },
    { id: "all", name: "All" }
  ],
  models: [
    { id: "codex-only/a", providerId: "codex-only", upstreamModel: "a" },
    { id: "codex-only/b", providerId: "codex-only", upstreamModel: "b", allowedClients: ["claude-code"] },
    { id: "all/c", providerId: "all", upstreamModel: "c", allowedClients: ["claude-code"], aliases: ["c-alias"] },
    { id: "all/d", providerId: "all", upstreamModel: "d" },
    { id: "all/disabled", providerId: "all", upstreamModel: "disabled", enabled: false }
  ],
  clients: {
    codex: { enabled: true, allowedModels: ["*"] },
    "claude-code": { enabled: true, allowedModels: ["c-alias", "all/d"] },
    hermes: { enabled: false, allowedModels: ["*"] }
  }
};

test("client visibility utils · filters models by provider, model and client scopes", () => {
  assert.deepEqual(modelsForClient(config, "codex").map((model) => model.id), ["codex-only/a", "all/d"]);
  assert.deepEqual(modelsForClient(config, "claude-code").map((model) => model.id), ["all/c", "all/d"]);
  assert.deepEqual(modelsForClient(config, "hermes"), []);
});

test("client visibility utils · normalizes empty scope to all clients", () => {
  assert.deepEqual(normalizeClientScope([]), ["*"]);
  assert.equal(clientScopeLabel(["codex", "claude-code"]), "Codex, Claude Code");
});

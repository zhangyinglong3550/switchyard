import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_FILTER_OPTIONS,
  CLIENT_LABELS,
  CLIENT_SCOPE_OPTIONS,
  clientDisplayLabel,
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
    { id: "codex-only/b", providerId: "codex-only", upstreamModel: "b", allowedClients: ["claude-code"], agentScopeOverride: true },
    { id: "all/c", providerId: "all", upstreamModel: "c", allowedClients: ["claude-code"], agentScopeOverride: true, aliases: ["c-alias"] },
    { id: "all/d", providerId: "all", upstreamModel: "d" },
    { id: "all/disabled", providerId: "all", upstreamModel: "disabled", enabled: false }
  ],
  clients: {
    codex: { enabled: true, allowedModels: ["*"] },
    "claude-code": { enabled: true, allowedModels: ["*"] },
    hermes: { enabled: false, allowedModels: ["*"] }
  }
};

test("client visibility utils · filters models by provider, model and client scopes", () => {
  assert.deepEqual(modelsForClient(config, "codex").map((model) => model.id), ["codex-only/a", "all/d"]);
  assert.deepEqual(modelsForClient(config, "claude-code").map((model) => model.id), ["codex-only/b", "all/c", "all/d"]);
  assert.deepEqual(modelsForClient(config, "hermes"), []);
});

test("client visibility utils · normalizes empty scope to all clients", () => {
  assert.deepEqual(normalizeClientScope([]), ["*"]);
  assert.equal(clientScopeLabel(["codex", "claude-code"]), "Codex, Claude Code");
});

test("client visibility utils · client list carries every supported runtime entry once", () => {
  const ids = CLIENT_SCOPE_OPTIONS.map(([id]) => id);
  assert.deepEqual(ids, ["codex", "claude-code", "hermes", "opencode", "grok", "deepseek-harness", "zcode", "generic-openai"]);
  assert.equal(new Set(ids).size, ids.length, "客户端 id 不能重复");
  for (const [, label] of CLIENT_SCOPE_OPTIONS) assert.ok(label, "每个客户端都要有展示名");
  assert.equal(CLIENT_LABELS.get("zcode"), "ZCode");
});

test("client visibility utils · data filters cover pseudo client ids that never appear as write targets", () => {
  const filterIds = CLIENT_FILTER_OPTIONS.map(([id]) => id);
  const scopeIds = CLIENT_SCOPE_OPTIONS.map(([id]) => id);
  // 测试台请求以 model-test 落库，用量 / 请求日志必须能筛到它
  assert.ok(filterIds.includes("model-test"));
  assert.ok(!scopeIds.includes("model-test"), "伪 clientId 不能成为可选的接入目标");
  assert.deepEqual(filterIds.slice(0, scopeIds.length), scopeIds);
});

test("client visibility utils · unknown client id falls back to the raw id", () => {
  assert.equal(clientDisplayLabel("codex"), "Codex");
  assert.equal(clientDisplayLabel("model-test"), "模型测试");
  assert.equal(clientDisplayLabel("some-new-agent"), "some-new-agent");
  assert.equal(clientDisplayLabel(""), "-");
  assert.equal(clientDisplayLabel(null), "-");
});

test("client visibility utils · zcode respects provider scope like any other client", () => {
  const zcodeConfig = {
    providers: [{ id: "all", name: "All" }],
    models: [
      { id: "all/a", providerId: "all", upstreamModel: "a" },
      { id: "all/b", providerId: "all", upstreamModel: "b", allowedClients: ["codex"], agentScopeOverride: true }
    ],
    clients: { zcode: { enabled: true, allowedModels: ["*"] } }
  };
  assert.deepEqual(modelsForClient(zcodeConfig, "zcode").map((model) => model.id), ["all/a"]);
  zcodeConfig.clients.zcode.enabled = false;
  assert.deepEqual(modelsForClient(zcodeConfig, "zcode"), []);
});

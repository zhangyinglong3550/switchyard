import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("agent plugins · reads Claude Code marketplaces, installed plugins and switchyard sources", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-agent-plugins-"));
  process.env.SWITCHYARD_AGENT_HOME = tmp;
  process.env.SWITCHYARD_PLUGIN_SOURCES_FILE = path.join(tmp, ".switchyard", "plugin-sources.json");
  t.after(() => {
    delete process.env.SWITCHYARD_AGENT_HOME;
    delete process.env.SWITCHYARD_PLUGIN_SOURCES_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const marketplace = path.join(tmp, ".claude", "plugins", "marketplaces", "team");
  fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(marketplace, ".claude-plugin", "marketplace.json"), JSON.stringify({
    name: "team",
    plugins: [{ name: "code-helper", description: "Team helper", category: "development", source: "./plugins/code-helper" }]
  }), "utf8");
  const installed = path.join(marketplace, "plugins", "code-helper", ".claude-plugin");
  fs.mkdirSync(installed, { recursive: true });
  fs.mkdirSync(path.join(marketplace, "plugins", "code-helper", "commands"), { recursive: true });
  fs.writeFileSync(path.join(installed, "plugin.json"), JSON.stringify({
    name: "code-helper",
    version: "1.0.0",
    description: "Installed helper"
  }), "utf8");

  const mod = await import(`../../../apps/desktop/src/agent-plugins.mjs?v=${Date.now()}`);
  const first = await mod.listAgentPlugins({ agentId: "claude-code" });
  assert.ok(first.sources.some((source) => source.name === "team"));
  assert.ok(first.available.some((plugin) => plugin.name === "code-helper"));
  assert.ok(first.installed.some((plugin) => plugin.name === "code-helper" && plugin.features.includes("commands")));

  const extra = path.join(tmp, "extra-marketplace");
  fs.mkdirSync(extra, { recursive: true });
  fs.writeFileSync(path.join(extra, "marketplace.json"), JSON.stringify({
    name: "extra",
    plugins: [{ name: "extra-plugin", description: "Extra plugin" }]
  }), "utf8");
  const added = mod.addPluginSource({ agentId: "claude-code", name: "extra", path: extra });
  assert.equal(added.ok, true);
  const second = await mod.listAgentPlugins({ agentId: "claude-code" });
  assert.ok(second.available.some((plugin) => plugin.name === "extra-plugin"));
  const removed = mod.removePluginSource({ id: added.source.id });
  assert.equal(removed.removed, 1);
});

test("agent plugins · install and uninstall plugin roundtrip", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-agent-plugins-2-"));
  process.env.SWITCHYARD_AGENT_HOME = tmp;
  process.env.SWITCHYARD_PLUGIN_SOURCES_FILE = path.join(tmp, ".switchyard", "plugin-sources.json");
  t.after(() => {
    delete process.env.SWITCHYARD_AGENT_HOME;
    delete process.env.SWITCHYARD_PLUGIN_SOURCES_FILE;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const source = path.join(tmp, "my-plugin-source");
  fs.mkdirSync(path.join(source, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "my-plugin", version: "1.0.0", description: "Test plugin" }), "utf8");
  fs.mkdirSync(path.join(source, "commands"), { recursive: true });

  const mod = await import("../../../apps/desktop/src/agent-plugins.mjs?v=" + Date.now());
  const result = mod.installPlugin({ agentId: "claude-code", sourcePath: source, pluginName: "my-plugin" });
  assert.equal(result.ok, true);
  const list = await mod.listAgentPlugins({ agentId: "claude-code" });
  assert.ok(list.installed.some((p) => p.name === "my-plugin"));
  const removed = mod.uninstallPlugin({ agentId: "claude-code", pluginName: "my-plugin" });
  assert.equal(removed.ok, true);
  const list2 = await mod.listAgentPlugins({ agentId: "claude-code" });
  assert.ok(!list2.installed.some((p) => p.name === "my-plugin"));
});

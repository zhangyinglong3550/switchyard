import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMobileCommandCatalog } from "../../../apps/desktop/src/mobile-control/command-catalog.mjs";

function skill(root, name, frontMatter, file = "SKILL.md") {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, file), `---\n${frontMatter}\n---\nSensitive body at /Users/alice/private\n`);
}

test("mobile command catalog discovers safe agent-specific skills and syntax", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-command-catalog-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  skill(path.join(home, ".codex", "skills"), "review-folder", "name: code-review\ndescription: Review changed code");
  skill(path.join(home, ".codex", "skills", ".system"), "system-helper", "name: system-helper\ndescription: System helper");
  skill(path.join(home, ".agents", "skills"), "shared", "name: shared-skill\ndescription: Shared helper");
  skill(path.join(home, ".claude", "skills"), "claude-skill", "name: claude-skill\ndescription: Claude helper");
  skill(path.join(home, ".config", "opencode", "skills"), "oc-skill", "name: oc-skill\ndescription: OpenCode helper");
  skill(path.join(home, ".grok", "skills"), "grok-skill", "name: grok-skill\ndescription: Grok helper");
  skill(path.join(home, ".grok", "skills"), "disabled", "name: disabled\ndescription: hidden", "SKILL.md.disabled");
  fs.mkdirSync(path.join(home, ".claude", "plugins"), { recursive: true });
  const pluginRoot = path.join(home, "claude-plugin");
  skill(path.join(pluginRoot, "skills"), "plugin-skill", "name: plugin-skill\ndescription: Plugin helper");
  fs.mkdirSync(path.join(pluginRoot, "commands"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "commands", "plugin-command.md"), "---\ndescription: Plugin command\n---\n");
  fs.writeFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({
    plugins: { "demo@marketplace": [{ scope: "user", installPath: pluginRoot }] }
  }));

  const catalog = createMobileCommandCatalog({ home });
  const codex = catalog.list("codex");
  const claude = catalog.list("claude-code");
  const opencode = catalog.list("opencode");
  const grok = catalog.list("grok");

  assert.equal(codex.find((item) => item.name === "code-review").insertText, "$code-review ");
  assert.equal(codex.find((item) => item.name === "shared-skill").kind, "skill");
  assert.equal(codex.find((item) => item.name === "system-helper").insertText, "$system-helper ");
  assert.equal(claude.find((item) => item.name === "claude-skill").insertText, "/claude-skill ");
  assert.equal(claude.find((item) => item.name === "demo:plugin-skill").insertText, "/demo:plugin-skill ");
  assert.equal(claude.find((item) => item.name === "demo:plugin-command").insertText, "/demo:plugin-command ");
  assert.equal(opencode.find((item) => item.name === "oc-skill").insertText, "/oc-skill ");
  assert.equal(grok.find((item) => item.name === "grok-skill").insertText, "/grok-skill ");
  assert.equal(grok.some((item) => item.name === "disabled"), false);
  assert.equal(JSON.stringify([...codex, ...claude, ...opencode, ...grok]).includes("/Users/alice"), false);
});

test("Codex exposes native plugin mentions without leaking local plugin paths", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-command-mention-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rows = createMobileCommandCatalog({ home }).list("codex", [], { mentions: [{
    name: "chrome", description: "Control Chrome", path: "/Users/alice/private/plugin"
  }] });
  assert.deepEqual(rows.filter((item) => item.kind === "mention"), [{
    id: "mention:chrome", kind: "mention", name: "chrome",
    description: "Control Chrome", insertText: "@chrome ", source: "agent"
  }]);
  assert.equal(JSON.stringify(rows).includes("/Users/alice"), false);
});

test("mobile command catalog merges dynamic commands and removes duplicates", () => {
  const catalog = createMobileCommandCatalog({ home: "/missing-home" });
  const rows = catalog.list("opencode", [
    { name: "compact", description: "Dynamic compact" },
    { name: "/custom", description: "Custom command" },
    { name: "custom", description: "Duplicate" }
  ]);
  assert.equal(rows.filter((item) => item.name === "compact").length, 1);
  assert.equal(rows.filter((item) => item.name === "custom").length, 1);
  assert.equal(rows.find((item) => item.name === "custom").insertText, "/custom ");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function hasSqlite3() {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("agent resources · lists sessions and manages skills inside agent roots", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-agent-res-"));
  process.env.SWITCHYARD_AGENT_HOME = tmp;
  t.after(() => {
    delete process.env.SWITCHYARD_AGENT_HOME;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const codexSessions = path.join(tmp, ".codex", "archived_sessions");
  const codexSkill = path.join(tmp, ".codex", "skills", "demo-skill");
  const codexCore = path.join(tmp, ".codex", "AGENTS.md");
  const claudeProject = path.join(tmp, ".claude", "projects", "demo");
  const hermesHome = path.join(tmp, ".hermes");
  fs.mkdirSync(codexSessions, { recursive: true });
  fs.mkdirSync(codexSkill, { recursive: true });
  fs.mkdirSync(claudeProject, { recursive: true });
  fs.mkdirSync(path.join(hermesHome, "memories"), { recursive: true });
  fs.writeFileSync(path.join(codexSessions, "rollout-demo.jsonl"), [
    JSON.stringify({ type: "response_item", timestamp: "2026-06-23T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "你好" }] } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-06-23T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好，我在。" }] } })
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(claudeProject, "session.jsonl"), JSON.stringify({
    type: "user",
    timestamp: "2026-06-23T00:00:00.000Z",
    message: { role: "user", content: "Claude 你好" }
  }) + "\n", "utf8");
  fs.writeFileSync(codexCore, "# Codex 根说明\n", "utf8");
  fs.writeFileSync(path.join(hermesHome, "SOUL.md"), "# Hermes Soul\n", "utf8");
  fs.writeFileSync(path.join(hermesHome, "memories", "USER.md"), "# Hermes User\n", "utf8");
  fs.writeFileSync(path.join(hermesHome, "memories", "MEMORY.md"), "# Hermes Memory\n", "utf8");
  fs.writeFileSync(path.join(codexSkill, "SKILL.md"), "---\nname: demo\n---\nBody\n", "utf8");

  const mod = await import(`../../../apps/desktop/src/agent-resources.mjs?v=${Date.now()}`);
  const sessions = mod.listAgentSessions();
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((item) => item.agentId === "codex"));
  assert.ok(sessions.some((item) => item.agentId === "claude-code"));
  const sessionText = mod.readAgentSession(sessions.find((item) => item.agentId === "codex").id);
  assert.match(sessionText.text, /response_item/);
  assert.equal(sessionText.conversation.count, 2);
  assert.equal(sessionText.conversation.messages[0].role, "user");
  assert.match(sessionText.conversation.messages[1].text, /我在/);

  const coreFiles = mod.listAgentCoreFiles({ agentId: "codex" });
  assert.ok(coreFiles.some((item) => item.relativePath === "AGENTS.md" && item.exists));
  const core = mod.readAgentCoreFile(coreFiles.find((item) => item.relativePath === "AGENTS.md").id);
  assert.match(core.text, /Codex 根说明/);
  const savedCore = mod.saveAgentCoreFile(core.id, "# Changed\n");
  assert.equal(savedCore.ok, true);
  assert.match(mod.readAgentCoreFile(core.id).text, /Changed/);
  const hermesCoreFiles = mod.listAgentCoreFiles({ agentId: "hermes" }).map((item) => item.relativePath);
  assert.ok(hermesCoreFiles.includes("SOUL.md"));
  assert.ok(hermesCoreFiles.includes(path.join("memories", "USER.md")));
  assert.ok(hermesCoreFiles.includes(path.join("memories", "MEMORY.md")));

  const skills = mod.listAgentSkills({ agentId: "codex" });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "demo-skill");
  const read = mod.readAgentSkill(skills[0].id);
  assert.match(read.text, /Body/);

  const saved = mod.saveAgentSkill(skills[0].id, "---\nname: demo\n---\nChanged\n");
  assert.equal(saved.ok, true);
  assert.match(mod.readAgentSkill(skills[0].id).text, /Changed/);

  const disabled = mod.setAgentSkillDisabled(skills[0].id, true);
  assert.equal(disabled.disabled, true);
  assert.equal(fs.existsSync(path.join(codexSkill, "SKILL.md")), false);
  assert.equal(fs.existsSync(path.join(codexSkill, "SKILL.md.disabled")), true);
  const enabled = mod.setAgentSkillDisabled(skills[0].id, false);
  assert.equal(enabled.disabled, false);
  assert.equal(fs.existsSync(path.join(codexSkill, "SKILL.md")), true);

  const linked = mod.linkAgentSkill(skills[0].id, { targetAgentId: "claude-code", skillName: "demo-linked" });
  assert.equal(linked.ok, true);
  const linkedPath = path.join(tmp, ".claude", "skills", "demo-linked");
  assert.equal(fs.lstatSync(linkedPath).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(linkedPath), fs.realpathSync(codexSkill));
  const claudeSkills = mod.listAgentSkills({ agentId: "claude-code" });
  assert.equal(claudeSkills.length, 1);
  assert.equal(claudeSkills[0].name, "demo-linked");
  assert.equal(claudeSkills[0].linked, true);

  const downloadedSkill = path.join(tmp, "downloaded-skill");
  fs.mkdirSync(downloadedSkill, { recursive: true });
  fs.writeFileSync(path.join(downloadedSkill, "SKILL.md"), "---\nname: downloaded\n---\nDownloaded\n", "utf8");
  const installed = mod.installAgentSkillFromDirectory(downloadedSkill, { targetAgentId: "hermes", skillName: "downloaded" });
  assert.equal(installed.ok, true);
  const hermesSkills = mod.listAgentSkills({ agentId: "hermes" });
  assert.equal(hermesSkills.length, 1);
  assert.equal(hermesSkills[0].name, "downloaded");

  if (hasSqlite3()) {
    const db = path.join(hermesHome, "state.db");
    execFileSync("sqlite3", [db, `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        user_id TEXT,
        model TEXT,
        model_config TEXT,
        system_prompt TEXT,
        parent_session_id TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        end_reason TEXT,
        message_count INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0,
        title TEXT,
        archived INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL,
        token_count INTEGER,
        finish_reason TEXT,
        reasoning TEXT,
        reasoning_content TEXT,
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sessions (id, source, model, title, started_at, message_count, archived)
      VALUES ('h1', 'desktop', 'glm', 'Hermes 测试会话', 1782230000, 2, 0);
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES ('h1', 'user', '[{"type":"text","text":"Hermes 你好"}]', 1782230001);
      INSERT INTO messages (session_id, role, content, timestamp)
      VALUES ('h1', 'assistant', '你好，我是 Hermes。', 1782230002);
    `]);
    const hermesSessions = mod.listAgentSessions({ agentId: "hermes" });
    assert.equal(hermesSessions.length, 1);
    assert.equal(hermesSessions[0].source, "hermes-state-db");
    const hermesRead = mod.readAgentSession(hermesSessions[0].id);
    assert.equal(hermesRead.conversation.format, "hermes-state-db");
    assert.equal(hermesRead.conversation.messages[0].role, "user");
    assert.equal(hermesRead.conversation.messages[0].text, "Hermes 你好");
    assert.match(hermesRead.conversation.messages[1].text, /Hermes/);
    const archived = mod.archiveAgentSession(hermesSessions[0].id);
    assert.equal(archived.archived, true);
    assert.equal(mod.listAgentSessions({ agentId: "hermes" }).length, 0);
  }
});

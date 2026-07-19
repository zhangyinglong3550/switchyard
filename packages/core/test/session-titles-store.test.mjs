import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("session-titles-store · set / get / clear overlay and apply to list rows", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-session-titles-"));
  process.env.SWITCHYARD_SESSION_TITLES_PATH = path.join(tmp, "session-titles.json");
  t.after(() => {
    delete process.env.SWITCHYARD_SESSION_TITLES_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const store = await import(`../../../apps/desktop/src/session-titles-store.mjs?v=${Date.now()}`);

  assert.equal(store.getSessionTitle("sess-1"), null);

  const set = store.setSessionTitle("sess-1", "  我的绘画  ", { agentId: "claude-code" });
  assert.equal(set.cleared, false);
  assert.equal(set.title, "我的绘画");
  assert.equal(store.getSessionTitle("sess-1"), "我的绘画");

  const disk = JSON.parse(fs.readFileSync(process.env.SWITCHYARD_SESSION_TITLES_PATH, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.titles["sess-1"].title, "我的绘画");
  assert.equal(disk.titles["sess-1"].agentId, "claude-code");

  const rows = store.applySessionTitleOverlays([
    { id: "sess-1", name: "raw-file-name.json" },
    { id: "sess-2", name: "other" }
  ]);
  assert.equal(rows[0].name, "我的绘画");
  assert.equal(rows[0].hasCustomTitle, true);
  assert.equal(rows[0].nativeName, "raw-file-name.json");
  assert.equal(rows[1].name, "other");
  assert.equal(rows[1].hasCustomTitle, false);

  const cleared = store.setSessionTitle("sess-1", "   ");
  assert.equal(cleared.cleared, true);
  assert.equal(store.getSessionTitle("sess-1"), null);

  assert.throws(() => store.setSessionTitle("", "x"), /session id/);
});

test("sessions UI · rename control and IPC channel present", () => {
  const root = process.cwd();
  const html = fs.readFileSync(path.join(root, "apps/desktop/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/renderer.js"), "utf8");
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.mjs"), "utf8");
  assert.match(html, /id="sessions-tbody"/);
  assert.match(html, /自定义名称|命名/);
  assert.match(html, /id="session-rename-wrap"/);
  assert.match(html, /id="session-rename-title"/);
  assert.match(renderer, /data-session-rename/);
  assert.match(renderer, /agent:sessions:rename/);
  assert.match(renderer, /openSessionRenameDialog/);
  // Electron 禁用 window.prompt，命名必须走应用内对话框
  assert.doesNotMatch(renderer, /window\.prompt\s*\(/);
  assert.match(main, /agent:sessions:rename/);
  assert.match(main, /renameAgentSession/);
});

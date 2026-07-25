import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { summarizeCodexFile } from "../../../apps/desktop/src/mobile-control/local-session-scan.mjs";

test("Codex fork rollout keeps the current filename/first metadata thread id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-codex-scan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = "019f9246-3f32-7693-9690-3a659e1afd7a";
  const parent = "019f8c8b-9b6a-7271-90ad-07dd40ddefbd";
  const file = path.join(root, `rollout-2026-07-24T11-58-25-${current}.jsonl`);
  fs.writeFileSync(file, [
    JSON.stringify({ type: "session_meta", payload: { session_id: current, forked_from_id: parent, cwd: "/tmp/current", originator: "Codex Desktop" } }),
    JSON.stringify({ type: "session_meta", payload: { session_id: parent, cwd: "/tmp/parent", originator: "embedded parent" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] } })
  ].join("\n"));
  const summary = summarizeCodexFile(file);
  assert.equal(summary.sessionId, current);
  assert.equal(summary.cwd, "/tmp/current");
  assert.equal(summary.originator, "Codex Desktop");
});

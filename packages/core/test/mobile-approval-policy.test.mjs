import test from "node:test";
import assert from "node:assert/strict";
import { classifyMobileApproval } from "../../../apps/desktop/src/mobile-control/approval-policy.mjs";

const options = [
  { kind: "allow_once", name: "Allow", optionId: "allow" },
  { kind: "allow_always", name: "Always", optionId: "always" },
  { kind: "reject_once", name: "Reject", optionId: "reject" }
];

test("mobile approval permits only one-shot low-risk commands", () => {
  const safe = classifyMobileApproval({
    title: "Run command",
    command: "git status --short",
    options
  });
  assert.equal(safe.mobileAllowed, true);
  assert.equal(safe.allowOptionId, "allow");
  assert.equal(safe.rejectOptionId, "reject");
  assert.equal(safe.permanentOptionId, null);
});

test("mobile approval routes privileged, destructive and secret access to desktop", () => {
  for (const command of [
    "sudo launchctl unload /Library/LaunchDaemons/x",
    "rm -rf /Users/me/project",
    "cat ~/.ssh/id_ed25519",
    "security find-generic-password -w service"
  ]) {
    const result = classifyMobileApproval({ command, options });
    assert.equal(result.mobileAllowed, false, command);
    assert.equal(result.requiresDesktop, true, command);
  }
});

test("mobile approval never offers permanent allow", () => {
  const result = classifyMobileApproval({ command: "npm test", options });
  assert.equal(result.permanentOptionId, null);
  assert.deepEqual(result.actions, ["allow_once", "deny_once"]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { classifyMobileApproval } from "../../../apps/desktop/src/mobile-control/approval-policy.mjs";

const options = [
  { kind: "allow_once", name: "Allow", optionId: "allow" },
  { kind: "allow_always", name: "Always", optionId: "always" },
  { kind: "reject_once", name: "Reject", optionId: "reject" }
];

test("mobile approval infers ACP option kinds from optionId when kind is missing", () => {
  const result = classifyMobileApproval({
    command: "git status --short",
    options: [
      { optionId: "allow_once", name: "Allow once" },
      { optionId: "reject_once", name: "Reject" }
    ]
  });
  assert.equal(result.mobileAllowed, true);
  assert.equal(result.allowOptionId, "allow_once");
  assert.equal(result.rejectOptionId, "reject_once");
  assert.deepEqual(result.actions, ["allow_once", "allow_session", "deny_once"]);
});

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
  assert.deepEqual(safe.detail, { label: "将执行的命令", content: "git status --short" });
});

test("mobile approval permits a non-dangerous one-shot command outside the legacy allowlist", () => {
  const result = classifyMobileApproval({ command: "sbc doctor", options });
  assert.equal(result.mobileAllowed, true);
  assert.equal(result.requiresDesktop, false);
  assert.equal(result.summary, "一次性执行请求");
  assert.deepEqual(result.actions, ["allow_once", "allow_session", "deny_once"]);
});

test("mobile approval permits one-shot privileged and destructive commands", () => {
  for (const command of [
    "sudo launchctl unload /Library/LaunchDaemons/x",
    "rm -rf /Users/me/project",
    "cat ~/.ssh/id_ed25519",
    "security find-generic-password -w service"
  ]) {
    const result = classifyMobileApproval({ command, options });
    assert.equal(result.mobileAllowed, true, command);
    assert.equal(result.requiresDesktop, false, command);
    assert.deepEqual(result.actions, ["allow_once", "allow_session", "deny_once"], command);
  }
});

test("mobile approval permits every Codex app-server approval type", () => {
  const result = classifyMobileApproval({
    method: "item/permissions/requestApproval",
    reason: "请求更高权限"
  });
  assert.equal(result.mobileAllowed, true);
  assert.equal(result.requiresDesktop, false);
  assert.deepEqual(result.actions, ["allow_once", "allow_session", "deny_once"]);
});

test("mobile approval never offers permanent allow", () => {
  const result = classifyMobileApproval({ command: "npm test", options });
  assert.equal(result.permanentOptionId, null);
  assert.deepEqual(result.actions, ["allow_once", "allow_session", "deny_once"]);
});

test("mobile approval redacts credentials in the displayed detail", () => {
  const result = classifyMobileApproval({ command: "curl -H 'Authorization: Bearer secret-token-value'", options });
  assert.match(result.detail.content, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(result.detail.content, /secret-token-value/);
});

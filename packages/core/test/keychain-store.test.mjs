import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("keychain store · builds macOS security commands without exposing secrets", async () => {
  const calls = [];
  const runner = (cmd, args, options = {}) => {
    calls.push({ cmd, args, hasInput: Boolean(options.input) });
    if (args[0] === "find-generic-password") return "secret-value\n";
    return "";
  };
  const mod = await import("../../../apps/desktop/src/keychain-store.mjs");

  assert.equal(mod.setKeychainSecret("provider-a", "secret-value", { runner }).ok, true);
  assert.equal(mod.getKeychainSecret("provider-a", { runner }), "secret-value");
  assert.equal(mod.deleteKeychainSecret("provider-a", { runner }).ok, true);

  assert.deepEqual(calls.map((call) => call.args[0]), [
    "add-generic-password",
    "find-generic-password",
    "delete-generic-password"
  ]);
  assert.equal(calls[0].args.at(-1), "-w");
  assert.equal(JSON.stringify(calls.map((call) => call.args)).includes("secret-value"), false);
  assert.equal(calls[0].hasInput, true);
  assert.equal(mod.describeKeychainSecret("provider-a").includes("secret-value"), false);
  assert.equal(mod.keychainAccountForProvider({ id: "provider-a" }), "provider-a");
  assert.equal(mod.keychainAccountForProvider({ id: "provider-a", keychainAccount: "custom-account" }), "custom-account");
});

test("keychain store · returns empty string when key is missing", async () => {
  const runner = () => {
    const err = new Error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.");
    err.status = 44;
    throw err;
  };
  const mod = await import("../../../apps/desktop/src/keychain-store.mjs");
  assert.equal(mod.getKeychainSecret("missing-provider", { runner }), "");
  assert.equal(mod.hasKeychainSecret("missing-provider", { runner }), false);
});

test("keychain store · rejects newline secrets for macOS prompt mode", async () => {
  const mod = await import("../../../apps/desktop/src/keychain-store.mjs");
  assert.throws(
    () => mod.setKeychainSecret("provider-a", "line1\nline2", { runner: () => "" }),
    /cannot contain newlines/
  );
});

test("keychain store · uses a Windows DPAPI-backed encrypted file store on win32", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-secret-store-"));
  const calls = [];
  const runner = (cmd, args, options = {}) => {
    calls.push({ cmd, args, input: options.input });
    const script = String(args.at(-1) || "");
    if (script.includes("ConvertFrom-SecureString")) return "encrypted-value\n";
    if (script.includes("PtrToStringBSTR")) return "secret-value\n";
    return "";
  };
  const mod = await import("../../../apps/desktop/src/keychain-store.mjs");
  try {
    assert.equal(mod.setKeychainSecret("provider-a", "secret-value", { platform: "win32", secretDir: tmp, runner }).ok, true);
    assert.equal(mod.getKeychainSecret("provider-a", { platform: "win32", secretDir: tmp, runner }), "secret-value");
    assert.equal(mod.hasKeychainSecret("provider-a", { platform: "win32", secretDir: tmp, runner }), true);
    assert.equal(mod.deleteKeychainSecret("provider-a", { platform: "win32", secretDir: tmp, runner }).ok, true);
    assert.equal(fs.readdirSync(tmp).length, 0);
    assert.equal(calls.every((call) => call.cmd.toLowerCase().includes("powershell")), true);
    assert.equal(JSON.stringify(calls.map((call) => call.args)).includes("secret-value"), false);
    assert.equal(mod.describeKeychainSecret("provider-a", { platform: "win32" }).includes("Windows"), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

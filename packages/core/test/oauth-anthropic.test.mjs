import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAnthropicAuthUrl,
  generatePKCE,
  generateOAuthState,
  readAnthropicOAuthFile,
  writeAnthropicOAuthFile,
  clearAnthropicOAuthFile,
  anthropicOAuthAuthPath
} from "../src/oauth-anthropic.mjs";

test("generatePKCE returns verifier and s256 challenge", () => {
  const a = generatePKCE();
  assert.equal(typeof a.verifier, "string");
  assert.ok(a.verifier.length >= 32);
  assert.equal(typeof a.challenge, "string");
  assert.notEqual(a.verifier, a.challenge);
  const b = generatePKCE();
  assert.notEqual(a.verifier, b.verifier);
});

test("buildAnthropicAuthUrl includes client_id and pkce", () => {
  const state = generateOAuthState();
  const pkce = generatePKCE();
  const url = buildAnthropicAuthUrl({ state, codeChallenge: pkce.challenge });
  assert.ok(url.startsWith("https://claude.ai/oauth/authorize?"));
  const u = new URL(url);
  assert.equal(u.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(u.searchParams.get("state"), state);
  assert.ok(u.searchParams.get("scope")?.includes("user:inference"));
});

test("write/read/clear anthropic oauth file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-oauth-"));
  const file = path.join(dir, "anthropic.json");
  writeAnthropicOAuthFile(
    {
      accessToken: "access-test",
      refreshToken: "refresh-test",
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: "user@example.com",
      accountId: "acc-1"
    },
    file
  );
  const auth = readAnthropicOAuthFile(file);
  assert.equal(auth.ok, true);
  assert.equal(auth.accessToken, "access-test");
  assert.equal(auth.refreshToken, "refresh-test");
  assert.equal(auth.email, "user@example.com");
  const cleared = clearAnthropicOAuthFile(file);
  assert.equal(cleared.ok, true);
  assert.equal(readAnthropicOAuthFile(file).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("anthropicOAuthAuthPath defaults and per-provider", () => {
  const def = anthropicOAuthAuthPath();
  assert.ok(def.endsWith(`${path.sep}oauth${path.sep}anthropic.json`));
  const custom = anthropicOAuthAuthPath("my-claude");
  assert.ok(custom.endsWith(`${path.sep}oauth${path.sep}anthropic-my-claude.json`));
});

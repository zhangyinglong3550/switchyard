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
  anthropicOAuthAuthPath,
  parseClaudeCredentialsJson,
  normalizeExpiresAt,
  resolveAnthropicOAuthAuth
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

test("parseClaudeCredentialsJson matches CC Switch claudeAiOauth shape", () => {
  const ms = Date.now() + 3600_000;
  const parsed = parseClaudeCredentialsJson(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-test",
        refreshToken: "sk-ant-ort-test",
        expiresAt: ms,
        emailAddress: "u@example.com",
        accountUuid: "acc-uuid"
      }
    }),
    "test"
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.accessToken, "sk-ant-oat-test");
  assert.equal(parsed.refreshToken, "sk-ant-ort-test");
  assert.equal(parsed.email, "u@example.com");
  assert.equal(parsed.accountId, "acc-uuid");
  assert.ok(parsed.expiresAt.startsWith("20"));

  const alt = parseClaudeCredentialsJson(
    JSON.stringify({
      "claude.ai_oauth": { accessToken: "tok2", expiresAt: Math.floor(ms / 1000) }
    })
  );
  assert.equal(alt.ok, true);
  assert.equal(alt.accessToken, "tok2");
});

test("normalizeExpiresAt handles seconds and millis", () => {
  const sec = Math.floor(Date.now() / 1000) + 1000;
  const iso = normalizeExpiresAt(sec);
  assert.ok(iso.includes("T"));
  const ms = Date.now() + 1_000_000;
  assert.equal(normalizeExpiresAt(ms), new Date(ms).toISOString());
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

test("resolveAnthropicOAuthAuth prefers memory binding", () => {
  const auth = resolveAnthropicOAuthAuth({
    provider: {
      _anthropicAccessToken: "mem-token",
      _anthropicEmail: "m@example.com"
    }
  });
  assert.equal(auth.ok, true);
  assert.equal(auth.source, "memory");
  assert.equal(auth.accessToken, "mem-token");
});

test("anthropicOAuthAuthPath defaults and per-provider", () => {
  const def = anthropicOAuthAuthPath();
  assert.ok(def.endsWith(`${path.sep}oauth${path.sep}anthropic.json`));
  const custom = anthropicOAuthAuthPath("my-claude");
  assert.ok(custom.endsWith(`${path.sep}oauth${path.sep}anthropic-my-claude.json`));
});

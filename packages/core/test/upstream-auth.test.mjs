import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fakeJwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

test("codex oauth auth · reads ~/.codex/auth.json and builds Codex headers", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-codex-auth-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const token = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" }
    });
    fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".codex", "auth.json"), JSON.stringify({
      tokens: { access_token: token }
    }), "utf8");

    const mod = await import(`../src/upstream/clients.mjs?v=${Date.now()}`);
    const provider = { id: "codex", authMode: "codex_oauth", baseUrl: "https://chatgpt.com/backend-api/codex" };
    const auth = mod.readCodexOAuthAuth({ provider });
    assert.equal(auth.ok, true);
    assert.equal(auth.accountId, "acct_123");

    const headers = mod.providerAuthHeaders(provider, "bearer");
    assert.equal(headers.Authorization, `Bearer ${token}`);
    assert.equal(headers["OpenAI-Beta"], "responses=experimental");
    assert.equal(headers.originator, "codex_cli_rs");
    assert.equal(headers["User-Agent"], "codex_cli_rs/0.0.0");
    assert.equal(headers["chatgpt-account-id"], "acct_123");
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("provider auth · api_key and none modes remain isolated", async () => {
  const mod = await import(`../src/upstream/clients.mjs?v=${Date.now()}`);
  assert.deepEqual(mod.providerAuthHeaders({ authMode: "none" }, "bearer"), {});
  assert.deepEqual(
    mod.providerAuthHeaders({ authMode: "api_key", apiKey: "sk-test" }, "anthropic"),
    { "x-api-key": "sk-test", "anthropic-version": "2023-06-01" }
  );
});

test("provider endpoint · canonicalizes OpenCode Go base URL to the v1 API root", async () => {
  const mod = await import(`../src/upstream/clients.mjs?v=${Date.now()}`);
  assert.equal(
    mod.canonicalProviderBaseUrl({ id: "opencode go", apiFormat: "openai_chat", baseUrl: "https://opencode.ai/zen/go" }),
    "https://opencode.ai/zen/go/v1"
  );
  assert.equal(
    mod.canonicalProviderBaseUrl({ id: "opencode go", apiFormat: "anthropic_messages", baseUrl: "https://opencode.ai/zen/go" }),
    "https://opencode.ai/zen/go"
  );
  assert.equal(
    mod.canonicalProviderBaseUrl({ id: "deepseek", baseUrl: "https://api.deepseek.com/v1" }),
    "https://api.deepseek.com/v1"
  );
  assert.equal(
    mod.canonicalProviderBaseUrl({ id: "agnes", apiFormat: "anthropic_messages", baseUrl: "https://apihub.agnes-ai.com/v1" }),
    "https://apihub.agnes-ai.com"
  );
});

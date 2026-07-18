import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fakeJwt(payload) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

function loadMod() {
  return import(`../src/oauth-codex-local.mjs?v=${Date.now()}-${Math.random()}`);
}

test("parseCodexAuthJson · missing file shape is invalid", async () => {
  const mod = await loadMod();
  const r = mod.parseCodexAuthJson({}, { authFile: "/tmp/x" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-tokens");
});

test("parseCodexAuthJson · expired access without refresh is invalid", async () => {
  const mod = await loadMod();
  const expired = fakeJwt({
    exp: Math.floor(Date.now() / 1000) - 3600,
    email: "old@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_old" }
  });
  const r = mod.parseCodexAuthJson({
    auth_mode: "chatgpt",
    tokens: { access_token: expired, account_id: "acct_old" }
  });
  assert.equal(r.ok, false);
  assert.equal(r.accessUsable, false);
  assert.equal(r.canRefresh, false);
  assert.equal(r.reason, "access-expired-no-refresh");
});

test("parseCodexAuthJson · expired access with refresh is valid", async () => {
  const mod = await loadMod();
  const expired = fakeJwt({
    exp: Math.floor(Date.now() / 1000) - 60,
    email: "a@example.com"
  });
  const r = mod.parseCodexAuthJson({
    auth_mode: "chatgpt",
    tokens: {
      access_token: expired,
      refresh_token: "rt.1.AAAA",
      account_id: "acct_1"
    }
  });
  assert.equal(r.ok, true);
  assert.equal(r.accessUsable, false);
  assert.equal(r.canRefresh, true);
  assert.equal(r.hasRefreshToken, true);
  assert.equal(r.accountId, "acct_1");
});

test("parseCodexAuthJson · fresh access is valid", async () => {
  const mod = await loadMod();
  const fresh = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "ok@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_ok" }
  });
  const r = mod.parseCodexAuthJson({
    tokens: { access_token: fresh, id_token: fresh }
  });
  assert.equal(r.ok, true);
  assert.equal(r.accessUsable, true);
  assert.equal(r.email, "ok@example.com");
  assert.equal(r.accountId, "acct_ok");
});

test("codexOAuthStatus · missing auth.json => not logged in", async () => {
  const mod = await loadMod();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-codex-status-"));
  try {
    const st = mod.codexOAuthStatus(null, { home: tmp });
    assert.equal(st.loggedIn, false);
    assert.equal(st.valid, false);
    assert.equal(st.reason, "missing-auth-file");
    assert.match(st.hint || "", /登录/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("codexOAuthStatus · file exists but expired without refresh => not logged in", async () => {
  const mod = await loadMod();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-codex-status-"));
  try {
    const dir = path.join(tmp, ".codex");
    fs.mkdirSync(dir, { recursive: true });
    const expired = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      tokens: { access_token: expired }
    }));
    const st = mod.codexOAuthStatus(null, { home: tmp });
    assert.equal(st.loggedIn, false);
    assert.equal(st.hasAccessToken, true);
    assert.equal(st.accessUsable, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensureCodexLocalAccessToken · refreshes expired access and writes auth.json", async () => {
  const mod = await loadMod();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-codex-ensure-"));
  const authFile = path.join(tmp, ".codex", "auth.json");
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const expired = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 30, email: "old@x.com" });
  fs.writeFileSync(authFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: expired,
      refresh_token: "rt-old",
      id_token: expired,
      account_id: "acct-1"
    },
    last_refresh: "2020-01-01T00:00:00.000Z"
  }));

  const newAccess = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 7200,
    email: "new@x.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" }
  });
  const fetchImpl = async () => ({
    ok: true,
    async text() {
      return JSON.stringify({
        access_token: newAccess,
        refresh_token: "rt-new",
        id_token: newAccess,
        expires_in: 7200,
        token_type: "Bearer"
      });
    }
  });

  try {
    const ensured = await mod.ensureCodexLocalAccessToken({
      authFile,
      fetchImpl,
      forceRefresh: true
    });
    assert.equal(ensured.ok, true);
    assert.equal(ensured.refreshed, true);
    assert.equal(ensured.accessToken, newAccess);

    const written = JSON.parse(fs.readFileSync(authFile, "utf8"));
    assert.equal(written.tokens.access_token, newAccess);
    assert.equal(written.tokens.refresh_token, "rt-new");
    assert.ok(written.last_refresh);

    const st = mod.codexOAuthStatus(null, { authFile });
    assert.equal(st.loggedIn, true);
    assert.equal(st.accessUsable, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCodexOAuthLogin · polls until valid auth appears", async () => {
  const mod = await loadMod();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-codex-login-"));
  const authFile = path.join(tmp, "auth.json");
  const fresh = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "login@example.com"
  });

  setTimeout(() => {
    fs.writeFileSync(authFile, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: fresh,
        refresh_token: "rt-login",
        account_id: "acct-login"
      }
    }));
  }, 80);

  try {
    const result = await mod.runCodexOAuthLogin({
      authFile,
      skipSpawn: true,
      timeoutMs: 3000,
      pollMs: 40
    });
    assert.equal(result.ok, true);
    assert.equal(result.email, "login@example.com");
    assert.equal(result.accountId, "acct-login");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("providerReady · codex oauth requires usable credentials not just file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-codex-ready-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const clients = await import(`../src/upstream/clients.mjs?v=${Date.now()}-ready`);
    clients.resetCodexAuthCache();
    const provider = {
      id: "codex",
      authMode: "codex_oauth",
      providerType: "codex_oauth",
      baseUrl: "https://chatgpt.com/backend-api/codex"
    };
    assert.equal(clients.providerReady(provider), false);

    fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
    // 文件在但 token 过期且无 refresh → 仍未 ready
    const expired = fakeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({
      tokens: { access_token: expired }
    }));
    clients.resetCodexAuthCache();
    assert.equal(clients.providerReady(provider), false);

    // 有 refresh → ready
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({
      tokens: { access_token: expired, refresh_token: "rt-ready" }
    }));
    clients.resetCodexAuthCache();
    assert.equal(clients.providerReady(provider), true);

    // 未过期 access → ready
    const fresh = fakeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    fs.writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({
      tokens: { access_token: fresh }
    }));
    clients.resetCodexAuthCache();
    assert.equal(clients.providerReady(provider), true);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

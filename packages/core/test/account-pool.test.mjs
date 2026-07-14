import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseXaiImportPayload,
  upsertAccounts,
  loadPool,
  listEligibleAccounts,
  pickAccount,
  bindProviderToAccount,
  isAccountPoolProvider,
  resetRoundRobinCursors,
  listPoolAccountsPublic,
  importXaiAccountsFromText,
  importAntigravityFromCpaDirs,
  importCodexFromPaths,
  accountFromAntigravityJson,
  accountFromCodexAuthJson,
  poolKindOf,
  isWebSsoJwt
} from "../src/account-pool/index.mjs";
import { providerReady, providerAuthHeaders, isCodexOAuthProvider } from "../src/upstream/clients.mjs";
import { dispatchChat } from "../src/upstream/dispatch.mjs";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-pool-"));
}

test("parseXaiImportPayload · CPA json and refresh token list", () => {
  const cpa = parseXaiImportPayload(JSON.stringify({
    type: "xai",
    email: "a@example.com",
    access_token: "access-aaa",
    refresh_token: "refresh-token-aaaaaaaaaaaaaaaa",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    base_url: "https://api.x.ai/v1"
  }));
  assert.equal(cpa.ok, true);
  assert.equal(cpa.accounts.length, 1);
  assert.equal(cpa.accounts[0].email, "a@example.com");
  assert.equal(cpa.accounts[0].refreshToken, "refresh-token-aaaaaaaaaaaaaaaa");

  const list = parseXaiImportPayload("refresh-token-bbbbbbbbbbbbbbbb\nrefresh-token-cccccccccccccccc");
  assert.equal(list.ok, true);
  assert.equal(list.accounts.length, 2);
});

test("account pool store · upsert skip duplicates and public view hides tokens", () => {
  const home = tmpHome();
  try {
    const first = upsertAccounts("grok-pool", [{
      email: "a@example.com",
      accessToken: "tok-a",
      refreshToken: "refresh-token-aaaaaaaaaaaaaaaa",
      weight: 2
    }], { home, skipDuplicates: true });
    assert.equal(first.added, 1);
    const second = upsertAccounts("grok-pool", [{
      email: "a@example.com",
      accessToken: "tok-a2",
      refreshToken: "refresh-token-aaaaaaaaaaaaaaaa"
    }], { home, skipDuplicates: true });
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    const pub = listPoolAccountsPublic("grok-pool", { home });
    assert.equal(pub.accounts.length, 1);
    assert.equal(pub.accounts[0].hasAccessToken, true);
    assert.equal(pub.accounts[0].accessToken, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("picker · weighted round robin rotates accounts", () => {
  const home = tmpHome();
  resetRoundRobinCursors();
  try {
    upsertAccounts("pool-rr", [
      { id: "a1", email: "a1@x.com", accessToken: "t1", refreshToken: "refresh-token-1111111111111111", weight: 1 },
      { id: "a2", email: "a2@x.com", accessToken: "t2", refreshToken: "refresh-token-2222222222222222", weight: 1 }
    ], { home, skipDuplicates: false });
    const pool = loadPool("pool-rr", { home });
    const picks = [
      pickAccount(pool, { providerId: "pool-rr" }).id,
      pickAccount(pool, { providerId: "pool-rr" }).id,
      pickAccount(pool, { providerId: "pool-rr" }).id,
      pickAccount(pool, { providerId: "pool-rr" }).id
    ];
    assert.equal(new Set(picks).size, 2);
    assert.deepEqual(picks.slice(0, 2).sort(), ["a1", "a2"].sort());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("picker · cooldown accounts are filtered", () => {
  const home = tmpHome();
  try {
    upsertAccounts("pool-cd", [
      {
        id: "cool",
        email: "c@x.com",
        accessToken: "t",
        refreshToken: "refresh-token-3333333333333333",
        health: "cooldown",
        cooldownUntil: new Date(Date.now() + 60_000).toISOString()
      },
      {
        id: "ok",
        email: "o@x.com",
        accessToken: "t2",
        refreshToken: "refresh-token-4444444444444444"
      }
    ], { home });
    const pool = loadPool("pool-cd", { home });
    const eligible = listEligibleAccounts(pool);
    assert.equal(eligible.length, 1);
    assert.equal(eligible[0].id, "ok");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseXaiImportPayload · card SSO lines", () => {
  // fake JWT with session_id claim
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ session_id: "sess-1" })).toString("base64url");
  const sso = `${header}.${payload}.sig`;
  const card = parseXaiImportPayload(`user@example.com----pass123----${sso}`);
  assert.equal(card.ok, true);
  assert.equal(card.accounts.length, 1);
  assert.equal(card.accounts[0].email, "user@example.com");
  assert.equal(card.accounts[0].ssoToken, sso);
  assert.match(card.sourceFormat, /sso/);
});

test("clients · account_pool ready and bind auth headers", async () => {
  const home = tmpHome();
  const prev = process.env.SWITCHYARD_HOME;
  process.env.SWITCHYARD_HOME = home;
  try {
    const provider = {
      id: "grok-pool",
      authMode: "account_pool",
      poolKind: "xai_oauth",
      baseUrl: "https://api.x.ai/v1",
      apiFormat: "openai_chat"
    };
    assert.equal(isAccountPoolProvider(provider), true);
    assert.equal(providerReady(provider), false);

    await importXaiAccountsFromText("grok-pool", JSON.stringify({
      type: "xai",
      email: "u@x.com",
      access_token: "live-token",
      refresh_token: "refresh-token-5555555555555555"
    }));

    assert.equal(providerReady(provider), true);

    const bound = bindProviderToAccount(provider, {
      id: "acc1",
      email: "u@x.com",
      accessToken: "live-token"
    });
    assert.equal(isAccountPoolProvider(bound), false);
    assert.equal(providerAuthHeaders(bound, "bearer").Authorization, "Bearer live-token");
  } finally {
    if (prev === undefined) delete process.env.SWITCHYARD_HOME;
    else process.env.SWITCHYARD_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("dispatch · account pool failover on 429", async () => {
  const home = tmpHome();
  const prev = process.env.SWITCHYARD_HOME;
  process.env.SWITCHYARD_HOME = home;
  resetRoundRobinCursors();
  try {
    await importXaiAccountsFromText("failover-pool", JSON.stringify([
      {
        type: "xai",
        email: "bad@x.com",
        access_token: "bad-token",
        refresh_token: "refresh-token-badbadbadbadbad1"
      },
      {
        type: "xai",
        email: "good@x.com",
        access_token: "good-token",
        refresh_token: "refresh-token-goodgoodgoodgood1"
      }
    ]));

    const provider = {
      id: "failover-pool",
      authMode: "account_pool",
      poolKind: "xai_oauth",
      baseUrl: "https://api.x.ai/v1",
      apiFormat: "openai_chat"
    };

    let calls = 0;
    const fetchImpl = async (_url, init) => {
      calls += 1;
      const auth = init.headers.Authorization || "";
      if (auth.includes("bad-token")) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ error: "rate limited" }),
          json: async () => ({ error: "rate limited" })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          id: "chatcmpl-1",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }),
        json: async () => ({})
      };
    };

    const result = await dispatchChat(provider, "grok-4.5", {
      model: "grok-4.5",
      messages: [{ role: "user", content: "hi" }],
      stream: false
    }, { fetchImpl });

    assert.equal(result.kind, "json");
    assert.equal(result.status, 200);
    assert.equal(result.payload.choices[0].message.content, "OK");
    assert.ok(calls >= 1);
    assert.ok(result.accountEmail === "good@x.com" || result.accountEmail === "bad@x.com" || result.accountId);
    // 若先抽到 bad 会 failover；若先抽到 good 则 1 次成功
    if (calls >= 2) assert.equal(result.accountEmail, "good@x.com");
  } finally {
    if (prev === undefined) delete process.env.SWITCHYARD_HOME;
    else process.env.SWITCHYARD_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("sso convert · homepage 403 does not hard-fail probe", async () => {
  const { convertSsoCookie, isWebSsoJwt } = await import(`../src/account-pool/sso-convert.mjs?v=${Date.now()}-403`);
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ session_id: "abc" })).toString("base64url");
  const sso = `${header}.${payload}.sig`;
  assert.equal(isWebSsoJwt(sso), true);

  const fetchImpl = async (url) => {
    const u = String(url);
    if (u === "https://accounts.x.ai/" || u === "https://accounts.x.ai") {
      return {
        ok: false,
        status: 403,
        url: u,
        text: async () => "<html>cf</html>",
        clone() { return this; },
        json: async () => ({})
      };
    }
    if (u.includes("/oauth2/device") && !u.includes("user_code") && !u.includes("verify") && !u.includes("approve") && !u.includes("code")) {
      return { ok: true, status: 200, url: u, text: async () => "device", clone() { return this; }, json: async () => ({}) };
    }
    if (u.includes("/oauth2/device/code")) {
      return {
        ok: true, status: 200, url: u,
        text: async () => JSON.stringify({
          device_code: "dc-1",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-EFGH",
          interval: 0,
          expires_in: 600
        }),
        json: async () => ({})
      };
    }
    if (u.includes("device?user_code") || u.includes("/device?")) {
      return { ok: true, status: 200, url: u, text: async () => "page", json: async () => ({}) };
    }
    if (u.includes("/oauth2/device/verify")) {
      return { ok: true, status: 200, url: "https://auth.x.ai/oauth2/device/consent", text: async () => "consent", json: async () => ({}) };
    }
    if (u.includes("/oauth2/device/approve")) {
      return { ok: true, status: 200, url: "https://auth.x.ai/oauth2/device/done", text: async () => "done", json: async () => ({}) };
    }
    if (u.includes("/oauth2/token")) {
      return {
        ok: true, status: 200, url: u,
        text: async () => JSON.stringify({
          access_token: "access-from-sso",
          refresh_token: "refresh-from-sso-xxxxxxxx",
          expires_in: 3600,
          token_type: "Bearer"
        }),
        json: async () => ({})
      };
    }
    if (u.includes("/oauth2/userinfo")) {
      return { ok: true, status: 200, url: u, text: async () => JSON.stringify({ email: "from-sso@x.com" }), json: async () => ({ email: "from-sso@x.com" }) };
    }
    throw new Error(`unexpected url ${u}`);
  };

  const converted = await convertSsoCookie(sso, { fetchImpl, maxRetries: 1, proxyUrl: "" });
  assert.equal(converted.accessToken, "access-from-sso");
});

test("sso convert · device flow mocked end-to-end", async () => {
  const { convertSsoCookie, isWebSsoJwt } = await import(`../src/account-pool/sso-convert.mjs?v=${Date.now()}`);
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ session_id: "abc" })).toString("base64url");
  const sso = `${header}.${payload}.sig`;
  assert.equal(isWebSsoJwt(sso), true);

  let step = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || "GET").toUpperCase();
    step += 1;
    if ((u === "https://accounts.x.ai/" || u === "https://accounts.x.ai") && method === "GET") {
      return { ok: true, status: 200, url: "https://accounts.x.ai/home", text: async () => "ok", clone() { return this; }, json: async () => ({}) };
    }
    if (u.includes("/oauth2/device") && !u.includes("user_code") && !u.includes("verify") && !u.includes("approve") && !u.includes("code")) {
      return { ok: true, status: 200, url: u, text: async () => "device", clone() { return this; }, json: async () => ({}) };
    }
    if (u.includes("accounts.x.ai") && method === "GET" && !u.includes("oauth2")) {
      return { ok: true, status: 200, url: "https://accounts.x.ai/home", text: async () => "ok", clone() { return this; }, json: async () => ({}) };
    }
    if (u.includes("/oauth2/device/code")) {
      return {
        ok: true, status: 200, url: u,
        text: async () => JSON.stringify({
          device_code: "dc-1",
          user_code: "ABCD-EFGH",
          verification_uri_complete: "https://auth.x.ai/device?user_code=ABCD-EFGH",
          interval: 0,
          expires_in: 600
        }),
        json: async () => ({})
      };
    }
    if (u.includes("device?user_code") || u.includes("/device?")) {
      return { ok: true, status: 200, url: u, text: async () => "page", json: async () => ({}) };
    }
    if (u.includes("/oauth2/device/verify")) {
      return { ok: true, status: 200, url: "https://auth.x.ai/oauth2/device/consent", text: async () => "consent", json: async () => ({}) };
    }
    if (u.includes("/oauth2/device/approve")) {
      return { ok: true, status: 200, url: "https://auth.x.ai/oauth2/device/done", text: async () => "done", json: async () => ({}) };
    }
    if (u.includes("/oauth2/token")) {
      return {
        ok: true, status: 200, url: u,
        text: async () => JSON.stringify({
          access_token: "access-from-sso",
          refresh_token: "refresh-from-sso-xxxxxxxx",
          expires_in: 3600,
          token_type: "Bearer"
        }),
        json: async () => ({})
      };
    }
    if (u.includes("/oauth2/userinfo")) {
      return { ok: true, status: 200, url: u, text: async () => JSON.stringify({ email: "from-sso@x.com" }), json: async () => ({ email: "from-sso@x.com" }) };
    }
    throw new Error(`unexpected url ${u}`);
  };

  const converted = await convertSsoCookie(sso, { fetchImpl, maxRetries: 1 });
  assert.equal(converted.accessToken, "access-from-sso");
  assert.equal(converted.refreshToken, "refresh-from-sso-xxxxxxxx");
  assert.equal(converted.email, "from-sso@x.com");
  assert.ok(step >= 5);
});

test("import-multi · antigravity CPA json and codex auth.json", () => {
  const home = tmpHome();
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpa-auth-"));
  try {
    fs.writeFileSync(path.join(authDir, "antigravity-demo@x.com.json"), JSON.stringify({
      type: "antigravity",
      email: "demo@x.com",
      access_token: "ga-access",
      refresh_token: "1//google-refresh-token",
      expired: new Date(Date.now() + 3600_000).toISOString(),
      project_id: "proj-1"
    }));
    const anti = importAntigravityFromCpaDirs("antigravity-pool", {
      dirs: [authDir],
      home,
      syncToCliproxy: true
    });
    assert.equal(anti.ok, true);
    assert.equal(anti.added, 1);
    const antiPool = loadPool("antigravity-pool", { poolKind: "antigravity_oauth", home });
    assert.equal(antiPool.accounts.length, 1);
    assert.equal(antiPool.accounts[0].email, "demo@x.com");
    assert.ok(anti.sync?.written >= 1);

    const codexAuth = path.join(authDir, "auth.json");
    fs.writeFileSync(codexAuth, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "codex-access",
        refresh_token: "codex-refresh-token-xxxxxx",
        id_token: "header." + Buffer.from(JSON.stringify({
          email: "codex@openai.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" }
        })).toString("base64url") + ".sig",
        account_id: "acct-1"
      }
    }));
    const codex = importCodexFromPaths("codex-pool", {
      paths: [codexAuth],
      home
    });
    assert.equal(codex.ok, true);
    assert.equal(codex.added, 1);
    const codexPool = loadPool("codex-pool", { poolKind: "codex_oauth", home });
    assert.equal(codexPool.accounts[0].accessToken, "codex-access");
    assert.equal(codexPool.accounts[0].accountId, "acct-1");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(authDir, { recursive: true, force: true });
  }
});

test("picker · bind antigravity and codex pool kinds", () => {
  const antiProvider = {
    id: "antigravity-pool",
    authMode: "account_pool",
    poolKind: "antigravity_oauth",
    baseUrl: "http://127.0.0.1:8317/v1",
    apiKey: "sk-cliproxy-local"
  };
  assert.equal(poolKindOf(antiProvider), "antigravity_oauth");
  const antiBound = bindProviderToAccount(antiProvider, {
    id: "a1",
    email: "a@x.com",
    accessToken: "google-access"
  });
  assert.equal(antiBound.authMode, "api_key");
  assert.equal(antiBound.apiKey, "sk-cliproxy-local");
  assert.equal(antiBound._relay, "cliproxy");
  assert.equal(antiBound._accountEmail, "a@x.com");
  assert.equal(isAccountPoolProvider(antiBound), false);

  const codexProvider = {
    id: "codex-pool",
    authMode: "account_pool",
    poolKind: "codex_oauth",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiFormat: "openai_responses"
  };
  const codexBound = bindProviderToAccount(codexProvider, {
    id: "c1",
    email: "c@x.com",
    accessToken: "codex-live",
    accountId: "acct-9"
  });
  assert.equal(codexBound.authMode, "codex_oauth");
  assert.equal(isCodexOAuthProvider(codexBound), true);
  assert.equal(codexBound._codexAccessToken, "codex-live");
  assert.equal(providerAuthHeaders(codexBound, "bearer").Authorization, "Bearer codex-live");
  assert.equal(providerAuthHeaders(codexBound, "bearer")["chatgpt-account-id"], "acct-9");
});

test("accountFrom* helpers parse token fields", () => {
  const a = accountFromAntigravityJson({
    email: "g@x.com",
    access_token: "at",
    refresh_token: "rt",
    project_id: "p1"
  });
  assert.equal(a.email, "g@x.com");
  assert.equal(a.projectId, "p1");
  const c = accountFromCodexAuthJson({
    tokens: { access_token: "ca", refresh_token: "cr", account_id: "aid" },
    email: "c@x.com"
  });
  assert.equal(c.accessToken, "ca");
  assert.equal(c.accountId, "aid");
});

test("parseCodexImportPayload · json array and refresh lines", async () => {
  const { parseCodexImportPayload, importCodexAccountsFromText } = await import("../src/account-pool/import-multi.mjs");
  const arr = parseCodexImportPayload(JSON.stringify([
    {
      email: "a@x.com",
      tokens: { access_token: "aa", refresh_token: "refresh-aaaa-aaaa-aaaa-aaaa", account_id: "id-a" }
    },
    {
      type: "codex",
      email: "b@x.com",
      access_token: "bb",
      refresh_token: "refresh-bbbb-bbbb-bbbb-bbbb"
    }
  ]));
  assert.equal(arr.ok, true);
  assert.equal(arr.accounts.length, 2);
  assert.equal(arr.accounts[0].email, "a@x.com");
  assert.equal(arr.accounts[1].refreshToken, "refresh-bbbb-bbbb-bbbb-bbbb");

  const lines = parseCodexImportPayload("c@x.com----refresh-cccc-cccc-cccc-cccc\nrefresh-dddd-dddd-dddd-dddddddd");
  assert.equal(lines.ok, true);
  assert.ok(lines.accounts.length >= 2);

  const home = tmpHome();
  try {
    const r = importCodexAccountsFromText("codex-pool", JSON.stringify([{
      tokens: { access_token: "t", refresh_token: "refresh-eeee-eeee-eeee-eeee", account_id: "e1" },
      email: "e@x.com"
    }]), { home });
    assert.equal(r.ok, true);
    assert.equal(r.added, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("parseCodexUsagePayload · remaining windows", async () => {
  const { parseCodexUsagePayload } = await import("../src/account-pool/quota.mjs");
  const q = parseCodexUsagePayload({
    plan_type: "k12",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: 1784016538 },
      secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: 1784603338 }
    }
  });
  assert.equal(q.ok, true);
  assert.equal(q.primaryRemainingPercent, 93);
  assert.equal(q.secondaryRemainingPercent, 99);
  assert.match(q.summary, /5h 剩93%/);
  assert.equal(q.planType, "k12");
});

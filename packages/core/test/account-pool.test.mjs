import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  parseXaiImportPayload,
  upsertAccounts,
  loadPool,
  savePool,
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
  ensureFreshAccount,
  markAccountFailure,
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

test("picker · model-specific failures avoid only the affected account-model route", () => {
  const home = tmpHome();
  try {
    upsertAccounts("model-health-pool", [
      { id: "a", email: "a@x.com", accessToken: "ta", refreshToken: "refresh-token-aaaaaaaaaaaaaaaa" },
      { id: "b", email: "b@x.com", accessToken: "tb", refreshToken: "refresh-token-bbbbbbbbbbbbbbbb" }
    ], { home, skipDuplicates: false });
    const provider = { id: "model-health-pool", authMode: "account_pool", poolKind: "xai_oauth" };
    const accountA = loadPool("model-health-pool", { home }).accounts.find((account) => account.id === "a");
    markAccountFailure(provider, accountA, { status: 500, error: "model-a upstream error", upstreamModel: "model-a", home });

    const pool = loadPool("model-health-pool", { home });
    const updatedAccountA = pool.accounts.find((account) => account.id === "a");
    assert.equal(updatedAccountA.modelHealth["model-a"].consecutiveFailures, 1);
    assert.equal(updatedAccountA.health, "healthy", "5xx must not degrade the account for unrelated models");
    assert.equal(updatedAccountA.consecutiveFailures, 0);
    assert.equal(pickAccount(pool, { providerId: "model-health-pool", strategy: "lowest_error_rate", upstreamModel: "model-a" }).id, "b");
    assert.equal(listPoolAccountsPublic("model-health-pool", { home }).accounts.find((account) => account.id === "a").modelHealth["model-a"].health, "degraded");

    markAccountFailure(provider, updatedAccountA, { status: 429, error: "account quota exhausted", upstreamModel: "model-b", home });
    const quotaLimited = loadPool("model-health-pool", { home }).accounts.find((account) => account.id === "a");
    assert.equal(quotaLimited.health, "cooldown", "429 must cool down the whole account");
    assert.equal(listEligibleAccounts(loadPool("model-health-pool", { home })).some((account) => account.id === "a"), false);
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

test("dispatch · account pool does NOT multiply retries (no outer retry amplification)", async () => {
  // 2 个账号全部 500（500 不触发 cooldown，账号仍 eligible）。
  // 修复前：外层 withDispatchRetry(3) × 池(2) = 最多 6 次上游调用。
  // 修复后：账号池关闭外层重试，只由池内换号，calls ≤ 池大小(2)。
  const home = tmpHome();
  const prev = process.env.SWITCHYARD_HOME;
  process.env.SWITCHYARD_HOME = home;
  resetRoundRobinCursors();
  try {
    await importXaiAccountsFromText("amplify-pool", JSON.stringify([
      { type: "xai", email: "a@x.com", access_token: "ta", refresh_token: "ra-ra-ra-ra-ra-ra-ra-ra1" },
      { type: "xai", email: "b@x.com", access_token: "tb", refresh_token: "rb-rb-rb-rb-rb-rb-rb-rb1" }
    ]));

    const provider = {
      id: "amplify-pool",
      authMode: "account_pool",
      poolKind: "xai_oauth",
      baseUrl: "https://api.x.ai/v1",
      apiFormat: "openai_chat"
    };

    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ error: "boom" }),
        json: async () => ({ error: "boom" })
      };
    };

    const result = await dispatchChat(provider, "grok-4.5", {
      model: "grok-4.5",
      messages: [{ role: "user", content: "hi" }],
      stream: false
    }, { fetchImpl });

    assert.equal(result.kind, "error");
    assert.equal(result.status, 500);
    // 池有 2 个账号 -> 最多 2 次上游调用；修复前会是 6 次。
    assert.ok(calls <= 2, `expected <= 2 upstream calls (no amplification), got ${calls}`);
    assert.equal(result.retryPolicy?.enabled, false, "outer retry should be disabled for account pool");
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
    baseUrl: "https://daily-cloudcode-pa.googleapis.com"
  };
  assert.equal(poolKindOf(antiProvider), "antigravity_oauth");
  const antiBound = bindProviderToAccount(antiProvider, {
    id: "a1",
    email: "a@x.com",
    accessToken: "google-access"
  });
  assert.equal(antiBound.authMode, "antigravity_oauth");
  assert.equal(antiBound.apiFormat, "antigravity");
  assert.equal(antiBound.apiKey, "google-access");
  assert.equal(antiBound._antigravityAccessToken, "google-access");
  assert.equal(antiBound._relay, undefined);
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

test("picker · Antigravity CPA imports reuse the local refreshed credential without OAuth client env", async () => {
  const home = tmpHome();
  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-cpa-"));
  try {
    const email = "fresh@x.com";
    const fileName = `antigravity-${email}.json`;
    fs.writeFileSync(path.join(authDir, fileName), JSON.stringify({
      type: "antigravity",
      email,
      access_token: "fresh-local-access",
      refresh_token: "fresh-local-refresh",
      expired: new Date(Date.now() + 3600_000).toISOString(),
      project_id: "fresh-project"
    }));
    upsertAccounts("antigravity-pool", [{
      email,
      accessToken: "expired-pool-access",
      refreshToken: "expired-pool-refresh",
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
      projectId: "old-project",
      source: `cpa-file:${fileName}`
    }], { home, poolKind: "antigravity_oauth" });
    const account = loadPool("antigravity-pool", { home, poolKind: "antigravity_oauth" }).accounts[0];
    const result = await ensureFreshAccount(account, {
      home,
      provider: {
        id: "antigravity-pool",
        authMode: "account_pool",
        poolKind: "antigravity_oauth",
        antigravityAuthDir: authDir
      },
      fetchImpl: async () => {
        throw new Error("Google refresh should not run when CPA already has a fresh access token");
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.refreshed, true);
    assert.equal(result.account.accessToken, "fresh-local-access");
    assert.equal(result.account.projectId, "fresh-project");
    const stored = loadPool("antigravity-pool", { home, poolKind: "antigravity_oauth" }).accounts[0];
    assert.equal(stored.accessToken, "fresh-local-access");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(authDir, { recursive: true, force: true });
  }
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

test("picker · expired cooldown is conservatively recovered as degraded", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-recover-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const { recoverExpiredAccountCooldowns } = await import("../src/account-pool/index.mjs");
  savePool({ providerId: "recover-pool", poolKind: "xai_oauth", accounts: [{ id: "a", accessToken: "token", health: "cooldown", cooldownUntil: new Date(Date.now() - 1000).toISOString(), modelHealth: { "m": { health: "cooldown", cooldownUntil: new Date(Date.now() - 1000).toISOString() } } }] }, { home });
  const result = recoverExpiredAccountCooldowns({ id: "recover-pool", poolKind: "xai_oauth" }, { home });
  assert.equal(result.recoveredAccounts, 1);
  assert.equal(result.recoveredModels, 1);
  const account = loadPool("recover-pool", { poolKind: "xai_oauth", home }).accounts[0];
  assert.equal(account.health, "degraded");
  assert.equal(account.modelHealth.m.health, "degraded");
});

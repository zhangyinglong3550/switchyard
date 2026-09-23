import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createWorkBuddyAuthState,
  pollWorkBuddyLogin,
  refreshWorkBuddyTokens,
  fetchWorkBuddyAccount,
  upsertAccounts,
  loadPool,
  pickAndRefreshAccount,
  bindProviderToAccount,
  listPoolAccountsPublic,
  refreshExpiringAccounts,
  workBuddyHeaders,
  workBuddyRealmConfig,
  WORKBUDDY_BASE_URL
} from "../src/account-pool/index.mjs";
import { providerAuthHeaders, providerReady, callOpenAIChat } from "../src/upstream/clients.mjs";
import { prepareWorkBuddyChatBody, hardenWorkBuddyChatBody, sanitizeWorkBuddyChatBody, aggregateChatSseToChatResponse, normalizeWorkBuddyStreamLine } from "../src/upstream/workbuddy-adapter.mjs";
import { dispatchChat } from "../src/upstream/dispatch.mjs";
import { mergeWithDefaults } from "../src/config.mjs";
import { getProviderPreset } from "../src/provider-presets.mjs";

const envelope = (data, code = 0) => ({ code, msg: code === 0 ? "ok" : "pending", data });

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), body: { cancel: async () => {} } };
}

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-workbuddy-")); }

function dispatchPool(t, poolKind = "workbuddy_oauth") {
  const home = tmpHome();
  const prev = process.env.SWITCHYARD_HOME;
  process.env.SWITCHYARD_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.SWITCHYARD_HOME;
    else process.env.SWITCHYARD_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const provider = {
    id: path.basename(home), authMode: "account_pool", poolKind,
    apiFormat: "openai_chat", poolStrategy: "least_recently_used"
  };
  const saved = upsertAccounts(provider.id, [1, 2].map((n) => ({
    id: `account-${n}`, email: `test-${n}@example.invalid`, accountId: `uid-${n}`,
    accessToken: `fake-access-${n}`, refreshToken: `fake-refresh-${n}`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    lastUsedAt: `2026-01-0${n}T00:00:00.000Z`, realm: "global"
  })), { poolKind, home });
  return { provider, poolPath: saved.path, readPool: () => loadPool(provider.id, { poolKind, home }) };
}

for (const stream of [false, true]) {
  for (const status of [402, 404]) {
    for (const refresh of [false, true]) {
      test(`failure accounting ${status} stream=${stream} refresh=${refresh}`, async (t) => {
        const { provider, readPool } = dispatchPool(t);
        const calls = [];
        const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
          fetchImpl: async (url, init) => {
            calls.push(init.headers["X-User-Id"]);
            if (url.includes("/auth/token/refresh")) return new Response(JSON.stringify(envelope({
              accessToken: "fake-renewed", refreshToken: "fake-renewed-refresh", expiresIn: 86400
            })));
            return new Response('{"error":"denied"}', { status: refresh && calls.length === 1 ? 401 : status });
          }
        });
        assert.equal(result.status || result.upstream?.status, status);
        assert.equal(result.accountId, "account-1");
        assert.ok(calls.every((id) => id === "uid-1"));
        assert.ok(readPool().accounts.every((a) => !a.lastSuccessAt));
        if (result.upstream) await result.upstream.body.cancel();
      });
    }
  }
}

// 以下用例仅使用临时账号池与注入的 fetch，不访问真实凭证或网络。
for (const stream of [false, true]) {
  test(`reliability affinity stream=${stream}`, async (t) => {
    const { provider } = dispatchPool(t);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    const send = async (sessionKey, clientId = "client-a", model = "model-a", body = {}) => {
      clock += 1000;
      const result = await dispatchChat(provider, model, { ...dispatchBody(stream), ...body }, {
        sessionKey, clientId, fetchImpl: async () => new Response(successSse)
      });
      if (result.upstream) await result.upstream.text();
      const { updateAccountRuntime } = await import("../src/account-pool/index.mjs");
      updateAccountRuntime(provider.id, result.accountId, { lastUsedAt: new Date(clock).toISOString() }, { poolKind: "workbuddy_oauth" });
      return result.accountId;
    };
    assert.equal(await send("session-a"), "account-1");
    assert.equal(await send("session-a"), "account-1");
    assert.equal(await send("session-b"), "account-2");
    assert.equal(await send("session-a", "client-b"), "account-1");
    assert.equal(await send("session-a", "client-a", "model-b"), "account-2");
    assert.equal(await send("session-a"), "account-1");
    assert.equal(await send("", "client-a", "model-a", { session_id: "body-session" }), "account-2");
    assert.equal(await send("", "client-a", "model-a", { session_id: "body-session" }), "account-2");
    assert.notEqual(await send(""), await send(""));
  });

  test(`reliability saturation stream=${stream} default3`, async (t) => {
    const { provider, readPool } = dispatchPool(t);
    const { savePool } = await import("../src/account-pool/index.mjs");
    const pool = readPool();
    pool.accounts.forEach((a) => { a.expiresAt = new Date(Date.now() - 1000).toISOString(); });
    savePool(pool);
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(init.headers["X-User-Id"]);
      await gate;
      if (url.includes("/auth/token/refresh")) return new Response(JSON.stringify(envelope({ accessToken: "fake-fresh", expiresIn: 86400 })));
      return new Response(successSse, { headers: { "x-fixture": "kept" } });
    };
    const pending = Array.from({ length: 7 }, () => dispatchChat(provider, "model-a", dispatchBody(stream), { fetchImpl }));
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.filter((id) => id === "uid-1").length, 1);
      assert.equal(calls.filter((id) => id === "uid-2").length, 1);
    } finally { unblock(); }
    const results = await Promise.all(pending);
    assert.equal(results[6].status, 503);
    assert.match(results[6].payload.error, /capacity/i);
    for (const result of results.slice(0, 6)) {
      if (stream) {
        assert.equal(result.upstream.headers.get("x-fixture"), "kept");
        await result.upstream.text();
      }
    }
    const next = await dispatchChat(provider, "model-a", dispatchBody(false), { fetchImpl });
    assert.equal(next.kind, "json");
  });

  for (const hint of ["7200", "date", "invalid", "past"]) {
    test(`reliability cooldown stream=${stream} hint=${hint}`, async (t) => {
      const { provider, readPool } = dispatchPool(t);
      const before = Date.now();
      const advertised = before + 7200000;
      const header = hint === "date" ? new Date(advertised).toUTCString() : hint === "past" ? "Thu, 01 Jan 1970 00:00:00 GMT" : hint;
      let calls = 0;
      const opts = { fetchImpl: async () => {
        calls += 1;
        return new Response('{"error":{"message":"limited"}}', { status: 429, headers: { "Retry-After": header, "x-fixture": "kept" } });
      } };
      const result = await dispatchChat(provider, "model-a", dispatchBody(stream), opts);
      assert.equal(result.status, 429);
      assert.equal(result.headers.get("retry-after"), header);
      for (const account of readPool().accounts) {
        assert.ok(Date.parse(account.cooldownUntil) >= (hint === "7200" || hint === "date" ? advertised - 1000 : before + 30000));
      }
      const count = calls;
      assert.equal((await dispatchChat(provider, "model-a", dispatchBody(stream), opts)).status, 503);
      assert.equal(calls, count);
    });
  }
}

for (const ending of ["eof", "cancel", "error", "abort"]) {
  test(`reliability stream lease ${ending}`, async (t) => {
    const { provider, readPool } = dispatchPool(t);
    const { savePool } = await import("../src/account-pool/index.mjs");
    const pool = readPool(); pool.accounts = pool.accounts.slice(0, 1); savePool(pool);
    provider.maxInFlight = 1;
    let source;
    let cancelled = false;
    let pulls = 0;
    const controller = new AbortController();
    const result = await dispatchChat(provider, "model-a", dispatchBody(true), {
      signal: controller.signal,
      fetchImpl: async () => new Response(new ReadableStream({
        start(c) { source = c; }, pull() { pulls += 1; }, cancel() { cancelled = true; }
      }, { highWaterMark: 0 }), { headers: { "x-fixture": "kept" } })
    });
    const healthy = readPool().accounts[0];
    let calls = 0;
    const opts = { fetchImpl: async () => { calls += 1; return new Response(successSse); } };
    try {
      assert.equal((await dispatchChat(provider, "model-a", dispatchBody(false), opts)).status, 503);
      assert.equal(calls, 0);
      assert.equal(pulls, 0);
    } finally {
      if (ending === "eof") { source.close(); await result.upstream.text(); }
      if (ending === "cancel") { await result.upstream.body.cancel(); assert.equal(cancelled, true); }
      if (ending === "error") { source.error(new Error("fixture stream error")); await assert.rejects(result.upstream.text(), /fixture stream error/); }
      if (ending === "abort") { controller.abort(); await assert.rejects(result.upstream.text(), { name: "AbortError" }); assert.equal(cancelled, true); }
    }
    assert.deepEqual(readPool().accounts[0], healthy);
    assert.equal((await dispatchChat(provider, "model-a", dispatchBody(false), opts)).kind, "json");
  });
}

test("reliability abort before headers has no penalty or attempts", async (t) => {
  const { provider, poolPath } = dispatchPool(t);
  const before = fs.readFileSync(poolPath, "utf8");
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(dispatchChat(provider, "model-a", dispatchBody(false), {
    signal: controller.signal, fetchImpl: async () => {
      calls += 1; controller.abort(); throw new DOMException("aborted", "AbortError");
    }
  }), { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(poolPath, "utf8"), before);
});

const wafHtml = "<!doctype html><html><head><title>WAF Block Page</title></head><body>fake-secret-marker</body></html>";
const successSse = 'data: {"id":"chat-test","choices":[{"index":0,"delta":{"content":"正常输出"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const dispatchBody = (stream) => ({ stream, messages: [{ role: "user", content: "hi" }] });

for (const stream of [false, true]) {
  for (const title of ["<title>WAF Block Page</title>", "<TiTlE > \n waf\t BLOCK  Page \n </tItLe >"]) {
    test(`workbuddy WAF403 · stream=${stream} 标题=${JSON.stringify(title)} 保留状态且不换号或修改健康`, async (t) => {
      const { provider, poolPath } = dispatchPool(t);
      const before = fs.readFileSync(poolPath, "utf8");
      const calls = [];
      let bodyReads = 0;
      const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
        fetchImpl: async (url, init) => {
          calls.push({ url, init });
          const res = new Response(wafHtml.replace("<title>WAF Block Page</title>", title), { status: 403 });
          const text = res.text.bind(res);
          res.text = () => { bodyReads += 1; return text(); };
          return res;
        }
      });
      assert.equal(result.kind, "error");
      assert.equal(result.status, 403);
      assert.equal(result.payload.error.code, "upstream_policy_blocked");
      assert.equal(result.payload.error.type, "upstream_policy_error");
      assert.equal(result.payload.error.retryable, false);
      assert.equal(result.payload.error.upstreamStatus, 403);
      assert.match(result.payload.error.message, /上游.*安全策略.*拦截/);
      assert.match(result.payload.error.message, /不足以.*凭证.*过期/);
      assert.match(result.payload.error.message, /典型诱因.*fetch\/curl \+ 域名.*SSRF 启发式误报/s);
      assert.match(result.payload.error.message, /新建会话/);
      assert.match(result.payload.error.message, /Request UUID/);
      assert.ok(!("retriedAttempts" in result.payload.error));
      assert.equal(result.accountId, "account-1");
      assert.equal(result.accountEmail, "test-1@example.invalid");
      assert.equal(calls.length, 1);
      assert.equal(bodyReads, 1);
      assert.equal(result.retryCount, 0);
      assert.equal(calls[0].init.headers["X-User-Id"], "uid-1");
      assert.equal(fs.readFileSync(poolPath, "utf8"), before);
      assert.doesNotMatch(JSON.stringify(result), /fake-secret-marker|fake-access|fake-refresh|<html|<title/i);
    });
  }

  for (const status of [401, 403, 429]) {
    test(`workbuddy 普通 JSON${status} · stream=${stream} 保留错误与换号`, async (t) => {
      const { provider, readPool } = dispatchPool(t);
      const calls = [];
      const payload = { error: { code: "ordinary_error", message: "ordinary denial" } };
      const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
        fetchImpl: async (url, init) => {
          calls.push(init.headers["X-User-Id"]);
          if (url.includes("/auth/token/refresh")) return new Response("{}", { status: 400 });
          return new Response(JSON.stringify(payload), { status });
        }
      });
      assert.equal(result.kind, "error");
      assert.equal(result.status, status);
      assert.deepEqual(result.payload, payload);
      assert.equal(result.accountId, "account-2");
      assert.equal(result.accountEmail, "test-2@example.invalid");
      assert.equal(calls.length, status === 401 ? 4 : 2);
      assert.ok(calls.includes("uid-1") && calls.includes("uid-2"));
      for (const account of readPool().accounts) {
        assert.ok(account.consecutiveFailures > 0);
        assert.equal(account.health, status === 401 ? "degraded" : "cooldown");
      }
    });
  }

  test(`workbuddy 401 续期后 WAF403 · stream=${stream} 不因策略拦截标记成功或失败`, async (t) => {
    const { provider, readPool } = dispatchPool(t);
    const before = readPool().accounts.map(({ health, consecutiveFailures, lastError, lastUsedAt, lastSuccessAt, modelHealth }) =>
      ({ health, consecutiveFailures, lastError, lastUsedAt, lastSuccessAt, modelHealth }));
    let calls = 0;
    const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
      fetchImpl: async (url) => {
        calls += 1;
        if (url.includes("/auth/token/refresh")) return new Response(JSON.stringify(envelope({
          accessToken: "fake-renewed", refreshToken: "fake-renewed-refresh", expiresIn: 86400
        })));
        return calls === 1
          ? new Response('{"error":"expired"}', { status: 401 })
          : new Response(wafHtml, { status: 403 });
      }
    });
    assert.equal(result.payload.error.code, "upstream_policy_blocked");
    assert.equal(result.status, 403);
    assert.equal(result.accountId, "account-1");
    assert.equal(calls, 3);
    assert.deepEqual(readPool().accounts.map(({ health, consecutiveFailures, lastError, lastUsedAt, lastSuccessAt, modelHealth }) =>
      ({ health, consecutiveFailures, lastError, lastUsedAt, lastSuccessAt, modelHealth })), before);
  });


  test(`workbuddy 成功 SSE · stream=${stream} 输出与成功状态不变`, async (t) => {
    const { provider, readPool } = dispatchPool(t);
    let calls = 0;
    const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
      fetchImpl: async () => {
        calls += 1;
        return new Response(successSse, { headers: { "Content-Type": "text/event-stream" } });
      }
    });
    assert.equal(calls, 1);
    assert.equal(result.accountId, "account-1");
    if (stream) {
      assert.equal(result.kind, "stream");
      assert.equal(await result.upstream.text(), successSse);
    } else {
      assert.equal(result.kind, "json");
      assert.equal(result.payload.choices[0].message.content, "正常输出");
    }
    assert.ok(readPool().accounts[0].lastSuccessAt);
  });

  test(`非 WorkBuddy WAF403 · stream=${stream} 仍按普通失败换号`, async (t) => {
    const { provider, readPool } = dispatchPool(t, "xai_oauth");
    let calls = 0;
    const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
      fetchImpl: async () => { calls += 1; return new Response(wafHtml, { status: 403 }); }
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 403);
    assert.deepEqual(result.payload, { error: wafHtml });
    assert.equal(result.accountId, "account-2");
    assert.ok(readPool().accounts.every((a) => a.health === "cooldown"));
  });

  test(`workbuddy 非 WAF403 流兼容 · stream=${stream} 不扩大标题匹配范围`, async () => {
    const provider = { id: "wb-direct", authMode: "workbuddy_oauth", baseUrl: WORKBUDDY_BASE_URL };
    for (const text of ["<html><title>Forbidden</title><body>WAF Block Page</body></html>", "<title>WAF Block Page extra</title>", JSON.stringify({ error: "WAF Block Page" })]) {
      const result = await dispatchChat(provider, "test-model", dispatchBody(stream), {
        fetchImpl: async () => new Response(text, { status: 403 })
      });
      const expected = text.startsWith("{") ? JSON.parse(text) : { error: text };
      if (stream) {
        assert.equal(result.kind, "stream");
        assert.equal(result.upstream.status, 403);
        assert.deepEqual(await result.upstream.json(), expected);
      } else {
        assert.equal(result.kind, "error");
        assert.equal(result.status, 403);
        assert.deepEqual(result.payload, expected);
      }
    }
  });
}

// WorkBuddy 真实协议：state → token → account，刷新走 /v2/plugin/auth/token/refresh。
test("workbuddy oauth · 登录 state/token/account 与刷新走真实端点", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${WORKBUDDY_BASE_URL}/v2/plugin/auth/state?platform=CLI`) {
      return response(envelope({ state: "st-1", authUrl: `${WORKBUDDY_BASE_URL}/login?state=st-1` }));
    }
    if (url === `${WORKBUDDY_BASE_URL}/v2/plugin/auth/token?state=st-1`) {
      return response(envelope({ accessToken: "at-1", refreshToken: "rt-1", expiresIn: 3600, domain: "www.workbuddy.ai" }));
    }
    if (url === `${WORKBUDDY_BASE_URL}/v2/plugin/login/account?state=st-1`) {
      return response(envelope({ uid: "uid-1", enterpriseId: "", nickname: "nick-1" }));
    }
    if (url === `${WORKBUDDY_BASE_URL}/v2/plugin/auth/token/refresh`) {
      return response(envelope({ accessToken: "at-2", refreshToken: "rt-2", expiresIn: 7200, domain: "www.workbuddy.ai" }));
    }
    throw new Error(`unexpected url ${url}`);
  };

  const state = await createWorkBuddyAuthState({ fetchImpl });
  assert.equal(state.state, "st-1");
  assert.ok(state.authUrl.startsWith(WORKBUDDY_BASE_URL));

  const login = await pollWorkBuddyLogin("st-1", { fetchImpl });
  assert.equal(login.accessToken, "at-1");
  assert.equal(login.uid, "uid-1");
  assert.equal(login.realm, "global");

  const refreshed = await refreshWorkBuddyTokens("rt-1", { uid: "uid-1", fetchImpl });
  assert.equal(refreshed.accessToken, "at-2");
  assert.equal(refreshed.refreshToken, "rt-2");

  // 刷新请求必须带 X-Refresh-Token 与官方来源标识；state 请求走 POST。
  const refreshCall = calls.find((item) => item.url.endsWith("/v2/plugin/auth/token/refresh"));
  assert.equal(refreshCall.init.method, "POST");
  assert.equal(refreshCall.init.headers["X-Refresh-Token"], "rt-1");
  assert.equal(refreshCall.init.headers["X-Auth-Refresh-Source"], "plugin");
  assert.equal(refreshCall.init.headers["X-User-Id"], "uid-1");
  assert.equal(refreshCall.init.headers["X-Domain"], "www.workbuddy.ai");
  assert.equal(calls[0].init.method, "POST");

  const account = await fetchWorkBuddyAccount({ state: "st-1", accessToken: "at-1", fetchImpl });
  assert.equal(account.nickname, "nick-1");

  // 未登录完成时上游 code!=0 → 抛错而不是写入空账号。
  await assert.rejects(
    () => pollWorkBuddyLogin("st-pending", { fetchImpl: async () => response(envelope({}, 10086)) }),
    /code=10086/
  );
});

// realm 透传：state 取自哪个域，token 就必须在该域兑换。
// 漏传 realm 时轮询会回落 global 打到 www.workbuddy.ai，下方 fetchImpl 会抛 unexpected url。
test("workbuddy oauth · cn realm 的 state 与轮询必须同域", async () => {
  const cnBase = workBuddyRealmConfig("cn").baseUrl;
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === `${cnBase}/v2/plugin/auth/state?platform=CLI`) {
      return response(envelope({ state: "st-cn", authUrl: "https://www.codebuddy.cn/login?state=st-cn" }));
    }
    if (url === `${cnBase}/v2/plugin/auth/token?state=st-cn`) {
      return response(envelope({ accessToken: "at-cn", refreshToken: "rt-cn", expiresIn: 3600, domain: "www.codebuddy.cn" }));
    }
    if (url === `${cnBase}/v2/plugin/login/account?state=st-cn`) {
      return response(envelope({ uid: "uid-cn", enterpriseId: "", nickname: "nick-cn" }));
    }
    throw new Error(`unexpected url ${url}`);
  };

  const state = await createWorkBuddyAuthState({ realm: "cn", fetchImpl });
  assert.equal(state.realm, "cn");
  assert.ok(state.authUrl.startsWith("https://www.codebuddy.cn"));

  const login = await pollWorkBuddyLogin("st-cn", { realm: "cn", fetchImpl });
  assert.equal(login.accessToken, "at-cn");
  assert.equal(login.realm, "cn");
  assert.equal(login.domain, "www.codebuddy.cn");
  assert.equal(login.uid, "uid-cn");
  assert.ok(
    calls.every((url) => url.includes("copilot.tencent.com")),
    `所有请求都应落在 cn 域，实际: ${calls.join(", ")}`
  );
});

// 批量收号场景：同一 WorkBuddy 账号重新授权会换发新 refreshToken。
// 去重必须按 uid（accountId）而非 refreshToken，否则池中会堆出同账号的多个槽位，
// 加权轮询随后把并发摊到这些槽位上，等于对单账号叠加并发。
test("workbuddy account pool · 同 uid 重新授权不新增重复槽位", async () => {
  const home = tmpHome();
  try {
    const first = upsertAccounts("workbuddy-pool", [{
      accountId: "uid-1",
      name: "nick-1",
      realm: "global",
      domain: "www.workbuddy.ai",
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: new Date(Date.now() + 3600_000).toISOString()
    }], { poolKind: "workbuddy_oauth", home });
    assert.equal(first.added, 1);
    assert.equal(first.total, 1);

    const second = upsertAccounts("workbuddy-pool", [{
      accountId: "uid-1",
      name: "nick-1",
      realm: "global",
      domain: "www.workbuddy.ai",
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: new Date(Date.now() + 7200_000).toISOString()
    }], { poolKind: "workbuddy_oauth", skipDuplicates: false, home });
    assert.equal(second.added, 0);
    assert.equal(second.updated, 1);
    assert.equal(second.total, 1);

    const pool = loadPool("workbuddy-pool", { poolKind: "workbuddy_oauth", home });
    assert.equal(pool.accounts.length, 1);
    assert.equal(pool.accounts[0].refreshToken, "rt-new");

    // 跨 realm 的同 uid 不保证是同一账号，key 带 realm 才不会误合并。
    const crossRealm = upsertAccounts("workbuddy-pool", [{
      accountId: "uid-1",
      realm: "cn",
      domain: "www.codebuddy.cn",
      accessToken: "at-cn",
      refreshToken: "rt-cn",
      expiresAt: new Date(Date.now() + 3600_000).toISOString()
    }], { poolKind: "workbuddy_oauth", home });
    assert.equal(crossRealm.added, 1);
    assert.equal(crossRealm.total, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("workbuddy account pool · 刷新、绑定与公开脱敏", async () => {
  const home = tmpHome();
  try {
    upsertAccounts("workbuddy-pool", [{
      id: "wb-1",
      accountId: "uid-1",
      name: "nick-1",
      domain: "www.workbuddy.ai",
      accessToken: "expired",
      refreshToken: "refresh-wb",
      expiresAt: new Date(Date.now() - 1000).toISOString()
    }], { poolKind: "workbuddy_oauth", home });

    const provider = { id: "workbuddy-pool", authMode: "account_pool", poolKind: "workbuddy_oauth", baseUrl: WORKBUDDY_BASE_URL, apiFormat: "openai_chat" };
    const refreshCalls = [];
    const picked = await pickAndRefreshAccount(provider, {
      home,
      fetchImpl: async (url, init = {}) => {
        refreshCalls.push({ url, init });
        return response(envelope({ accessToken: "fresh-wb", refreshToken: "refresh-new", expiresIn: 3600, domain: "www.workbuddy.ai" }));
      }
    });
    assert.equal(picked.ok, true);
    assert.equal(picked.account.accessToken, "fresh-wb");
    assert.ok(refreshCalls[0].url.endsWith("/v2/plugin/auth/token/refresh"));

    const bound = bindProviderToAccount(provider, picked.account);
    assert.equal(bound.authMode, "workbuddy_oauth");
    const headers = providerAuthHeaders(bound, "bearer");
    assert.equal(headers.Authorization, "Bearer fresh-wb");
    // 上游必需头：X-User-Id / X-Domain / Origin（global 个人账号形态）。
    assert.equal(headers["X-User-Id"], "uid-1");
    assert.equal(headers["X-Domain"], "www.workbuddy.ai");
    assert.equal(headers.Origin, "https://www.workbuddy.ai");

    assert.equal(providerReady(bound), true);
    const publicView = listPoolAccountsPublic("workbuddy-pool", { poolKind: "workbuddy_oauth", home }).accounts[0];
    assert.equal(publicView.accessToken, undefined);
    assert.equal(publicView.hasRefreshToken, true);
    assert.equal(loadPool("workbuddy-pool", { poolKind: "workbuddy_oauth", home }).accounts[0].refreshToken, "refresh-new");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// chat 路径分叉：先 /v2/chat/completions（无内容 WAF），404 时回退 /console/chat/completions。
test("workbuddy chat · 先 v2 后 console 回退，且带账号头", async () => {
  const calls = [];
  const bound = {
    id: "workbuddy-pool",
    authMode: "workbuddy_oauth",
    providerType: "workbuddy_oauth",
    apiFormat: "openai_chat",
    baseUrl: WORKBUDDY_BASE_URL,
    _workbuddyAccessToken: "at-chat",
    _workbuddyUid: "uid-1",
    _workbuddyDomain: "www.workbuddy.ai",
    _workbuddyChatPaths: ["/v2/chat/completions", "/console/chat/completions"]
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${WORKBUDDY_BASE_URL}/v2/chat/completions`) return response({ error: "not found" }, 404);
    if (url === `${WORKBUDDY_BASE_URL}/console/chat/completions`) return response({ id: "chatcmpl-1", choices: [] });
    throw new Error(`unexpected url ${url}`);
  };
  const res = await callOpenAIChat(bound, { model: "deepseek-v4.1-flash", messages: [] }, { fetchImpl, stream: false });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${WORKBUDDY_BASE_URL}/v2/chat/completions`);
  assert.equal(calls[1].url, `${WORKBUDDY_BASE_URL}/console/chat/completions`);
  assert.equal(calls[1].init.headers.Authorization, "Bearer at-chat");
  assert.equal(calls[1].init.headers["X-User-Id"], "uid-1");
  assert.equal(calls[1].init.headers["X-Domain"], "www.workbuddy.ai");
});

// 双域：国内版走 copilot.tencent.com + codebuddy.cn 域头，chat 只有 /v2 路径。
test("workbuddy 双域 · 国内版账号按 cn realm 绑定与请求头", () => {
  const cnHeaders = workBuddyHeaders({ realm: "cn", uid: "cn-1", accessToken: "at-cn" });
  assert.equal(cnHeaders.Origin, "https://www.codebuddy.cn");
  assert.equal(cnHeaders["X-Domain"], "www.codebuddy.cn");
  assert.equal(cnHeaders["Accept-Language"], "zh-CN");
  assert.equal(cnHeaders["X-User-Id"], "cn-1");
  assert.deepEqual(workBuddyRealmConfig("cn").chatPaths, ["/v2/chat/completions"]);

  const provider = { id: "workbuddy-pool", authMode: "account_pool", poolKind: "workbuddy_oauth", apiFormat: "openai_chat" };
  const bound = bindProviderToAccount(provider, {
    id: "cn-1",
    accountId: "cnuid",
    domain: "www.codebuddy.cn",
    realm: "cn",
    accessToken: "at-cn",
    refreshToken: "rt-cn"
  });
  assert.equal(bound.baseUrl, "https://copilot.tencent.com");
  assert.equal(bound._workbuddyRealm, "cn");
  assert.deepEqual(bound._workbuddyChatPaths, ["/v2/chat/completions"]);
  assert.equal(providerAuthHeaders(bound, "bearer").Origin, "https://www.codebuddy.cn");

  // 海外账号仍按 global 绑定（base 与 /v2 优先路径）。
  const boundGlobal = bindProviderToAccount(provider, { id: "g-1", realm: "global", accessToken: "at-g", refreshToken: "rt-g" });
  assert.equal(boundGlobal.baseUrl, "https://www.workbuddy.ai");
  assert.deepEqual(boundGlobal._workbuddyChatPaths, ["/v2/chat/completions", "/console/chat/completions"]);
});

// 额度：billing 域聚合积分（信封 → Response.Data.Accounts，Cycle 字段优先）。
test("workbuddy 额度 · billing 域查询与积分聚合", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return response({
      code: 0,
      msg: "OK",
      data: {
        Response: {
          Data: {
            TotalCount: 2,
            Accounts: [
              { CycleCapacitySize: 100, CycleCapacityRemain: 60, CycleCapacityUsed: 40 },
              { CapacitySize: 20, CapacityRemain: 5, CapacityUsed: 15 }
            ]
          }
        }
      }
    });
  };
  const { fetchWorkBuddyAccountQuota } = await import("../src/account-pool/index.mjs");
  const quota = await fetchWorkBuddyAccountQuota({
    accessToken: "at-quota",
    accountId: "uid-1",
    domain: "www.workbuddy.ai",
    realm: "global"
  }, { fetchImpl });
  assert.equal(quota.ok, true);
  assert.equal(quota.summary, "积分 65/120（剩54% · 2 个套餐）");
  assert.equal(quota.primaryRemainingPercent, 54);
  // 海外首选无 /v2 前缀路径；请求带 X-User-Id / X-Domain / Authorization。
  assert.equal(calls[0].url, "https://www.workbuddy.ai/billing/meter/get-user-resource");
  assert.equal(calls[0].init.headers["X-User-Id"], "uid-1");
  assert.equal(calls[0].init.headers["X-Domain"], "www.workbuddy.ai");
  assert.equal(calls[0].init.headers.Authorization, "Bearer at-quota");
  assert.match(String(calls[0].init.body), /p_tcaca/);
});

// 后台续期：即将过期的账号被刷新，仍有效的账号不被上游打扰。
test("workbuddy 自动刷新 · 仅续期即将过期的账号", async () => {
  const home = tmpHome();
  try {
    const soon = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const far = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    upsertAccounts("workbuddy-pool", [
      { id: "soon-1", accountId: "uid-soon", accessToken: "at-soon", refreshToken: "rt-soon", expiresAt: soon, realm: "global", domain: "www.workbuddy.ai" },
      { id: "far-1", accountId: "uid-far", accessToken: "at-far", refreshToken: "rt-far", expiresAt: far, realm: "global", domain: "www.workbuddy.ai" }
    ], { poolKind: "workbuddy_oauth", home, skipDuplicates: false });
    const calls = [];
    const result = await refreshExpiringAccounts(
      { id: "workbuddy-pool", authMode: "account_pool", poolKind: "workbuddy_oauth", baseUrl: WORKBUDDY_BASE_URL, apiFormat: "openai_chat" },
      {
        home,
        skewMs: 60 * 60 * 1000,
        fetchImpl: async (url, init = {}) => {
          calls.push({ url, init });
          return response(envelope({ accessToken: "at-new", refreshToken: "rt-new", expiresIn: 3600, domain: "www.workbuddy.ai" }));
        }
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.checked, 1);
    assert.equal(result.refreshed, 1);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/v2/plugin/auth/token/refresh"));
    const pool = loadPool("workbuddy-pool", { poolKind: "workbuddy_oauth", home });
    const soonAccount = pool.accounts.find((a) => a.id === "soon-1");
    const farAccount = pool.accounts.find((a) => a.id === "far-1");
    assert.equal(soonAccount.accessToken, "at-new");
    assert.equal(farAccount.accessToken, "at-far");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("workbuddy 流帧清洗 · 只保留本帧有值的键，避免客户端按空键切换思考块", () => {
  const upstream = "data: " + JSON.stringify({
    id: "cmb-1",
    model: "deepseek-v4.1-flash",
    object: "chat.completion.chunk",
    created: 1,
    choices: [{
      index: 0,
      delta: { content: "", reasoning_content: "想", function_call: null, refusal: "", tool_calls: [], extra_fields: null },
      logprobs: null,
      finish_reason: ""
    }],
    usage: null
  });
  const clean = JSON.parse(normalizeWorkBuddyStreamLine(upstream).slice(5));
  assert.deepEqual(clean.choices[0].delta, { reasoning_content: "想" });
  assert.deepEqual(Object.keys(clean.choices[0]).sort(), ["delta", "finish_reason", "index"]);
  assert.equal(clean.usage, null);

  // role 帧只留 role；正文帧只留 content；工具调用帧只留 tool_calls。
  const roleLine = normalizeWorkBuddyStreamLine("data: " + JSON.stringify({
    choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: "" }, finish_reason: "" }]
  }));
  assert.deepEqual(JSON.parse(roleLine.slice(5)).choices[0].delta, { role: "assistant" });

  const toolLine = normalizeWorkBuddyStreamLine("data: " + JSON.stringify({
    choices: [{ index: 0, delta: { content: "", tool_calls: [{ index: 0, id: "call_1" }] }, finish_reason: "" }]
  }));
  assert.deepEqual(JSON.parse(toolLine.slice(5)).choices[0].delta, { tool_calls: [{ index: 0, id: "call_1" }] });

  // 非 data 行（心跳/注释）与 [DONE] 原样透传。
  assert.equal(normalizeWorkBuddyStreamLine(": keepalive"), ": keepalive");
  assert.equal(normalizeWorkBuddyStreamLine("data: [DONE]"), "data: [DONE]");
});

test("workbuddy 出站形态 · 官方桌面端 UA；不发送官chat链路不存在的归属头", () => {
  const globalHeaders = workBuddyHeaders({ realm: "global", uid: "u1", accessToken: "at", surface: "desktop" });
  assert.equal(globalHeaders["User-Agent"], "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1");
  // 官方 App 的 chat 链路只用 buildHeaders(session) 的四个基础头；以下归属头仅出现在
  // /v2/activity/workbuddy/banner 等非 chat 接口（app.asar 实测 X-Agent-Purpose 出现 0 次），
  // 凭空发送等于自报非官方客户端，故一律不发。
  assert.equal(globalHeaders["X-Agent-Purpose"], undefined);
  assert.equal(globalHeaders["X-IDE-Name"], undefined);
  assert.equal(globalHeaders["X-IDE-Type"], undefined);
  assert.equal(globalHeaders["X-IDE-Version"], undefined);
  assert.equal(globalHeaders["X-Product"], undefined);

  const cnHeaders = workBuddyHeaders({ realm: "cn", surface: "desktop" });
  assert.equal(cnHeaders["User-Agent"], "WorkBuddy/5.5.4 WorkBuddy/5.5.4 CLI/2.137.1");
  assert.equal(cnHeaders["X-Domain"], "www.codebuddy.cn");

  // 登录（plugin）流程保持 CLI 形态 UA。
  const pluginHeaders = workBuddyHeaders({ realm: "global" });
  assert.equal(pluginHeaders["User-Agent"], "CLI/2.63.2 CodeBuddy/2.63.2");
  assert.equal(pluginHeaders["X-IDE-Name"], undefined);

  // chat 出站（clients 层）同样不带归属头组。
  const provider = { id: "workbuddy", authMode: "account_pool", poolKind: "workbuddy_oauth", apiFormat: "openai_chat" };
  const bound = bindProviderToAccount(provider, {
    id: "wb-1", realm: "global", domain: "www.workbuddy.ai",
    accessToken: "at", refreshToken: "rt", accountId: "uid-1"
  });
  const headers = providerAuthHeaders(bound, "bearer");
  assert.equal(headers["User-Agent"], "WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1");
  assert.equal(headers["X-IDE-Type"], undefined);
  assert.equal(headers["X-Agent-Purpose"], undefined);
  // 设备 token 只用于官方计费/签到接口，chat 出站不注入。
  assert.equal(headers["X-Device-Token"], undefined);
  assert.equal(headers["X-Domain"], "www.workbuddy.ai");
});

// 上游第二类规则：HTTP/shell 动词 + URL 同现即拦，触发面按动词不同（实测）：
//   · curl / wget —— 只在 reasoning_content / reasoning 位拦（上游 SSRF 启发式只看思考链）
//   · fetch       —— content / reasoning_content / reasoning / tool_calls.arguments 全字段拦
// 破坏方式用 shell 空串拼接（c''url / f''etch）：任何 shell 都会先展开回原动词，不破坏可执行性。
// （引号包 URL 无效；大写 Curl 只在大小写不敏感文件系统上可执行，Linux 会 command not found。）
test("workbuddy 出站硬化 · 破坏动词字面量且保持 shell 可执行", () => {
  const body = {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "curl https://www.workbuddy.ai" },
      { role: "assistant", content: "收到", reasoning_content: "先 wget www.baidu.com 试试" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "看看 curl example.com 的结果" },
          { type: "image_url", image_url: { url: "data:image/png;base64,a.com-curl" } }
        ],
        tool_calls: [{ id: "call_1", function: { name: "shell", arguments: "{\"command\":\"curl https://api.example.com\"}" } }]
      }
    ]
  };
  const original = JSON.parse(JSON.stringify(body));
  const hardened = hardenWorkBuddyChatBody(body);

  assert.equal(hardened.messages[1].content, "c''url https://www.workbuddy.ai");
  assert.equal(hardened.messages[2].reasoning_content, "先 w''get www.baidu.com 试试");
  assert.equal(hardened.messages[3].content[0].text, "看看 c''url example.com 的结果");
  // 图片 data URL 不是语义文本，原样保留。
  assert.equal(hardened.messages[3].content[1].image_url.url, "data:image/png;base64,a.com-curl");
  assert.equal(hardened.messages[3].tool_calls[0].function.arguments, "{\"command\":\"c''url https://api.example.com\"}");

  // 不带目标特征的纯讨论不改写。
  const talk = hardenWorkBuddyChatBody({ messages: [{ role: "user", content: "curl 这个命令怎么用" }] });
  assert.equal(talk.messages[0].content, "curl 这个命令怎么用");
  // fetch + URL 实测全字段触发上游规则，同样必须硬化。
  // 代价：JS 代码里的 fetch("https://…") 会被改写成 f''etch(…)，模型读历史时能自行还原。
  const js = hardenWorkBuddyChatBody({ messages: [{ role: "user", content: "fetch(\"https://a.com\")" }] });
  assert.equal(js.messages[0].content, "f''etch(\"https://a.com\")");
  // 不带 URL 的 fetch 属普通词，不改写。
  const plainFetch = hardenWorkBuddyChatBody({ messages: [{ role: "user", content: "fetch 这个 API 怎么用" }] });
  assert.equal(plainFetch.messages[0].content, "fetch 这个 API 怎么用");
  // 内网 IP 同样命中规则（实测 A8），需一并硬化。
  const lan = hardenWorkBuddyChatBody({ messages: [{ role: "user", content: "curl 192.168.1.1" }] });
  assert.equal(lan.messages[0].content, "c''url 192.168.1.1");
  // 无 messages 时原样返回，不凭空加字段。
  assert.deepEqual(hardenWorkBuddyChatBody({ model: "m" }), { model: "m" });

  // 不可变：调用方传入的请求体不被改写。
  assert.deepEqual(body, original);
});

// 上游危险特征库：扫描 content / reasoning_content / tool_calls.arguments 全部字段，
// 且会先做 URL / HTML 实体 / JS 转义解码再匹配，所以不能只按表面字面量判断。
// 实测命中面只有三类 —— 这是「抓网页必被拦」的第一条成因（网页 HTML 头部即是 <script>）：
//   · 标签 <script / <base
//   · 事件 onerror= onload= onclick= onfocus= onmouseover= onchange= onsubmit=
//   · 函数调用 alert( msgbox( eval( confirm( unescape( decodeURIComponent( decodeURI(
//           fromCharCode( document.write( system( subprocess.run( compile(
// 函数族是 XSS 黑名单：前四个是经典 XSS 弹窗/求值，unescape/decodeURI*/fromCharCode 是
// JS 混淆解码组合，system/subprocess.run/compile 是命令执行与代码编译。
// 实测放行（不得改写，否则污染用户上下文——ZCode 会大量讨论前端与 Python 代码）：
// <div> <iframe> <img> <style>，prompt( escape( encodeURIComponent( encodeURI( atob(
// btoa( Function( setTimeout( exec( popen( subprocess( __import__( document.cookie。
// 2026-09-18 实测：ZCode 执行「curl 站点 → 写 Python 解析 HTML」后，脚本里的
// html.unescape( 让整段会话出站即 403；这是本次修复的直接触发场景。
test("workbuddy 出站硬化 · 破坏危险特征标点，放行面原样保留", () => {
  const hard = (content) =>
    hardenWorkBuddyChatBody({ messages: [{ role: "user", content }] }).messages[0].content;

  // 危险标签：破坏起始尖括号
  assert.equal(hard("<script>alert(1)</script>"), "\u2039script>alert\uff081)</script>");
  assert.equal(hard('<base href="x">'), '\u2039base href="x">');
  // 事件绑定：等号换全角
  assert.equal(hard("onerror=alert(1)"), "onerror\uff1dalert\uff081)");
  assert.equal(hard("<svg onload=x>"), "<svg onload\uff1dx>");
  // 危险函数：左括号换全角
  assert.equal(hard("eval(x)"), "eval\uff08x)");
  assert.equal(hard("confirm(1)"), "confirm\uff081)");
  // 解码 / 编码 / 命令执行族：只换左括号，函数名与点号保持原样
  assert.equal(hard("html.unescape(t)"), "html.unescape\uff08t)");
  assert.equal(hard("decodeURIComponent(x)"), "decodeURIComponent\uff08x)");
  assert.equal(hard("String.fromCharCode(65)"), "String.fromCharCode\uff0865)");
  assert.equal(hard("document.write(x)"), "document.write\uff08x)");
  assert.equal(hard("os.system(x)"), "os.system\uff08x)");
  assert.equal(hard("subprocess.run(x)"), "subprocess.run\uff08x)");
  assert.equal(hard("re.compile(p)"), "re.compile\uff08p)");
  // 转义形态：上游先解码再匹配，只能在转义序列本身下手
  assert.equal(hard("%3cscript%3e"), "\uff053cscript%3e");
  assert.equal(hard("&lt;script&gt;"), "&\uff4ct;script&gt;");

  // 放行面：不应做任何改写
  for (const safe of [
    '<div class="a">hi</div>', "<iframe src=x>", "<img src=x>", "<style>x</style>",
    "<svg>y</svg>", "<object data=x>", "prompt(1)", "javascript:void(0)", "document.cookie",
    // 同名但非调用形态：无左括号即放行，避免误伤普通词
    "subprocess", "subprocess(x)", "a.compile", "the system design"
  ]) {
    assert.equal(hard(safe), safe, `放行面被误改：${safe}`);
  }

  // 字段覆盖：可携带语义文本的字段都要走到。
  // reasoning 与 reasoning_content 会由 prepare 派生并存，两者都在上游扫描面内，必须同改。
  const fields = hardenWorkBuddyChatBody({
    messages: [
      { role: "assistant", content: "<script>a</script>", reasoning_content: "先 onload=x 再说", reasoning: "再 fetch https://a.com" },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"c":"<script>"}' } }] }
    ]
  });
  assert.equal(fields.messages[0].content, "\u2039script>a</script>");
  assert.equal(fields.messages[0].reasoning_content, "先 onload\uff1dx 再说");
  assert.equal(fields.messages[0].reasoning, "再 f''etch https://a.com");
  assert.equal(fields.messages[1].tool_calls[0].function.arguments, '{"c":"\u2039script>"}');
});

// 上游内容审核指纹：按**逐字精确匹配**拦截 CLI 模板句（非语义审核），命中即
// 400 code=11128（displayMsg：请求被安全策略拦截）。规则表对齐参考实现
// workbuddy2api/internal/upstream/sanitize.go。
// 2026-09-18 实测：ZCode 的 system prompt 含 "Main branch (you will usually use this for PRs)"，
// 真实请求体 1:1 重放（直连 /v2 与经网关两条路径）必 400；仅替换该句即 200。
// 同一出口下 Cursor 正常，即因它的 prompt 不含该句。
// 注意 /v2 端点此前被认为「不做内容扫描」——本类规则推翻了这个假设。
test("workbuddy 出站脱敏 · 逐字改写模板句指纹，无关文本零改动", () => {
  const strip = (content) =>
    sanitizeWorkBuddyChatBody({ messages: [{ role: "user", content }] }).messages[0].content;

  // 改写层：每句只换一个词，语义不变。
  assert.equal(
    strip("Main branch (you will usually use this for PRs): main"),
    "Default branch (you will usually use this for PRs): main"
  );
  assert.equal(
    strip("You are Claude Code, Anthropic's official CLI for Claude."),
    "You are Claude Code, Anthropic's official CLI tool for Claude."
  );
  assert.equal(
    strip("You are a coding agent running in the Codex CLI, a terminal-based coding assistant."),
    "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."
  );
  assert.equal(
    strip("To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues"),
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues"
  );
  // 反探测：请求体里出现裸数字 11128 即整单拦截，而它正是本类拦截自身的错误码。
  assert.equal(strip("网关返回 11128"), "网关返回 11-128");
  assert.equal(strip("相邻错误码 11148 / 11101 不受影响"), "相邻错误码 11148 / 11101 不受影响");

  // 剥离层：header 键值段整段删除，残留裸键名做最小缩写。
  assert.equal(strip("cfg: x-anthropic-billing-header: abc123; tail"), "cfg: tail");
  assert.equal(strip("X-Anthropic-Billing-Header"), "x-anthropic-billing-hdr");
  // cc_* 尾随裸键值循环清理。
  assert.equal(strip("cc_version=1.0.3; cc_entrypoint=cli; done"), "done");

  // 放行面：不含任何指纹的文本必须原样保留（含大小写相近的普通表达）。
  for (const safe of [
    "main branch 上的 PR 怎么合",
    "You are a helpful assistant.",
    "错误码 11101 / 11155",
    "You are Claude",
    "x-anthropic-billing"
  ]) {
    assert.equal(strip(safe), safe, `放行面被误改：${safe}`);
  }

  // 字段覆盖：可携带语义文本的字段都要走到；图片 data URL 不是语义文本，原样保留。
  const body = {
    messages: [
      { role: "system", content: [{ type: "text", text: "Main branch (you will usually use this for PRs)" }] },
      { role: "assistant", content: "没事", reasoning_content: "先看 11128 是什么", reasoning: "再看 Main branch (you will usually use this for PRs)" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "查一下 11128" },
          { type: "image_url", image_url: { url: "data:image/png;base64,11128" } }
        ],
        tool_calls: [{ id: "c1", function: { name: "shell", arguments: '{"c":"echo 11128"}' } }]
      }
    ]
  };
  const original = JSON.parse(JSON.stringify(body));
  const sanitized = sanitizeWorkBuddyChatBody(body);

  assert.equal(sanitized.messages[0].content[0].text, "Default branch (you will usually use this for PRs)");
  assert.equal(sanitized.messages[1].reasoning_content, "先看 11-128 是什么");
  assert.equal(sanitized.messages[1].reasoning, "再看 Default branch (you will usually use this for PRs)");
  assert.equal(sanitized.messages[2].content[0].text, "查一下 11-128");
  assert.equal(sanitized.messages[2].content[1].image_url.url, "data:image/png;base64,11128");
  assert.equal(sanitized.messages[2].tool_calls[0].function.arguments, '{"c":"echo 11-128"}');

  // 无 messages 时原样返回，不凭空加字段。
  assert.deepEqual(sanitizeWorkBuddyChatBody({ model: "m" }), { model: "m" });

  // 不可变：调用方传入的请求体不被改写。
  assert.deepEqual(body, original);
});

test("workbuddy preset/config · 默认指向真实海外域与 Chat 协议", () => {
  const preset = getProviderPreset("workbuddy-account-pool");
  assert.equal(preset.poolKind, "workbuddy_oauth");
  assert.equal(preset.baseUrl, WORKBUDDY_BASE_URL);
  const config = mergeWithDefaults({ providers: [{ id: "wb", presetId: "workbuddy-account-pool", authMode: "account_pool", poolKind: "workbuddy_oauth" }] });
  assert.equal(config.providers[0].baseUrl, WORKBUDDY_BASE_URL);
  assert.equal(config.providers[0].apiFormat, "openai_chat");
});

// 上游硬约束：只接受流式 + 首条消息必须是 system；非流式客户端在网关侧聚合。
test("workbuddy 适配 · 强制 stream 与 system 头，SSE 聚合为 Chat JSON", () => {
  const prepared = prepareWorkBuddyChatBody({ model: "deepseek-v4.1-flash", messages: [{ role: "user", content: "hi" }], stream: false });
  assert.equal(prepared.stream, true);
  assert.equal(prepared.messages[0].role, "system");
  assert.equal(prepared.messages[1].role, "user");
  // 官方 CLI 流式必发 include_usage，上游据此在末帧返回 usage。
  assert.deepEqual(prepared.stream_options, { include_usage: true });
  // DeepSeek 系注入思维链开关；但**历史无思考痕迹时不能带 reasoning_effort**——
  // 上游一旦真开思维链就要求每轮回传真实思考，ZCode 这类客户端不回传会被 11155 拒绝。
  assert.deepEqual(prepared.thinking, { type: "enabled" });
  assert.equal(prepared.reasoning_effort, undefined);

  // 显式 strict（网关判定历史可回传思考/首轮）→ 带默认档，进入严格思维链模式。
  const strict = prepareWorkBuddyChatBody({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1", reasoning_content: "上一轮真实思考" },
      { role: "user", content: "u2" }
    ]
  }, { thinkingMode: "strict" });
  assert.equal(strict.reasoning_effort, "high");

  // 显式 off（历史 assistant 配不到思考）→ 不开严格模式，避免上游 11155。
  const off = prepareWorkBuddyChatBody({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "s" },
      { role: "assistant", content: "a1" }
    ]
  }, { thinkingMode: "off" });
  assert.equal(off.reasoning_effort, undefined);
  assert.equal(off.messages.find((m) => m.role === "assistant").reasoning_content, undefined);

  const alreadySystem = prepareWorkBuddyChatBody({ messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] });
  assert.equal(alreadySystem.messages.length, 2);

  // tool_choice 对象形式归一为 string（上游拒绝对象形式，会 400）；none 时连 tools 一起抑制。
  const normalized = prepareWorkBuddyChatBody({
    model: "gpt-5.6-terra",
    messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }],
    tool_choice: { type: "function", function: { name: "lookup" } },
    tools: [{ type: "function", function: { name: "lookup" } }]
  });
  assert.equal(normalized.tool_choice, "lookup");
  assert.equal(normalized.thinking, undefined);

  const suppressed = prepareWorkBuddyChatBody({
    model: "gpt-5.6-terra",
    messages: [{ role: "system", content: "s" }],
    tool_choice: { type: "none" },
    tools: [{ type: "function", function: { name: "lookup" } }]
  });
  assert.equal(suppressed.tool_choice, undefined);
  assert.equal(suppressed.tools, undefined);

  // developer 角色归一到 system（与上游一致）。
  const roleFixed = prepareWorkBuddyChatBody({ model: "gpt-5.6-terra", messages: [{ role: "developer", content: "d" }] });
  assert.equal(roleFixed.messages[0].role, "system");

  // 多轮：严格思维链模式下**所有** assistant 都必须带 reasoning_content（上游 11155 硬要求）。
  const backfilled = prepareWorkBuddyChatBody({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "system", content: "s" },
      { role: "assistant", content: "a1", reasoning: "想过" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" }
    ]
  });
  const assistants = backfilled.messages.filter((m) => m.role === "assistant");
  assert.equal(assistants[0].reasoning_content, "想过");
  assert.equal(assistants[1].reasoning_content, "");
  // 普通多轮（无思考痕迹）走非严格模式：不加 effort，也不强行补 reasoning_content。
  const plainMultiTurn = prepareWorkBuddyChatBody({
    model: "deepseek-v4.1-flash",
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }
    ]
  });
  assert.equal(plainMultiTurn.reasoning_effort, undefined);
  assert.equal(plainMultiTurn.messages.find((m) => m.role === "assistant").reasoning_content, undefined);
  // 显式关闭思考时不应强行加字段。
  const thinkingOff = prepareWorkBuddyChatBody({
    model: "deepseek-v4.1-flash",
    thinking: { type: "disabled" },
    messages: [{ role: "assistant", content: "a1" }]
  });
  assert.equal(thinkingOff.messages.find((m) => m.role === "assistant").reasoning_content, undefined);

  const sse = [
    'data: {"id":"chatcmpl-1","model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"content":"池化"},"finish_reason":""}]}',
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"想一想"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"成功","tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"a\\":1}"}}]},"finish_reason":"stop"}],"usage":{"total_tokens":9}}',
    "data: [DONE]",
    ""
  ].join("\n");
  const aggregated = aggregateChatSseToChatResponse(sse, "deepseek-v4.1-flash");
  assert.equal(aggregated.object, "chat.completion");
  assert.equal(aggregated.model, "deepseek-v4.1-flash");
  assert.equal(aggregated.choices[0].message.content, "池化成功");
  assert.equal(aggregated.choices[0].message.reasoning_content, "想一想");
  assert.equal(aggregated.choices[0].finish_reason, "tool_calls");
  assert.equal(aggregated.choices[0].message.tool_calls[0].function.name, "f");
  assert.equal(aggregated.usage.total_tokens, 9);
});

for (const stream of [false, true]) {
  test(`reliability model6004 stream=${stream}`, async (t) => {
    const { provider, readPool } = dispatchPool(t);
    const reset = "2099-01-02T00:00:00.000Z";
    let calls = 0;
    const opts = { fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { code: 6004, message: "Model limit reached; reset at 2099-01-02 08:00:00 UTC+8" } }), { status: 429 });
    } };
    assert.equal((await dispatchChat(provider, "model-a", dispatchBody(stream), opts)).status, 429);
    assert.ok(readPool().accounts.every((a) => a.health === "healthy"));
    assert.ok(readPool().accounts.every((a) => a.modelHealth["model-a"].cooldownUntil === reset));
    const count = calls;
    assert.equal((await dispatchChat(provider, "model-a", dispatchBody(stream), opts)).status, 503);
    assert.equal(calls, count);
    const result = await dispatchChat(provider, "model-b", dispatchBody(false), { fetchImpl: async () => new Response(successSse) });
    assert.equal(result.kind, "json");
  });
  test(`reliability ordinary403 headers stream=${stream}`, async (t) => {
    const { provider } = dispatchPool(t);
    const result = await dispatchChat(provider, "model-a", dispatchBody(stream), {
      fetchImpl: async () => new Response('{"error":"denied"}', { status: 403, headers: { "retry-after": "120", "x-fixture": "retained" } })
    });
    assert.equal(result.status, 403);
    assert.equal(result.headers?.get("x-fixture"), "retained");
  });
}

test("reliability concurrent counters and cooldowns never regress", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { markAccountFailure, markAccountSuccess, savePool, bindAccountAffinity, pickAndRefreshAccount } = await import("../src/account-pool/index.mjs");
  const stale = readPool().accounts[0];
  markAccountFailure(provider, stale, { status: 429, retryAfterSec: 7200, upstreamModel: "model-a" });
  const until = readPool().accounts[0].cooldownUntil;
  markAccountFailure(provider, stale, { status: 429, retryAfterSec: 60, upstreamModel: "model-a" });
  assert.equal(readPool().accounts[0].consecutiveFailures, 2);
  assert.equal(readPool().accounts[0].cooldownUntil, until);
  markAccountSuccess(provider, stale, { upstreamModel: "model-b" });
  assert.equal(readPool().accounts[0].cooldownUntil, until);
  assert.equal(readPool().accounts[0].modelHealth["model-a"].cooldownUntil, until);
  bindAccountAffinity(provider, "fixture", stale.id);
  const picked = await pickAndRefreshAccount(provider, { reserveLease: true, sessionKey: "fixture", upstreamModel: "model-a", fetchImpl: async () => { throw new Error("unexpected refresh"); } });
  assert.equal(picked.account.id, "account-2"); picked.release?.();
  const pool = readPool();
  pool.accounts.forEach((a) => { a.health = "healthy"; a.cooldownUntil = null; a.modelHealth["model-a"] = { health: "cooldown", cooldownUntil: "2000-01-01T00:00:00Z" }; });
  savePool(pool);
  const expired = await pickAndRefreshAccount(provider, { reserveLease: true, upstreamModel: "model-a", fetchImpl: async () => { throw new Error("unexpected refresh"); } });
  assert.equal(expired.ok, true); expired.release?.();
});

test("reliability affinity TTL and bounded cache", async (t) => {
  const { provider } = dispatchPool(t);
  const { accountAffinityId, bindAccountAffinity } = await import("../src/account-pool/index.mjs");
  bindAccountAffinity(provider, "old", "account-1");
  for (let i = 0; i < 2001; i += 1) bindAccountAffinity(provider, `s-${i}`, "account-2");
  assert.equal(accountAffinityId(provider, "old"), "");
  t.mock.method(Date, "now", () => 9000000000000);
  assert.equal(accountAffinityId(provider, "s-2000"), "");
});

test("reliability refresh failure releases capacity", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { savePool } = await import("../src/account-pool/index.mjs");
  provider.maxInFlight = 1;
  const pool = readPool(); pool.accounts = pool.accounts.slice(0, 1);
  pool.accounts[0].expiresAt = "2000-01-01T00:00:00Z"; savePool(pool);
  const failed = await dispatchChat(provider, "model-a", dispatchBody(false), { fetchImpl: async () => new Response("{}", { status: 400 }) });
  assert.equal(failed.status, 503);
  const result = await dispatchChat(provider, "model-a", dispatchBody(false), { fetchImpl: async (url) => url.includes("/auth/token/refresh")
    ? new Response(JSON.stringify(envelope({ accessToken: "fake-ok", expiresIn: 86400 }))) : new Response(successSse) });
  assert.equal(result.kind, "json");
});

test("reliability refresh completion cannot erase concurrent cooldown", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { savePool, ensureFreshAccount, markAccountFailure } = await import("../src/account-pool/index.mjs");
  const pool = readPool(); pool.accounts[0].expiresAt = "2000-01-01T00:00:00Z"; savePool(pool);
  let unblock;
  const pending = ensureFreshAccount(pool.accounts[0], { provider, fetchImpl: async () => {
    await new Promise((resolve) => { unblock = resolve; });
    return new Response(JSON.stringify(envelope({ accessToken: "fake-refreshed", expiresIn: 86400 })));
  } });
  markAccountFailure(provider, pool.accounts[0], { status: 429, retryAfterSec: 7200, upstreamModel: "model-a" });
  unblock(); await pending;
  assert.equal(readPool().accounts[0].health, "cooldown");
});

test("reliability affinity obeys disabled and model cooldown", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { bindAccountAffinity, pickAndRefreshAccount, savePool } = await import("../src/account-pool/index.mjs");
  const opts = { reserveLease: true, sessionKey: "fixture", upstreamModel: "model-a", fetchImpl: async () => { throw new Error("unexpected refresh"); } };
  for (const condition of ["disabled", "model"]) {
    const pool = readPool(); pool.accounts[0].enabled = condition !== "disabled";
    pool.accounts[0].modelHealth = condition === "model" ? { "model-a": { health: "cooldown", cooldownUntil: "2099-01-01T00:00:00Z" } } : {};
    savePool(pool); bindAccountAffinity(provider, "fixture", "account-1");
    const result = await pickAndRefreshAccount(provider, opts);
    assert.equal(result.account.id, "account-2"); result.release(); result.release();
  }
});

test("reliability WorkBuddy cache does not evict Antigravity bindings", async (t) => {
  const { provider } = dispatchPool(t);
  const { bindAccountAffinity, accountAffinityId } = await import("../src/account-pool/index.mjs");
  const ag = { id: provider.id + "-ag", poolKind: "antigravity_oauth" };
  bindAccountAffinity(ag, "keep", "ag-account");
  for (let i = 0; i < 2100; i += 1) bindAccountAffinity(provider, `bounded-${i}`, "account-1");
  assert.equal(accountAffinityId(ag, "keep"), "ag-account");
});

test("reliability other errors cannot deactivate an advertised cooldown", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { markAccountFailure } = await import("../src/account-pool/index.mjs");
  const stale = readPool().accounts[0];
  markAccountFailure(provider, stale, { status: 429, retryAfterSec: 7200, upstreamModel: "model-a" });
  markAccountFailure(provider, stale, { status: 401, upstreamModel: "model-b" });
  assert.equal(readPool().accounts[0].health, "cooldown");
});

for (const stream of [false, true]) {
  for (const fixture of ["explicit", "chinese", "date"]) {
    test(`absolute cooldown clock drift ${fixture} stream=${stream}`, async (t) => {
      let clock = Date.parse("2099-01-01T00:00:00Z");
      t.mock.method(Date, "now", () => { const now = clock; clock += 137; return now; });
      const { provider, readPool } = dispatchPool(t);
      const result = await dispatchChat(provider, "model-a", dispatchBody(stream), {
        fetchImpl: async () => new Response(JSON.stringify({ error: {
          code: fixture === "date" ? 429 : 6004,
          message: fixture === "chinese" ? "将在 2099-01-02 08:00:00 重置" : "reset at 2099-01-02 08:00:00 UTC+8"
        } }), { status: 429, headers: fixture === "date" ? { "retry-after": "Fri, 02 Jan 2099 00:00:00 GMT" } : {} })
      });
      assert.equal(result.status, 429);
      for (const account of readPool().accounts) {
        assert.equal(account.modelHealth["model-a"].cooldownUntil, "2099-01-02T00:00:00.000Z");
        assert.equal(account.health, fixture === "date" ? "cooldown" : "healthy");
      }
    });
  }
}

test("absolute cooldown seconds capture time before header access", async (t) => {
  let clock = Date.parse("2099-01-01T00:00:00Z");
  t.mock.method(Date, "now", () => clock);
  const { provider, readPool } = dispatchPool(t);
  const expected = new Map();
  await dispatchChat(provider, "model-a", dispatchBody(false), {
    fetchImpl: async (url, init) => {
      const res = new Response('{"error":"limited"}', { status: 429, headers: { "retry-after": "7200" } });
      const get = res.headers.get.bind(res.headers);
      res.headers.get = (name) => {
        if (name.toLowerCase() === "retry-after") {
          expected.set(init.headers["X-User-Id"], new Date(clock + 7200000).toISOString());
          clock += 137;
        }
        return get(name);
      };
      return res;
    }
  });
  for (const account of readPool().accounts) assert.equal(account.cooldownUntil, expected.get(account.accountId));
});

test("absolute cooldown minimum and existing deadline survive", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { markAccountFailure } = await import("../src/account-pool/index.mjs");
  const now = Date.parse("2099-01-01T00:00:00Z");
  t.mock.method(Date, "now", () => now);
  const stale = readPool().accounts[0];
  const fail = (cooldownDeadline) => markAccountFailure(provider, stale, { status: 429, cooldownDeadline, upstreamModel: "model-a" });
  fail(now + 1000);
  assert.equal(readPool().accounts[0].cooldownUntil, new Date(now + 30000).toISOString());
  fail(now + 7200000);
  fail(now + 60000);
  assert.equal(readPool().accounts[0].cooldownUntil, new Date(now + 7200000).toISOString());
  assert.equal(readPool().accounts[0].consecutiveFailures, 3);
});

test("lease review pure probe picks never consume chat reservations", async (t) => {
  const { provider, readPool } = dispatchPool(t);
  const { savePool } = await import("../src/account-pool/index.mjs");
  const pool = readPool(); pool.accounts = pool.accounts.slice(0, 1); savePool(pool);
  const fetchImpl = async () => new Response(successSse);
  for (let i = 0; i < 10; i += 1) {
    const picked = await pickAndRefreshAccount(provider, { fetchImpl });
    assert.equal(picked.ok, true);
    assert.equal(picked.release, undefined);
  }
  const streams = [];
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = await dispatchChat(provider, "model-a", dispatchBody(true), { fetchImpl });
      assert.equal(result.kind, "stream"); streams.push(result.upstream);
    }
    let calls = 0;
    const busy = await dispatchChat(provider, "model-a", dispatchBody(false), { fetchImpl: async () => { calls += 1; return new Response(successSse); } });
    assert.equal(busy.status, 503); assert.equal(calls, 0);
  } finally { for (const stream of streams) await stream.body.cancel(); }
  assert.equal((await dispatchChat(provider, "model-a", dispatchBody(false), { fetchImpl })).kind, "json");
});

for (const forced of [false, true]) {
  for (const condition of ["disabled", "global", "model"]) {
    for (const stream of [false, true]) {
      test(`lease review refresh eligibility forced=${forced} ${condition} stream=${stream}`, async (t) => {
        const { provider, readPool } = dispatchPool(t);
        const { savePool } = await import("../src/account-pool/index.mjs");
        const pool = readPool();
        if (!forced) pool.accounts[0].expiresAt = "2000-01-01T00:00:00Z";
        pool.accounts[1].enabled = false;
        savePool(pool);
        provider.maxInFlight = 1;
        let reached, unblock;
        const entered = new Promise((resolve) => { reached = resolve; });
        const gate = new Promise((resolve) => { unblock = resolve; });
        const chatAccounts = [];
        const pending = dispatchChat(provider, "model-a", dispatchBody(stream), {
          fetchImpl: async (url, init) => {
            if (url.includes("/auth/token/refresh")) {
              reached(); await gate;
              return new Response(JSON.stringify(envelope({ accessToken: "fake-refreshed", expiresIn: 86400 })));
            }
            const id = init.headers["X-User-Id"];
            chatAccounts.push(id);
            return forced && chatAccounts.length === 1 ? new Response('{"error":"expired"}', { status: 401 }) : new Response(successSse);
          }
        });
        await entered;
        const latest = readPool();
        const a = latest.accounts[0];
        if (condition === "disabled") a.enabled = false;
        if (condition === "global") { a.health = "cooldown"; a.cooldownUntil = "2099-01-01T00:00:00Z"; }
        if (condition === "model") a.modelHealth["model-a"] = { health: "cooldown", cooldownUntil: "2099-01-01T00:00:00Z" };
        latest.accounts[1].enabled = true;
        savePool(latest); unblock();
        const result = await pending;
        if (result.upstream) await result.upstream.text();
        assert.equal(result.accountId, "account-2");
        assert.deepEqual(chatAccounts, forced ? ["uid-1", "uid-2"] : ["uid-2"]);
        const after = readPool();
        assert.equal(after.accounts[0].lastSuccessAt, null);
        assert.equal(after.accounts[0].consecutiveFailures, 0);
        // 恢复 A 并停用 B，证明跳过 A 的路径已释放原租约。
        after.accounts[0].enabled = true; after.accounts[0].health = "healthy";
        after.accounts[0].cooldownUntil = null; after.accounts[0].modelHealth = {};
        after.accounts[1].enabled = false; savePool(after);
        const next = await dispatchChat(provider, "model-a", dispatchBody(false), { fetchImpl: async () => new Response(successSse) });
        assert.equal(next.accountId, "account-1"); assert.equal(next.kind, "json");
      });
    }
  }
}

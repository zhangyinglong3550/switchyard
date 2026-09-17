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
import { prepareWorkBuddyChatBody, aggregateChatSseToChatResponse, normalizeWorkBuddyStreamLine } from "../src/upstream/workbuddy-adapter.mjs";
import { mergeWithDefaults } from "../src/config.mjs";
import { getProviderPreset } from "../src/provider-presets.mjs";

const envelope = (data, code = 0) => ({ code, msg: code === 0 ? "ok" : "pending", data });

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload), body: { cancel: async () => {} } };
}

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-workbuddy-")); }

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

// chat 路径分叉：先 /console/chat/completions，404 时回退 /v2/chat/completions。
test("workbuddy chat · 先 console 后 v2 回退，且带账号头", async () => {
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
    _workbuddyChatPaths: ["/console/chat/completions", "/v2/chat/completions"]
  };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${WORKBUDDY_BASE_URL}/console/chat/completions`) return response({ error: "not found" }, 404);
    if (url === `${WORKBUDDY_BASE_URL}/v2/chat/completions`) return response({ id: "chatcmpl-1", choices: [] });
    throw new Error(`unexpected url ${url}`);
  };
  const res = await callOpenAIChat(bound, { model: "deepseek-v4.1-flash", messages: [] }, { fetchImpl, stream: false });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, `${WORKBUDDY_BASE_URL}/console/chat/completions`);
  assert.equal(calls[1].url, `${WORKBUDDY_BASE_URL}/v2/chat/completions`);
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

  // 海外账号仍按 global 绑定（base 与 /console 优先路径不变）。
  const boundGlobal = bindProviderToAccount(provider, { id: "g-1", realm: "global", accessToken: "at-g", refreshToken: "rt-g" });
  assert.equal(boundGlobal.baseUrl, "https://www.workbuddy.ai");
  assert.deepEqual(boundGlobal._workbuddyChatPaths, ["/console/chat/completions", "/v2/chat/completions"]);
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
  // DeepSeek 系必须注入思维链开关 + 默认档位，否则上游不返回思考（实测思考帧为 0）。
  assert.deepEqual(prepared.thinking, { type: "enabled" });
  assert.equal(prepared.reasoning_effort, "high");

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

  // 多轮：任一 assistant 带 reasoning 痕迹 → 所有 assistant 补 reasoning_content（可为空串）。
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

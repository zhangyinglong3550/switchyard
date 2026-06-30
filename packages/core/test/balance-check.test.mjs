import test from "node:test";
import assert from "node:assert/strict";
import { checkBalance } from "../src/balance-check.mjs";

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

async function withMockFetch(fn, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test("balance check · returns no-usage-check-config for unsupported providers", async () => {
  const result = await checkBalance({
    id: "anthropic",
    baseUrl: "https://api.anthropic.com",
    authMode: "api_key",
    apiKey: "sk-test"
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "no-usage-check-config");
});

test("balance check · fails fast when API key is missing", async () => {
  const result = await checkBalance({
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    authMode: "api_key"
  });
  assert.equal(result.success, false);
  assert.equal(result.error, "api-key-empty");
});

test("balance check · parses DeepSeek balance_infos", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "deepseek",
      baseUrl: "https://api.deepseek.com",
      authMode: "api_key",
      apiKey: "sk-test"
    });
    assert.equal(result.success, true);
    assert.equal(result.status, "available");
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data.map((row) => [row.planName, row.remaining, row.unit]), [
      ["CNY", 12.5, "CNY"],
      ["USD", 3.25, "USD"]
    ]);
  }, async (url, init) => {
    assert.equal(url, "https://api.deepseek.com/user/balance");
    assert.equal(init.headers.Authorization, "Bearer sk-test");
    return jsonResponse({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "12.50" },
        { currency: "USD", total_balance: 3.25 }
      ]
    });
  });
});

test("balance check · computes OpenRouter remaining credits", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      authMode: "api_key",
      apiKey: "sk-test"
    });
    assert.equal(result.success, true);
    assert.equal(result.data[0].remaining, 8.5);
    assert.equal(result.data[0].total, 10);
    assert.equal(result.data[0].used, 1.5);
    assert.equal(result.data[0].unit, "USD");
  }, async (url) => {
    assert.equal(url, "https://openrouter.ai/api/v1/credits");
    return jsonResponse({ data: { total_credits: 10, total_usage: 1.5 } });
  });
});

test("balance check · converts Novita 0.0001 USD units", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "novita",
      baseUrl: "https://api.novita.ai/openai/v1",
      authMode: "api_key",
      apiKey: "sk-test"
    });
    assert.equal(result.success, true);
    assert.equal(result.data[0].remaining, 1.25);
    assert.equal(result.data[0].unit, "USD");
  }, async (url) => {
    assert.equal(url, "https://api.novita.ai/v3/user/balance");
    return jsonResponse({ availableBalance: 12500 });
  });
});

test("balance check · parses MiniMax coding-plan remaining percentages", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "minimax",
      baseUrl: "https://api.minimaxi.com/v1",
      authMode: "api_key",
      apiKey: "sk-test"
    });
    assert.equal(result.success, true);
    assert.equal(result.data.length, 2);
    assert.deepEqual(result.data.map((row) => [row.planName, row.remaining, row.total, row.used, row.unit]), [
      ["MiniMax 5 小时窗口", 80, 100, 20, "%"],
      ["MiniMax 周限额", 45.5, 100, 54.5, "%"]
    ]);
  }, async (url, init) => {
    assert.equal(url, "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
    assert.equal(init.headers.Authorization, "Bearer sk-test");
    return jsonResponse({
      base_resp: { status_code: 0 },
      model_remains: [
        { model_name: "video", current_interval_remaining_percent: 10 },
        {
          model_name: "general",
          current_interval_remaining_percent: 80,
          current_weekly_status: 1,
          current_weekly_remaining_percent: 45.5
        }
      ]
    });
  });
});

test("balance check · supports custom usage_check baseUrl path and JSON path extractor", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "custom-api",
      baseUrl: "https://llm.example.com/v1",
      authMode: "api_key",
      apiKey: "provider-key",
      usage_check: {
        templateType: "balance",
        apiKey: "usage-key",
        baseUrl: "https://billing.example.com",
        path: "/v1/usage",
        method: "GET",
        extract: { path: "data.remaining", unit: "USD" },
        planName: "自定义余额"
      }
    });
    assert.equal(result.success, true);
    assert.equal(result.data[0].planName, "自定义余额");
    assert.equal(result.data[0].remaining, 42.75);
    assert.equal(result.data[0].unit, "USD");
  }, async (url, init) => {
    assert.equal(url, "https://billing.example.com/v1/usage");
    assert.equal(init.headers.Authorization, "Bearer usage-key");
    return jsonResponse({ data: { remaining: "42.75" } });
  });
});
test("balance check · supports ccswitch-style custom usage script", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "script-api",
      baseUrl: "https://api.example.com",
      authMode: "api_key",
      apiKey: "sk-script",
      usage_check: {
        templateType: "custom",
        code: `({
          request: {
            url: "{{baseUrl}}/v1/usage",
            method: "GET",
            headers: { Authorization: "Bearer {{apiKey}}" }
          },
          extractor(response) {
            return { planName: "脚本余额", remaining: response.balance, unit: "USD", isValid: true };
          }
        })`
      }
    });
    assert.equal(result.success, true);
    assert.equal(result.data[0].planName, "脚本余额");
    assert.equal(result.data[0].remaining, 9.5);
  }, async (url, init) => {
    assert.equal(url, "https://api.example.com/v1/usage");
    assert.equal(init.headers.Authorization, "Bearer sk-script");
    return jsonResponse({ balance: 9.5 });
  });
});
test("balance check · handles auth failures as standardized result", async () => {
  await withMockFetch(async () => {
    const result = await checkBalance({
      id: "siliconflow",
      baseUrl: "https://api.siliconflow.cn/v1",
      authMode: "api_key",
      apiKey: "bad-key"
    });
    assert.equal(result.success, false);
    assert.match(result.error, /auth-failed/);
  }, async () => jsonResponse({ error: "invalid" }, { status: 401 }));
});

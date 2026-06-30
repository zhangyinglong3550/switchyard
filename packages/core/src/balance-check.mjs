// 供应商余额/用量查询引擎。
//
// 设计参考 ccswitch 的 services/balance.rs 与 services/coding_plan.rs：
// 按供应商专用解析函数分发，而非通用 JSON-path 提取——因为各供应商
// 响应结构差异大（OpenRouter 需 total_credits-total_usage、Novita 需 /10000、
// DeepSeek 是多数组、Kimi/智谱返回配额层级）。
//
// 入口 checkBalance(provider) 返回标准 UsageResult：
//   { success, data: [{ planName, remaining, total, used, unit, raw }], error, status }
import { resolveApiKey, isCodexOAuthProvider, readCodexOAuthAuth } from "./upstream/clients.mjs";
import { getProviderKeychainSecret } from "./keychain-store.mjs";
import { providerPresetFor } from "./provider-presets.mjs";
import {
  USAGE_TEMPLATE_TYPES,
  createUsageResult,
  deriveBalanceStatus,
  freezeUsageResult,
} from "./usage-template-types.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;

// ── 公开 API ──────────────────────────────────────────────

// 对一个供应商执行余额/用量查询，返回 UsageResult。
// provider 是完整供应商记录（含 id、baseUrl、apiKey 等）。
// 若供应商预设中没有 usage_check 配置，返回 { success:false, error:"no-usage-check-config" }。
export async function checkBalance(provider) {
  if (!provider?.id) return createUsageResult({ error: "invalid-provider" });
  const config = resolveUsageCheckConfig(provider);
  if (!config) return createUsageResult({ error: "no-usage-check-config" });
  const apiKey = resolveQueryApiKey(provider, config);
  if (!apiKey && ![USAGE_TEMPLATE_TYPES.SUBSCRIPTION, USAGE_TEMPLATE_TYPES.CUSTOM].includes(config.templateType)) {
    return createUsageResult({ error: "api-key-empty" });
  }
  const baseUrl = canonicalBaseUrl({ ...provider, baseUrl: config.baseUrl || provider.baseUrl });

  try {
    const result = await executeTemplateQuery(baseUrl, apiKey, provider, config);
    result.status = deriveBalanceStatus(result);
    return freezeUsageResult(result);
  } catch (err) {
    return freezeUsageResult(createUsageResult({ success: false, error: err?.message || String(err) }));
  }
}

// 从供应商配置或预设中解析 usage_check 配置。
// 供应商自身配置优先于预设的 usage_check。
function resolveUsageCheckConfig(provider) {
  if (provider?.usage_check) return provider.usage_check;
  const preset = providerPresetFor(provider);
  return preset?.usage_check || null;
}

// ── 凭证解析 ──────────────────────────────────────────────

function resolveQueryApiKey(provider, config) {
  // 显式 apiKey 字段（自写配置时可用）优先
  if (config.apiKey) return config.apiKey;
  // keychain 存储的密钥
  if (provider.authMode === "keychain" || provider.keychainAccount) {
    return getProviderKeychainSecret(provider) || "";
  }
  return resolveApiKey(provider);
}

function resolveQueryAccessToken(provider) {
  if (isCodexOAuthProvider(provider)) {
    const auth = readCodexOAuthAuth({ provider });
    if (auth.ok) return auth.accessToken;
  }
  return null;
}

// ── 模板分发 ──────────────────────────────────────────────

async function executeTemplateQuery(baseUrl, apiKey, provider, config) {
  const templateType = config.templateType || USAGE_TEMPLATE_TYPES.BALANCE;
  switch (templateType) {
    case USAGE_TEMPLATE_TYPES.CUSTOM:
      return await queryCustomUsage(baseUrl, apiKey, config);
    case USAGE_TEMPLATE_TYPES.BALANCE:
      return await dispatchBalance(baseUrl, apiKey, config);
    case USAGE_TEMPLATE_TYPES.USER_INFO:
      return await queryUserInfoApi(baseUrl, apiKey, config);
    case USAGE_TEMPLATE_TYPES.CODING_PLAN:
      return await dispatchCodingPlan(baseUrl, apiKey, provider, config);
    case USAGE_TEMPLATE_TYPES.SUBSCRIPTION:
      return await querySubscriptionApi(provider, config);
    default:
      throw new Error(`unsupported usage template type: ${templateType}`);
  }
}

// ── 自定义查询（custom） ────────────────────────────────
// 支持 ccswitch 风格：
// ({ request: { url, method, headers, body }, extractor: function(response) { return { remaining, unit } } })
async function queryCustomUsage(baseUrl, apiKey, config) {
  const script = String(config.code || "").trim();
  if (!script) return await queryGenericBalance(baseUrl, apiKey, config);
  const spec = evaluateUsageSpec(script);
  const request = spec?.request || {};
  const url = replaceUsagePlaceholders(request.url || config.path || baseUrl, { baseUrl, apiKey });
  if (!url) throw new Error("custom usage query missing request.url");
  const headers = Object.fromEntries(
    Object.entries(request.headers || {}).map(([key, value]) => [key, replaceUsagePlaceholders(String(value), { baseUrl, apiKey })])
  );
  const resp = await fetchJson(url, {
    method: request.method || config.method || "GET",
    headers,
    body: request.body
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const raw = await parseJson(resp);
  const extracted = typeof spec.extractor === "function" ? spec.extractor(raw) : raw;
  return finalize([{
    planName: extracted?.planName || config.planName || "自定义余额",
    remaining: parseFiniteNumber(extracted?.remaining ?? extracted?.balance),
    total: parseFiniteNumber(extracted?.total),
    used: parseFiniteNumber(extracted?.used),
    unit: extracted?.unit || config.unit || inferUnit(raw, extracted?.remaining),
    raw
  }], extracted?.isValid === false ? (extracted?.invalidMessage || "余额不可用") : "");
}

function evaluateUsageSpec(script) {
  try {
    // 本地用户配置脚本：只允许表达式返回对象，不注入 Node 能力。
    // 与 ccswitch 的用量脚本模板兼容，适合个人本机配置。
    return Function(`"use strict"; return (${script});`)();
  } catch (err) {
    throw new Error(`usage script parse failed: ${err?.message || String(err)}`);
  }
}

function replaceUsagePlaceholders(value, { baseUrl, apiKey }) {
  return String(value || "")
    .replaceAll("{{baseUrl}}", String(baseUrl || "").replace(/\/+$/, ""))
    .replaceAll("{{apiKey}}", String(apiKey || ""));
}


// 端点与响应格式精确对齐 ccswitch services/balance.rs。
async function dispatchBalance(baseUrl, apiKey, config) {
  const balanceProvider = String(config.balanceProvider || "").toLowerCase();
  switch (balanceProvider) {
    case "deepseek":
      return await queryDeepSeekBalance(apiKey);
    case "siliconflow":
      return await querySiliconFlowBalance(baseUrl, apiKey);
    case "openrouter":
      return await queryOpenRouterBalance(apiKey);
    case "stepfun":
      return await queryStepFunBalance(apiKey);
    case "novita":
      return await queryNovitaBalance(apiKey);
    default:
      // 通用 fallback：用 config.path + extract.path 提取
      return await queryGenericBalance(baseUrl, apiKey, config);
  }
}

// DeepSeek: GET https://api.deepseek.com/user/balance
// 响应: { balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }], is_available }
async function queryDeepSeekBalance(apiKey) {
  const resp = await fetchJson("https://api.deepseek.com/user/balance", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const isAvailable = body?.is_available !== false;
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const data = infos.map((info) => ({
    planName: String(info?.currency || "CNY"),
    remaining: parseFiniteNumber(info?.total_balance),
    total: parseFiniteNumber(info?.total_balance),
    used: null,
    unit: String(info?.currency || "CNY"),
    raw: info,
  }));
  if (!data.length) return createUsageResult({ success: false, error: "no-balance-info" });
  return finalize(data, !isAvailable ? "余额不可用" : "");
}

// SiliconFlow: GET {base}/v1/user/info
// 响应: { data: { totalBalance, chargeBalance, balance, status } }
async function querySiliconFlowBalance(baseUrl, apiKey) {
  const isCn = String(baseUrl).includes("siliconflow.cn");
  const domain = isCn ? "https://api.siliconflow.cn" : "https://api.siliconflow.com";
  const resp = await fetchJson(`${domain}/v1/user/info`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const data = body?.data || {};
  return finalize([{
    planName: isCn ? "SiliconFlow" : "SiliconFlow (EN)",
    remaining: parseFiniteNumber(data.totalBalance),
    total: parseFiniteNumber(data.totalBalance),
    used: null,
    unit: isCn ? "CNY" : "USD",
    raw: data,
  }]);
}

// OpenRouter: GET https://openrouter.ai/api/v1/credits
// 响应: { data: { total_credits, total_usage } }，remaining = total_credits - total_usage
async function queryOpenRouterBalance(apiKey) {
  const resp = await fetchJson("https://openrouter.ai/api/v1/credits", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const data = body?.data || body || {};
  const totalCredits = parseFiniteNumber(data.total_credits) ?? 0;
  const totalUsage = parseFiniteNumber(data.total_usage) ?? 0;
  const remaining = totalCredits - totalUsage;
  return finalize([{
    planName: "OpenRouter",
    remaining,
    total: totalCredits,
    used: totalUsage,
    unit: "USD",
    raw: data,
  }], remaining <= 0 ? "余额耗尽" : "");
}

// StepFun: GET https://api.stepfun.com/v1/accounts
// 响应: { balance, total_cash_balance, total_voucher_balance }
async function queryStepFunBalance(apiKey) {
  const resp = await fetchJson("https://api.stepfun.com/v1/accounts", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  return finalize([{
    planName: "StepFun",
    remaining: parseFiniteNumber(body?.balance) ?? 0,
    total: null,
    used: null,
    unit: "CNY",
    raw: body,
  }]);
}

// Novita AI: GET https://api.novita.ai/v3/user/balance
// 响应: { availableBalance }，单位 0.0001 USD，需 /10000
async function queryNovitaBalance(apiKey) {
  const resp = await fetchJson("https://api.novita.ai/v3/user/balance", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const available = (parseFiniteNumber(body?.availableBalance) ?? 0) / 10000;
  return finalize([{
    planName: "Novita AI",
    remaining: available,
    total: null,
    used: null,
    unit: "USD",
    raw: body,
  }], available <= 0 ? "余额耗尽" : "");
}

// 通用余额查询 fallback：用 config.path + extract.path 从响应中提取数值。
// 适用于自定义供应商或未在上表列出的供应商。
async function queryGenericBalance(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for balance query");
  const url = joinUrl(baseUrl, config.path || "/api/v1/organization/credits");
  const method = config.method || "GET";
  const headers = buildAuthHeaders(apiKey, config);
  const body = method === "POST" ? config.body : undefined;
  const resp = await fetchJson(url, { method, headers, body });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const raw = await parseJson(resp);
  const remaining = extractNumericValue(raw, config);
  const unit = config.unit || config.extract?.unit || inferUnit(raw, remaining);
  return finalize([{
    planName: config.planName || "默认套餐",
    remaining,
    total: null,
    used: null,
    unit,
    raw,
  }]);
}

// ── 用户信息接口查询（user_info） ───────────────────────
// 通用 /user/info 类接口，用 extract.path 提取余额字段。
async function queryUserInfoApi(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for user-info query");
  const url = joinUrl(baseUrl, config.path || "/api/user/info");
  const headers = buildAuthHeaders(apiKey, config);
  const resp = await fetchJson(url, { method: "GET", headers });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const raw = await parseJson(resp);
  const remaining = extractNumericValue(raw, config);
  const unit = config.unit || config.extract?.unit || inferUnit(raw, remaining);
  return finalize([{
    planName: config.planName || "默认套餐",
    remaining,
    total: null,
    used: null,
    unit,
    raw,
  }]);
}

// ── 套餐/配额查询分发（coding_plan） ───────────────────
async function dispatchCodingPlan(baseUrl, apiKey, provider, config) {
  const codingPlanProvider = String(config.codingPlanProvider || "").toLowerCase();
  switch (codingPlanProvider) {
    case "kimi":
      return await queryKimiCodingPlan(apiKey);
    case "zhipu":
      return await queryZhipuCodingPlan(baseUrl, apiKey);
    case "minimax":
      return await queryMiniMaxCodingPlan(baseUrl, apiKey);
    case "volcengine":
      return await queryVolcengineCodingPlan(baseUrl, apiKey, config);
    case "zenmux":
      return await queryZenMuxCodingPlan(baseUrl, apiKey, config);
    default:
      return await queryGenericBalance(baseUrl, apiKey, config);
  }
}

// Kimi For Coding: GET https://api.kimi.com/coding/v1/usages
// 响应: { limits: [{ detail: { limit, remaining, resetTime } }], usage: { limit, remaining, resetTime } }
async function queryKimiCodingPlan(apiKey) {
  const resp = await fetchJson("https://api.kimi.com/coding/v1/usages", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const data = [];
  // 5 小时窗口
  const limits = Array.isArray(body?.limits) ? body.limits : [];
  for (const item of limits) {
    const detail = item?.detail;
    if (!detail) continue;
    data.push({
      planName: "Kimi 5 小时窗口",
      remaining: parseFiniteNumber(detail.remaining),
      total: parseFiniteNumber(detail.limit),
      used: null,
      unit: "tokens",
      raw: detail,
    });
  }
  // 周限额
  if (body?.usage) {
    data.push({
      planName: "Kimi 周限额",
      remaining: parseFiniteNumber(body.usage.remaining),
      total: parseFiniteNumber(body.usage.limit),
      used: null,
      unit: "tokens",
      raw: body.usage,
    });
  }
  if (!data.length) return createUsageResult({ success: false, error: "no-quota-info" });
  return finalize(data);
}

// 智谱 GLM: GET {base}/api/monitor/usage/quota/limit
// 注意：智谱 Authorization 不加 Bearer 前缀，直接传 api_key。
// 响应: { data: { limits: [{ type: "TOKENS_LIMIT", percentage, unit, nextResetTime }] } }
async function queryZhipuCodingPlan(baseUrl, apiKey) {
  const base = String(baseUrl).toLowerCase().includes("bigmodel.cn")
    ? "https://open.bigmodel.cn"
    : "https://api.z.ai";
  const resp = await fetchJson(`${base}/api/monitor/usage/quota/limit`, {
    method: "GET",
    headers: { Authorization: apiKey },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
  const data = [];
  for (const item of limits) {
    if (!String(item?.type || "").toLowerCase().includes("tokens_limit")) continue;
    const percentage = parseFiniteNumber(item.percentage) ?? 0;
    // percentage 是已用百分比，remaining 用 100-percentage 近似
    data.push({
      planName: zhipuWindowLabel(item),
      remaining: Math.max(0, 100 - percentage),
      total: 100,
      used: percentage,
      unit: "%",
      raw: item,
    });
  }
  if (!data.length) return createUsageResult({ success: false, error: "no-quota-info" });
  return finalize(data);
}

function zhipuWindowLabel(item) {
  const unit = Number(item?.unit);
  if (unit === 3) return "智谱 5 小时窗口";
  if (unit === 6) return "智谱周限额";
  return "智谱配额";
}

// MiniMax Coding Plan: GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
// 响应 model_remains[] 中 model_name=general 的 current_*_remaining_percent 为“剩余百分比”。
async function queryMiniMaxCodingPlan(baseUrl, apiKey) {
  const isCn = !String(baseUrl).toLowerCase().includes("minimax.io");
  const domain = isCn ? "https://api.minimaxi.com" : "https://api.minimax.io";
  const resp = await fetchJson(`${domain}/v1/api/openplatform/coding_plan/remains`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  const baseResp = body?.base_resp;
  if (baseResp && Number(baseResp.status_code) !== 0) {
    return createUsageResult({ success: false, error: `minimax api error: ${baseResp.status_msg || baseResp.status_code}` });
  }
  const item = Array.isArray(body?.model_remains)
    ? body.model_remains.find((row) => row?.model_name === "general")
    : null;
  if (!item) return createUsageResult({ success: false, error: "minimax-coding-plan: no general model quota" });
  const data = [];
  const fiveHourRemaining = parseFiniteNumber(item.current_interval_remaining_percent);
  if (fiveHourRemaining != null) {
    data.push({
      planName: "MiniMax 5 小时窗口",
      remaining: fiveHourRemaining,
      total: 100,
      used: Math.max(0, 100 - fiveHourRemaining),
      unit: "%",
      raw: item,
    });
  }
  if (Number(item.current_weekly_status) === 1) {
    const weeklyRemaining = parseFiniteNumber(item.current_weekly_remaining_percent);
    if (weeklyRemaining != null) {
      data.push({
        planName: "MiniMax 周限额",
        remaining: weeklyRemaining,
        total: 100,
        used: Math.max(0, 100 - weeklyRemaining),
        unit: "%",
        raw: item,
      });
    }
  }
  if (!data.length) return createUsageResult({ success: false, error: "minimax-coding-plan: no quota tiers" });
  return finalize(data);
}

// 火山方舟 Coding/Agent Plan: 推理端点无标准配额查询接口，
// 控制平面查询需要 AK/SK SigV4 签名（暂不支持）。先尝试推理端点上的兼容路径。
async function queryVolcengineCodingPlan(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for volcengine coding plan");
  const candidates = [
    joinUrl(baseUrl, config.path || "/api/coding/plan/usage"),
    joinUrl(baseUrl, "/api/coding/plan/quota"),
  ];
  for (const url of candidates) {
    try {
      const resp = await fetchJson(url, {
        method: config.method || "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!resp.ok) continue;
      const body = await parseJson(resp);
      return finalize([{
        planName: "火山方舟配额",
        remaining: parseFiniteNumber(body?.remaining) ?? parseFiniteNumber(body?.data?.remaining),
        total: parseFiniteNumber(body?.total) ?? parseFiniteNumber(body?.data?.total),
        used: null,
        unit: "tokens",
        raw: body,
      }]);
    } catch {
      // try next candidate
    }
  }
  return createUsageResult({ success: false, error: "volcengine-coding-plan: 需 AK/SK 签名，暂不支持" });
}

// ZenMux Token Plan: GET {base}/api/plan/quota
async function queryZenMuxCodingPlan(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for zenmux coding plan");
  const url = joinUrl(baseUrl, config.path || "/api/plan/quota");
  const resp = await fetchJson(url, {
    method: config.method || "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  return finalize([{
    planName: "ZenMux 配额",
    remaining: parseFiniteNumber(body?.remaining) ?? parseFiniteNumber(body?.data?.remaining),
    total: parseFiniteNumber(body?.total) ?? parseFiniteNumber(body?.data?.total),
    used: null,
    unit: "USD",
    raw: body,
  }]);
}

// ── 订阅额度查询（subscription） ───────────────────────
// Codex OAuth / ChatGPT Plus/Pro 订阅额度查询。
async function querySubscriptionApi(provider, config) {
  const accessToken = resolveQueryAccessToken(provider);
  if (!accessToken) return createUsageResult({ success: false, error: "no-access-token" });
  const baseUrl = config.subscriptionBaseUrl || "https://chatgpt.com/backend-api";
  const url = joinUrl(baseUrl, config.path || "/user/subscription");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(config.headers || {}),
  };
  const resp = await fetchJson(url, { method: "GET", headers });
  if (resp.status === 401 || resp.status === 403) return authError(resp.status);
  if (!resp.ok) return httpError(resp);
  const body = await parseJson(resp);
  return finalize([{
    planName: body?.plan_name || body?.planType || "ChatGPT 订阅",
    remaining: null,
    total: null,
    used: null,
    unit: "subscription",
    raw: body,
  }]);
}

// ── HTTP 工具函数 ────────────────────────────────────────

function canonicalBaseUrl(provider) {
  return String(provider?.baseUrl || "").replace(/\/+$/, "");
}

function joinUrl(baseUrl, suffix) {
  if (!suffix) return baseUrl;
  if (suffix.startsWith("http://") || suffix.startsWith("https://")) return suffix;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = String(suffix || "").replace(/^\/+/, "");
  return path ? `${base}/${path}` : base;
}

function buildAuthHeaders(apiKey, config) {
  const headers = { ...(config.headers || {}) };
  if (!headers.Authorization && !headers["x-api-key"] && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  headers.Accept = "application/json";
  return headers;
}

async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("balance-query-timeout")), DEFAULT_TIMEOUT_MS);
  try {
    return await globalThis.fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // 不跟随重定向以避免凭证泄露到不同域名
      redirect: "manual",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function parseJson(resp) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ── 结果构建辅助 ──────────────────────────────────────────

function parseFiniteNumber(value) {
  if (value == null) return null;
  const num = typeof value === "string" ? Number(value) : Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractNumericValue(raw, config) {
  if (config.extract?.path) {
    const val = jsonPathValue(raw, config.extract.path);
    const num = parseFiniteNumber(val);
    if (num != null) return num;
  }
  const candidates = [
    "data.balance_credits", "data.balance", "data.credits", "data.totalBalance",
    "total_credits", "credits", "balance", "remaining",
  ];
  for (const path of candidates) {
    const num = parseFiniteNumber(jsonPathValue(raw, path));
    if (num != null && num >= 0) return num;
  }
  return null;
}

function jsonPathValue(obj, path) {
  if (!obj || typeof obj !== "object") return null;
  let current = obj;
  for (const part of String(path).split(".")) {
    if (current == null) return null;
    current = current[part];
  }
  return current;
}

function inferUnit(raw, amount) {
  const rawStr = JSON.stringify(raw || {});
  if (/\$|usd|USD/i.test(rawStr)) return "USD";
  if (/CNY|¥|元|RMB/i.test(rawStr)) return "CNY";
  if (/token|tokenCount/i.test(rawStr)) return "tokens";
  return amount != null && amount < 1_000_000 ? "USD" : "tokens";
}

// 把 data 数组包装成标准 UsageResult。
// invalidMessage 非空时标记套餐不可用（仍算 success，但 data[0].isValid=false）。
function finalize(data, invalidMessage = "") {
  const normalized = data.map((item) => ({
    planName: String(item.planName || ""),
    remaining: item.remaining != null ? Number(item.remaining) : null,
    total: item.total != null ? Number(item.total) : null,
    used: item.used != null ? Number(item.used) : null,
    unit: String(item.unit || ""),
    isValid: !invalidMessage,
    invalidMessage: invalidMessage || undefined,
    raw: item.raw && typeof item.raw === "object" ? item.raw : null,
  }));
  return createUsageResult({ success: true, data: normalized });
}

function authError(status) {
  return createUsageResult({
    success: false,
    error: `auth-failed (HTTP ${status})`,
    data: [{ isValid: false, invalidMessage: `认证失败 (HTTP ${status})` }],
  });
}

function httpError(resp) {
  return createUsageResult({
    success: false,
    error: `upstream-error: HTTP ${resp.status}`,
  });
}

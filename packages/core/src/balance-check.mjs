// 供应商余额/用量查询引擎。
// 执行 HTTP 余额测试，按供应商预设的 usage_check 配置分发查询，
// 结果统一为 UsageResult 标准化格式。
import { resolveApiKey, isCodexOAuthProvider, readCodexOAuthAuth } from "./upstream/clients.mjs";
import { getProviderKeychainSecret } from "./keychain-store.mjs";
import {
  USAGE_TEMPLATE_TYPES,
  createUsageResult,
  deriveBalanceStatus,
} from "./usage-template-types.mjs";
import { providerPresetFor } from "./provider-presets.mjs";

// ── 公开 API ──────────────────────────────────────────────

// 对一个供应商执行余额/用量查询，返回 UsageResult。
// provider 是完整供应商记录（含 id、baseUrl、apiKey 等）。
// 如果供应商预设中没有 usage_check 配置，返回 { success: false, error: "no-usage-check-config" }。
export async function checkBalance(provider) {
  if (!provider?.id) return createUsageResult({ error: "invalid-provider" });
  const config = resolveUsageCheckConfig(provider);
  if (!config) return createUsageResult({ error: "no-usage-check-config" });
  const apiKey = resolveQueryApiKey(provider, config);
  const baseUrl = canonicalBaseUrl(provider);

  try {
    const raw = await executeTemplateQuery(baseUrl, apiKey, provider, config);
    const result = normalizeResult(raw, config);
    Object.freeze(result);
    return result;
  } catch (err) {
    return createUsageResult({
      success: false,
      error: err?.message || String(err),
    });
  }
}

// 从预设配置中解析 usage_check 配置（含 providerPresetFor 回退）。
function resolveUsageCheckConfig(provider) {
  const preset = providerPresetForProvider(provider);
  if (!preset) return null;
  // 供应商自身配置优先于预设的 usage_check
  return provider.usage_check || preset.usage_check || null;
}

// ── 凭证解析 ──────────────────────────────────────────────

function resolveQueryApiKey(provider, config) {
  // 显式 apiKey 字段（自写配置时可用）优先
  if (config.apiKey) return config.apiKey;
  // 否则走供应商认证体系
  if (provider.authMode === "keychain" || provider.keychainAccount) return getProviderKeychainSecret(provider) || "";
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
    case USAGE_TEMPLATE_TYPES.BALANCE:
      return await queryBalanceApi(baseUrl, apiKey, config);
    case USAGE_TEMPLATE_TYPES.USER_INFO:
      return await queryUserInfoApi(baseUrl, apiKey, config);
    case USAGE_TEMPLATE_TYPES.CODING_PLAN:
      return await queryCodingPlanApi(baseUrl, apiKey, provider, config);
    case USAGE_TEMPLATE_TYPES.SUBSCRIPTION:
      return await querySubscriptionApi(provider, config);
    default:
      throw new Error(`unsupported usage template type: ${templateType}`);
  }
}

// ── 余额 API 查询（balance） ────────────────────────────

async function queryBalanceApi(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for balance query");
  const url = joinUrl(baseUrl, config.path || "/api/v1/organization/credits");
  const method = config.method || "GET";
  const headers = buildAuthHeaders(apiKey, config);
  const body = method === "POST" ? config.body : undefined;

  const resp = await fetchJson(url, { method, headers, body });
  if (!resp.ok) {
    throw new Error(
      resp.status === 401
        ? "auth-failed"
        : resp.status === 404
          ? "endpoint-not-found"
          : `upstream-error: ${resp.status}`
    );
  }
  return await parseResponseBody(resp);
}

// ── 用户信息接口查询（user_info） ───────────────────────

async function queryUserInfoApi(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for user-info query");
  const url = joinUrl(baseUrl, config.path || "/api/user/info");
  const headers = buildAuthHeaders(apiKey, config);

  const resp = await fetchJson(url, { method: "GET", headers });
  if (!resp.ok) {
    throw new Error(resp.status === 401 ? "auth-failed" : `upstream-error: ${resp.status}`);
  }
  return await parseResponseBody(resp);
}

// ── 套餐/配额查询（coding_plan） ───────────────────────

async function queryCodingPlanApi(baseUrl, apiKey, provider, config) {
  // coding_plan 类型按供应商子类型分发
  const codingPlanProvider = (config.codingPlanProvider || "").toLowerCase();

  switch (codingPlanProvider) {
    case "volcengine":
      return await queryVolcengineCodingPlan(baseUrl, apiKey, provider, config);
    case "zhipu":
      return await queryZhipuCodingPlan(baseUrl, apiKey, config);
    case "minimax":
      return await queryMiniMaxCodingPlan(baseUrl, apiKey, config);
    case "kimi":
      return await queryKimiCodingPlan(baseUrl, apiKey, config);
    case "zenmux":
      return await queryZenMuxCodingPlan(baseUrl, apiKey, config);
    default:
      // 通用 coding_plan fallback：尝试直接调用配置的端点
      return await queryBalanceApi(baseUrl, apiKey, config);
  }
}

// ── 订阅额度查询（subscription） ───────────────────────

async function querySubscriptionApi(provider, config) {
  const accessToken = resolveQueryAccessToken(provider);
  if (!accessToken) throw new Error("no-access-token for subscription query");

  const baseUrl = config.subscriptionBaseUrl || "https://chatgpt.com/backend-api";
  const url = joinUrl(baseUrl, config.path || "/user/subscription");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(config.headers || {}),
  };

  const resp = await fetchJson(url, { method: "GET", headers });
  if (!resp.ok) {
    throw new Error(resp.status === 401 ? "auth-failed" : `upstream-error: ${resp.status}`);
  }
  return await parseResponseBody(resp);
}

// ── 供应商专用 coding_plan 实现 ─────────────────────────

// 火山方舟：coding plan 查询
async function queryVolcengineCodingPlan(baseUrl, apiKey, provider, config) {
  // 火山方舟 coding plan 需要控制平面 API（open.volcengineapi.com）+ SigV4 签名
  // 这里使用 inference endpoint 上的兼容查询接口作为 fallback
  if (!baseUrl) throw new Error("missing baseUrl for volcengine coding plan");
  const candidates = [
    joinUrl(baseUrl, config.path || "/api/coding/plan/usage"),
    joinUrl(baseUrl, "/api/coding/plan/quota"),
  ];
  const headers = buildAuthHeaders(apiKey, config);
  for (const url of candidates) {
    try {
      const resp = await fetchJson(url, { method: config.method || "GET", headers });
      if (resp.ok) return await parseResponseBody(resp);
    } catch {
      // try next candidate
    }
  }
  throw new Error("volcengine-coding-plan: no valid endpoint found");
}

// 智谱 GLM  Coding Plan 查询
async function queryZhipuCodingPlan(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for zhipu coding plan");
  const candidates = [
    "https://api.z.ai/api/coding/paas/v4/user/quota",
    "https://open.bigmodel.cn/api/coding/paas/v4/user/quota",
    joinUrl(baseUrl, config.path || "/user/quota"),
  ];
  const headers = buildAuthHeaders(apiKey, config);
  for (const url of candidates) {
    try {
      const resp = await fetchJson(url, { method: config.method || "GET", headers });
      if (resp.ok) return await parseResponseBody(resp);
    } catch {
      // try next candidate
    }
  }
  throw new Error("zhipu-coding-plan: no valid endpoint found");
}

// MiniMax Coding Plan 查询
async function queryMiniMaxCodingPlan(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for minimax coding plan");
  const candidates = [
    joinUrl(baseUrl, config.path || "/v1/tokens/status"),
    joinUrl(baseUrl, "/api/v1/tokens/status"),
  ];
  const headers = buildAuthHeaders(apiKey, config);
  for (const url of candidates) {
    try {
      const resp = await fetchJson(url, { method: config.method || "GET", headers });
      if (resp.ok) return await parseResponseBody(resp);
    } catch {
      // try next candidate
    }
  }
  throw new Error("minimax-coding-plan: no valid endpoint found");
}

// Kimi Coding Plan 查询
async function queryKimiCodingPlan(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for kimi coding plan");
  const url = joinUrl(baseUrl, config.path || "/api/v1/token/usage");
  const headers = buildAuthHeaders(apiKey, config);
  const resp = await fetchJson(url, { method: config.method || "GET", headers });
  if (!resp.ok) throw new Error(`kimi-coding-plan error: ${resp.status}`);
  return await parseResponseBody(resp);
}

// ZenMux Token Plan 查询
async function queryZenMuxCodingPlan(baseUrl, apiKey, config) {
  if (!baseUrl) throw new Error("missing baseUrl for zenmux coding plan");
  const url = joinUrl(baseUrl, config.path || "/api/plan/quota");
  const headers = buildAuthHeaders(apiKey, config);
  const resp = await fetchJson(url, { method: config.method || "GET", headers });
  if (!resp.ok) throw new Error(`zenmux-coding-plan error: ${resp.status}`);
  return await parseResponseBody(resp);
}

// ── HTTP 工具函数 ────────────────────────────────────────

function canonicalBaseUrl(provider) {
  const url = String(provider?.baseUrl || "").replace(/\/+$/, "");
  return url;
}

function joinUrl(baseUrl, suffix) {
  if (!suffix) return baseUrl;
  // suffix 已是完整 URL 时直接返回
  if (suffix.startsWith("http://") || suffix.startsWith("https://")) return suffix;
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const path = String(suffix || "").replace(/^\/+/, "");
  return path ? `${base}/${path}` : base;
}

function buildAuthHeaders(apiKey, config) {
  const headers = { ...(config.headers || {}) };
  // 自动注入 Authorization
  if (!headers.Authorization && !headers["x-api-key"] && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  headers.Accept = "application/json";
  return headers;
}

async function fetchJson(url, { method = "GET", headers = {}, body } = {}) {
  // 复用项目已有 fetch 实现（浏览器环境的 globalThis.fetch 或 Node 原生 fetch）
  const resp = await globalThis.fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    // 不跟随重定向以避免凭证泄露到不同域名
    redirect: "manual",
  });
  return resp;
}

async function parseResponseBody(resp) {
  const text = await resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// ── 结果标准化 ────────────────────────────────────────────

function normalizeResult(raw, config) {
  // 1. 尝试 extract 自定义函数（高级用法，暂留接口）
  // 2. 使用 extract.path JSON 路径提取
  let extracted = raw;
  if (config.extract && typeof config.extract === "object" && config.extract.path) {
    extracted = jsonPathValue(raw, config.extract.path);
  }

  // 3. 推断 amount / unit
  const amount = extractNumericValue(extracted, raw, config);
  const unit = inferUnit(config, raw, amount);

  // 4. 构建 UsageData
  const data = [createUsageData({
    planName: inferPlanName(config, raw),
    remaining: amount,
    unit,
    raw,
  })];

  const result = createUsageResult({ success: true, data });
  // 附加派生状态
  result.status = deriveBalanceStatus(result);
  return result;
}

function jsonPathValue(obj, path) {
  if (!obj || typeof obj !== "object") return null;
  const parts = String(path).split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return current;
}

function extractNumericValue(extracted, rawFallback, config) {
  // 优先从 extracted 中提取数值
  if (extracted != null) {
    const direct = Number(extracted);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    // 可能是对象（如 { total, used, remaining }）
    if (typeof extracted === "object") {
      if (Number.isFinite(Number(extracted.remaining))) return Number(extracted.remaining);
      if (Number.isFinite(Number(extracted.total))) return Number(extracted.total);
      if (Number.isFinite(Number(extracted.balance))) return Number(extracted.balance);
    }
  }
  // fallback：在 raw 中搜索常见字段
  const candidates = [
    config.extract?.path,
    "data.balance_credits",
    "data.balance",
    "data.credits",
    "total_credits",
    "credits",
    "balance",
  ];
  for (const path of candidates) {
    if (!path) continue;
    const val = jsonPathValue(rawFallback, path);
    if (val != null) {
      const num = Number(val);
      if (Number.isFinite(num) && num >= 0) return num;
    }
  }
  return null;
}

function inferUnit(config, raw, amount) {
  // 显式声明的 unit 优先
  if (config.unit) return config.unit;
  if (config.extract?.unit) return config.extract.unit;
  // 尝试从原始响应中推断
  const rawStr = JSON.stringify(raw || {});
  if (/\$|usd|USD/i.test(rawStr)) return "USD";
  if (/CNY|¥|元|RMB/i.test(rawStr)) return "CNY";
  if (/token|tokenCount/i.test(rawStr)) return "tokens";
  // 无单位信息时按金额默认 USD
  if (amount != null && amount < 1_000_000) return "USD";
  return "tokens";
}

function inferPlanName(config, raw) {
  if (config.planName) return config.planName;
  // 从响应中推断
  const rawObj = typeof raw === "object" ? raw : {};
  return rawObj.plan_name || rawObj.planName || rawObj.organization_name || "默认套餐";
}

function createUsageData({ planName, remaining, unit, raw }) {
  return {
    planName: String(planName || ""),
    remaining: remaining != null ? Number(remaining) : null,
    unit: String(unit || ""),
    raw: raw && typeof raw === "object" ? { ...raw } : null,
  };
}

// ── 预设辅助 ──────────────────────────────────────────────

// providerPresetFor 在 provider-presets.mjs 中导出，但这里做安全检查的本地引用。
function providerPresetForProvider(provider) {
  try {
    // 动态引用以避免循环依赖
    const mod = await import("./provider-presets.mjs");
    return mod.providerPresetFor ? mod.providerPresetFor(provider) : null;
  } catch {
    return null;
  }
}

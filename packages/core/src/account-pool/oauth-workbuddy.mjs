// WorkBuddy 账号 OAuth：端点与请求头按 workbuddy2api 实测协议实现
// （登录/刷新走 /v2/plugin/*；global chat 走 /console 再回退 /v2，cn chat 走 /v2）。
// 双域：global → www.workbuddy.ai（Origin 同域）；cn → copilot.tencent.com（Origin www.codebuddy.cn）。
// 所有网络调用支持注入 fetchImpl，便于单测复用。
import { ProxyAgent } from "undici";

export const WORKBUDDY_BASE_URL = "https://www.workbuddy.ai";
export const WORKBUDDY_GLOBAL_DOMAIN = "www.workbuddy.ai";
// 插件授权流程（登录 state/token/account）使用的 CLI 形态 UA。
export const WORKBUDDY_CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
// 官方桌面端形态（chat / refresh / 资源查询出站必须对齐，否则可能被上游判为非官方客户端 → 403）：
//   UA = `WorkBuddy/<clientVersion> <platform>/<clientVersion> CLI/<cliVersion>`
//   平台段品牌按 realm 切换：global = `WorkBuddy AI`，cn = `WorkBuddy`
export const WORKBUDDY_CLIENT_VERSION = "5.5.4";
export const WORKBUDDY_CLI_VERSION = "2.137.1";
export const WORKBUDDY_STATE_PATH = "/v2/plugin/auth/state?platform=CLI";
export const WORKBUDDY_TOKEN_PATH = "/v2/plugin/auth/token";
export const WORKBUDDY_ACCOUNT_PATH = "/v2/plugin/login/account";
export const WORKBUDDY_REFRESH_PATH = "/v2/plugin/auth/token/refresh";
// 上游路径分叉（global）：/console 与 /v2 两个端点共存，但**内容扫描策略不同**——
// 2026-09-18 实测：同一条未硬化请求（含裸 `curl https://…` / `html.unescape(` /
// `<script>alert(1)` / `%3Cscript` / `&lt;script`），/console 一律 403（WAF 拦截页），
// /v2 一律 200。即 /console 挂了内容 WAF，/v2 没有。
//
// 因此 global 改为 **/v2 优先**：正常请求不再撞内容扫描，也无需出站改写内容
// （见 workbuddy-adapter 的 wafHardening，现降级为按需开关）。/v2 若被上游下线
// （404/405），callOpenAIChat 会自动回退 /console，此时才需要开启 wafHardening。
// cn 只有 /v2，本就无此问题。
export const WORKBUDDY_CHAT_PATHS = ["/v2/chat/completions", "/console/chat/completions"];

/** 双域配置：base / Origin / X-Domain / chat 路径 / 模型目录路径。 */
export const WORKBUDDY_REALMS = {
  global: {
    label: "WorkBuddy（workbuddy.ai）",
    baseUrl: "https://www.workbuddy.ai",
    origin: "https://www.workbuddy.ai",
    domain: "www.workbuddy.ai",
    chatPaths: ["/v2/chat/completions", "/console/chat/completions"],
    modelsPath: "/v2/enterprises/personal/models",
    acceptLanguage: "en-US"
  },
  cn: {
    label: "CodeBuddy（codebuddy.cn）",
    baseUrl: "https://copilot.tencent.com",
    origin: "https://www.codebuddy.cn",
    domain: "www.codebuddy.cn",
    chatPaths: ["/v2/chat/completions"],
    modelsPath: "/console/enterprises/personal/models",
    acceptLanguage: "zh-CN"
  }
};

/** realm 归一化：非法/缺省一律回落 global。 */
export function workBuddyRealmConfig(realm) {
  const key = String(realm || "").trim().toLowerCase();
  return WORKBUDDY_REALMS[key] || WORKBUDDY_REALMS.global;
}

export function workBuddyRealmOf(realm) {
  const key = String(realm || "").trim().toLowerCase();
  return WORKBUDDY_REALMS[key] ? key : "global";
}

const PROXY_AGENTS = new Map();
const refreshInFlight = new Map();

function dispatcher(proxyUrl) {
  if (!proxyUrl) return null;
  const value = String(proxyUrl).trim();
  if (!value) return null;
  if (!PROXY_AGENTS.has(value)) PROXY_AGENTS.set(value, new ProxyAgent(value));
  return PROXY_AGENTS.get(value);
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || WORKBUDDY_BASE_URL).replace(/\/+$/, "")}${suffix}`;
}

/** 官方桌面端 UA：platform 段按 realm 切品牌（global=WorkBuddy AI，cn=WorkBuddy）。 */
export function workBuddyUserAgent(realm = "global") {
  const platform = workBuddyRealmOf(realm) === "cn" ? "WorkBuddy" : "WorkBuddy AI";
  return `WorkBuddy/${WORKBUDDY_CLIENT_VERSION} ${platform}/${WORKBUDDY_CLIENT_VERSION} CLI/${WORKBUDDY_CLI_VERSION}`;
}

/**
 * WorkBuddy 出站请求头。
 * @param {"plugin"|"desktop"} surface plugin = 插件授权流程（登录用 CLI 形态 UA）；
 *        desktop = chat/refresh/资源查询（官方桌面端 UA）。
 */
export function workBuddyHeaders({ accessToken = "", uid = "", realm = "global", domain = "", surface = "plugin", extra = {} } = {}) {
  const realmCfg = workBuddyRealmConfig(realm);
  const host = realmCfg.origin;
  const effectiveDomain = String(domain || realmCfg.domain).trim() || realmCfg.domain;
  const desktop = surface === "desktop";
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": realmCfg.acceptLanguage,
    "X-Requested-With": "XMLHttpRequest",
    Origin: host,
    Referer: `${host}/`,
    "User-Agent": desktop ? workBuddyUserAgent(realm) : WORKBUDDY_CLIENT_UA,
    "X-CodeBuddy-Request": "1",
    "X-No-Enterprise-Id": "1",
    "X-Domain": effectiveDomain,
    ...(uid ? { "X-User-Id": String(uid).trim() } : {}),
    ...(accessToken ? { Authorization: `Bearer ${String(accessToken).trim()}` } : {}),
    ...extra
  };
}

// 上游统一信封 {code,msg,data}；code!==0 视为业务失败。
function unwrapEnvelope(payload, label) {
  const code = Number(payload?.code ?? 0);
  if (Number.isFinite(code) && code !== 0) {
    throw new Error(`${label}: code=${code}${payload?.msg ? ` ${payload.msg}` : ""}`);
  }
  return payload?.data && typeof payload.data === "object" ? payload.data : (payload || {});
}

async function requestJson(url, init = {}, { fetchImpl, proxyUrl = "", label = "workbuddy" } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const next = { ...init, headers: { ...(init.headers || {}) } };
  const agent = dispatcher(proxyUrl);
  if (agent) next.dispatcher = agent;
  const response = await doFetch(url, next);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${String(text).slice(0, 300)}`);
  }
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = {}; }
  return unwrapEnvelope(payload, label);
}

function expiresAtIso(data, fallbackSeconds = 3600) {
  const seconds = Number(data?.expiresIn ?? data?.expires_in ?? fallbackSeconds);
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : fallbackSeconds;
  return new Date(Date.now() + safe * 1000).toISOString();
}

function normalizedTokens(data, previousRefreshToken = "", realm = "global") {
  const accessToken = String(data?.accessToken || data?.access_token || "").trim();
  if (!accessToken) throw new Error("workbuddy oauth: missing accessToken");
  const realmCfg = workBuddyRealmConfig(realm);
  return {
    accessToken,
    refreshToken: String(data?.refreshToken || data?.refresh_token || previousRefreshToken || "").trim(),
    idToken: String(data?.idToken || data?.id_token || "").trim(),
    tokenType: String(data?.tokenType || data?.token_type || "Bearer").trim() || "Bearer",
    domain: String(data?.domain || realmCfg.domain).trim() || realmCfg.domain,
    realm: workBuddyRealmOf(realm),
    expiresAt: expiresAtIso(data)
  };
}

/** 1) 取授权 URL（POST /v2/plugin/auth/state?platform=CLI，无 PKCE，state 由服务端签发）。 */
export async function createWorkBuddyAuthState({ realm = "global", baseUrl = "", proxyUrl = "", fetchImpl } = {}) {
  const realmCfg = workBuddyRealmConfig(realm);
  const data = await requestJson(joinUrl(baseUrl || realmCfg.baseUrl, WORKBUDDY_STATE_PATH), {
    method: "POST",
    headers: workBuddyHeaders({ realm }),
    body: "{}"
  }, { fetchImpl, proxyUrl, label: "workbuddy auth state" });
  const state = String(data?.state || "").trim();
  const authUrl = String(data?.authUrl || data?.auth_url || "").trim();
  if (!state || !authUrl) throw new Error("workbuddy auth state: missing state or authUrl");
  return { state, authUrl, realm: workBuddyRealmOf(realm) };
}

/** 2) 轮询登录结果（GET /v2/plugin/auth/token?state=）。未完成时上游 code!=0 → 抛错。 */
export async function pollWorkBuddyAuthToken(state, { realm = "global", baseUrl = "", proxyUrl = "", fetchImpl } = {}) {
  const key = String(state || "").trim();
  if (!key) throw new Error("workbuddy poll: state is required");
  const realmCfg = workBuddyRealmConfig(realm);
  const data = await requestJson(`${joinUrl(baseUrl || realmCfg.baseUrl, WORKBUDDY_TOKEN_PATH)}?state=${encodeURIComponent(key)}`, {
    method: "GET",
    headers: workBuddyHeaders({ realm })
  }, { fetchImpl, proxyUrl, label: "workbuddy login poll" });
  return normalizedTokens(data, "", realm);
}

/** 3) 取账号信息（GET /v2/plugin/login/account?state=，带 Bearer）。 */
export async function fetchWorkBuddyAccount({ state, accessToken, realm = "global", baseUrl = "", proxyUrl = "", fetchImpl } = {}) {
  const key = String(state || "").trim();
  if (!key) throw new Error("workbuddy account: state is required");
  const realmCfg = workBuddyRealmConfig(realm);
  const data = await requestJson(`${joinUrl(baseUrl || realmCfg.baseUrl, WORKBUDDY_ACCOUNT_PATH)}?state=${encodeURIComponent(key)}`, {
    method: "GET",
    headers: workBuddyHeaders({ accessToken, realm })
  }, { fetchImpl, proxyUrl, label: "workbuddy account" });
  return {
    uid: String(data?.uid || "").trim(),
    enterpriseId: String(data?.enterpriseId || data?.enterprise_id || "").trim(),
    nickname: String(data?.nickname || data?.name || "").trim()
  };
}

/** 登录轮询一步到位：token + 账号信息（account 失败不阻断 token 落盘）。 */
export async function pollWorkBuddyLogin(state, opts = {}) {
  const realm = workBuddyRealmOf(opts?.realm);
  const tokens = await pollWorkBuddyAuthToken(state, { ...opts, realm });
  let account = { uid: "", enterpriseId: "", nickname: "" };
  try {
    account = await fetchWorkBuddyAccount({ state, accessToken: tokens.accessToken, ...opts, realm });
  } catch {
    // 账号信息仅用于展示与刷新头；取不到时仍以 token 为准。
  }
  return { ...tokens, ...account, realm };
}

/** 刷新 access token（POST /v2/plugin/auth/token/refresh + X-Refresh-Token 头）。 */
export async function refreshWorkBuddyTokens(refreshToken, {
  uid = "",
  realm = "global",
  domain = "",
  baseUrl = "",
  proxyUrl = "",
  fetchImpl
} = {}) {
  const rt = String(refreshToken || "").trim();
  if (!rt) throw new Error("workbuddy token refresh: refreshToken is required");
  const realmKey = workBuddyRealmOf(realm);
  const realmCfg = workBuddyRealmConfig(realmKey);
  const base = baseUrl || realmCfg.baseUrl;
  const key = `${base}::${rt}`;
  if (refreshInFlight.has(key)) return refreshInFlight.get(key);
  const task = (async () => {
    const data = await requestJson(joinUrl(base, WORKBUDDY_REFRESH_PATH), {
      method: "POST",
      headers: workBuddyHeaders({
        uid,
        realm: realmKey,
        domain,
        surface: "desktop",
        extra: { "X-Refresh-Token": rt, "X-Auth-Refresh-Source": "plugin" }
      }),
      body: "{}"
    }, { fetchImpl, proxyUrl, label: "workbuddy token refresh" });
    return normalizedTokens(data, rt, realmKey);
  })();
  refreshInFlight.set(key, task);
  try {
    return await task;
  } finally {
    refreshInFlight.delete(key);
  }
}

export const refreshWorkBuddyAccountTokens = refreshWorkBuddyTokens;
export const getWorkBuddyAccount = fetchWorkBuddyAccount;

// ─── 积分余额（billing 域，对齐 workbuddy2api internal/upstream/client.go UserResource）───
export const WORKBUDDY_BILLING_BASE = {
  global: "https://www.workbuddy.ai",
  cn: "https://www.codebuddy.cn"
};
// global 首选无 /v2 前缀（国际版实测），404 时回退 /v2；cn 只有 /v2。
export const WORKBUDDY_RESOURCE_PATHS = {
  global: ["/billing/meter/get-user-resource", "/v2/billing/meter/get-user-resource"],
  cn: ["/v2/billing/meter/get-user-resource"]
};
const RESOURCE_PAGE_SIZE = 100;
const PACKAGE_END_LAYOUT = { pad: 2 };

// 上游套餐到期时间是 UTC+8 墙钟（与官网展示同口径）。
function formatPackageEndTime(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const p = PACKAGE_END_LAYOUT.pad;
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(p, "0");
  const d = String(shifted.getUTCDate()).padStart(p, "0");
  const h = String(shifted.getUTCHours()).padStart(p, "0");
  const mi = String(shifted.getUTCMinutes()).padStart(p, "0");
  const s = String(shifted.getUTCSeconds()).padStart(p, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function packageRemainUsed(entry) {
  const cycleSize = Number(entry?.CycleCapacitySize || 0);
  const cycleRemain = Number(entry?.CycleCapacityRemain || 0);
  const cycleUsed = Number(entry?.CycleCapacityUsed || 0);
  const size = Number(entry?.CapacitySize || 0);
  const remain = Number(entry?.CapacityRemain || 0);
  const used = Number(entry?.CapacityUsed || 0);
  if (cycleSize > 0) {
    const clamped = Math.max(0, Math.min(cycleSize, cycleRemain));
    return { remain: clamped, used: Math.max(cycleUsed, cycleSize - clamped), size: cycleSize };
  }
  const clamped = Math.max(0, remain);
  return { remain: clamped, used: Math.max(used, size - clamped, 0), size: Math.max(size, clamped) };
}

/** 查询账号积分（remain/used/size/packs），realm 决定 billing base 与路径候选。 */
export async function fetchWorkBuddyUserResource({
  accessToken,
  uid = "",
  realm = "global",
  domain = "",
  enterpriseId = "",
  proxyUrl = "",
  fetchImpl
} = {}) {
  const token = String(accessToken || "").trim();
  if (!token) throw new Error("workbuddy resource: accessToken is required");
  const realmKey = workBuddyRealmOf(realm);
  const realmCfg = workBuddyRealmConfig(realmKey);
  const base = WORKBUDDY_BILLING_BASE[realmKey] || WORKBUDDY_BILLING_BASE.global;
  const now = new Date();
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: RESOURCE_PAGE_SIZE,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: formatPackageEndTime(now),
    PackageEndTimeRangeEnd: formatPackageEndTime(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000))
  });
  const headers = workBuddyHeaders({
    accessToken: token,
    uid,
    realm: realmKey,
    domain,
    surface: "desktop",
    extra: {
      Accept: "application/json",
      ...(enterpriseId ? { "X-Enterprise-Id": String(enterpriseId).trim(), "X-Tenant-Id": String(enterpriseId).trim() } : {})
    }
  });
  const paths = WORKBUDDY_RESOURCE_PATHS[realmKey] || WORKBUDDY_RESOURCE_PATHS.global;
  let lastError = null;
  for (const path of paths) {
    try {
      const { payload } = await requestJsonRaw(joinUrl(base, path), { method: "POST", headers, body }, { fetchImpl, proxyUrl, label: "workbuddy resource" });
      // 响应为 {code,msg,data:{Response:{Data:{Accounts}}}}：先过信封再取 Response 层。
      const code = Number(payload?.code ?? 0);
      if (Number.isFinite(code) && code !== 0) {
        throw new Error(`workbuddy resource: code=${code}${payload?.msg ? ` ${payload.msg}` : ""}`);
      }
      const envelope = payload?.data && typeof payload.data === "object" ? payload.data : payload;
      const accounts = envelope?.Response?.Data?.Accounts;
      if (!Array.isArray(accounts)) throw new Error("workbuddy resource: unexpected payload");
      let remain = 0;
      let used = 0;
      let size = 0;
      let packs = 0;
      for (const entry of accounts) {
        const agg = packageRemainUsed(entry);
        if (agg.size <= 0 && agg.remain <= 0 && agg.used <= 0) continue;
        remain += agg.remain;
        used += agg.used;
        size += agg.size;
        packs += 1;
      }
      return { remain, used, size, packs, path, realm: realmKey };
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      // 仅 404/405 视为路径分叉，继续尝试下一个候选；其余错误直接抛出。
      if (!/40[45]/.test(message)) throw err;
    }
  }
  throw lastError || new Error("workbuddy resource: no candidate path succeeded");
}

// billing 域返回的是嵌套 {Response:{Data}} 结构，不走 {code,msg,data} 信封。
async function requestJsonRaw(url, init = {}, { fetchImpl, proxyUrl = "", label = "workbuddy" } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const next = { ...init, headers: { ...(init.headers || {}) } };
  const agent = dispatcher(proxyUrl);
  if (agent) next.dispatcher = agent;
  const response = await doFetch(url, next);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${String(text).slice(0, 300)}`);
  }
  let payload = {};
  try { payload = JSON.parse(text); } catch { payload = {}; }
  return { payload, status: response.status };
}

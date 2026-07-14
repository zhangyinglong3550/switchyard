// Grok web SSO cookie JWT → 官方 xAI OAuth（OIDC Device Flow）
// 对齐 GrokGo src-tauri/src/sso_convert.rs，纯 Node fetch，不依赖浏览器。
import { ProxyAgent } from "undici";
import { XAI_OAUTH_CLIENT_ID } from "./oauth-xai.mjs";

const OIDC_ISSUER = "https://auth.x.ai";
const SCOPES =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
const ACCOUNTS_HOME = "https://accounts.x.ai/";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/**
 * 将 SSO cookie / 卡密行中的 JWT 转成 OAuth access/refresh。
 * @param {string} ssoCookie
 * @param {{ emailHint?: string, proxyUrl?: string, fetchImpl?: Function, clientId?: string, maxRetries?: number }} [opts]
 */
export async function convertSsoCookie(ssoCookie, opts = {}) {
  const sso = normalizeSso(ssoCookie);
  if (!sso) throw new Error("empty sso cookie");
  if (!looksLikeJwt(sso)) throw new Error("sso cookie does not look like a JWT");

  const clientId = String(opts.clientId || XAI_OAUTH_CLIENT_ID).trim();
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 6;
  // 默认走常见本机代理（与 Grok 供应商配置一致），国内直连 accounts.x.ai 易 403
  const proxyUrl = String(
    opts.proxyUrl ||
    process.env.SWITCHYARD_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    "http://127.0.0.1:7890"
  ).trim();
  const session = createSsoSession(sso, { ...opts, proxyUrl });

  try {
    await validateSsoSession(session);
  } catch (err) {
    // 探测失败时附带更可读的中文提示
    const msg = err?.message || String(err);
    if (/sso invalid/i.test(msg)) {
      throw new Error(`${msg}（SSO 可能已失效，请向卡商要新的 SSO / 重新导出）`);
    }
    if (/rate_limited/i.test(msg)) {
      throw new Error(`${msg}（请求过快被限流，请隔 1～2 分钟再试）`);
    }
    throw new Error(`${msg}（可检查代理 ${proxyUrl || "未设置"} 是否可用）`);
  }

  let lastError = "device flow failed";
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const token = await deviceFlowOnce(session, clientId);
      let email = String(opts.emailHint || "").trim() || "";
      if (!email) email = (await fetchUserinfoEmail(session, token.accessToken)) || "";
      return {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken || "",
        expiresIn: token.expiresIn || 21600,
        expiresAt: new Date(Date.now() + (token.expiresIn || 21600) * 1000).toISOString(),
        tokenType: token.tokenType || "Bearer",
        email,
        ssoToken: sso
      };
    } catch (err) {
      lastError = err?.message || String(err);
      const retryable = isRateLimitedMsg(lastError) || isTransient(lastError);
      if (retryable && attempt < maxRetries) {
        const delay = backoffMs(isRateLimitedMsg(lastError) ? 15_000 : 8_000, attempt, isRateLimitedMsg(lastError) ? 180_000 : 60_000);
        await sleep(delay);
        continue;
      }
      throw new Error(lastError);
    }
  }
  throw new Error(lastError);
}

function createSsoSession(sso, opts = {}) {
  const cookie = `sso=${sso}`;
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const proxyUrl = String(opts.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "").trim();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : null;

  async function request(url, init = {}) {
    const headers = {
      "User-Agent": BROWSER_UA,
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: cookie,
      ...(init.headers || {})
    };
    const finalInit = {
      ...init,
      headers,
      redirect: init.redirect || "follow"
    };
    if (dispatcher) finalInit.dispatcher = dispatcher;
    return doFetch(url, finalInit);
  }

  return { request, sso };
}

/**
 * 探测 SSO 是否仍有效。
 * 注意：accounts.x.ai 首页常被 Cloudflare 对非浏览器直接 403，
 * 不能把首页 403 当成 SSO 失效；优先看是否跳到登录页，或 device 页是否可用。
 */
async function validateSsoSession(session) {
  // 1) 首页探测：仅当明确跳登录页时判失败；403/CF 拦截则跳过
  try {
    const resp = await session.request(ACCOUNTS_HOME, {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        Referer: "https://accounts.x.ai/"
      }
    });
    const finalUrl = String(resp.url || ACCOUNTS_HOME);
    const lower = finalUrl.toLowerCase();
    if (lower.includes("sign-in") || lower.includes("sign-up") || /\/login(?:\?|$)/.test(lower)) {
      throw new Error(`sso invalid (redirected to login): ${finalUrl}`);
    }
    if (isRateLimitedUrl(finalUrl)) {
      throw new Error(`rate_limited on accounts.x.ai: ${finalUrl}`);
    }
    // 2xx/3xx：认为会话可能有效
    if (resp.status >= 200 && resp.status < 400) return;
    // 403：常见是 CF/WAF 拦首页，不据此失败
    if (resp.status === 403) {
      // fall through to device page probe
    } else if (resp.status !== 404) {
      // 其它 4xx/5xx 也先尝试 device 页，避免误杀
    }
  } catch (err) {
    if (/sso invalid|rate_limited/i.test(err?.message || "")) throw err;
    // 网络错误时继续试 device 页
  }

  // 2) device 页探测（比首页更贴近后续 Device Flow）
  const deviceHome = `${ACCOUNTS_HOME.replace(/\/$/, "")}/oauth2/device`;
  const deviceResp = await session.request(deviceHome, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: "https://accounts.x.ai/"
    }
  });
  const deviceUrl = String(deviceResp.url || deviceHome);
  const deviceBody = await deviceResp.text().catch(() => "");
  const deviceLower = deviceUrl.toLowerCase();
  if (deviceLower.includes("sign-in") || deviceLower.includes("sign-up") || /\/login(?:\?|$)/.test(deviceLower)) {
    throw new Error(`sso invalid (device page redirected to login): ${deviceUrl}`);
  }
  if (isRateLimitedUrl(deviceUrl) || isRateLimitedBody(deviceBody)) {
    throw new Error(`rate_limited on accounts.x.ai device page: ${deviceUrl}`);
  }
  // device 页 200/3xx 即可；403 也可能是 CF，不阻断（后续 device/code 在 auth.x.ai 通常仍可用）
  if (deviceResp.status === 401) {
    throw new Error(`sso invalid (device page 401): ${deviceUrl}`);
  }
}

async function deviceFlowOnce(session, clientId) {
  const dc = await requestDeviceCode(session, clientId);

  const ver = await session.request(dc.verificationUriComplete, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: "https://accounts.x.ai/"
    }
  });
  const verUrl = String(ver.url || "");
  await ver.text().catch(() => "");
  if (isRateLimitedUrl(verUrl)) {
    throw new Error(`rate_limited on verification_uri: ${verUrl}`);
  }

  const verifyBody = new URLSearchParams({ user_code: dc.userCode });
  const verifyResp = await session.request(`${OIDC_ISSUER}/oauth2/device/verify`, {
    method: "POST",
    headers: formHeaders(),
    body: verifyBody.toString()
  });
  const verifyFinal = String(verifyResp.url || "");
  const verifyText = await verifyResp.text().catch(() => "");
  if (isRateLimitedUrl(verifyFinal) || isRateLimitedBody(verifyText)) {
    throw new Error(`rate_limited on device/verify: ${verifyFinal}`);
  }
  if (!verifyFinal.includes("consent") && !verifyText.toLowerCase().includes("consent")) {
    // 某些版本直接跳到 consent 相关页；若 status 正常且未登录页，继续尝试 approve
    if (verifyFinal.toLowerCase().includes("login") || verifyFinal.toLowerCase().includes("sign-in")) {
      throw new Error(`device/verify failed (login): url=${verifyFinal} body=${truncate(verifyText, 200)}`);
    }
  }

  const approveBody = new URLSearchParams({
    user_code: dc.userCode,
    action: "allow",
    principal_type: "User",
    principal_id: ""
  });
  const approveResp = await session.request(`${OIDC_ISSUER}/oauth2/device/approve`, {
    method: "POST",
    headers: formHeaders(),
    body: approveBody.toString()
  });
  const approveFinal = String(approveResp.url || "");
  const approveText = await approveResp.text().catch(() => "");
  if (isRateLimitedUrl(approveFinal) || isRateLimitedBody(approveText)) {
    throw new Error(`rate_limited on device/approve: ${approveFinal}`);
  }
  if (!approveFinal.includes("done") && !approveText.toLowerCase().includes("done")) {
    // 继续 poll：部分部署 approve 成功但不改 URL
  }

  return pollToken(session, clientId, dc.deviceCode, dc.interval, dc.expiresIn, 90);
}

async function requestDeviceCode(session, clientId) {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: SCOPES
  });
  const resp = await session.request(`${OIDC_ISSUER}/oauth2/device/code`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString()
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`device/code HTTP ${resp.status}: ${truncate(text, 240)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`device/code JSON parse failed: ${truncate(text, 200)}`);
  }
  if (!payload.device_code || !payload.user_code || !payload.verification_uri_complete) {
    throw new Error(`device/code missing fields: ${truncate(text, 200)}`);
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUriComplete: payload.verification_uri_complete,
    interval: Number(payload.interval) || 5,
    expiresIn: Number(payload.expires_in) || 1800
  };
}

async function pollToken(session, clientId, deviceCode, intervalSec, expiresIn, timeoutSecs) {
  const deadline = Date.now() + Math.min(timeoutSecs, expiresIn) * 1000;
  let interval = Math.max(1, intervalSec || 5);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: deviceCode
    });
    const resp = await session.request(`${OIDC_ISSUER}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString()
    });
    const text = await resp.text();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
    const err = parsed.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err) throw new Error(`token error: ${err} (${truncate(text, 200)})`);
    if (resp.ok && parsed.access_token) {
      return {
        accessToken: String(parsed.access_token).trim(),
        refreshToken: String(parsed.refresh_token || "").trim(),
        expiresIn: Number(parsed.expires_in) || 21600,
        tokenType: String(parsed.token_type || "Bearer").trim() || "Bearer"
      };
    }
    if (!resp.ok) throw new Error(`token HTTP ${resp.status}: ${truncate(text, 240)}`);
  }
  throw new Error("token poll timed out");
}

async function fetchUserinfoEmail(session, accessToken) {
  try {
    const resp = await session.request(`${OIDC_ISSUER}/oauth2/userinfo`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
    if (!resp.ok) return "";
    const payload = await resp.json();
    return String(payload?.email || "").trim();
  } catch {
    return "";
  }
}

function formHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Origin: "https://auth.x.ai",
    Referer: "https://auth.x.ai/"
  };
}

export function normalizeSso(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^sso=/i, "").trim();
  return t.replace(/^["'`]+|["'`]+$/g, "");
}

export function isWebSsoJwt(token) {
  const t = normalizeSso(token);
  if (!looksLikeJwt(t)) return false;
  try {
    const payload = decodeJwtPayload(t);
    if (payload?.session_id) return true;
    // 卡商常见 session JWT
    if (payload?.sid || payload?.sessionId) return true;
    return false;
  } catch {
    return false;
  }
}

export function looksLikeJwt(token) {
  const t = String(token || "").trim();
  if (!t.startsWith("eyJ")) return false;
  return t.split(".").length === 3 && t.length >= 40;
}

function decodeJwtPayload(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function isRateLimitedMsg(msg) {
  return isRateLimitedBody(msg) || isRateLimitedUrl(msg);
}

function isRateLimitedUrl(url) {
  const b = String(url || "").toLowerCase();
  return b.includes("rate_limited") || b.includes("rate-limited") || b.includes("too_many_requests") || b.includes("ratelimit");
}

function isRateLimitedBody(body) {
  const b = String(body || "").toLowerCase();
  return b.includes("rate_limited") || b.includes("rate-limited") || b.includes("too_many_requests") || b.includes("ratelimit");
}

function isTransient(msg) {
  const b = String(msg || "").toLowerCase();
  return b.includes("timeout") || b.includes("timed out") || b.includes("connection") || b.includes("reset") || b.includes("temporarily") || b.includes("fetch failed");
}

function backoffMs(base, attempt, cap) {
  const shift = Math.min(Math.max(attempt - 1, 0), 4);
  const d = Math.min(base * 2 ** shift, cap);
  return d + Math.floor(Math.random() * 5000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s, max) {
  const t = String(s || "").replace(/\n/g, " ");
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/**
 * 批量转换：每条之间加间隔，避免 xAI 限流。
 */
export async function convertSsoCookiesBatch(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const gapMs = Number.isFinite(opts.gapMs) ? opts.gapMs : 2500;
  const out = { ok: 0, failed: 0, results: [], errors: [] };
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {};
    const sso = item.ssoToken || item.sso || item.token || item;
    const emailHint = item.email || item.emailHint || "";
    try {
      const converted = await convertSsoCookie(typeof sso === "string" ? sso : "", {
        ...opts,
        emailHint
      });
      out.ok += 1;
      out.results.push({ index: i, ok: true, ...converted });
    } catch (err) {
      out.failed += 1;
      out.errors.push({ index: i, ok: false, error: err?.message || String(err), email: emailHint });
      out.results.push({ index: i, ok: false, error: err?.message || String(err), email: emailHint });
    }
    if (i < list.length - 1 && gapMs > 0) await sleep(gapMs);
  }
  return out;
}

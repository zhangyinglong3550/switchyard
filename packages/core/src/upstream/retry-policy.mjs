// 上游调用可恢复失败重试策略（模型 / 供应商可配）
// 默认：最多 3 次，仅 0/429/5xx，指数阶梯退避；流式仅在未成功建立可读流前重试。

export const DEFAULT_RETRY_STATUSES = [0, 429, 500, 502, 503, 504];
export const DEFAULT_RETRY_BACKOFF_MS = [500, 1500, 3000];
export const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
export const DEFAULT_RETRY_AFTER_MAX_MS = 60_000;

function asInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function asStatusList(value, fallback) {
  if (!Array.isArray(value) || !value.length) return [...fallback];
  return value.map((item) => asInt(item, NaN)).filter((n) => Number.isFinite(n));
}

function asBackoffList(value, fallback) {
  if (!Array.isArray(value) || !value.length) return [...fallback];
  return value.map((item) => Math.max(0, asInt(item, 0)));
}

/**
 * 解析重试策略：模型.retry 覆盖供应商.retry，再叠默认。
 * - enabled: false 或 maxAttempts <= 1 → 不重试
 * - enabled 缺省 true（使用默认 maxAttempts=3）
 */
export function resolveRetryPolicy(provider = null, model = null, opts = {}) {
  const fromOpts = opts?.retry && typeof opts.retry === "object" ? opts.retry : null;
  const fromModel = model?.retry && typeof model.retry === "object" ? model.retry : null;
  const fromProvider = provider?.retry && typeof provider.retry === "object" ? provider.retry : null;
  const raw = { ...(fromProvider || {}), ...(fromModel || {}), ...(fromOpts || {}) };

  if (raw.enabled === false) {
    return {
      enabled: false,
      maxAttempts: 1,
      onStatus: new Set(DEFAULT_RETRY_STATUSES),
      backoffMs: [...DEFAULT_RETRY_BACKOFF_MS],
      retryStream: true,
      maxRetryAfterMs: DEFAULT_RETRY_AFTER_MAX_MS
    };
  }

  let maxAttempts = asInt(raw.maxAttempts, DEFAULT_RETRY_MAX_ATTEMPTS);
  if (maxAttempts < 1) maxAttempts = 1;
  if (maxAttempts > 10) maxAttempts = 10; // 硬顶，防止配置爆炸

  return {
    enabled: maxAttempts > 1,
    maxAttempts,
    onStatus: new Set(asStatusList(raw.onStatus, DEFAULT_RETRY_STATUSES)),
    backoffMs: asBackoffList(raw.backoffMs, DEFAULT_RETRY_BACKOFF_MS),
    retryStream: raw.retryStream !== false,
    maxRetryAfterMs: Math.max(0, asInt(raw.maxRetryAfterMs, DEFAULT_RETRY_AFTER_MAX_MS))
  };
}

export function isRetryableStatus(status, policy) {
  const code = Number(status);
  const normalized = Number.isFinite(code) ? code : 0;
  return policy?.onStatus?.has(normalized) === true;
}

/**
 * 判断 dispatch 结果是否值得再试（同模型/同策略）。
 * - error + 可恢复 status
 * - stream 且 upstream 未 ok（尚未向客户端写出）
 */
export function shouldRetryDispatchResult(result, policy) {
  if (!policy?.enabled || !result) return false;
  if (result.kind === "error") {
    return isRetryableStatus(result.status, policy);
  }
  if (result.kind === "stream" && policy.retryStream) {
    const upstream = result.upstream;
    if (!upstream) return true;
    if (upstream.ok === false) {
      return isRetryableStatus(upstream.status, policy);
    }
    // 已拿到可 pipe 的成功流：不再整请求重试（避免重复输出）
    return false;
  }
  return false;
}

export function backoffForAttempt(policy, attemptIndexZeroBased) {
  const list = policy?.backoffMs?.length ? policy.backoffMs : DEFAULT_RETRY_BACKOFF_MS;
  const idx = Math.min(Math.max(0, attemptIndexZeroBased), list.length - 1);
  return Math.max(0, Number(list[idx]) || 0);
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "").trim();
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return String(value || "").trim();
  }
  return "";
}

function resultHeaders(result) {
  return result?.headers || result?.upstream?.headers || null;
}

export function retryAfterMs(headers, { now = Date.now(), maxMs = DEFAULT_RETRY_AFTER_MAX_MS } = {}) {
  const value = headerValue(headers, "retry-after");
  if (!value) return 0;
  let milliseconds = 0;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    milliseconds = Math.ceil(Number(value) * 1000);
  } else {
    const at = Date.parse(value);
    if (Number.isFinite(at)) milliseconds = Math.max(0, at - now);
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 0;
  return Math.min(milliseconds, Math.max(0, Number(maxMs) || 0));
}

export function retryDelayForResult(result, policy, attemptIndexZeroBased, now = Date.now()) {
  const localBackoff = backoffForAttempt(policy, attemptIndexZeroBased);
  const upstreamBackoff = retryAfterMs(resultHeaders(result), {
    now,
    maxMs: policy?.maxRetryAfterMs ?? DEFAULT_RETRY_AFTER_MAX_MS
  });
  return Math.max(localBackoff, upstreamBackoff);
}

export function sleep(ms, { signal } = {}) {
  const wait = Math.max(0, Number(ms) || 0);
  if (wait <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, wait);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

async function cancelUpstreamBody(result) {
  try {
    const body = result?.upstream?.body;
    if (body && typeof body.cancel === "function") await body.cancel();
  } catch {
    // ignore
  }
}

/**
 * 对 runner 结果做策略重试。runner(attempt) 返回 dispatch 结果。
 * 抛出的网络/运行时错误按 status=0 视为可恢复（若策略允许）。
 */
export async function withDispatchRetry(provider, model, opts, runner) {
  const policy = resolveRetryPolicy(provider, model, opts);
  if (!policy.enabled) {
    try {
      const result = await runner(1);
      return attachRetryMeta(result, [{ attempt: 1, kind: result?.kind, status: resultStatus(result) }], policy);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      const result = errorFromThrow(err);
      return attachRetryMeta(result, [{ attempt: 1, kind: "error", status: 0, error: result.payload?.error }], policy);
    }
  }

  let last = null;
  const attempts = [];
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      last = await runner(attempt);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      last = errorFromThrow(err);
    }
    const status = resultStatus(last);
    attempts.push({
      attempt,
      kind: last?.kind || "unknown",
      status,
      accountId: last?.accountId || "",
      error: last?.kind === "error" ? String(last.payload?.error?.message || last.payload?.error || "").slice(0, 200) : undefined
    });

    const retry = shouldRetryDispatchResult(last, policy) && attempt < policy.maxAttempts;
    if (!retry) break;

    // 失败流要释放 body，再退避重试
    if (last?.kind === "stream") await cancelUpstreamBody(last);
    const waitMs = retryDelayForResult(last, policy, attempt - 1);
    attempts[attempts.length - 1].waitMs = waitMs;
    await sleep(waitMs, { signal: opts?.signal });
  }
  return attachRetryMeta(last, attempts, policy);
}

function errorFromThrow(err) {
  const message = err?.message || String(err);
  return {
    kind: "error",
    status: 0,
    payload: { error: message }
  };
}

function resultStatus(result) {
  if (!result) return 0;
  if (result.kind === "error") return Number(result.status) || 0;
  if (result.kind === "stream") return Number(result.upstream?.status) || (result.upstream?.ok ? 200 : 0);
  if (result.kind === "json") return Number(result.status) || 200;
  return 0;
}

function attachRetryMeta(result, attempts, policy) {
  if (!result || typeof result !== "object") return result;
  const retryCount = Math.max(0, (attempts?.length || 1) - 1);
  return {
    ...result,
    retryCount,
    retryAttempts: attempts || [],
    retryPolicy: {
      maxAttempts: policy.maxAttempts,
      enabled: policy.enabled
    }
  };
}

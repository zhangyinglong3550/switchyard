// dispatch.mjs — protocol-agnostic upstream dispatcher.
//
// Inputs:
//   - provider: full provider record (carries .apiFormat)
//   - upstreamModel: model name for the upstream call
//   - chatBody: a chat-completions-shaped body (the canonical internal format)
//   - opts: { stream, signal, fetchImpl }
//
// Output: a chat-completions-shaped non-stream payload (for non-stream requests)
//         or the raw upstream Response object (for stream requests).
//
// Why chat-completions as the canonical internal format:
//   It is the most widely used wire format among third-party providers, has the
//   richest tool-calling surface, and both Responses and Anthropic Messages map
//   cleanly into and out of it. Client adapters convert this canonical chat
//   payload back to the client-facing protocol.
import { callOpenAIChat, callOpenAIResponses, callAnthropicMessages, callAntigravity, isCodexOAuthProvider, isWorkBuddyOAuthProvider, readJsonResponse } from "./clients.mjs";
import { prepareWorkBuddyChatBody, hardenWorkBuddyChatBody, aggregateChatSseToChatResponse } from "./workbuddy-adapter.mjs";
import { reasoningCache, resolveReasoningCacheKey } from "../reasoning-cache.mjs";
import { chatToResponses, normalizeChatgptCodexResponsesBody, responsesToChatResponse, responsesStreamToChatResponse } from "../openai-adapter-out.mjs";
import { contentToText, safeJsonParse } from "../utils.mjs";
import { chatToAnthropicMessages, anthropicMessagesToChatResponse } from "../anthropic-adapter-out.mjs";
import {
  antigravityPayloadToChatResponse,
  antigravitySessionKey,
  antigravityStreamToChatResponse,
  buildAntigravityEnvelope,
  clearAntigravityReplay
} from "../antigravity-adapter.mjs";
import { applyOutbound, applyInbound } from "../compat/index.mjs";
import { captureRequestBody } from "../request-body-capture.mjs";
import { rectifyUpstreamRequest } from "../compat/runtime-rectifier.mjs";
import { transformOpenCodeTextToolCalls } from "../opencode-text-tool-calls.mjs";
import {
  bindProviderToAccount,
  bindAccountAffinity,
  clearAccountAffinity,
  currentEligibleAccount,
  isAccountPoolProvider,
  markAccountFailure,
  markAccountSuccess,
  ensureFreshAccount,
  pickAndRefreshAccount
} from "../account-pool/index.mjs";
import { retryAfterMs, withDispatchRetry } from "./retry-policy.mjs";

const ACCOUNT_POOL_FAILOVER_STATUSES = new Set([401, 403, 429, 500, 502, 503, 504]);
const ACCOUNT_POOL_MAX_ATTEMPTS = 3;

function normalizeChatPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.choices)) return payload;
  const choices = payload.choices.map((choice) => {
    if (!choice || typeof choice !== "object") return choice;
    const message = choice.message;
    if (!message || typeof message !== "object") return choice;
    const content = message.content;
    const normalizedContent = typeof content === "string"
      ? content
      : (content && typeof content === "object" && typeof content.output_text === "string")
        ? content.output_text
        : contentToText(content);
    if (normalizedContent === content) return choice;
    return { ...choice, message: { ...message, content: normalizedContent } };
  });
  return { ...payload, choices };
}

function withAccountMeta(result, account) {
  if (!result || !account) return result;
  return {
    ...result,
    accountId: account.id,
    accountEmail: account.email || ""
  };
}

function shouldFailoverStatus(status) {
  return ACCOUNT_POOL_FAILOVER_STATUSES.has(Number(status) || 0);
}

function isWorkBuddyPolicyBlock(provider, result) {
  return isWorkBuddyOAuthProvider(provider) && result?.kind === "error" && result.status === 403
    && result.payload?.error?.code === "upstream_policy_blocked";
}

// 只有真正的成功（2xx JSON / ok 流）才能记为账号健康。非换号失败（402/404 等）
// 也不得记成功：换号循环会直接返回错误，任何到达这里的错误结果都代表上游拒绝。
function isHealthyResult(provider, result) {
  if (isWorkBuddyPolicyBlock(provider, result)) return false;
  if (result?.kind === "stream") return Boolean(result.upstream?.ok);
  return result?.kind === "json" && result.status >= 200 && result.status < 300;
}

// 只读取显式会话标识，不以文本或内容哈希推断会话。
function workbuddySessionKey(body, opts, model) {
  const id = opts?.sessionKey || body?.session_id || body?.sessionId || body?.metadata?.session_id;
  return typeof id === "string" && id.trim() ? JSON.stringify([opts?.clientId || "", model, id.trim()]) : "";
}

function workbuddyCooldown(result) {
  if (result.status !== 429) return {};
  const payload = result.payload;
  const modelOnly = Number(payload?.error?.code ?? payload?.code) === 6004;
  const message = String(payload?.error?.message || payload?.message || payload?.msg || "");
  const now = Date.now();
  const milliseconds = retryAfterMs(result.headers, { now, maxMs: Number.MAX_SAFE_INTEGER });
  let cooldownDeadline = milliseconds > 0 ? now + milliseconds : 0;
  // 6004 已知协议墙钟为 UTC+8；只匹配明确时区或“将在 … 重置”，不猜测通用时间戳。
  const match = modelOnly && (
    /(?:reset|重置|恢复)[^\d]*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*UTC\+8/i.exec(message)
    || /将在\s*(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\s*重置/.exec(message)
  );
  if (match) {
    const at = Date.parse(`${match[1]}T${match[2]}+08:00`);
    // 往返校验拒绝日期解析器自动归一化的无效日期。
    if (Number.isFinite(at) && at > now && new Date(at + 8 * 3600000).toISOString().slice(0, 19) === `${match[1]}T${match[2]}`) {
      cooldownDeadline = Math.max(cooldownDeadline, at);
    }
  }
  return { modelOnly, ...(cooldownDeadline > 0 ? { cooldownDeadline } : {}) };
}

// 按需拉取一个块，不预读、不聚合；租约覆盖整个响应体生命周期。
function leasedResponse(upstream, release, signal) {
  if (!upstream.body) { release(); return upstream; }
  const reader = upstream.body.getReader();
  let ended = false;
  let controller;
  const finish = () => {
    if (ended) return;
    ended = true;
    signal?.removeEventListener("abort", abort);
    release();
  };
  const abort = () => {
    if (ended) return;
    const error = new DOMException("aborted", "AbortError");
    finish(); controller.error(error); void reader.cancel(error).catch(() => {});
  };
  const body = new ReadableStream({
    start(c) { controller = c; signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort(); },
    async pull(c) {
      try {
        const { value, done } = await reader.read();
        if (ended) return;
        if (done) { finish(); c.close(); } else c.enqueue(value);
      } catch (err) { if (!ended) { finish(); c.error(err); } }
    },
    async cancel(reason) { finish(); await reader.cancel(reason); }
  }, { highWaterMark: 0 });
  return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers });
}

async function runWithAccountPool(provider, opts, runner) {
  if (!isAccountPoolProvider(provider)) return runner(provider, null);
  const workbuddy = isWorkBuddyOAuthProvider(provider);
  const excludeIds = [];
  let lastResult = null;
  let lastError = null;
  for (let attempt = 0; attempt < ACCOUNT_POOL_MAX_ATTEMPTS; attempt += 1) {
    opts?.signal?.throwIfAborted();
    const picked = await pickAndRefreshAccount(provider, {
      excludeIds, fetchImpl: opts?.fetchImpl, signal: opts?.signal, reserveLease: true,
      sessionKey: opts?.accountSessionKey, upstreamModel: opts?.upstreamModel || ""
    });
    if (!picked.ok) { lastError = picked.error || "account pool unavailable"; break; }
    let account = picked.account;
    let streaming = false;
    excludeIds.push(account.id);
    try {
      let result = await runner(bindProviderToAccount(provider, account), account);
      opts?.signal?.throwIfAborted();
      if (isWorkBuddyPolicyBlock(provider, result)) return withAccountMeta(result, account);
      let status = result?.status || result?.upstream?.status;
      if (!isHealthyResult(provider, result) && status === 401 && (account.refreshToken || account.sessionToken)) {
        const renewed = await ensureFreshAccount(account, {
          provider, proxyUrl: provider.proxyUrl, fetchImpl: opts?.fetchImpl, signal: opts?.signal, force: true
        });
        opts?.signal?.throwIfAborted();
        if (renewed.ok) {
          await result.upstream?.body?.cancel?.();
          account = workbuddy
            ? currentEligibleAccount(provider, renewed.account.id, { upstreamModel: opts?.upstreamModel || "" })
            : renewed.account;
          if (!account) {
            clearAccountAffinity(provider, opts?.accountSessionKey, renewed.account.id);
            // finally 释放原租约，下一轮只选择最新可用账号，不向冷却或停用账号重发。
            continue;
          }
          result = await runner(bindProviderToAccount(provider, account), account);
          opts?.signal?.throwIfAborted();
          if (isWorkBuddyPolicyBlock(provider, result)) return withAccountMeta(result, account);
          status = result?.status || result?.upstream?.status;
        }
      }
      if (isHealthyResult(provider, result)) {
        markAccountSuccess(provider, account, { upstreamModel: opts?.upstreamModel || "" });
        if (workbuddy) bindAccountAffinity(provider, opts?.accountSessionKey, account.id);
        if (picked.release && result.kind === "stream") {
          result = { ...result, upstream: leasedResponse(result.upstream, picked.release, opts?.signal) };
          streaming = true;
        }
        return withAccountMeta(result, account);
      }
      if (!shouldFailoverStatus(status)) return withAccountMeta(result, account);
      if (result.kind === "stream") result = {
        kind: "error", status, headers: result.upstream.headers,
        payload: await readJsonResponse(result.upstream).catch(() => ({ error: `status ${status}` }))
      };
      markAccountFailure(provider, account, {
        status, error: result.payload?.error?.message || result.payload?.error || `status ${status}`,
        upstreamModel: opts?.upstreamModel || "", ...(workbuddy ? workbuddyCooldown(result) : {})
      });
      lastResult = withAccountMeta(result, account);
      clearAccountAffinity(provider, opts?.accountSessionKey, account.id);
    } catch (err) {
      if (opts?.signal?.aborted || err?.name === "AbortError") throw new DOMException("aborted", "AbortError");
      lastError = err?.message || String(err);
      markAccountFailure(provider, account, { status: 0, error: lastError, upstreamModel: opts?.upstreamModel || "" });
      clearAccountAffinity(provider, opts?.accountSessionKey, account.id);
      lastResult = withAccountMeta({ kind: "error", status: 502, payload: { error: lastError } }, account);
    } finally { if (!streaming) picked.release?.(); }
  }
  return lastResult || { kind: "error", status: 503, payload: { error: lastError || "account pool exhausted" } };
}

export async function dispatchChat(provider, upstreamModel, chatBody, opts = {}) {
  // 账号池已在 runWithAccountPool 内换号 failover（最多 ACCOUNT_POOL_MAX_ATTEMPTS 个账号）。
  // 若外层 withDispatchRetry 再叠一轮重试，会放大成「池尝试 × 重试」次上游调用
  // （默认 3×3=9），对 5xx/限流场景反而加剧压力。故账号池供应商关闭外层重试，
  // 由池内换号兜底；非池供应商保留外层重试（默认最多 3 次）。
  // Cursor subscription requests are single-account, quota-sensitive calls.
  // Retrying a 429 through the generic dispatcher both hides the original
  // upstream message and needlessly trips its lane circuit breaker.
  const retryOpts = isAccountPoolProvider(provider)
    ? { ...opts, retry: { enabled: false } }
    : opts;
  const accountSessionKey = provider?.poolKind === "antigravity_oauth"
    ? antigravitySessionKey(chatBody, opts)
    : isWorkBuddyOAuthProvider(provider) ? workbuddySessionKey(chatBody, opts, upstreamModel) : "";
  const poolOpts = { ...opts, ...(accountSessionKey ? { accountSessionKey } : {}), upstreamModel };
  return withDispatchRetry(provider, opts.model, retryOpts, () =>
    runWithAccountPool(provider, poolOpts, (activeProvider, account) =>
      dispatchChatOnce(activeProvider, upstreamModel, chatBody, opts, account)
    )
  ).then((result) => attachOutboundBodyRef(result, opts));
}

/** 把一轮 assistant 的思考写进会话缓存（供下一轮回填，维持严格思维链）。 */
function rememberWorkBuddyReasoning(cacheKey, payload) {
  const key = String(cacheKey || "").trim();
  if (!key || !payload) return;
  const message = payload?.choices?.[0]?.message;
  if (!message) return;
  const thought = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  if (!thought.trim()) return;
  reasoningCache.remember(key, message.content, thought);
}

async function dispatchChatOnce(provider, upstreamModel, chatBody, opts = {}, account = null) {
  const ctxModel = { ...(opts.model || {}), id: chatBody._modelId || opts.model?.id || upstreamModel, providerId: opts.model?.providerId || provider.id };
  const ctx = { provider, model: ctxModel, clientId: opts.clientId };
  const stream = Boolean(chatBody.stream);
  const outbound = applyOutbound(stripInternalFields({ ...chatBody, model: upstreamModel }), ctx);
  maybeCaptureOutboundBody(opts, outbound);
  const apiFormat = provider.apiFormat || "openai_chat";
  const upstreamOpts = { ...opts, proxyUrl: effectiveProxyUrl(provider, opts.proxyUrl) };
  const requestOverrides = collectRequestOverrides(provider, ctxModel);
  const upstreamOptsWithOverrides = applyHeaderOverrides(upstreamOpts, requestOverrides);

  if (apiFormat === "antigravity") {
    const built = buildAntigravityEnvelope(provider, upstreamModel, outbound, upstreamOptsWithOverrides);
    const upstream = await callAntigravity(provider, built.envelope, {
      ...upstreamOptsWithOverrides,
      stream
    });
    if (stream) {
      if (!upstream.ok) return withAccountMeta({ kind: "stream", upstream, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
      const chatStream = antigravityStreamToChatResponse(upstream, upstreamModel, built);
      return withAccountMeta({ kind: "stream", upstream: chatStream, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    }
    const raw = await readJsonResponse(upstream);
    if (!upstream.ok) {
      const message = raw?.error?.message || raw?.error || "";
      if (/signature|invalid_argument|invalid argument/i.test(String(message))) {
        clearAntigravityReplay(built.wireModel, built.sessionId);
      }
      return withAccountMeta({ kind: "error", status: upstream.status, payload: raw, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    }
    try {
      const payload = antigravityPayloadToChatResponse(raw, upstreamModel, built);
      return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(payload, ctx), rawPayload: raw, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    } catch (err) {
      return withAccountMeta({
        kind: "error",
        status: 502,
        payload: { error: err?.message || String(err) },
        requestOverrides: requestOverrideSummary(requestOverrides)
      }, account);
    }
  }

  if (apiFormat === "openai_chat") {
    // Chat 中转也可能在服务端转 Responses；同样剥掉 image_gen 保留命名空间冲突工具。
    let upstreamBody = stripConflictingImageGenTools(
      applyBodyOverrides(stripInternalFieldsDeep(outbound), requestOverrides)
    );
    upstreamBody = { ...upstreamBody, messages: sanitizeUpstreamMessages(upstreamBody.messages) };
    // WorkBuddy 上游只接受流式请求，且要求首条消息为 system 提示。
    const workbuddy = isWorkBuddyOAuthProvider(provider);
    if (workbuddy) {
      // 严格思维链判定（DeepSeek 系）：
      //   - 历史里没有 assistant（首轮）→ 可以直接开思维链（上游无回传要求）；
      //   - 历史 assistant 都能配上思考（客户端自带，或网关缓存回填）→ 开；
      //   - 有 assistant 但配不到思考 → 走「不思考」模式，避免上游 11155。
      const cacheKey = resolveReasoningCacheKey(upstreamBody, { clientId: opts?.clientId, sessionKey: opts?.sessionKey });
      if (cacheKey) {
        const filled = reasoningCache.apply(upstreamBody, cacheKey);
        if (filled) ctx._reasoningFilled = filled;
        ctx.reasoningCacheKey = cacheKey;
      }
      const modelName = String(upstreamBody.model || upstreamModel || "").toLowerCase();
      let thinkingMode;
      if (modelName.startsWith("deepseek")) {
        const assistants = (upstreamBody.messages || []).filter((m) => m && m.role === "assistant");
        const allHaveThinking = assistants.every((m) =>
          (typeof m.reasoning_content === "string" && m.reasoning_content.trim())
          || (typeof m.reasoning === "string" && m.reasoning.trim()));
        thinkingMode = assistants.length === 0 || allHaveThinking ? "strict" : "off";
      }
      upstreamBody = prepareWorkBuddyChatBody(upstreamBody, { thinkingMode });
      // 出站内容中和：/console 端点对危险特征（`<script` / `onXxx=` / `alert(` / `curl+URL` 等）
      // 做内容扫描，命中即 403；/v2 端点实测不做任何内容扫描（见 oauth-workbuddy 的路径说明）。
      //
      // 因此默认**不硬化**：global 走 /v2，改写历史纯属副作用——实测模型会读到被改写的
      // `html.unescape（t)` 并在思考链里指出「这是全角括号语法错误」，反而干扰作答。
      // 仅在显式设 provider.wafHardening = true 时启用（/v2 下线回退 /console 时的兜底）。
      if (provider.wafHardening === true) {
        upstreamBody = hardenWorkBuddyChatBody(upstreamBody);
      }
    }
    let upstream = await callOpenAIChat(provider, upstreamBody, upstreamOptsWithOverrides);
    if (workbuddy && upstream.status === 403) {
      // 先识别明确的 HTML WAF 标题，避免把策略拦截记成账号故障或触发纠错重试。
      const text = await upstream.text();
      if (/^\s*</.test(text) && /<title\s*>\s*WAF\s+Block\s+Page\s*<\/title\s*>/i.test(text)) {
        return withAccountMeta({
          kind: "error",
          status: 403,
          payload: { error: {
            code: "upstream_policy_blocked",
            type: "upstream_policy_error",
            message: "WorkBuddy 上游安全策略拦截了请求（WAF）。典型诱因：会话历史中包含「fetch/curl + 域名」类思考文本或工具输出（上游 SSRF 启发式误报）。该响应不足以证明凭证已过期；建议该会话改用其他供应商或新建会话，并向站点方提交 WAF 误报（拦截页含 Request UUID）。",
            retryable: false,
            upstreamStatus: 403
          } },
          requestOverrides: requestOverrideSummary(requestOverrides)
        }, account);
      }
      const payload = safeJsonParse(text, { error: text });
      if (!stream) {
        return withAccountMeta({ kind: "error", status: upstream.status, headers: upstream.headers, payload, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
      }
      // 原响应体只读一次；普通 403 重建可读响应，继续沿用流式纠错与换号逻辑。
      upstream = jsonResponseFromPayload(payload, upstream.status, upstream.headers);
    }
    // 非流式客户端 + 只吐 SSE 的上游：在本地聚合为 Chat JSON（workbuddy2api 同策略）。
    if (workbuddy && !stream) {
      if (!upstream.ok) {
        return withAccountMeta({ kind: "error", status: upstream.status, headers: upstream.headers, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
      }
      const text = await upstream.text();
      const payload = aggregateChatSseToChatResponse(text, upstreamModel);
      rememberWorkBuddyReasoning(ctx.reasoningCacheKey, payload);
      return withAccountMeta({ kind: "json", status: upstream.status || 200, payload: applyInbound(payload, ctx), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    }
    if (stream) {
      const rectifiedStream = await retryFailedStreamWithRectifier({
        upstream,
        body: upstreamBody,
        apiFormat,
        ctx,
        send: (body) => callOpenAIChat(provider, body, upstreamOptsWithOverrides)
      });
      const normalizedUpstream = rectifiedStream.upstream.ok && isOpenCodeGoDeepSeek(provider, upstreamModel)
        ? transformOpenCodeTextToolCalls(rectifiedStream.upstream, {
          tools: outbound.tools,
          restoreToolName: (name) => ctx._switchyardToolNameSafeToRaw?.get(name) || name
        })
        : rectifiedStream.upstream;
      return withAccountMeta({
        kind: "stream",
        upstream: normalizedUpstream,
        compatContext: ctx,
        rectifiers: rectifiedStream.rectifiers,
        errorClass: rectifiedStream.errorClass,
        requestOverrides: requestOverrideSummary(requestOverrides)
      }, account);
    }
    const maybeRetry = await readOrRetryRectified({
      upstream,
      body: upstreamBody,
      apiFormat,
      ctx,
      send: (body) => callOpenAIChat(provider, body, upstreamOptsWithOverrides)
    });
    if (!maybeRetry.ok) return withAccountMeta({ kind: "error", status: maybeRetry.status, headers: maybeRetry.headers, payload: maybeRetry.payload, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    const payload = normalizeChatPayload(maybeRetry.payload);
    return withAccountMeta({ kind: "json", status: maybeRetry.status, payload: applyInbound(payload, ctx), rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  }

  if (apiFormat === "openai_responses") {
    let responsesBody = applyBodyOverrides(chatToResponses(outbound, upstreamModel), requestOverrides);
    // 通用：去掉 image_gen hosted/function 冲突工具，避免三方 Responses 400。
    responsesBody = stripConflictingImageGenTools(responsesBody);
    const codexOAuth = isCodexOAuthProvider(provider);
    if (codexOAuth) {
      responsesBody.store = false;
      responsesBody.stream = true;
      if (!Object.prototype.hasOwnProperty.call(responsesBody, "instructions")) responsesBody.instructions = "";
      delete responsesBody.max_output_tokens;
      Object.assign(responsesBody, normalizeChatgptCodexResponsesBody(responsesBody));
    }
    const upstream = await callOpenAIResponses(provider, responsesBody, upstreamOptsWithOverrides);
    if (stream) {
      // Codex → Responses 原生流：OpenCode Go 大工具清单常先 400，需在下发 SSE 前纠错重试。
      const rectifiedStream = await retryFailedStreamWithRectifier({
        upstream,
        body: responsesBody,
        apiFormat,
        ctx,
        send: (body) => callOpenAIResponses(provider, body, upstreamOptsWithOverrides)
      });
      return withAccountMeta({
        kind: "stream",
        upstream: rectifiedStream.upstream,
        translate: "responses",
        rectifiers: rectifiedStream.rectifiers,
        errorClass: rectifiedStream.errorClass,
        requestOverrides: requestOverrideSummary(requestOverrides)
      }, account);
    }
    if (!upstream.ok) return withAccountMeta({ kind: "error", status: upstream.status, headers: upstream.headers, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    if (codexOAuth) {
      const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
      return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    }
    const rawResponses = await readJsonResponse(upstream);
    const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
    return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  }

  if (apiFormat === "anthropic_messages") {
    const anthBody = applyBodyOverrides(chatToAnthropicMessages(outbound, upstreamModel), requestOverrides);
    const upstream = await callAnthropicMessages(provider, anthBody, upstreamOptsWithOverrides);
    if (stream) return withAccountMeta({ kind: "stream", upstream, translate: "anthropic", requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    const maybeRetry = await readOrRetryRectified({
      upstream,
      body: anthBody,
      apiFormat,
      ctx,
      send: (body) => callAnthropicMessages(provider, body, upstreamOptsWithOverrides)
    });
    if (!maybeRetry.ok) return withAccountMeta({ kind: "error", status: maybeRetry.status, headers: maybeRetry.headers, payload: maybeRetry.payload, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    const rawAnth = maybeRetry.payload;
    const chatLike = anthropicMessagesToChatResponse(rawAnth, upstreamModel);
    return withAccountMeta({ kind: "json", status: maybeRetry.status, payload: applyInbound(chatLike, ctx), rawPayload: rawAnth, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  }

  throw new Error(`Unsupported provider.apiFormat: ${apiFormat}`);
}

export async function dispatchResponses(provider, upstreamModel, responsesBody, opts = {}) {
  const apiFormat = provider.apiFormat || "openai_chat";
  if (apiFormat !== "openai_responses") {
    const chatBody = stripInternalFields({ ...responsesBody, model: upstreamModel });
    return dispatchChat(provider, upstreamModel, chatBody, opts);
  }
  return withDispatchRetry(provider, opts.model, opts, () =>
    runWithAccountPool(provider, opts, (activeProvider, account) =>
      dispatchResponsesOnce(activeProvider, upstreamModel, responsesBody, opts, account)
    )
  ).then((result) => attachOutboundBodyRef(result, opts));
}

async function dispatchResponsesOnce(provider, upstreamModel, responsesBody, opts = {}, account = null) {
  const model = { ...(opts.model || {}), id: opts.model?.id || responsesBody?._modelId || upstreamModel, providerId: opts.model?.providerId || provider.id };
  const ctx = { provider, model, clientId: opts.clientId };
  const upstreamOpts = { ...opts, proxyUrl: effectiveProxyUrl(provider, opts.proxyUrl) };

  const requestOverrides = collectRequestOverrides(provider, model);
  const upstreamOptsWithOverrides = applyHeaderOverrides(upstreamOpts, requestOverrides);
  let upstreamBody = applyBodyOverrides(stripInternalFields({ ...(responsesBody || {}), model: upstreamModel }), requestOverrides);
  // 通用：去掉 image_gen hosted/function 冲突工具，避免 upstream 400。
  upstreamBody = stripConflictingImageGenTools(upstreamBody);
  maybeCaptureOutboundBody(opts, upstreamBody);
  const codexOAuth = isCodexOAuthProvider(provider);
  const clientRequestedStream = Boolean(responsesBody?.stream);
  if (codexOAuth) {
    upstreamBody.store = false;
    upstreamBody.stream = true;
    if (!Object.prototype.hasOwnProperty.call(upstreamBody, "instructions")) upstreamBody.instructions = "";
    delete upstreamBody.max_output_tokens;
    Object.assign(upstreamBody, normalizeChatgptCodexResponsesBody(upstreamBody));
  }
  const upstream = await callOpenAIResponses(provider, upstreamBody, upstreamOptsWithOverrides);
  if (clientRequestedStream) {
    // 与 chat 流式一致：上游若因 tool manifest 直接 400，先纠错再把 SSE 交给客户端。
    const rectifiedStream = await retryFailedStreamWithRectifier({
      upstream,
      body: upstreamBody,
      apiFormat: "openai_responses",
      ctx,
      send: (body) => callOpenAIResponses(provider, body, upstreamOptsWithOverrides)
    });
    return withAccountMeta({
      kind: "stream",
      upstream: rectifiedStream.upstream,
      translate: "responses",
      rectifiers: rectifiedStream.rectifiers,
      errorClass: rectifiedStream.errorClass,
      requestOverrides: requestOverrideSummary(requestOverrides)
    }, account);
  }
  if (!upstream.ok) return withAccountMeta({ kind: "error", status: upstream.status, headers: upstream.headers, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  if (codexOAuth) {
    const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
    return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  }
  const rawResponses = await readJsonResponse(upstream);
  const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
  return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
}



// 严格上游（KE→Bedrock 等）要求 messages 里不能有空 text block：assistant 工具调用
// 轮次常见 content:""（Codex 历史），必须去掉该字段而非保留空串；tool 结果空则补占位。
function isEmptyContent(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function sanitizeUpstreamMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  let callSeq = 0;
  const pendingToolIds = [];
  const ensureId = (id) => {
    if (id && String(id).trim()) return String(id).trim();
    return `call_swy_${++callSeq}`;
  };
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    if (msg.role === "assistant") {
      const next = { ...msg };
      if (Array.isArray(next.tool_calls)) {
        // 严格上游（KE deepseek-v4-pro 等）要求 tool_calls[].id 非空，且后续
        // tool 消息的 tool_call_id 必须配对。Grok 历史里两者常为空串。
        next.tool_calls = next.tool_calls.map((tc) => {
          if (!tc || typeof tc !== "object") return tc;
          const id = ensureId(tc.id);
          pendingToolIds.push(id);
          return tc.id === id ? tc : { ...tc, id };
        });
      }
      if (isEmptyContent(next.content)) {
        if (Array.isArray(next.tool_calls) && next.tool_calls.length) {
          delete next.content;
        } else {
          // 既无正文也无工具调用的空 assistant 会触发更严格上游的校验，补占位兜底。
          next.content = "(空)";
        }
      }
      return next;
    }
    if (msg.role === "tool") {
      let next = msg;
      if (!msg.tool_call_id || !String(msg.tool_call_id).trim()) {
        const id = pendingToolIds.length ? pendingToolIds.shift() : `call_swy_${++callSeq}`;
        next = { ...msg, tool_call_id: id };
      } else {
        const i = pendingToolIds.indexOf(String(msg.tool_call_id).trim());
        if (i >= 0) pendingToolIds.splice(i, 1);
      }
      if (isEmptyContent(next.content)) next = { ...next, content: "(空)" };
      return next;
    }
    if (msg.role === "user" && isEmptyContent(msg.content)) {
      return { ...msg, content: "(空)" };
    }
    return msg;
  });
}

function maybeCaptureOutboundBody(opts, body) {
  if (!opts?.requestBodyCapture?.enabled || opts._outboundRequestBodyRef) return;
  try {
    const captured = captureRequestBody({
      body,
      captureConfig: opts.requestBodyCapture,
      sensitiveGuard: opts.sensitiveGuard,
      baseLogDir: opts.requestBodyCaptureBaseLogDir || undefined
    });
    if (captured?.ref) opts._outboundRequestBodyRef = captured.ref;
  } catch {
    // 落盘失败不阻断上游调用
  }
}

function attachOutboundBodyRef(result, opts) {
  if (result && typeof result === "object" && opts?._outboundRequestBodyRef && !result.outboundRequestBodyRef) {
    return { ...result, outboundRequestBodyRef: opts._outboundRequestBodyRef };
  }
  return result;
}

function stripInternalFields(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
}

/** AIGo / aigocode 号池类中转：请求身份与 tools 需特殊处理。 */
export function isAigoLikeProvider(provider, model = null) {
  const text = [
    provider?.id,
    provider?.name,
    provider?.baseUrl,
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes("api.aigocode.app") || text.includes("aigo") || text.includes("中转gpt");
}

/**
 * 剥离 tools 里会触发上游 400 的 image_gen 冲突工具。
 *
 * Codex / ChatGPT / Grok 常带：
 * - hosted：`image_generation` / `image_gen`，或 namespace `image_gen`
 * - 客户端技能：function `image_gen.imagegen` / `image_gen.image_gen`
 *
 * 官方后端能吞；多数三方 Responses / 中转会报：
 *   Function 'image_gen.imagegen' conflicts with a hosted tool
 *   或 Function 'image_gen.image_gen' is not allowed in reserved namespace 'image_gen'
 *
 * 中转还可能在服务端再注入 hosted，因此不能「只删一边、保留 function」——
 * 只要请求里出现任一类 image_gen 相关工具，就全部去掉，避免冲突。
 */
export function stripConflictingImageGenTools(body) {
  if (!body || typeof body !== "object") return body;
  if (!Array.isArray(body.tools) || body.tools.length === 0) return body;

  const toolName = (tool) => {
    if (!tool || typeof tool !== "object") return "";
    return String(tool.name || tool.function?.name || "").trim();
  };
  const isHostedImageGen = (tool) => {
    if (!tool || typeof tool !== "object") return false;
    const type = String(tool.type || "").toLowerCase();
    const name = toolName(tool).toLowerCase();
    if (type === "image_gen" || type === "image_generation") return true;
    if (type === "namespace" && name === "image_gen") return true;
    return name === "image_gen" && type !== "function";
  };
  const isImageGenFunction = (tool) => {
    if (!tool || typeof tool !== "object") return false;
    const type = String(tool.type || "function").toLowerCase();
    if (type !== "function" && type !== "") return false;
    const name = toolName(tool).toLowerCase();
    // image_gen.imagegen / image_gen.image_gen / *.imagegen 都落在保留命名空间
    return name === "imagegen"
      || name === "image_gen"
      || name.startsWith("image_gen.")
      || name.endsWith(".imagegen");
  };

  const hasHosted = body.tools.some(isHostedImageGen);
  const hasFunction = body.tools.some(isImageGenFunction);
  if (!hasHosted && !hasFunction) return body;

  const nextTools = [];
  for (const tool of body.tools) {
    if (isHostedImageGen(tool) || isImageGenFunction(tool)) continue;
    if (
      tool &&
      typeof tool === "object" &&
      String(tool.type || "").toLowerCase() === "namespace" &&
      toolName(tool).toLowerCase() === "image_gen"
    ) {
      const children = Array.isArray(tool.tools) ? tool.tools.filter((child) => !isImageGenFunction(child)) : [];
      if (!children.length) continue;
      nextTools.push({ ...tool, tools: children });
      continue;
    }
    nextTools.push(tool);
  }
  return { ...body, tools: nextTools };
}

function collectRequestOverrides(provider, model) {
  const sources = [
    ["provider", provider?.localProxyRequestOverrides || provider?.requestOverrides || provider?.meta?.localProxyRequestOverrides],
    ["model", model?.localProxyRequestOverrides || model?.requestOverrides]
  ];
  const headers = {};
  let body = {};
  const sourceNames = [];
  for (const [source, value] of sources) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const nextHeaders = plainObject(value.headers) ? value.headers : null;
    const nextBody = plainObject(value.body) ? value.body : null;
    if (nextHeaders || nextBody) sourceNames.push(source);
    if (nextHeaders) {
      for (const [key, item] of Object.entries(nextHeaders)) {
        const name = String(key || "").trim();
        if (!name || item == null) continue;
        headers[name] = String(item);
      }
    }
    if (nextBody) body = deepMerge(body, nextBody);
  }
  return { headers, body, sources: sourceNames };
}

function applyHeaderOverrides(opts, overrides) {
  if (!Object.keys(overrides.headers || {}).length) return opts;
  return {
    ...opts,
    requestHeaders: {
      ...(opts.requestHeaders || {}),
      ...overrides.headers
    }
  };
}

function applyBodyOverrides(body, overrides) {
  if (!Object.keys(overrides.body || {}).length) return body;
  return deepMerge(body, overrides.body);
}

function requestOverrideSummary(overrides) {
  const headerNames = Object.keys(overrides.headers || {});
  const bodyKeys = Object.keys(overrides.body || {});
  if (!headerNames.length && !bodyKeys.length) return null;
  return {
    sources: overrides.sources,
    headerNames: headerNames.map(redactHeaderName),
    bodyKeys
  };
}

function redactHeaderName(name) {
  return /authorization|cookie|token|key|secret/i.test(name) ? "[redacted-header]" : name;
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepMerge(base, patch) {
  if (!plainObject(base) || !plainObject(patch)) return cloneValue(patch);
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = plainObject(value) && plainObject(out[key]) ? deepMerge(out[key], value) : cloneValue(value);
  }
  return out;
}

function cloneValue(value) {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
}

async function readOrRetryRectified({ upstream, body, apiFormat, ctx, send }) {
  const payload = await readJsonResponse(upstream);
  if (upstream.ok) return { ok: true, status: upstream.status, headers: upstream.headers, payload, rectifiers: [] };
  const rectified = rectifyUpstreamRequest({ apiFormat, body, payload, status: upstream.status, ctx });
  if (!rectified.applied) {
    return { ok: false, status: upstream.status, headers: upstream.headers, payload, rectifiers: [], errorClass: rectified.errorClass || "" };
  }
  const retry = await send(rectified.body);
  const retryPayload = await readJsonResponse(retry);
  const rectifier = {
    ...rectified.action,
    retryStatus: retry.status,
    retryOk: retry.ok
  };
  return {
    ok: retry.ok,
    status: retry.status,
    headers: retry.headers,
    payload: retryPayload,
    rectifiers: [rectifier],
    errorClass: rectified.errorClass || rectifier.errorClass || ""
  };
}

// A stream that failed before its headers/body became a usable SSE stream is
// safe to retry: nothing has been emitted to the client, so a retry cannot
// duplicate text or a tool call. Keep this separate from readOrRetryRectified
// because the normal stream path must return a Response for the server to
// pipe, while failed error bodies have already been consumed for inspection.
async function retryFailedStreamWithRectifier({ upstream, body, apiFormat, ctx, send }) {
  if (upstream.ok) return { upstream, rectifiers: [], errorClass: "" };

  let activeUpstream = upstream;
  let activeBody = body;
  const rectifiers = [];
  let errorClass = "";

  // 纠错只在下游尚未收到上游字节时进行：
  // 0) compact schema  1) 去掉 description  2) 再截断工具数量（OpenCode Go 193 工具面仍 400）
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = await readJsonResponse(activeUpstream);
    const rectified = rectifyUpstreamRequest({
      apiFormat,
      body: activeBody,
      payload,
      status: activeUpstream.status,
      ctx: { ...ctx, runtimeRectifierAttempt: attempt }
    });
    errorClass = rectified.errorClass || errorClass;
    if (!rectified.applied) {
      return {
        upstream: jsonResponseFromPayload(payload, activeUpstream.status, activeUpstream.headers),
        rectifiers,
        errorClass
      };
    }

    activeBody = rectified.body;
    activeUpstream = await send(activeBody);
    const rectifier = {
      ...rectified.action,
      retryStatus: activeUpstream.status,
      retryOk: activeUpstream.ok
    };
    rectifiers.push(rectifier);
    if (activeUpstream.ok) {
      return {
        upstream: activeUpstream,
        rectifiers,
        errorClass: errorClass || rectifier.errorClass || ""
      };
    }
  }

  return {
    upstream: activeUpstream,
    rectifiers,
    errorClass
  };
}

function jsonResponseFromPayload(payload, status, originalHeaders) {
  const headers = new Headers(originalHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(JSON.stringify(payload ?? { error: `status ${status || 0}` }), {
    status: Number(status) || 502,
    headers
  });
}

export function stripInternalFieldsDeep(value, path = []) {
  if (Array.isArray(value)) return value.map((item) => stripInternalFieldsDeep(item, path));
  if (!value || typeof value !== "object") return value;
  const schemaNameMap = ["properties", "patternProperties", "definitions", "$defs"].includes(path[path.length - 1]);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith("_") && !schemaNameMap) continue;
    out[key] = stripInternalFieldsDeep(item, [...path, key]);
  }
  return out;
}

function isOpenCodeGoDeepSeek(provider, upstreamModel) {
  if (String(provider?.id || "").toLowerCase() !== "opencode-go") return false;
  return /deepseek/i.test(String(upstreamModel || ""));
}

function effectiveProxyUrl(provider, override) {
  const direct = String(override || "").trim();
  if (direct) return direct;
  return String(provider?.proxyUrl || "").trim();
}

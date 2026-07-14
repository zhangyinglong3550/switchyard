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
import { callOpenAIChat, callOpenAIResponses, callAnthropicMessages, isCodexOAuthProvider, readJsonResponse } from "./clients.mjs";
import { chatToResponses, normalizeChatgptCodexResponsesBody, responsesToChatResponse, responsesStreamToChatResponse } from "../openai-adapter-out.mjs";
import { contentToText } from "../utils.mjs";
import { chatToAnthropicMessages, anthropicMessagesToChatResponse } from "../anthropic-adapter-out.mjs";
import { applyOutbound, applyInbound } from "../compat/index.mjs";
import { rectifyUpstreamRequest } from "../compat/runtime-rectifier.mjs";
import {
  bindProviderToAccount,
  isAccountPoolProvider,
  markAccountFailure,
  markAccountSuccess,
  pickAndRefreshAccount
} from "../account-pool/index.mjs";

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

async function runWithAccountPool(provider, opts, runner) {
  if (!isAccountPoolProvider(provider)) {
    return runner(provider, null);
  }
  const excludeIds = [];
  let lastResult = null;
  let lastError = null;
  for (let attempt = 0; attempt < ACCOUNT_POOL_MAX_ATTEMPTS; attempt += 1) {
    const picked = await pickAndRefreshAccount(provider, {
      excludeIds,
      fetchImpl: opts?.fetchImpl
    });
    if (!picked.ok) {
      lastError = picked.error || "account pool unavailable";
      break;
    }
    const account = picked.account;
    excludeIds.push(account.id);
    const bound = bindProviderToAccount(provider, account);
    try {
      const result = await runner(bound, account);
      if (result?.kind === "error" && shouldFailoverStatus(result.status)) {
        markAccountFailure(provider, account, {
          status: result.status,
          error: result.payload?.error?.message || result.payload?.error || `status ${result.status}`
        });
        lastResult = withAccountMeta(result, account);
        // 401：同号已在 pick 时 refresh；仍失败则换号
        continue;
      }
      if (result?.kind === "stream" && result.upstream && !result.upstream.ok && shouldFailoverStatus(result.upstream.status)) {
        markAccountFailure(provider, account, {
          status: result.upstream.status,
          error: `stream status ${result.upstream.status}`
        });
        lastResult = withAccountMeta({
          kind: "error",
          status: result.upstream.status,
          payload: await readJsonResponse(result.upstream).catch(() => ({ error: `status ${result.upstream.status}` }))
        }, account);
        continue;
      }
      markAccountSuccess(provider, account);
      return withAccountMeta(result, account);
    } catch (err) {
      const message = err?.message || String(err);
      markAccountFailure(provider, account, { status: 0, error: message });
      lastError = message;
      lastResult = withAccountMeta({
        kind: "error",
        status: 502,
        payload: { error: message }
      }, account);
    }
  }
  if (lastResult) return lastResult;
  return {
    kind: "error",
    status: 503,
    payload: { error: lastError || "account pool exhausted" }
  };
}

export async function dispatchChat(provider, upstreamModel, chatBody, opts = {}) {
  return runWithAccountPool(provider, opts, (activeProvider, account) =>
    dispatchChatOnce(activeProvider, upstreamModel, chatBody, opts, account)
  );
}

async function dispatchChatOnce(provider, upstreamModel, chatBody, opts = {}, account = null) {
  const ctxModel = { ...(opts.model || {}), id: chatBody._modelId || opts.model?.id || upstreamModel, providerId: opts.model?.providerId || provider.id };
  const ctx = { provider, model: ctxModel, clientId: opts.clientId };
  const stream = Boolean(chatBody.stream);
  const outbound = applyOutbound(stripInternalFields({ ...chatBody, model: upstreamModel }), ctx);
  const apiFormat = provider.apiFormat || "openai_chat";
  const upstreamOpts = { ...opts, proxyUrl: effectiveProxyUrl(provider, opts.proxyUrl) };
  const requestOverrides = collectRequestOverrides(provider, ctxModel);
  const upstreamOptsWithOverrides = applyHeaderOverrides(upstreamOpts, requestOverrides);

  if (apiFormat === "openai_chat") {
    const upstreamBody = applyBodyOverrides(stripInternalFieldsDeep(outbound), requestOverrides);
    const upstream = await callOpenAIChat(provider, upstreamBody, upstreamOptsWithOverrides);
    if (stream) return withAccountMeta({ kind: "stream", upstream, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    const maybeRetry = await readOrRetryRectified({
      upstream,
      body: upstreamBody,
      apiFormat,
      ctx,
      send: (body) => callOpenAIChat(provider, body, upstreamOptsWithOverrides)
    });
    if (!maybeRetry.ok) return withAccountMeta({ kind: "error", status: maybeRetry.status, payload: maybeRetry.payload, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    const payload = normalizeChatPayload(maybeRetry.payload);
    return withAccountMeta({ kind: "json", status: maybeRetry.status, payload: applyInbound(payload, ctx), rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  }

  if (apiFormat === "openai_responses") {
    let responsesBody = applyBodyOverrides(chatToResponses(outbound, upstreamModel), requestOverrides);
    if (isAigoLikeProvider(provider, ctxModel)) {
      responsesBody = stripConflictingImageGenTools(responsesBody);
    }
    const codexOAuth = isCodexOAuthProvider(provider);
    if (codexOAuth) {
      responsesBody.store = false;
      responsesBody.stream = true;
      if (!Object.prototype.hasOwnProperty.call(responsesBody, "instructions")) responsesBody.instructions = "";
      delete responsesBody.max_output_tokens;
      Object.assign(responsesBody, normalizeChatgptCodexResponsesBody(responsesBody));
    }
    const upstream = await callOpenAIResponses(provider, responsesBody, upstreamOptsWithOverrides);
    if (stream) return withAccountMeta({ kind: "stream", upstream, translate: "responses", requestOverrides: requestOverrideSummary(requestOverrides) }, account);
    if (!upstream.ok) return withAccountMeta({ kind: "error", status: upstream.status, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
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
    if (!maybeRetry.ok) return withAccountMeta({ kind: "error", status: maybeRetry.status, payload: maybeRetry.payload, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
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
  return runWithAccountPool(provider, opts, (activeProvider, account) =>
    dispatchResponsesOnce(activeProvider, upstreamModel, responsesBody, opts, account)
  );
}

async function dispatchResponsesOnce(provider, upstreamModel, responsesBody, opts = {}, account = null) {
  const model = { ...(opts.model || {}), id: opts.model?.id || responsesBody?._modelId || upstreamModel, providerId: opts.model?.providerId || provider.id };
  const ctx = { provider, model, clientId: opts.clientId };
  const upstreamOpts = { ...opts, proxyUrl: effectiveProxyUrl(provider, opts.proxyUrl) };

  const requestOverrides = collectRequestOverrides(provider, model);
  const upstreamOptsWithOverrides = applyHeaderOverrides(upstreamOpts, requestOverrides);
  let upstreamBody = applyBodyOverrides(stripInternalFields({ ...(responsesBody || {}), model: upstreamModel }), requestOverrides);
  // AIGo / 号池中转：去掉 image_gen hosted 与 function 同名冲突，避免 upstream 400。
  if (isAigoLikeProvider(provider, model)) {
    upstreamBody = stripConflictingImageGenTools(upstreamBody);
  }
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
  if (clientRequestedStream) return withAccountMeta({ kind: "stream", upstream, translate: "responses", requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  if (!upstream.ok) return withAccountMeta({ kind: "error", status: upstream.status, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  if (codexOAuth) {
    const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
    return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), requestOverrides: requestOverrideSummary(requestOverrides) }, account);
  }
  const rawResponses = await readJsonResponse(upstream);
  const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
  return withAccountMeta({ kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses, requestOverrides: requestOverrideSummary(requestOverrides) }, account);
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
 * 去掉 Responses tools 里 hosted image_gen 与 function `image_gen.imagegen` 的同名冲突。
 * ChatGPT App 会带 hosted image_gen；部分中转会再注入 imagegen function，导致 400。
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
    return name === "image_gen.imagegen" || name === "imagegen" || name.endsWith(".imagegen");
  };

  const hasHosted = body.tools.some(isHostedImageGen);
  const hasFunction = body.tools.some(isImageGenFunction);
  if (!hasHosted && !hasFunction) return body;

  // 优先保留 function 路径不可控（中转可能再次注入），因此去掉 hosted + 冲突 function，
  // 让上游只剩一种或零种 image 工具，避免 "conflicts with a hosted tool"。
  const nextTools = [];
  for (const tool of body.tools) {
    if (isHostedImageGen(tool) || isImageGenFunction(tool)) continue;
    if (tool && typeof tool === "object" && String(tool.type || "").toLowerCase() === "namespace" && toolName(tool).toLowerCase() === "image_gen") {
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
  if (upstream.ok) return { ok: true, status: upstream.status, payload, rectifiers: [] };
  const rectified = rectifyUpstreamRequest({ apiFormat, body, payload, status: upstream.status, ctx });
  if (!rectified.applied) {
    return { ok: false, status: upstream.status, payload, rectifiers: [], errorClass: rectified.errorClass || "" };
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
    payload: retryPayload,
    rectifiers: [rectifier],
    errorClass: rectified.errorClass || rectifier.errorClass || ""
  };
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

function effectiveProxyUrl(provider, override) {
  const direct = String(override || "").trim();
  if (direct) return direct;
  return String(provider?.proxyUrl || "").trim();
}

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
import { chatToAnthropicMessages, anthropicMessagesToChatResponse } from "../anthropic-adapter-out.mjs";
import { applyOutbound, applyInbound } from "../compat/index.mjs";
import { rectifyUpstreamRequest } from "../compat/runtime-rectifier.mjs";

export async function dispatchChat(provider, upstreamModel, chatBody, opts = {}) {
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
    if (stream) return { kind: "stream", upstream, requestOverrides: requestOverrideSummary(requestOverrides) };
    const maybeRetry = await readOrRetryRectified({
      upstream,
      body: upstreamBody,
      apiFormat,
      ctx,
      send: (body) => callOpenAIChat(provider, body, upstreamOptsWithOverrides)
    });
    if (!maybeRetry.ok) return { kind: "error", status: maybeRetry.status, payload: maybeRetry.payload, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) };
    const payload = maybeRetry.payload;
    return { kind: "json", status: maybeRetry.status, payload: applyInbound(payload, ctx), rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) };
  }

  if (apiFormat === "openai_responses") {
    const responsesBody = applyBodyOverrides(chatToResponses(outbound, upstreamModel), requestOverrides);
    const codexOAuth = isCodexOAuthProvider(provider);
    if (codexOAuth) {
      responsesBody.store = false;
      responsesBody.stream = true;
      if (!Object.prototype.hasOwnProperty.call(responsesBody, "instructions")) responsesBody.instructions = "";
      delete responsesBody.max_output_tokens;
      Object.assign(responsesBody, normalizeChatgptCodexResponsesBody(responsesBody));
    }
    const upstream = await callOpenAIResponses(provider, responsesBody, upstreamOptsWithOverrides);
    if (stream) return { kind: "stream", upstream, translate: "responses", requestOverrides: requestOverrideSummary(requestOverrides) };
    if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) };
    if (codexOAuth) {
      const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
      return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), requestOverrides: requestOverrideSummary(requestOverrides) };
    }
    const rawResponses = await readJsonResponse(upstream);
    const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
    return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses, requestOverrides: requestOverrideSummary(requestOverrides) };
  }

  if (apiFormat === "anthropic_messages") {
    const anthBody = applyBodyOverrides(chatToAnthropicMessages(outbound, upstreamModel), requestOverrides);
    const upstream = await callAnthropicMessages(provider, anthBody, upstreamOptsWithOverrides);
    if (stream) return { kind: "stream", upstream, translate: "anthropic", requestOverrides: requestOverrideSummary(requestOverrides) };
    const maybeRetry = await readOrRetryRectified({
      upstream,
      body: anthBody,
      apiFormat,
      ctx,
      send: (body) => callAnthropicMessages(provider, body, upstreamOptsWithOverrides)
    });
    if (!maybeRetry.ok) return { kind: "error", status: maybeRetry.status, payload: maybeRetry.payload, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) };
    const rawAnth = maybeRetry.payload;
    const chatLike = anthropicMessagesToChatResponse(rawAnth, upstreamModel);
    return { kind: "json", status: maybeRetry.status, payload: applyInbound(chatLike, ctx), rawPayload: rawAnth, rectifiers: maybeRetry.rectifiers, errorClass: maybeRetry.errorClass, requestOverrides: requestOverrideSummary(requestOverrides) };
  }

  throw new Error(`Unsupported provider.apiFormat: ${apiFormat}`);
}

export async function dispatchResponses(provider, upstreamModel, responsesBody, opts = {}) {
  const model = { ...(opts.model || {}), id: opts.model?.id || responsesBody?._modelId || upstreamModel, providerId: opts.model?.providerId || provider.id };
  const ctx = { provider, model, clientId: opts.clientId };
  const apiFormat = provider.apiFormat || "openai_chat";
  const upstreamOpts = { ...opts, proxyUrl: effectiveProxyUrl(provider, opts.proxyUrl) };
  if (apiFormat !== "openai_responses") {
    const chatBody = stripInternalFields({ ...responsesBody, model: upstreamModel });
    return dispatchChat(provider, upstreamModel, chatBody, opts);
  }

  const requestOverrides = collectRequestOverrides(provider, model);
  const upstreamOptsWithOverrides = applyHeaderOverrides(upstreamOpts, requestOverrides);
  const upstreamBody = applyBodyOverrides(stripInternalFields({ ...(responsesBody || {}), model: upstreamModel }), requestOverrides);
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
  if (clientRequestedStream) return { kind: "stream", upstream, translate: "responses", requestOverrides: requestOverrideSummary(requestOverrides) };
  if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) };
  if (codexOAuth) {
    const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
    return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), requestOverrides: requestOverrideSummary(requestOverrides) };
  }
  const rawResponses = await readJsonResponse(upstream);
  const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
  return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses, requestOverrides: requestOverrideSummary(requestOverrides) };
}

function stripInternalFields(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
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

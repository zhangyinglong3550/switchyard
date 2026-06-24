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
import { chatToResponses, responsesToChatResponse, responsesStreamToChatResponse } from "../openai-adapter-out.mjs";
import { chatToAnthropicMessages, anthropicMessagesToChatResponse } from "../anthropic-adapter-out.mjs";
import { applyOutbound, applyInbound } from "../compat/index.mjs";

export async function dispatchChat(provider, upstreamModel, chatBody, opts = {}) {
  const ctxModel = { ...(opts.model || {}), id: chatBody._modelId || opts.model?.id || upstreamModel, providerId: opts.model?.providerId || provider.id };
  const ctx = { provider, model: ctxModel, clientId: opts.clientId };
  const stream = Boolean(chatBody.stream);
  const outbound = applyOutbound(stripInternalFields({ ...chatBody, model: upstreamModel }), ctx);
  const apiFormat = provider.apiFormat || "openai_chat";
  const upstreamOpts = { ...opts, proxyUrl: effectiveProxyUrl(provider, opts.proxyUrl) };

  if (apiFormat === "openai_chat") {
    const upstream = await callOpenAIChat(provider, outbound, upstreamOpts);
    if (stream) return { kind: "stream", upstream };
    if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream) };
    const payload = await readJsonResponse(upstream);
    return { kind: "json", status: upstream.status, payload: applyInbound(payload, ctx) };
  }

  if (apiFormat === "openai_responses") {
    const responsesBody = chatToResponses(outbound, upstreamModel);
    const codexOAuth = isCodexOAuthProvider(provider);
    if (codexOAuth) {
      responsesBody.store = false;
      responsesBody.stream = true;
      if (!Object.prototype.hasOwnProperty.call(responsesBody, "instructions")) responsesBody.instructions = "";
      delete responsesBody.max_output_tokens;
    }
    const upstream = await callOpenAIResponses(provider, responsesBody, upstreamOpts);
    if (stream) return { kind: "stream", upstream, translate: "responses" };
    if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream) };
    if (codexOAuth) {
      const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
      return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx) };
    }
    const rawResponses = await readJsonResponse(upstream);
    const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
    return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses };
  }

  if (apiFormat === "anthropic_messages") {
    const anthBody = chatToAnthropicMessages(outbound, upstreamModel);
    const upstream = await callAnthropicMessages(provider, anthBody, upstreamOpts);
    if (stream) return { kind: "stream", upstream, translate: "anthropic" };
    if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream) };
    const rawAnth = await readJsonResponse(upstream);
    const chatLike = anthropicMessagesToChatResponse(rawAnth, upstreamModel);
    return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawAnth };
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

  const upstreamBody = stripInternalFields({ ...(responsesBody || {}), model: upstreamModel });
  if (isCodexOAuthProvider(provider)) {
    upstreamBody.store = false;
    upstreamBody.stream = Boolean(responsesBody?.stream);
    if (!Object.prototype.hasOwnProperty.call(upstreamBody, "instructions")) upstreamBody.instructions = "";
  }
  const upstream = await callOpenAIResponses(provider, upstreamBody, upstreamOpts);
  if (upstreamBody.stream) return { kind: "stream", upstream, translate: "responses" };
  if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream) };
  const rawResponses = await readJsonResponse(upstream);
  const chatLike = responsesToChatResponse(rawResponses, upstreamModel);
  return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), rawPayload: rawResponses };
}

function stripInternalFields(body) {
  const out = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (!key.startsWith("_")) out[key] = value;
  }
  return out;
}

function effectiveProxyUrl(provider, override) {
  const direct = String(override || "").trim();
  if (direct) return direct;
  return String(provider?.proxyUrl || "").trim();
}

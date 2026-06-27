// HTTP gateway server. Provides three client-facing protocol entry points and
// fans every request out to a single canonical chat-style call, regardless of
// what upstream protocol the chosen provider speaks. Compat patches plug in via
// applyOutbound/applyInbound and are provider/model targeted.
import http from "node:http";
import crypto from "node:crypto";
import { loadConfig, listModelsForClient, publicModelsForClient } from "./config.mjs";
import { resolveRoute } from "./router.mjs";
import { buildCodexModelCatalog } from "./profile-writer.mjs";
import { dispatchChat, dispatchResponses } from "./upstream/dispatch.mjs";
import { readJsonResponse } from "./upstream/clients.mjs";
import { applyVisionFallback } from "./vision-fallback.mjs";
import { contentToText, json, readJsonBody } from "./utils.mjs";
import { responsesToChat, chatToResponse, streamChatAsResponses, extractNamespaceMap } from "./openai-adapter.mjs";
import { anthropicToChat, chatToAnthropic, streamChatAsAnthropic, streamAnthropicAsChat, streamMessageAsAnthropic, streamAnthropicError, countTokensApprox } from "./anthropic-adapter.mjs";
import { registerBuiltinPatches, applyStreamLine, activePatchDescriptors } from "./compat/index.mjs";
registerBuiltinPatches();

const CLIENT_PROTOCOL = {
  chat: "openai_chat",
  responses: "openai_responses",
  messages: "anthropic_messages"
};

const CLIENT_PREFIXES = [
  { prefix: "/codex", clientId: "codex" },
  { prefix: "/claude-code", clientId: "claude-code" },
  { prefix: "/claude-app", clientId: "claude-app" },
  { prefix: "/hermes", clientId: "hermes" },
  { prefix: "/openai", clientId: "generic-openai" },
  { prefix: "/anthropic", clientId: "generic-openai" }
];

function detectClient(req, url) {
  const headerClient = req.headers["x-switchyard-client"];
  if (typeof headerClient === "string" && headerClient) return headerClient;
  for (const { prefix, clientId } of CLIENT_PREFIXES) {
    if (url.pathname === prefix) return clientId;
    if (url.pathname.startsWith(prefix + "/")) return clientId;
  }
  return null;
}

function stripClientPrefix(pathname) {
  for (const { prefix } of CLIENT_PREFIXES) {
    if (pathname === prefix) return "/";
    if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  }
  return pathname;
}

function normalizeApiPath(pathname) {
  let out = pathname || "/";
  while (out.startsWith("/v1/v1/")) out = out.replace(/^\/v1\/v1(?=\/)/, "/v1");
  if (out === "/v1/v1") return "/v1";
  return out;
}

export function createServer({ onLog } = {}) {
  let config = loadConfig();
  const emit = (entry) => {
    try { if (typeof onLog === "function") onLog(entry); } catch {}
  };

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const clientId = detectClient(req, url);
    const path = normalizeApiPath(stripClientPrefix(url.pathname));
    const requestRecord = {
      requestLog: true,
      method: req.method,
      path: url.pathname,
      clientId: clientId || null
    };
    try {
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { ok: true, service: "switchyard", clients: Object.keys(config.clients || {}) });
        return;
      }
      if ((req.method === "GET" || req.method === "HEAD") && clientId && path === "/") {
        if (req.method === "HEAD") {
          res.writeHead(200, { "Cache-Control": "no-store" });
          res.end();
        } else {
          json(res, 200, { ok: true, service: "switchyard", client: clientId });
        }
        return;
      }
      if (req.method === "POST" && path === "/admin/reload") {
        config = loadConfig();
        json(res, 200, { ok: true, models: config.models.length, providers: config.providers.length });
        emit({ level: "info", msg: "config reloaded", models: config.models.length, providers: config.providers.length });
        return;
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/v1/models/" || path === "/models" || path === "/models/")) {
        const models = publicModelsForClient(config, clientId);
        if (clientId === "claude-code" || clientId === "claude-app") {
          json(res, 200, {
            data: models,
            has_more: false,
            first_id: models[0]?.id || null,
            last_id: models[models.length - 1]?.id || null
          });
          return;
        }
        if (clientId === "codex") {
          const catalogModels = codexCatalogModels(config);
          json(res, 200, {
            object: "list",
            data: catalogModels.map(codexPublicModelFromCatalog),
            models: catalogModels
          });
          return;
        }
        const payload = { object: "list", data: models };
        json(res, 200, payload);
        return;
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        await handleChat(config, req, res, clientId, emit, requestRecord);
        return;
      }
      if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        await handleResponses(config, req, res, clientId, emit, requestRecord);
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        await handleAnthropicMessages(config, req, res, clientId, emit, requestRecord);
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
        const body = await readJsonBody(req);
        json(res, 200, countTokensApprox(body));
        return;
      }
      json(res, 404, { error: "Not found", path: url.pathname });
    } catch (err) {
      const message = errorMessage(err);
      requestRecord.error = message;
      emit({ level: "error", msg: message });
      json(res, 500, { error: message });
    } finally {
      emit({ level: "info", msg: "request", ...requestRecord, status: res.statusCode, ms: Date.now() - start });
    }
  });

  server.reloadConfig = () => { config = loadConfig(); return { models: config.models.length, providers: config.providers.length }; };
  server.currentConfig = () => config;
  return server;
}

function codexCatalogModels(config) {
  const providerById = new Map((config.providers || []).map((provider) => [provider.id, provider]));
  const models = listModelsForClient(config, "codex").map((model) => ({
    ...model,
    providerName: providerById.get(model.providerId)?.name || model.providerId
  }));
  return buildCodexModelCatalog({ models, defaultModel: config.defaultModel }).models;
}

function codexPublicModelFromCatalog(model) {
  return {
    ...model,
    id: model.slug,
    object: "model",
    created: 0,
    owned_by: model["x-switchyard-provider"] || "switchyard",
    display_name: model.display_name || model.slug
  };
}

function errorMessage(err) {
  const base = err?.message || String(err);
  const cause = err?.cause;
  const details = [
    cause?.code,
    cause?.host,
    cause?.port ? `:${cause.port}` : ""
  ].filter(Boolean).join(" ");
  return details ? `${base} (${details})` : base;
}

function nativeRoutingDecision(provider, clientProtocol) {
  const apiFormat = provider?.apiFormat || "openai_chat";
  const mode = provider?.routingMode || "auto";
  if (mode === "gateway") return { ok: true, native: false, mode, apiFormat };
  if (apiFormat === clientProtocol) return { ok: true, native: true, mode, apiFormat };
  if (mode === "native") {
    return {
      ok: false,
      native: false,
      mode,
      apiFormat,
      error: `Provider ${provider?.id || "(unknown)"} routingMode=native requires ${clientProtocol}, but apiFormat is ${apiFormat}`
    };
  }
  return { ok: true, native: false, mode, apiFormat };
}

function rejectRoutingError(res, record, decision) {
  const message = decision.error || "Invalid native routing configuration";
  if (record) {
    record.error = message;
    record.responseSummary = summarizeResponse({ error: message }, { status: 400, error: message });
  }
  json(res, 400, { error: message });
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function recordRoute(record, route, requestedModel) {
  if (!record) return;
  record.requestedModel = requestedModel || "";
  record.modelId = route.model.id;
  record.providerId = route.provider.id;
  record.upstreamModel = route.upstreamModel;
  record.apiFormat = route.provider.apiFormat || "openai_chat";
}

function previewText(value, max = 1200) {
  const text = contentToText(value).replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[图片]").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function imageCount(value) {
  if (!value) return 0;
  if (typeof value === "string") return /data:image\/[^;]+;base64,|https?:\/\/\S+\.(?:png|jpe?g|webp|gif)/i.test(value) ? 1 : 0;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + imageCount(item), 0);
  if (typeof value !== "object") return 0;
  let count = 0;
  if (value.type === "image" || value.type === "image_url" || value.type === "input_image") count += 1;
  if (value.image_url || value.source?.data) count += 1;
  for (const key of ["content", "text", "image_url", "source"]) count += imageCount(value[key]);
  return count;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 120).map((tool) => {
    const fn = tool?.function || tool || {};
    return {
      name: String(fn.name || tool?.name || "").slice(0, 120),
      description: String(fn.description || tool?.description || "").slice(0, 260),
      required: Array.isArray(fn.parameters?.required) ? fn.parameters.required.slice(0, 20) : [],
      propertyCount: fn.parameters?.properties && typeof fn.parameters.properties === "object" ? Object.keys(fn.parameters.properties).length : 0
    };
  }).filter((tool) => tool.name);
}

function extractSkillNames(systemText) {
  const text = String(systemText || "");
  if (!/(skill|skills|技能|能力)/i.test(text)) return [];
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(?:[-*]\s*)?`?([A-Za-z0-9_.:@/-]{2,80})`?\s*(?:[:：-]|—)\s+/.exec(trimmed);
    if (match && /skill|技能|能力/i.test(trimmed)) names.add(match[1]);
  }
  for (const match of text.matchAll(/(?:skill|技能)\s*[:：]\s*`?([A-Za-z0-9_.:@/-]{2,80})`?/gi)) names.add(match[1]);
  return Array.from(names).slice(0, 80);
}

function summarizeMessages(messages) {
  const out = { system: [], user: [], assistant: [], tool: [], images: 0, roleCounts: {} };
  for (const message of messages || []) {
    const role = message?.role || "event";
    out.roleCounts[role] = (out.roleCounts[role] || 0) + 1;
    out.images += imageCount(message?.content);
    const item = {
      role,
      text: previewText(message?.content, role === "system" ? 2000 : 1200),
      toolCalls: Array.isArray(message?.tool_calls)
        ? message.tool_calls.map((call) => ({ name: call.function?.name || call.name || "", id: call.id || "" })).filter((call) => call.name).slice(0, 40)
        : []
    };
    if (role === "system") out.system.push(item);
    else if (role === "assistant") out.assistant.push(item);
    else if (role === "tool") out.tool.push(item);
    else out.user.push(item);
  }
  out.skills = extractSkillNames(out.system.map((item) => item.text).join("\n"));
  return out;
}

function summarizeRequest(chatBody, route, protocol) {
  const messages = summarizeMessages(chatBody.messages || []);
  const upstreamProtocol = route?.provider?.apiFormat || "openai_chat";
  return {
    protocol,
    modelId: route?.model?.id || "",
    upstreamModel: route?.upstreamModel || "",
    providerId: route?.provider?.id || "",
    conversionChain: {
      steps: protocol === upstreamProtocol ? [protocol] : [protocol, upstreamProtocol]
    },
    compatRules: {
      outbound: activePatchDescriptors({ provider: route?.provider, model: route?.model, direction: "outbound" }),
      inbound: activePatchDescriptors({ provider: route?.provider, model: route?.model, direction: "inbound" }),
      stream: activePatchDescriptors({ provider: route?.provider, model: route?.model, direction: "stream" })
    },
    params: {
      stream: Boolean(chatBody.stream),
      temperature: chatBody.temperature,
      maxTokens: chatBody.max_tokens,
      toolChoice: chatBody.tool_choice
    },
    messages,
    vision: chatBody._switchyardVision || null,
    tools: summarizeTools(chatBody.tools),
    toolCount: Array.isArray(chatBody.tools) ? chatBody.tools.length : 0
  };
}

function previewJson(value, max = 800) {
  if (value == null) return "";
  if (typeof value === "string") return previewText(value, max);
  try {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return previewText(value, max);
  }
}

function normalizeResponseUsage(usage) {
  const promptTokens = firstNumber(usage?.prompt_tokens, usage?.input_tokens);
  const completionTokens = firstNumber(usage?.completion_tokens, usage?.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: firstNumber(usage?.total_tokens, promptTokens + completionTokens)
  };
}

function summarizeChatPayload(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
      id: call.id || "",
      name: call.function?.name || call.name || "",
      argumentsPreview: previewJson(call.function?.arguments || call.arguments || "", 800)
    })).filter((call) => call.name).slice(0, 60)
    : [];
  return {
    text: previewText(message.content || "", 1600),
    reasoning: previewText(message.reasoning_content || message.reasoning || payload?.reasoning || "", 1600),
    toolCalls,
    finishReason: choice.finish_reason || "",
    usage: normalizeResponseUsage(payload?.usage)
  };
}

function summarizeResponsesPayload(payload) {
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  if (payload?.output_text) text.push(payload.output_text);
  for (const item of payload?.output || []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "output_text" || part.type === "text") text.push(part.text || "");
        else if (part.type === "refusal") text.push(part.refusal || part.text || "");
        else {
          const partText = contentToText(part);
          if (partText) text.push(partText);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id || "",
        name: item.name || "",
        argumentsPreview: previewJson(item.arguments || item.input || "", 800)
      });
    } else if (item.type === "reasoning") {
      const summary = contentToText(item.summary || item.content || item.text || "");
      if (summary) reasoning.push(summary);
    }
  }
  return {
    text: previewText(text.filter(Boolean).join("\n"), 1600),
    reasoning: previewText(reasoning.filter(Boolean).join("\n"), 1600),
    toolCalls: toolCalls.filter((call) => call.name).slice(0, 60),
    finishReason: payload?.status || payload?.incomplete_details?.reason || "",
    usage: normalizeResponseUsage(payload?.usage)
  };
}

function summarizeAnthropicPayload(payload) {
  const text = [];
  const reasoning = [];
  const toolCalls = [];
  for (const block of payload?.content || []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") text.push(block.text || "");
    else if (block.type === "thinking") reasoning.push(block.thinking || block.text || "");
    else if (block.type === "redacted_thinking") reasoning.push("[redacted thinking]");
    else if (block.type === "tool_use" || block.type === "server_tool_use") {
      toolCalls.push({
        id: block.id || "",
        name: block.name || "",
        argumentsPreview: previewJson(block.input || {}, 800)
      });
    }
  }
  return {
    text: previewText(text.filter(Boolean).join("\n"), 1600),
    reasoning: previewText(reasoning.filter(Boolean).join("\n"), 1600),
    toolCalls: toolCalls.filter((call) => call.name).slice(0, 60),
    finishReason: payload?.stop_reason || "",
    usage: normalizeResponseUsage(payload?.usage)
  };
}

function responsePayloadSummary(payload) {
  if (!payload || typeof payload !== "object") return {};
  if (Array.isArray(payload.choices)) return summarizeChatPayload(payload);
  if (Array.isArray(payload.output) || payload.object === "response") return summarizeResponsesPayload(payload);
  if (Array.isArray(payload.content) && (payload.type === "message" || payload.role === "assistant")) return summarizeAnthropicPayload(payload);
  return {
    text: responsePreview(payload),
    reasoning: "",
    toolCalls: [],
    finishReason: payload.finish_reason || payload.stop_reason || payload.status || "",
    usage: normalizeResponseUsage(payload.usage)
  };
}

function summarizeResponse(payload, { stream = false, status = null, error = "" } = {}) {
  const summary = responsePayloadSummary(payload);
  return {
    stream,
    status,
    text: summary.text || "",
    reasoning: summary.reasoning || "",
    toolCalls: summary.toolCalls || [],
    finishReason: summary.finishReason || "",
    usage: summary.usage || normalizeResponseUsage(null),
    error: error || requestPayloadError(payload)
  };
}

function recordRequestSummary(record, chatBody, route, protocol) {
  if (!record) return;
  record.requestSummary = summarizeRequest(chatBody, route, protocol);
}

function recordResponseSummary(record, payload, opts = {}) {
  if (!record) return;
  record.responseSummary = summarizeResponse(payload, opts);
}

function streamEventCount(summary, ...names) {
  const counts = summary?.dataTypeCounts || summary?.eventCounts || {};
  return names.reduce((sum, name) => sum + firstNumber(counts[name]), 0);
}

function responseSummaryFromStreamDiagnostics(summary, { status = 0, error = "" } = {}) {
  const textDeltaCount = streamEventCount(summary, "response.output_text.delta");
  const textDoneCount = streamEventCount(summary, "response.output_text.done", "response.content_part.done");
  const functionCallDeltaCount = streamEventCount(summary, "response.function_call_arguments.delta");
  const functionCallDoneCount = streamEventCount(summary, "response.function_call_arguments.done");
  const toolCalls = [];
  if (functionCallDeltaCount || functionCallDoneCount) {
    toolCalls.push({
      id: "stream",
      name: "function_call_arguments",
      argumentsPreview: `${functionCallDeltaCount} delta events, ${functionCallDoneCount} done events`
    });
  }
  return {
    stream: true,
    status,
    text: "",
    reasoning: "",
    toolCalls,
    finishReason: summary?.sawTerminalEvent ? "completed" : "incomplete",
    usage: normalizeResponseUsage(null),
    error,
    streamDiagnostics: summary || null,
    streamEventSummary: {
      textDeltaCount,
      textDoneCount,
      functionCallDeltaCount,
      functionCallDoneCount,
      retryCount: firstNumber(summary?.retryCount),
      preludeRetryCount: firstNumber(summary?.preludeRetryCount),
      sawTerminalEvent: Boolean(summary?.sawTerminalEvent),
      sawMeaningfulEvent: Boolean(summary?.sawMeaningfulEvent)
    }
  };
}

function recordStreamDiagnostics(record, summary, { status = 0, error = "" } = {}) {
  if (!record || !summary) return;
  if (!record.requestSummary) record.requestSummary = {};
  record.requestSummary.streamDiagnostics = summary;
  record.responseSummary = responseSummaryFromStreamDiagnostics(summary, { status, error: error || record.error || "" });
}

function recordDispatchCompatibility(record, result) {
  if (!record || !result) return;
  if (!record.requestSummary) record.requestSummary = {};
  if (Array.isArray(result.rectifiers) && result.rectifiers.length) {
    record.requestSummary.rectifiers = result.rectifiers;
  }
  if (result.errorClass) record.requestSummary.errorClass = result.errorClass;
  if (result.requestOverrides) record.requestSummary.requestOverrides = result.requestOverrides;
}

function emitTraceStart(emit, record) {
  if (!record || typeof emit !== "function") return;
  emit({
    ...record,
    level: "info",
    msg: "request started",
    traceLog: true,
    requestLog: false,
    phase: "request",
  });
}

function recordPrompt(record, messages) {
  if (!record || !Array.isArray(messages)) return;
  const text = messages
    .filter((message) => message?.role === "user")
    .map((message) => previewText(message.content))
    .filter(Boolean)
    .slice(-3)
    .join("\n---\n");
  if (text) record.promptPreview = text;
}

function responsePreview(payload) {
  if (!payload || typeof payload !== "object") return "";
  const chat = payload.choices?.[0]?.message?.content;
  if (chat) return previewText(chat);
  const output = payload.output;
  if (Array.isArray(output)) return previewText(output.flatMap((item) => item.content || []).map((item) => item.text || item.output_text || "").filter(Boolean).join("\n"));
  const content = payload.content;
  if (Array.isArray(content)) return previewText(content.map((item) => item.text || item.content || "").filter(Boolean).join("\n"));
  return "";
}

function recordResponsePreview(record, payload) {
  if (!record) return;
  const text = responsePreview(payload);
  if (text) record.responsePreview = text;
}

function recordUsage(record, payload) {
  if (!record) return;
  const usage = payload?.usage || {};
  const prompt = firstNumber(usage.prompt_tokens, usage.input_tokens);
  const completion = firstNumber(usage.completion_tokens, usage.output_tokens);
  record.promptTokens = prompt;
  record.completionTokens = completion;
  record.totalTokens = firstNumber(usage.total_tokens, prompt + completion);
}

function requestPayloadError(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload.slice(0, 300);
  return payload.error?.message || payload.error || payload.message || "";
}

function emitRequestError(record, requestedModel, message) {
  if (!record) return;
  record.requestedModel = requestedModel || "";
  record.error = message;
  record.responseSummary = summarizeResponse(null, { status: 400, error: message });
}

async function handleChat(config, req, res, clientId, emit, requestRecord) {
  const body = await readJsonBody(req);
  const route = resolveRoute(config, body.model || "", { clientId });
  if (!route) {
    emitRequestError(requestRecord, body.model, `No route for model ${body.model || "(empty)"}`);
    json(res, 400, { error: `No route for model ${body.model || "(empty)"}` });
    return;
  }
  recordRoute(requestRecord, route, body.model);
  const routing = nativeRoutingDecision(route.provider, CLIENT_PROTOCOL.chat);
  if (!routing.ok) {
    rejectRoutingError(res, requestRecord, routing);
    return;
  }
  let chatBody = { ...body, _modelId: route.model.id };
  recordPrompt(requestRecord, chatBody.messages);
  chatBody = await applyVisionFallback(config, route, chatBody, { clientId });
  setVisionHeader(res, chatBody);
  recordRequestSummary(requestRecord, chatBody, route, "openai_chat");
  emitTraceStart(emit, requestRecord);
  if (body.stream) {
    // 流式支持 openai_chat 直通和 anthropic_messages 翻译两种模式。
    const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId, model: route.model, stream: true, proxyUrl: route.model.proxyUrl });
    if (result.kind === "stream") {
      recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
      if (result.translate === "anthropic") {
        // Anthropic SSE → OpenAI Chat SSE 实时翻译
        return streamAnthropicAsChat(result.upstream, res, body.model);
      }
      // openai_chat 直通
      return pipeStream(result.upstream, res, { provider: route.provider, model: route.model });
    }
    // 上游不支持流式或返回错误，fallback 到非流式 + 合成 SSE
    if (result.kind === "error") {
      requestRecord.error = requestPayloadError(result.payload) || `status ${result.status}`;
      recordResponseSummary(requestRecord, result.payload, { stream: true, status: result.status, error: requestRecord.error });
      json(res, result.status, result.payload);
      return;
    }
    // 非预期情况，fallback 到非流式
    const responsePayload = result.rawPayload || result.payload;
    recordUsage(requestRecord, responsePayload);
    recordResponsePreview(requestRecord, responsePayload);
    recordResponseSummary(requestRecord, responsePayload, { stream: true, status: result.status });
    emit({ level: "info", msg: "chat", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat, syntheticStream: true });
    return streamChatPayloadAsSse(res, result.payload, body.model);
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
  recordDispatchCompatibility(requestRecord, result);
  if (result.kind === "error") {
    requestRecord.error = requestPayloadError(result.payload) || `status ${result.status}`;
    recordResponseSummary(requestRecord, result.payload, { status: result.status, error: requestRecord.error });
    json(res, result.status, result.payload);
    return;
  }
  const responsePayload = result.rawPayload || result.payload;
  recordUsage(requestRecord, responsePayload);
  recordResponsePreview(requestRecord, responsePayload);
  recordResponseSummary(requestRecord, responsePayload, { status: result.status });
  res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result.payload));
  emit({ level: "info", msg: "chat", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat });
}

async function handleResponses(config, req, res, clientId, emit, requestRecord) {
  const body = await readJsonBody(req);
  const route = resolveRoute(config, body.model || "", { clientId });
  if (!route) {
    emitRequestError(requestRecord, body.model, `No route for model ${body.model || "(empty)"}`);
    json(res, 400, { error: `No route for model ${body.model || "(empty)"}` });
    return;
  }
  recordRoute(requestRecord, route, body.model);
  const apiFormat = route.provider.apiFormat || "openai_chat";
  const routing = nativeRoutingDecision(route.provider, CLIENT_PROTOCOL.responses);
  if (!routing.ok) {
    rejectRoutingError(res, requestRecord, routing);
    return;
  }
  if (routing.native) {
    recordRequestSummary(requestRecord, { ...responsesToChat(body, route.upstreamModel), _modelId: route.model.id }, route, "openai_responses");
    emitTraceStart(emit, requestRecord);
    const upstreamBody = { ...body, model: route.upstreamModel, _modelId: route.model.id };
    if (body.stream) {
      const dispatchNativeStream = async () => {
        const next = await dispatchResponses(route.provider, route.upstreamModel, upstreamBody, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
        if (next.kind !== "stream") {
          if (next.kind === "error") throw new Error(requestPayloadError(next.payload) || `status ${next.status}`);
          throw new Error("native Responses retry did not return a stream");
        }
        return next.upstream;
      };
      const upstream = await dispatchNativeStream();
      recordResponseSummary(requestRecord, null, { stream: true, status: upstream?.status || 0 });
      return pipeRawStream(upstream, res, {
        protocol: "responses",
        model: body.model,
        retryUpstream: dispatchNativeStream,
        onStreamSummary: (summary) => {
          recordStreamDiagnostics(requestRecord, summary, { status: upstream?.status || 0 });
        },
        onError: (err) => {
          requestRecord.error = errorMessage(err);
          recordResponseSummary(requestRecord, null, { stream: true, status: upstream?.status || 0, error: requestRecord.error });
        }
      });
    }
    const result = await dispatchResponses(route.provider, route.upstreamModel, upstreamBody, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
    recordDispatchCompatibility(requestRecord, result);
    if (result.kind === "error") {
      requestRecord.error = requestPayloadError(result.payload) || `status ${result.status}`;
      recordResponseSummary(requestRecord, result.payload, { status: result.status, error: requestRecord.error });
      json(res, result.status, result.payload);
      return;
    }
    const responsePayload = result.rawPayload || result.payload;
    recordUsage(requestRecord, responsePayload);
    recordResponsePreview(requestRecord, responsePayload);
    recordResponseSummary(requestRecord, responsePayload, { status: result.status });
    json(res, result.status || 200, responsePayload);
    emit({ level: "info", msg: "responses", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat, nativeResponses: true, routingMode: routing.mode });
    return;
  }
  let chatBody = { ...responsesToChat(body, route.upstreamModel), _modelId: route.model.id };
  const namespaceMap = extractNamespaceMap(body.tools);
  recordPrompt(requestRecord, chatBody.messages);
  chatBody = await applyVisionFallback(config, route, chatBody, { clientId });
  setVisionHeader(res, chatBody);
  recordRequestSummary(requestRecord, chatBody, route, "openai_responses");
  emitTraceStart(emit, requestRecord);
  if (body.stream) {
    if (apiFormat === "openai_responses") {
      const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
      if (result.kind === "stream" && result.translate === "responses") {
        recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
        return pipeRawStream(result.upstream, res, {
          protocol: "responses",
          model: body.model,
          onStreamSummary: (summary) => {
            recordStreamDiagnostics(requestRecord, summary, { status: result.upstream?.status || 0 });
          },
          onError: (err) => {
            requestRecord.error = errorMessage(err);
            recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0, error: requestRecord.error });
          }
        });
      }
    }
    if (apiFormat !== "openai_chat") {
      const fallback = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: false }, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
      recordDispatchCompatibility(requestRecord, fallback);
      if (fallback.kind === "error") {
        requestRecord.error = requestPayloadError(fallback.payload) || `status ${fallback.status}`;
        recordResponseSummary(requestRecord, fallback.payload, { status: fallback.status, error: requestRecord.error });
        json(res, fallback.status, fallback.payload);
        return;
      }
      const responsePayload = fallback.rawPayload || fallback.payload;
      recordUsage(requestRecord, responsePayload);
      recordResponsePreview(requestRecord, responsePayload);
      recordResponseSummary(requestRecord, responsePayload, { stream: true, status: fallback.status });
      emit({ level: "info", msg: "responses", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat, syntheticStream: true });
      return streamResponsePayload(res, chatToResponse(fallback.payload, body.model, { namespaceMap }));
    }
    const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
    if (!result.upstream?.ok) {
      const payload = await readJsonResponse(result.upstream);
      requestRecord.error = requestPayloadError(payload) || `status ${result.upstream?.status || 0}`;
      recordResponseSummary(requestRecord, payload, { stream: true, status: result.upstream?.status || 0, error: requestRecord.error });
      json(res, result.upstream?.status || 502, payload);
      return;
    }
    recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
    return streamChatAsResponses(result.upstream, res, body.model, { namespaceMap });
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
  recordDispatchCompatibility(requestRecord, result);
  if (result.kind === "error") {
    requestRecord.error = requestPayloadError(result.payload) || `status ${result.status}`;
    recordResponseSummary(requestRecord, result.payload, { status: result.status, error: requestRecord.error });
    json(res, result.status, result.payload);
    return;
  }
  const responsePayload = result.rawPayload || result.payload;
  recordUsage(requestRecord, responsePayload);
  recordResponsePreview(requestRecord, responsePayload);
  recordResponseSummary(requestRecord, responsePayload, { status: result.status });
  json(res, 200, chatToResponse(result.payload, body.model, { namespaceMap }));
  emit({ level: "info", msg: "responses", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat });
}

function streamResponsePayload(res, payload) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const response = { ...payload, status: "in_progress" };
  writeSse(res, "response.created", { type: "response.created", response });
  const output = Array.isArray(payload.output) ? payload.output : [];
  output.forEach((item, outputIndex) => {
    writeSse(res, "response.output_item.added", { type: "response.output_item.added", output_index: outputIndex, item: { ...item, status: "in_progress" } });
    if (item.type === "message") {
      const parts = Array.isArray(item.content) ? item.content : [];
      parts.forEach((part, contentIndex) => {
        writeSse(res, "response.content_part.added", { type: "response.content_part.added", item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { ...part, text: "" } });
        if (part.type === "output_text" && part.text) {
          writeSse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text });
          writeSse(res, "response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text });
        }
        writeSse(res, "response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: outputIndex, content_index: contentIndex, part });
      });
    }
    writeSse(res, "response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item });
  });
  writeSse(res, "response.completed", { type: "response.completed", response: payload });
  res.write("data: [DONE]\n\n");
  res.end();
}

// 合成 Chat SSE 流（将完整 chat completion payload 拆成 SSE 事件序列）
function streamChatPayloadAsSse(res, payload, requestedModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const id = payload?.id || `chatcmpl_${crypto.randomUUID()}`;
  const created = payload?.created || Math.floor(Date.now() / 1000);
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || {};
  const writeChunk = (delta, finishReason = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })}\n\n`);
  };
  // 起始 chunk
  writeChunk({ role: "assistant", content: "" });
  // 文本内容
  const text = contentToText(message.content);
  if (text) writeChunk({ content: text });
  // tool_calls
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc, index) => {
      writeChunk({
        tool_calls: [{
          index,
          id: tc.id || `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: tc.function?.name || "", arguments: tc.function?.arguments || "" }
        }]
      });
    });
  }
  // 结束 chunk
  writeChunk({}, choice.finish_reason || "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function shouldRetryStreamError(err) {
  const code = err?.cause?.code || err?.code || "";
  return ["HPE_INVALID_EOF_STATE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ECONNABORTED", "EPIPE", "ETIMEDOUT"].includes(code) ||
    /HPE_INVALID_EOF_STATE|UND_ERR_CONNECT_TIMEOUT|fetch failed|terminated|socket|disconnect|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|connect timeout/i.test(errorMessage(err));
}

function writeRawStreamHeaders(res, upstream) {
  if (res.headersSent) return;
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
}

function chunkHasBytes(chunk) {
  return Boolean((typeof chunk === "string" && chunk.length) || chunk?.byteLength || chunk?.length);
}

function streamTerminalSeen(text) {
  return /(?:^|\n)event:\s*response\.(?:completed|failed|cancelled)\s*(?:\n|$)/.test(text) ||
    /(?:^|\n)data:\s*\[DONE\]\s*(?:\n|$)/.test(text);
}

function streamMeaningfulResponsesEventSeen(text) {
  return /(?:^|\n)event:\s*response\.(?:output_text|content_part|output_item|function_call|reasoning|reasoning_summary)[^\n]*\s*(?:\n|$)/.test(text) ||
    /"type"\s*:\s*"response\.(?:output_text|content_part|output_item|function_call|reasoning|reasoning_summary)[^"]*"/.test(text);
}

function createStreamDiagnostics(protocol) {
  if (protocol !== "responses") return null;
  return {
    protocol,
    chunkCount: 0,
    byteCount: 0,
    eventCounts: {},
    dataTypeCounts: {},
    doneCount: 0,
    retryCount: 0,
    preludeRetryCount: 0,
    sawTerminalEvent: false,
    sawMeaningfulEvent: false,
    _lineBuffer: "",
    _eventName: "message"
  };
}

function incrementCounter(target, key) {
  if (!target || !key) return;
  target[key] = (target[key] || 0) + 1;
}

function parseJsonType(data) {
  try {
    const parsed = JSON.parse(data);
    return typeof parsed?.type === "string" ? parsed.type : "json_without_type";
  } catch {
    return "non_json";
  }
}

function observeResponsesStreamText(diag, text) {
  if (!diag || !text) return;
  diag._lineBuffer += text;
  const lines = diag._lineBuffer.split(/\r?\n/);
  diag._lineBuffer = lines.pop() || "";
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line) {
      diag._eventName = "message";
      continue;
    }
    if (line.startsWith(":")) {
      incrementCounter(diag.eventCounts, "comment");
      continue;
    }
    if (line.startsWith("event:")) {
      diag._eventName = line.slice(6).trim() || "message";
      incrementCounter(diag.eventCounts, diag._eventName);
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      diag.doneCount += 1;
      incrementCounter(diag.dataTypeCounts, "[DONE]");
      continue;
    }
    incrementCounter(diag.dataTypeCounts, parseJsonType(data));
  }
}

function publicStreamDiagnostics(diag, extra = {}) {
  if (!diag) return null;
  return {
    protocol: diag.protocol,
    chunkCount: diag.chunkCount,
    byteCount: diag.byteCount,
    eventCounts: diag.eventCounts,
    dataTypeCounts: diag.dataTypeCounts,
    doneCount: diag.doneCount,
    retryCount: diag.retryCount,
    preludeRetryCount: diag.preludeRetryCount,
    sawTerminalEvent: Boolean(extra.sawTerminalEvent ?? diag.sawTerminalEvent),
    sawMeaningfulEvent: Boolean(extra.sawMeaningfulEvent ?? diag.sawMeaningfulEvent)
  };
}

async function pipeRawStream(upstream, res, { protocol = "", model = "", onError = null, retryUpstream = null, onStreamSummary = null } = {}) {
  writeRawStreamHeaders(res, upstream);
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(`: switchyard keepalive ${Date.now()}\n\n`);
  }, 15_000);
  heartbeat.unref?.();
  let wroteUpstreamChunk = false;
  let sawTerminalEvent = false;
  let sawMeaningfulEvent = false;
  let scanTail = "";
  const decoder = new TextDecoder();
  const streamDiagnostics = createStreamDiagnostics(protocol);
  let retried = false;
  let pendingPreludeChunks = [];
  let pendingPreludeBytes = 0;
  const bufferResponsesPrelude = protocol === "responses";
  const preludeBufferLimit = 128 * 1024;
  const writeChunk = (chunk) => {
    if (bufferResponsesPrelude && !sawMeaningfulEvent && !sawTerminalEvent && pendingPreludeBytes < preludeBufferLimit) {
      pendingPreludeChunks.push(chunk);
      pendingPreludeBytes += chunk?.byteLength || chunk?.length || 0;
      return;
    }
    if (pendingPreludeChunks.length) {
      for (const pending of pendingPreludeChunks) res.write(pending);
      pendingPreludeChunks = [];
      pendingPreludeBytes = 0;
    }
    res.write(chunk);
  };
  const resetBufferedPrelude = () => {
    pendingPreludeChunks = [];
    pendingPreludeBytes = 0;
  };
  try {
    while (true) {
      try {
        if (!upstream.body) return;
        for await (const chunk of upstream.body) {
          if (chunkHasBytes(chunk)) wroteUpstreamChunk = true;
          if (streamDiagnostics) {
            streamDiagnostics.chunkCount += 1;
            streamDiagnostics.byteCount += chunk?.byteLength || chunk?.length || 0;
          }
          const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
          if (text) {
            observeResponsesStreamText(streamDiagnostics, text);
            const scan = `${scanTail}${text}`;
            if (streamTerminalSeen(scan)) sawTerminalEvent = true;
            if (streamMeaningfulResponsesEventSeen(scan)) sawMeaningfulEvent = true;
            if (streamDiagnostics) {
              streamDiagnostics.sawTerminalEvent = sawTerminalEvent;
              streamDiagnostics.sawMeaningfulEvent = sawMeaningfulEvent;
            }
            scanTail = scan.slice(-256);
          }
          writeChunk(chunk);
        }
        if (protocol === "responses" && wroteUpstreamChunk && !sawTerminalEvent) {
          throw new Error("Responses stream disconnected before completion");
        }
        if (pendingPreludeChunks.length) {
          for (const pending of pendingPreludeChunks) res.write(pending);
          resetBufferedPrelude();
        }
        return;
      } catch (err) {
        if (sawTerminalEvent && shouldRetryStreamError(err)) return;
        if (!sawMeaningfulEvent && !retried && typeof retryUpstream === "function" && shouldRetryStreamError(err)) {
          retried = true;
          if (streamDiagnostics) {
            streamDiagnostics.retryCount += 1;
            streamDiagnostics.preludeRetryCount += 1;
          }
          sawTerminalEvent = false;
          wroteUpstreamChunk = false;
          scanTail = "";
          resetBufferedPrelude();
          upstream = await retryUpstream(err);
          writeRawStreamHeaders(res, upstream);
          continue;
        }
        if (sawMeaningfulEvent && !sawTerminalEvent && shouldRetryStreamError(err)) {
          return;
        }
        try { if (typeof onError === "function") onError(err); } catch {}
        writeStreamError(res, err, { protocol, model });
        return;
      }
    }
  } catch (err) {
    try { if (typeof onError === "function") onError(err); } catch {}
    writeStreamError(res, err, { protocol, model });
  } finally {
    try {
      if (typeof onStreamSummary === "function") {
        onStreamSummary(publicStreamDiagnostics(streamDiagnostics, { sawTerminalEvent, sawMeaningfulEvent }));
      }
    } catch {}
    clearInterval(heartbeat);
    res.end();
  }
}

function writeStreamError(res, err, { protocol = "", model = "" } = {}) {
  if (res.destroyed || res.writableEnded) return;
  const message = errorMessage(err);
  res.write("\n\n");
  writeSse(res, "error", {
    type: "error",
    error: {
      type: "upstream_stream_error",
      message
    }
  });
  if (protocol === "responses") {
    const response = {
      id: `resp_failed_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      model,
      output: [],
      error: {
        type: "upstream_stream_error",
        message
      }
    };
    writeSse(res, "response.failed", { type: "response.failed", response });
  }
  res.write("data: [DONE]\n\n");
}

async function handleAnthropicMessages(config, req, res, clientId, emit, requestRecord) {
  const body = await readJsonBody(req);
  const route = resolveRoute(config, body.model || "", { clientId });
  if (!route) {
    emitRequestError(requestRecord, body.model, `No route for model ${body.model || "(empty)"}`);
    json(res, 400, { error: `No route for model ${body.model || "(empty)"}` });
    return;
  }
  recordRoute(requestRecord, route, body.model);
  const routing = nativeRoutingDecision(route.provider, CLIENT_PROTOCOL.messages);
  if (!routing.ok) {
    rejectRoutingError(res, requestRecord, routing);
    return;
  }
  let chatBody = { ...anthropicToChat(body, route.upstreamModel), _modelId: route.model.id };
  recordPrompt(requestRecord, chatBody.messages);
  chatBody = await applyVisionFallback(config, route, chatBody, { clientId });
  setVisionHeader(res, chatBody);
  recordRequestSummary(requestRecord, chatBody, route, "anthropic_messages");
  emitTraceStart(emit, requestRecord);
  if (body.stream) {
    if ((route.provider.apiFormat || "openai_chat") !== "openai_chat") {
      let result = null;
      try {
      result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: false }, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
      recordDispatchCompatibility(requestRecord, result);
      } catch (err) {
        requestRecord.error = errorMessage(err);
        recordResponseSummary(requestRecord, null, { stream: true, status: 0, error: requestRecord.error });
        return streamAnthropicError(res, err);
      }
      if (result.kind === "error") {
        requestRecord.error = requestPayloadError(result.payload) || `status ${result.status}`;
        recordResponseSummary(requestRecord, result.payload, { status: result.status, error: requestRecord.error });
        return streamAnthropicError(res, new Error(requestRecord.error));
      }
      const responsePayload = result.rawPayload || result.payload;
      recordUsage(requestRecord, responsePayload);
      recordResponsePreview(requestRecord, responsePayload);
      recordResponseSummary(requestRecord, responsePayload, { stream: true, status: result.status });
      return streamMessageAsAnthropic(chatToAnthropic(result.payload, body.model), res);
    }
    const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
    recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
    return streamChatAsAnthropic(result.upstream, res, body.model);
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId, model: route.model, proxyUrl: route.model.proxyUrl });
  recordDispatchCompatibility(requestRecord, result);
  if (result.kind === "error") {
    requestRecord.error = requestPayloadError(result.payload) || `status ${result.status}`;
    recordResponseSummary(requestRecord, result.payload, { status: result.status, error: requestRecord.error });
    json(res, result.status, result.payload);
    return;
  }
  const responsePayload = result.rawPayload || result.payload;
  recordUsage(requestRecord, responsePayload);
  recordResponsePreview(requestRecord, responsePayload);
  recordResponseSummary(requestRecord, responsePayload, { status: result.status });
  json(res, 200, chatToAnthropic(result.payload, body.model));
  emit({ level: "info", msg: "messages", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat });
}

function setVisionHeader(res, chatBody) {
  if (!chatBody?._switchyardVision || res.headersSent) return;
  res.setHeader("X-Switchyard-Vision", encodeURIComponent(JSON.stringify(chatBody._switchyardVision)));
}

async function pipeStream(upstream, res, ctx) {
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  if (!upstream.body) { res.end(); return; }
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      // SSE lines separated by \n; process complete lines
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line) { res.write("\n"); continue; }
        const transformed = ctx ? applyStreamLine(line, ctx) : line;
        if (transformed == null) continue;
        res.write(transformed + "\n");
      }
    }
    if (buf) {
      const transformed = ctx ? applyStreamLine(buf, ctx) : buf;
      if (transformed != null) res.write(transformed);
    }
  } catch (err) {
    writeStreamError(res, err);
  }
  res.end();
}

export function startServer({ host, port, onLog } = {}) {
  const config = loadConfig();
  const server = createServer({ onLog });
  const actualHost = host || config.host || "127.0.0.1";
  const actualPort = Number(port || config.port || 17888);
  return new Promise((resolve) => {
    server.listen(actualPort, actualHost, () => {
      const addr = server.address();
      const realPort = typeof addr === "object" && addr ? addr.port : actualPort;
      console.error(`[switchyard] listening on http://${actualHost}:${realPort}`);
      resolve({ server, host: actualHost, port: realPort });
    });
  });
}

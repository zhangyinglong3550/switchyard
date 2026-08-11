// HTTP gateway server. Provides three client-facing protocol entry points and
// fans every request out to a single canonical chat-style call, regardless of
// what upstream protocol the chosen provider speaks. Compat patches plug in via
// applyOutbound/applyInbound and are provider/model targeted.
import http from "node:http";
import crypto from "node:crypto";
import { loadConfig, listModelsForClient, publicModelsForClient } from "./config.mjs";
import { isDeletedProviderModelRequest, resolveRoute } from "./router.mjs";
import { activeCodexSwitchyardModel, buildCodexModelCatalog } from "./profile-writer.mjs";
import { dispatchChat, dispatchResponses } from "./upstream/dispatch.mjs";
import { recordSensitiveAudit } from "./sensitive-audit-store.mjs";
import { summarizeSensitiveHits } from "./sensitive-guard.mjs";
import { describeProtocolRoute } from "./protocol-capabilities.mjs";
import { readJsonResponse } from "./upstream/clients.mjs";
import { applyVisionFallback } from "./vision-fallback.mjs";
import { contentToText, json, readJsonBody } from "./utils.mjs";
import { previewText } from "./text-preview.mjs";
import { responsesToChat, chatToResponse, streamChatAsResponses, extractNamespaceMap } from "./openai-adapter.mjs";
import { streamResponsesAsChat } from "./openai-adapter-out.mjs";
import { anthropicToChat, chatToAnthropic, streamChatAsAnthropic, streamResponsesAsAnthropic, streamAnthropicAsChat, streamMessageAsAnthropic, streamAnthropicError, countTokensApprox } from "./anthropic-adapter.mjs";
import { registerBuiltinPatches, applyStreamLine, activePatchDescriptors } from "./compat/index.mjs";
import { applyReasoningEffortCatalog } from "./reasoning-effort-catalog.mjs";
import { captureRequestBody } from "./request-body-capture.mjs";
import { SseParser } from "./sse-parser.mjs";
import { iterateUpstreamBody } from "./stream-idle-timeout.mjs";
import { streamCompatPolicy } from "./stream-compat-policy.mjs";
import {
  CODEX_RESPONSES_HEARTBEAT_MS,
  startStreamKeepalive,
  writeCodexResponsesHeartbeat
} from "./stream-keepalive.mjs";
import {
  applyUsageToRequestRecord,
  extractUsageFromSseDataLine,
  extractUsageFromSseJson,
  mergeUsage,
  normalizeUsageObject
} from "./stream-usage.mjs";
import {
  DISCOVERY_PROBE_MODEL_ID,
  isDiscoveryProbeRequest
} from "./request-kind.mjs";
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
  { prefix: "/opencode", clientId: "opencode" },
  { prefix: "/grok", clientId: "grok" },
  { prefix: "/openai", clientId: "generic-openai" },
  { prefix: "/anthropic", clientId: "generic-openai" }
];
const REQUEST_ABORT_SIGNALS = new WeakMap();

function detectClient(req, url) {
  const headerClient = req.headers["x-switchyard-client"];
  if (typeof headerClient === "string" && headerClient) return headerClient;
  for (const { prefix, clientId } of CLIENT_PREFIXES) {
    if (url.pathname === prefix) return clientId;
    if (url.pathname.startsWith(prefix + "/")) return clientId;
  }
  return null;
}


function incomingHeadersFromReq(req) {
  return { ...(req?.headers || {}) };
}

// Codex Desktop sends its native task id on gateway requests. Retain only this
// opaque identifier (never arbitrary request headers) so the mobile controller
// can attach a gateway route to the exact Codex task.
function codexThreadCorrelation(req, clientId) {
  if (clientId !== "codex") return "";
  const headers = req?.headers || {};
  const value = headers["x-codex-parent-thread-id"] || headers["x-codex-thread-id"] || "";
  const id = Array.isArray(value) ? value[0] : value;
  return /^[0-9a-f]{8}-[0-9a-f-]{20,80}$/i.test(String(id || "").trim())
    ? String(id).trim()
    : "";
}

function sensitiveSessionKeyFromReq(req) {
  const headers = req?.headers || {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = headers[key];
      const raw = Array.isArray(value) ? value[0] : value;
      const text = String(raw || "").trim();
      if (text) return text.slice(0, 200);
    }
    return "";
  };
  return pick(
    "x-switchyard-session",
    "x-session-id",
    "x-codex-thread-id",
    "x-codex-parent-thread-id",
    "x-conversation-id"
  );
}

function dispatchOptsFromReq(req, base = {}, { config, onSensitiveAudit } = {}) {
  return {
    ...base,
    signal: REQUEST_ABORT_SIGNALS.get(req)?.signal,
    incomingHeaders: incomingHeadersFromReq(req),
    // aigo / 号池：透传 Codex App 身份头（对齐 CC Switch local proxy）
    forwardClientHeaders: true,
    sessionKey: base.sessionKey || sensitiveSessionKeyFromReq(req),
    sensitiveGuard: config?.sensitiveGuard || { enabled: true, mode: "redact" },
    requestBodyCapture: config?.requestBodyCapture || null,
    onSensitiveAudit
  };
}

function bindRequestAbort(req, res) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  req.once("aborted", () => abort(new Error("client_request_aborted")));
  req.once("close", () => {
    if (req.aborted || !req.complete) abort(new Error("client_request_closed"));
  });
  res.once("close", () => {
    if (!res.writableEnded) abort(new Error("client_response_closed"));
  });
  REQUEST_ABORT_SIGNALS.set(req, controller);
  return controller;
}

function streamCompatibility(config, route, protocol = "") {
  return streamCompatPolicy({ config, provider: route?.provider, model: route?.model, protocol });
}

function streamIdleTimeoutMs(config, route, protocol = "") {
  return streamCompatibility(config, route, protocol).idleTimeoutMs;
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
  const onSensitiveAudit = (event = {}) => {
    try {
      const recorded = recordSensitiveAudit(event);
      if (!recorded) return;
      const allowed = recorded.action === "allow";
      emit({
        level: allowed ? "info" : "warn",
        msg: allowed
          ? "sensitive guard session allow (bypass redact)"
          : "sensitive content redacted before upstream",
        sensitiveAudit: true,
        id: recorded.id,
        action: recorded.action,
        clientId: recorded.clientId,
        modelId: recorded.modelId,
        providerId: recorded.providerId,
        sessionKey: recorded.sessionKey || "",
        // 网关实时日志不带原文；完整原文只在 sensitive-audit.jsonl。
        hits: (recorded.hits || []).map(({ ruleId, type, label, count }) => ({ ruleId, type, label, count })),
        total: recorded.total,
        summary: allowed ? "会话放行" : summarizeSensitiveHits(recorded.hits)
      });
    } catch {}
  };
  const withDispatchOpts = (req, base = {}) => dispatchOptsFromReq(req, base, { config, onSensitiveAudit });

  const server = http.createServer(async (req, res) => {
    const requestAbort = bindRequestAbort(req, res);
    const start = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const clientId = detectClient(req, url);
    const path = normalizeApiPath(stripClientPrefix(url.pathname));
    const requestRecord = {
      requestLog: true,
      method: req.method,
      path: url.pathname,
      clientId: clientId || null,
      correlationThreadId: codexThreadCorrelation(req, clientId) || null
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
        await handleChat(config, req, res, clientId, emit, requestRecord, withDispatchOpts);
        return;
      }
      if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        await handleResponses(config, req, res, clientId, emit, requestRecord, withDispatchOpts);
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        await handleAnthropicMessages(config, req, res, clientId, emit, requestRecord, withDispatchOpts);
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
      REQUEST_ABORT_SIGNALS.delete(req);
      if (!res.writableEnded && !requestAbort.signal.aborted) {
        requestAbort.abort(new Error("request_finished_without_response"));
      }
      // 协议探测（列模型 / Ollama tags / props 等）无 body.model，单独标成「发现探测」
      const finished = { ...requestRecord, status: res.statusCode, ms: Date.now() - start };
      if (isDiscoveryProbeRequest(finished)) {
        finished.modelId = finished.modelId || DISCOVERY_PROBE_MODEL_ID;
        finished.requestedModel = finished.requestedModel || DISCOVERY_PROBE_MODEL_ID;
        finished.requestKind = "discovery_probe";
      }
      emit({ level: "info", msg: "request", ...finished });
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

export function nativeRoutingDecision(provider, clientProtocol) {
  const apiFormat = provider?.apiFormat || "openai_chat";
  const protocolRoute = describeProtocolRoute({ clientProtocol, provider });
  const mode = provider?.routingMode || "auto";
  if (mode === "gateway") return { ok: true, native: false, mode, apiFormat, protocolRoute };
  if (apiFormat === clientProtocol) return { ok: true, native: true, mode, apiFormat, protocolRoute };
  if (mode === "native") {
    return {
      ok: false,
      native: false,
      mode,
      apiFormat,
      protocolRoute,
      error: `Provider ${provider?.id || "(unknown)"} routingMode=native requires ${clientProtocol}, but apiFormat is ${apiFormat}`
    };
  }
  return { ok: true, native: false, mode, apiFormat, protocolRoute };
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
  if (record.routeRecovery) {
    if (!record.requestSummary) record.requestSummary = {};
    record.requestSummary.routeRecovery = record.routeRecovery;
  }
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
      // 描述宜短：长工具表会撑爆 request_summary，导致落库时 tools 整段丢失
      description: String(fn.description || tool?.description || "").slice(0, 120),
      required: Array.isArray(fn.parameters?.required) ? fn.parameters.required.slice(0, 12) : [],
      propertyCount: fn.parameters?.properties && typeof fn.parameters.properties === "object" ? Object.keys(fn.parameters.properties).length : 0
    };
  }).filter((tool) => tool.name);
}

/** 定位系统提示里的 "### Available skills" 清单段（到下一个 Markdown 标题为止）。 */
function extractAvailableSkillsSection(systemText) {
  const text = String(systemText || "");
  const match = /(?:#{1,6}\s*)?(?:Available\s+[Ss]kills?|可用\s*技能|技能列表)/.exec(text);
  if (!match) return "";
  const rest = text.slice(match.index);
  const nextHeading = rest.search(/\n#{1,6}\s+\S/);
  return nextHeading > 0 ? rest.slice(0, nextHeading) : rest.slice(0, 40000);
}

// `skill: <name>` 兜底时过滤掉明显不是技能名的通用词（防止 "description" 这类误报）
const GENERIC_SKILL_WORDS = new Set([
  "description", "name", "type", "skill", "skills", "file", "path", "usage",
  "parameters", "required", "properties", "summary", "detail", "list"
]);

function extractSkillNames(systemText) {
  const text = String(systemText || "");
  const names = new Set();

  // 1) Codex 等会在系统提示里给出 "### Available skills" 清单：
  //    `- name: 描述 (file: …/SKILL.md)`。只解析这一段，避免把 Skill roots
  //    （`- r0 = …`）或插件说明（`- Relevance: …`）误当成 Skill。
  const section = extractAvailableSkillsSection(text);
  if (section) {
    for (const line of section.split(/\r?\n/)) {
      const trimmed = line.trim();
      const match = /^[-*]\s+([A-Za-z0-9_.:@/-]{2,120}?)(?::|：)\s+/.exec(trimmed);
      if (match) names.add(match[1]);
    }
  }

  // 2) 兜底：显式 "skill: name" / "技能: name" 标记
  for (const match of text.matchAll(/(?:^|\s)(?:skill|技能)\s*[:：]\s*`?([A-Za-z0-9_.:@/-]{2,80})`?/gi)) {
    if (!GENERIC_SKILL_WORDS.has(match[1].toLowerCase())) names.add(match[1]);
  }

  // 3) 兜底：`skills/<name>` 路径（跳过路径里目录名恰为 "skills" 的段）
  for (const match of text.matchAll(/skills\/([A-Za-z0-9_.:@/-]{2,80})(?:\/SKILL\.md)?/gi)) {
    if (match[1] === "skills") continue;
    names.add(match[1]);
  }

  return Array.from(names).slice(0, 80);
}

/** Codex 等会注入伪 user（internal_context），不能当作「用户刚发的话」。 */
function isSyntheticUserText(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  if (/<codex_internal_context\b/i.test(t)) return true;
  if (/^continue working toward the active thread/i.test(t)) return true;
  if (/<recommended_plugins\b/i.test(t)) return true;
  return false;
}

function isUserLikeRole(role) {
  return Boolean(role && role !== "system" && role !== "assistant" && role !== "tool");
}

function summarizeMessages(messages) {
  const out = { system: [], user: [], assistant: [], tool: [], images: 0, roleCounts: {}, latestUser: null };
  const systemFullTexts = [];
  const list = Array.isArray(messages) ? messages : [];
  let lastMeaningfulUserIndex = -1;
  let lastUserLikeIndex = -1;
  for (let i = 0; i < list.length; i += 1) {
    const role = list[i]?.role || "event";
    if (!isUserLikeRole(role)) continue;
    lastUserLikeIndex = i;
    if (!isSyntheticUserText(contentToText(list[i]?.content || ""))) lastMeaningfulUserIndex = i;
  }
  const focusUserIndex = lastMeaningfulUserIndex >= 0 ? lastMeaningfulUserIndex : lastUserLikeIndex;
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    const role = message?.role || "event";
    out.roleCounts[role] = (out.roleCounts[role] || 0) + 1;
    out.images += imageCount(message?.content);
    const content = contentToText(message?.content || "");
    if (role === "system") systemFullTexts.push(content);
    // 最新真实用户消息用更大预算 + 头尾保留，便于调用可视化看到本轮增量
    let max = 1200;
    let strategy = "head-tail";
    if (role === "system") {
      max = 2000;
      strategy = "head";
    } else if (role === "tool") {
      max = 800;
      strategy = "head-tail";
    } else if (index === focusUserIndex) {
      max = 6000;
      strategy = "head-tail";
    } else if (isUserLikeRole(role)) {
      max = 1600;
      strategy = "head-tail";
    }
    const text = previewText(content, max, { strategy });
    const item = {
      role,
      text,
      truncated: content.length > max,
      synthetic: isUserLikeRole(role) && isSyntheticUserText(content),
      // Safe diagnostic only: retain the original size, never the full
      // tool/browser output. This distinguishes a malformed tool history from
      // an oversized transcript when an upstream returns only a generic 400.
      contentChars: content.length,
      toolCalls: Array.isArray(message?.tool_calls)
        ? message.tool_calls.map((call) => ({ name: call.function?.name || call.name || "", id: call.id || "" })).filter((call) => call.name).slice(0, 40)
        : []
    };
    if (role === "system") out.system.push(item);
    else if (role === "assistant") out.assistant.push(item);
    else if (role === "tool") out.tool.push(item);
    else out.user.push(item);
  }
  for (let i = out.user.length - 1; i >= 0; i -= 1) {
    if (!out.user[i]?.synthetic) {
      out.latestUser = out.user[i];
      break;
    }
  }
  if (!out.latestUser && out.user.length) out.latestUser = out.user[out.user.length - 1];
  // 用完整系统提示提取 Skill 名（存的是小清单；系统正文仍按截断保存，避免撑爆摘要上限）
  out.skills = extractSkillNames(systemFullTexts.join("\n"));
  return out;
}

/** 判断本请求是「新用户提问」还是「同用户轮的工具/助手续跑」。 */
function describeTurnPhase(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  let lastMeaningfulUserIndex = -1;
  let effectiveLastIndex = -1;
  for (let i = 0; i < list.length; i += 1) {
    const role = list[i]?.role || "";
    if (!role || role === "system") continue;
    const syntheticUser = isUserLikeRole(role) && isSyntheticUserText(contentToText(list[i]?.content || ""));
    if (isUserLikeRole(role) && !syntheticUser) lastMeaningfulUserIndex = i;
    // 跳过伪 user，避免把 internal_context 当成「新的一问」
    if (!syntheticUser) effectiveLastIndex = i;
  }
  const last = effectiveLastIndex >= 0 ? list[effectiveLastIndex] : null;
  const lastRole = last?.role || "";
  const continuation = Boolean(last && lastRole !== "user" && lastMeaningfulUserIndex >= 0 && effectiveLastIndex > lastMeaningfulUserIndex);
  const toolNames = [];
  if (lastRole === "assistant" && Array.isArray(last?.tool_calls)) {
    for (const call of last.tool_calls) {
      const name = call?.function?.name || call?.name || "";
      if (name) toolNames.push(name);
    }
  }
  let lastAction = "";
  if (lastRole === "tool") {
    const name = last?.name || last?.tool_name || "tool";
    const preview = previewText(last?.content || "", 120, { strategy: "head" });
    lastAction = preview ? `工具结果 ${name}: ${preview}` : `工具结果 ${name}`;
  } else if (toolNames.length) {
    lastAction = `待执行工具 ${[...new Set(toolNames)].slice(0, 4).join(", ")}`;
  } else if (lastRole === "assistant") {
    const preview = previewText(last?.content || "", 120, { strategy: "head" });
    lastAction = preview ? `助手续写: ${preview}` : "助手续跑";
  }
  const afterUser = lastMeaningfulUserIndex >= 0 ? list.slice(lastMeaningfulUserIndex + 1) : [];
  const continueSteps = afterUser.filter((item) => {
    const role = item?.role || "";
    if (!role || role === "system") return false;
    if (isUserLikeRole(role) && isSyntheticUserText(contentToText(item?.content || ""))) return false;
    return true;
  }).length;
  return {
    turnPhase: continuation ? "continue" : "user",
    continuation,
    continueSteps,
    lastRole: lastRole || "",
    lastAction
  };
}

function summarizeRequest(chatBody, route, protocol) {
  const messages = summarizeMessages(chatBody.messages || []);
  const turn = describeTurnPhase(chatBody.messages || []);
  const protocolRoute = describeProtocolRoute({
    clientProtocol: protocol,
    provider: route?.provider
  });
  // 用副本跑 catalog，只取 trace，不改原始 chatBody
  const { trace: reasoningEffortTrace } = applyReasoningEffortCatalog(
    { ...(chatBody || {}) },
    { provider: route?.provider, model: route?.model }
  );
  return {
    protocol,
    modelId: route?.model?.id || "",
    upstreamModel: route?.upstreamModel || "",
    providerId: route?.provider?.id || "",
    conversionChain: {
      mode: protocolRoute.mode,
      lossless: protocolRoute.lossless,
      steps: protocolRoute.steps,
      features: protocolRoute.features
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
      toolChoice: chatBody.tool_choice,
      // 思考档位：便于对照日志验证是否传到网关（chat→Responses 透传依赖这些字段）
      reasoning: chatBody.reasoning,
      reasoningEffort: chatBody.reasoning_effort
        ?? (chatBody.reasoning && typeof chatBody.reasoning === "object" ? chatBody.reasoning.effort : undefined),
      thinking: chatBody.thinking,
      enableThinking: chatBody.enable_thinking,
      reasoningSplit: chatBody.reasoning_split
    },
    reasoningEffortTrace: chatBody?._switchyardReasoningEffortTrace || reasoningEffortTrace || null,
    messages,
    turnPhase: turn.turnPhase,
    continuation: turn.continuation,
    continueSteps: turn.continueSteps,
    lastAction: turn.lastAction,
    lastRole: turn.lastRole,
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
  // 复用 stream-usage 完整归一（含 cache），摘要里同时保留 camelCase 供 UI
  const normalized = normalizeUsageObject(usage);
  if (!normalized) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  }
  return {
    promptTokens: normalized.prompt_tokens,
    completionTokens: normalized.completion_tokens,
    totalTokens: normalized.total_tokens,
    cacheReadTokens: normalized.cache_read_tokens,
    cacheCreationTokens: normalized.cache_creation_tokens,
    // snake_case 兼容落库 / 旧读者
    prompt_tokens: normalized.prompt_tokens,
    completion_tokens: normalized.completion_tokens,
    total_tokens: normalized.total_tokens,
    cache_read_tokens: normalized.cache_read_tokens,
    cache_creation_tokens: normalized.cache_creation_tokens
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

function recordRequestSummary(record, chatBody, route, protocol, config = null) {
  if (!record) return;
  record.requestSummary = summarizeRequest(chatBody, route, protocol);
  maybeCaptureRequestBody(record, chatBody, route, protocol, config);
}

function maybeCaptureRequestBody(record, chatBody, route, protocol, config) {
  if (!record || !config?.requestBodyCapture?.enabled) return;
  try {
    const captured = captureRequestBody({
      body: chatBody,
      captureConfig: config.requestBodyCapture,
      sensitiveGuard: config.sensitiveGuard,
      meta: {
        protocol,
        clientId: record.clientId || "",
        modelId: route?.model?.id || record.modelId || "",
        providerId: route?.provider?.id || record.providerId || "",
        upstreamModel: route?.upstreamModel || record.upstreamModel || "",
        path: record.path || "",
        method: record.method || ""
      }
    });
    if (!captured?.ref) return;
    record.requestBodyRef = captured.ref;
    if (!record.requestSummary) record.requestSummary = {};
    record.requestSummary.requestBodyCapture = {
      ref: captured.ref,
      truncated: Boolean(captured.truncated),
      originalBytes: captured.originalBytes,
      storedBytes: captured.storedBytes
    };
  } catch {
    // 调试落盘失败不能影响主请求
  }
}


function shouldCaptureClaudeDebug(record) {
  return process.env.SWITCHYARD_CAPTURE_CLAUDE_GPT54 === "1" &&
    record?.clientId === "claude-code" &&
    record?.requestedModel === "claude-switchyard-gpt-gpt-5.4-02ad2dbb";
}

function debugCapturePath(kind) {
  return path.join(os.homedir(), "file", "codex", `switchyard-${kind}.jsonl`);
}

function appendDebugCapture(kind, payload) {
  try {
    fs.mkdirSync(path.join(os.homedir(), "file", "codex"), { recursive: true });
    fs.appendFileSync(debugCapturePath(kind), `${JSON.stringify(payload)}
`);
  } catch {}
}

function maybeCaptureClaudeDebugRequest(record, body, route, protocol) {
  if (!shouldCaptureClaudeDebug(record)) return;
  appendDebugCapture("claude-gpt54-request", {
    ts: new Date().toISOString(),
    clientId: record?.clientId || "",
    requestedModel: record?.requestedModel || "",
    providerId: route?.provider?.id || "",
    upstreamModel: route?.upstreamModel || "",
    protocol,
    body
  });
}

function maybeCaptureClaudeDebugResponse(record, payload, meta = {}) {
  if (!shouldCaptureClaudeDebug(record)) return;
  appendDebugCapture("claude-gpt54-response", {
    ts: new Date().toISOString(),
    clientId: record?.clientId || "",
    requestedModel: record?.requestedModel || "",
    meta,
    payload
  });
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
  // 流式 usage：优先 diag 解析到的 usage（含 cache），再回退空
  const streamUsage = summary?.usage
    ? normalizeResponseUsage(summary.usage)
    : normalizeResponseUsage(null);
  const sampledText = previewText(summary?.textSample || "", 800, { strategy: "head-tail", headRatio: 0.3 });
  return {
    stream: true,
    status,
    text: sampledText,
    reasoning: "",
    toolCalls,
    finishReason: summary?.terminalState || (summary?.sawTerminalEvent ? "completed" : "incomplete"),
    usage: streamUsage,
    error,
    streamTerminal: summary?.terminalState ? {
      state: summary.terminalState,
      reason: summary.terminalReason || ""
    } : null,
    // diagnostics 只留计数/状态，不回写原文采样（避免敏感内容进 requestSummary.streamDiagnostics）
    streamDiagnostics: sanitizeStreamDiagnostics(summary),
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

function sanitizeStreamDiagnostics(summary) {
  if (!summary || typeof summary !== "object") return summary || null;
  const { textSample, ...safe } = summary;
  return {
    ...safe,
    textSampleChars: typeof textSample === "string" ? textSample.length : 0
  };
}

function recordStreamDiagnostics(record, summary, { status = 0, error = "" } = {}) {
  if (!record || !summary) return;
  if (!record.requestSummary) record.requestSummary = {};
  record.requestSummary.streamDiagnostics = sanitizeStreamDiagnostics(summary);
  // 把流式解析到的 usage 落到 requestRecord 顶层，request_logs 入库才能汇总 Token
  if (summary.usage) applyUsageToRequestRecord(record, summary.usage);
  record.responseSummary = responseSummaryFromStreamDiagnostics(summary, { status, error: error || record.error || "" });
  if (record.responseSummary?.text && !record.responsePreview) {
    record.responsePreview = record.responseSummary.text;
  }
}

function recordDispatchCompatibility(record, result) {
  if (!record || !result) return;
  if (!record.requestSummary) record.requestSummary = {};
  if (Array.isArray(result.rectifiers) && result.rectifiers.length) {
    record.requestSummary.rectifiers = result.rectifiers;
  }
  if (result.errorClass) record.requestSummary.errorClass = result.errorClass;
  if (result.requestOverrides) record.requestSummary.requestOverrides = result.requestOverrides;
  // 网关同模型重试：写入 request 记录，便于日志与排查
  if (Number.isFinite(Number(result.retryCount)) && Number(result.retryCount) > 0) {
    record.retryCount = Number(result.retryCount);
    record.requestSummary.dispatchRetryCount = Number(result.retryCount);
    if (Array.isArray(result.retryAttempts) && result.retryAttempts.length) {
      record.requestSummary.dispatchRetryAttempts = result.retryAttempts;
    }
  }
  if (result.outboundRequestBodyRef) {
    record.requestSummary.outboundRequestBodyCapture = { ref: String(result.outboundRequestBodyRef) };
  }
  if (result.accountId) {
    record.accountId = result.accountId;
    record.requestSummary.accountId = result.accountId;
    if (result.accountEmail) {
      record.accountEmail = result.accountEmail;
      record.requestSummary.accountEmail = result.accountEmail;
    }
  }
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
  // 只保留最近一条真实用户消息，跳过 codex_internal_context 等伪 user
  const users = messages.filter((message) => isUserLikeRole(message?.role));
  let latest = null;
  for (let i = users.length - 1; i >= 0; i -= 1) {
    if (!isSyntheticUserText(contentToText(users[i]?.content || ""))) {
      latest = users[i];
      break;
    }
  }
  if (!latest) latest = users[users.length - 1];
  const text = latest ? previewText(latest.content, 2000, { strategy: "head-tail", headRatio: 0.25 }) : "";
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
  // 兼容 chat/responses/anthropic 的 usage 字段名
  applyUsageToRequestRecord(record, payload?.usage || payload);
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

function resolveDeletedCodexTaskRoute(config, requestedModel, clientId) {
  if (clientId !== "codex" || !isDeletedProviderModelRequest(config, requestedModel)) return null;
  const fallbackModel = activeCodexSwitchyardModel();
  if (!fallbackModel || fallbackModel === String(requestedModel || "").trim()) return null;
  const route = resolveRoute(config, fallbackModel, { clientId });
  return route ? { route, fallbackModel } : null;
}

function resolveRequestRoute(config, requestedModel, clientId, requestRecord, emit) {
  const direct = resolveRoute(config, requestedModel, { clientId });
  if (direct) return direct;
  const recovery = resolveDeletedCodexTaskRoute(config, requestedModel, clientId);
  if (!recovery) return null;
  if (requestRecord) requestRecord.routeRecovery = "deleted-codex-provider";
  if (typeof emit === "function") {
    emit({
      level: "warn",
      msg: "recovered deleted Codex task model route",
      clientId,
      requestedModel: requestedModel || "",
      fallbackModel: recovery.fallbackModel,
      modelId: recovery.route.model.id,
      providerId: recovery.route.provider.id
    });
  }
  return recovery.route;
}

async function handleChat(config, req, res, clientId, emit, requestRecord, withDispatchOpts = dispatchOptsFromReq) {
  const body = await readJsonBody(req);
  const route = resolveRequestRoute(config, body.model || "", clientId, requestRecord, emit);
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
  recordRequestSummary(requestRecord, chatBody, route, "openai_chat", config);
  emitTraceStart(emit, requestRecord);
  if (body.stream) {
    // 流式支持 openai_chat 直通和 anthropic_messages 翻译两种模式。
    const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, withDispatchOpts(req, { clientId, model: route.model, stream: true, proxyUrl: route.model.proxyUrl }));
    recordDispatchCompatibility(requestRecord, result);
    if (result.kind === "stream") {
      recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
      if (result.translate === "anthropic") {
        // Anthropic SSE → OpenAI Chat SSE 实时翻译
        return streamAnthropicAsChat(result.upstream, res, body.model, {
          idleTimeoutMs: streamIdleTimeoutMs(config, route)
        });
      }
      if (result.translate === "responses") {
        // Responses SSE → Chat Completions SSE（Grok/OpenCode 等 chat 客户端 + GPT/Codex 上游）
        if (!result.upstream?.ok) {
          const payload = await readJsonResponse(result.upstream);
          requestRecord.error = requestPayloadError(payload) || `status ${result.upstream?.status || 0}`;
          recordResponseSummary(requestRecord, payload, { stream: true, status: result.upstream?.status || 0, error: requestRecord.error });
          json(res, result.upstream?.status || 502, payload);
          return;
        }
        return streamResponsesAsChat(result.upstream, res, body.model, {
          idleTimeoutMs: streamIdleTimeoutMs(config, route),
          onStreamSummary: (summary) => {
            recordStreamDiagnostics(requestRecord, summary, { status: result.upstream?.status || 0 });
          }
        });
      }
      // openai_chat 直通：流结束后把 usage 落库
      return pipeStream(result.upstream, res, {
        ...(result.compatContext || {}),
        provider: route.provider,
        model: route.model,
        clientId,
        idleTimeoutMs: streamIdleTimeoutMs(config, route),
        onStreamSummary: (summary) => {
          recordStreamDiagnostics(requestRecord, summary, { status: result.upstream?.status || 0 });
        }
      });
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
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
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

async function handleResponses(config, req, res, clientId, emit, requestRecord, withDispatchOpts = dispatchOptsFromReq) {
  const body = await readJsonBody(req);
  const route = resolveRequestRoute(config, body.model || "", clientId, requestRecord, emit);
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
    recordRequestSummary(requestRecord, { ...responsesToChat(body, route.upstreamModel), _modelId: route.model.id }, route, "openai_responses", config);
    emitTraceStart(emit, requestRecord);
    const upstreamBody = { ...body, model: route.upstreamModel, _modelId: route.model.id };
    if (body.stream) {
      const dispatchNativeStream = async () => {
        const next = await dispatchResponses(route.provider, route.upstreamModel, upstreamBody, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
        if (next.kind !== "stream") {
          if (next.kind === "error") throw new Error(requestPayloadError(next.payload) || `status ${next.status}`);
          throw new Error("native Responses retry did not return a stream");
        }
        return next.upstream;
      };
      const result = await dispatchResponses(route.provider, route.upstreamModel, upstreamBody, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
      recordDispatchCompatibility(requestRecord, result);
      if (result.kind !== "stream") {
        const message = result.kind === "error"
          ? (requestPayloadError(result.payload) || `status ${result.status}`)
          : "native Responses dispatcher returned an unexpected result";
        requestRecord.error = message;
        recordResponseSummary(requestRecord, result.kind === "error" ? result.payload : null, { stream: true, status: result.status || 0, error: message });
        json(res, result.status || 502, result.kind === "error" ? result.payload : { error: message });
        return;
      }
      const upstream = result.upstream;
      // 上游已是 JSON 错误体（含纠错失败）时，不要当 SSE 硬 pipe，否则 Codex 只看到 adapter_eof。
      if (!upstream?.ok) {
        const payload = await readJsonResponse(upstream);
        requestRecord.error = requestPayloadError(payload) || `status ${upstream?.status || 0}`;
        recordResponseSummary(requestRecord, payload, { stream: true, status: upstream?.status || 0, error: requestRecord.error });
        json(res, upstream?.status || 502, payload);
        return;
      }
      recordResponseSummary(requestRecord, null, { stream: true, status: upstream?.status || 0 });
      return pipeRawStream(upstream, res, {
        protocol: "responses",
        model: body.model,
        // Grok Build 的 Responses serde 强制要求 message item/content 带
        // `annotations`；部分中转上游（如 good-gpt）省略，这里只对 grok 补字段。
        injectAnnotations: clientId === "grok",
        idleTimeoutMs: streamIdleTimeoutMs(config, route),
        retryUpstream: streamCompatibility(config, route, "responses").retryPreludeOnEof
          ? async () => {
            const next = await dispatchNativeStream();
            if (!next?.ok) {
              const payload = await readJsonResponse(next);
              throw new Error(requestPayloadError(payload) || `status ${next?.status || 0}`);
            }
            return next;
          }
          : null,
        preludeRetryAttempts: streamCompatibility(config, route, "responses").preludeRetryAttempts,
        preludeRetryBackoffMs: streamCompatibility(config, route, "responses").preludeRetryBackoffMs,
        onStreamSummary: (summary) => {
          recordStreamDiagnostics(requestRecord, summary, { status: upstream?.status || 0 });
        },
        onError: (err) => {
          requestRecord.error = errorMessage(err);
          recordResponseSummary(requestRecord, null, { stream: true, status: upstream?.status || 0, error: requestRecord.error });
        }
      });
    }
    const result = await dispatchResponses(route.provider, route.upstreamModel, upstreamBody, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
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
  recordRequestSummary(requestRecord, chatBody, route, "openai_responses", config);
  emitTraceStart(emit, requestRecord);
  if (body.stream) {
    if (apiFormat === "openai_responses") {
      const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
      recordDispatchCompatibility(requestRecord, result);
      if (result.kind === "stream" && result.translate === "responses") {
        if (!result.upstream?.ok) {
          const payload = await readJsonResponse(result.upstream);
          requestRecord.error = requestPayloadError(payload) || `status ${result.upstream?.status || 0}`;
          recordResponseSummary(requestRecord, payload, { stream: true, status: result.upstream?.status || 0, error: requestRecord.error });
          json(res, result.upstream?.status || 502, payload);
          return;
        }
        recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
        return pipeRawStream(result.upstream, res, {
          protocol: "responses",
          model: body.model,
          idleTimeoutMs: streamIdleTimeoutMs(config, route),
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
    // Antigravity and Cursor subscription are normalized to Chat SSE by
    // dispatch, so they can use the same lossless Chat -> Responses bridge as
    // OpenAI-compatible providers.
    if (apiFormat !== "openai_chat" && apiFormat !== "antigravity" && apiFormat !== "cursor_subscription") {
      const fallback = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: false }, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
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
    const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
    recordDispatchCompatibility(requestRecord, result);
    if (result.kind !== "stream") {
      const message = result.kind === "error"
        ? (requestPayloadError(result.payload) || `status ${result.status}`)
        : "Responses stream dispatcher returned an unexpected result";
      requestRecord.error = message;
      recordResponseSummary(requestRecord, result.kind === "error" ? result.payload : null, { stream: true, status: result.status || 0, error: message });
      json(res, result.status || 502, result.kind === "error" ? result.payload : { error: message });
      return;
    }
    if (!result.upstream?.ok) {
      const payload = await readJsonResponse(result.upstream);
      requestRecord.error = requestPayloadError(payload) || `status ${result.upstream?.status || 0}`;
      recordResponseSummary(requestRecord, payload, { stream: true, status: result.upstream?.status || 0, error: requestRecord.error });
      json(res, result.upstream?.status || 502, payload);
      return;
    }
    recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
    return streamChatAsResponses(result.upstream, res, body.model, {
      namespaceMap,
      idleTimeoutMs: streamIdleTimeoutMs(config, route),
      // KE's Kimi K3 relay may end with a usage footer but no `[DONE]` or
      // finish_reason. Do not convert that ambiguous terminal state into a
      // successful Codex response; keep the partial output and surface it as
      // incomplete instead.
      acceptUsageFooterAsTerminal: streamCompatibility(config, route, "responses").acceptUsageFooterAsTerminal,
      onUsage: (usage) => {
        applyUsageToRequestRecord(requestRecord, usage);
        if (!requestRecord.responseSummary) requestRecord.responseSummary = {};
        requestRecord.responseSummary.usage = normalizeResponseUsage(usage);
        requestRecord.responseSummary.stream = true;
      },
      onStreamEnd: (diagnostics) => {
        if (!requestRecord.requestSummary) requestRecord.requestSummary = {};
        requestRecord.requestSummary.chatStreamTerminal = diagnostics;
        if (!requestRecord.responseSummary) requestRecord.responseSummary = {};
        requestRecord.responseSummary.chatStreamTerminal = diagnostics;
      }
    });
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
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

function createStreamDiagnostics(protocol) {
  // chat / responses 都收集 usage；responses 额外有事件计数
  return {
    protocol: protocol || "stream",
    chunkCount: 0,
    byteCount: 0,
    eventCounts: {},
    dataTypeCounts: {},
    doneCount: 0,
    retryCount: 0,
    preludeRetryCount: 0,
    sawTerminalEvent: false,
    sawMeaningfulEvent: false,
    usage: null,
    // 采样一小段输出文本，供请求日志「回」摘要（非完整落盘）
    textSample: ""
  };
}

function appendStreamTextSample(diag, piece, limit = 800) {
  if (!diag) return;
  const chunk = String(piece || "");
  if (!chunk) return;
  if (typeof diag.textSample !== "string") diag.textSample = "";
  if (diag.textSample.length >= limit) return;
  diag.textSample += chunk.slice(0, limit - diag.textSample.length);
}

function incrementCounter(target, key) {
  if (!target || !key) return;
  target[key] = (target[key] || 0) + 1;
}

function parseSseJson(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function sseDataType(data, parsed) {
  if (data === "[DONE]") return "[DONE]";
  return typeof parsed?.type === "string" ? parsed.type : (parsed ? "json_without_type" : "non_json");
}

function isResponsesTerminalEvent(eventName, dataType) {
  return dataType === "[DONE]" ||
    /^(?:response\.(?:completed|failed|cancelled))$/.test(eventName) ||
    /^(?:response\.(?:completed|failed|cancelled))$/.test(dataType);
}

function isResponsesMeaningfulEvent(eventName, dataType) {
  return /^(?:response\.(?:output_text|content_part|output_item|function_call|reasoning|reasoning_summary))/.test(eventName) ||
    /^(?:response\.(?:output_text|content_part|output_item|function_call|reasoning|reasoning_summary))/.test(dataType);
}

function isChatTerminalEvent(data, parsed) {
  if (data === "[DONE]") return true;
  return Array.isArray(parsed?.choices) && parsed.choices.some((choice) => choice?.finish_reason != null);
}

function isChatMeaningfulEvent(parsed) {
  return Array.isArray(parsed?.choices) && parsed.choices.some((choice) => {
    const delta = choice?.delta || {};
    return choice?.message || choice?.text || choice?.finish_reason != null ||
      Boolean(delta.content || delta.reasoning_content || delta.tool_calls?.length || delta.function_call);
  });
}

function observeSseEvent(diag, event, protocol) {
  const eventName = event?.event || "message";
  const data = String(event?.data || "").trim();
  const parsed = data === "[DONE]" ? null : parseSseJson(data);
  const dataType = sseDataType(data, parsed);
  if (event?.fields?.comments?.length) incrementCounter(diag.eventCounts, "comment");
  if (data || eventName !== "message") incrementCounter(diag.eventCounts, eventName);
  if (data) incrementCounter(diag.dataTypeCounts, dataType);
  if (dataType === "[DONE]") diag.doneCount += 1;
  const usage = data ? extractUsageFromSseDataLine(data) : null;
  if (usage) diag.usage = mergeUsage(diag.usage, usage);

  // 采样输出文本，避免流式请求日志「回」永远为空
  if (parsed && protocol === "chat" && Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices) {
      const delta = choice?.delta || {};
      appendStreamTextSample(diag, delta.content || choice?.message?.content || choice?.text || "");
      for (const call of delta.tool_calls || []) {
        appendStreamTextSample(diag, call?.function?.arguments || call?.arguments || "");
      }
    }
  } else if (parsed) {
    if (typeof parsed.delta === "string") appendStreamTextSample(diag, parsed.delta);
    if (typeof parsed.text === "string" && /output_text|function_call/.test(dataType)) {
      appendStreamTextSample(diag, parsed.text);
    }
  }

  const terminal = protocol === "chat"
    ? isChatTerminalEvent(data, parsed)
    : isResponsesTerminalEvent(eventName, dataType);
  const meaningful = protocol === "chat"
    ? isChatMeaningfulEvent(parsed)
    : isResponsesMeaningfulEvent(eventName, dataType);
  if (terminal) diag.sawTerminalEvent = true;
  if (meaningful) diag.sawMeaningfulEvent = true;
  return { terminal, meaningful };
}

function createSseObserver(diag, protocol, state) {
  return new SseParser((event) => {
    const observed = observeSseEvent(diag, event, protocol);
    if (observed.terminal) state.sawTerminalEvent = true;
    if (observed.meaningful) state.sawMeaningfulEvent = true;
  });
}

function consumeSseLines(state, text, { flush = false, onLine } = {}) {
  if (text) state.buffer += text;
  while (true) {
    let index = -1;
    let separatorLength = 0;
    for (let i = 0; i < state.buffer.length; i += 1) {
      const code = state.buffer.charCodeAt(i);
      if (code === 10) {
        index = i;
        separatorLength = 1;
        break;
      }
      if (code === 13) {
        if (i === state.buffer.length - 1 && !flush) return;
        index = i;
        separatorLength = state.buffer[i + 1] === "\n" ? 2 : 1;
        break;
      }
    }
    if (index < 0) break;
    onLine(state.buffer.slice(0, index));
    state.buffer = state.buffer.slice(index + separatorLength);
  }
  if (flush && state.buffer) {
    onLine(state.buffer);
    state.buffer = "";
  }
}

function markStreamTerminal(streamState, state, reason = "") {
  if (!streamState || streamState.terminalState === "completed") return;
  streamState.terminalState = state;
  streamState.terminalReason = reason;
}

function markStreamTerminalFromError(streamState, err) {
  if (streamState?.sawTerminalEvent) {
    markStreamTerminal(streamState, "completed", "protocol_terminal");
    return;
  }
  if (err?.code === "SWITCHYARD_STREAM_IDLE_TIMEOUT") {
    markStreamTerminal(streamState, "incomplete", "upstream_stall_timeout");
    return;
  }
  if (err?.code === "SWITCHYARD_INCOMPLETE_STREAM") {
    markStreamTerminal(streamState, "incomplete", "adapter_eof");
    return;
  }
  if (err?.name === "AbortError" || err?.code === "ABORT_ERR") {
    markStreamTerminal(streamState, "cancelled", "client_cancelled");
    return;
  }
  markStreamTerminal(streamState, "failed", "upstream_error");
}

function publicStreamDiagnostics(diag, extra = {}) {
  if (!diag) return null;
  const sawTerminalEvent = Boolean(extra.sawTerminalEvent ?? diag.sawTerminalEvent);
  const terminalState = extra.terminalState || (sawTerminalEvent ? "completed" : "incomplete");
  // textSample 仅供组装 responseSummary.text；写入日志前会经 sanitizeStreamDiagnostics 剥离
  return {
    protocol: diag.protocol,
    chunkCount: diag.chunkCount,
    byteCount: diag.byteCount,
    eventCounts: diag.eventCounts,
    dataTypeCounts: diag.dataTypeCounts,
    doneCount: diag.doneCount,
    retryCount: diag.retryCount,
    preludeRetryCount: diag.preludeRetryCount,
    usage: diag.usage || null,
    textSample: typeof diag.textSample === "string" ? diag.textSample.slice(0, 800) : "",
    terminalState,
    terminalReason: extra.terminalReason || (sawTerminalEvent ? "protocol_terminal" : "adapter_eof"),
    sawTerminalEvent,
    sawMeaningfulEvent: Boolean(extra.sawMeaningfulEvent ?? diag.sawMeaningfulEvent)
  };
}

// Grok Build 的 Responses SSE 被 Rust serde 严格校验：
// message 输出项 / 内容 part 必须带 `annotations` 字段，否则报
// `missing field annotations`。部分中转上游（如 good-gpt）省略该字段，
// 这里在 grok 出口侧补上，避免 break 其它客户端。仅当 clientId==="grok" 时启用。
function ensureAnnotationsField(obj) {
  if (!obj || typeof obj !== "object") return false;
  let changed = false;
  if (obj.type === "message" && !Object.prototype.hasOwnProperty.call(obj, "annotations")) {
    obj.annotations = [];
    changed = true;
  }
  if (Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (part && typeof part === "object" && !Object.prototype.hasOwnProperty.call(part, "annotations")) {
        part.annotations = [];
        changed = true;
      }
    }
  }
  return changed;
}

function normalizeResponsesAnnotationLine(line) {
  if (typeof line !== "string" || !line.startsWith("data:")) return line;
  const rest = line.startsWith("data: ") ? line.slice(6) : line.slice(5);
  if (!rest || rest === "[DONE]") return line;
  let o;
  try { o = JSON.parse(rest); } catch { return line; }
  const type = o && o.type;
  let changed = false;
  if (type === "response.output_item.added" || type === "response.output_item.done") {
    if (ensureAnnotationsField(o.item)) changed = true;
  } else if (type === "response.content_part.added" || type === "response.content_part.done") {
    if (o.part && typeof o.part === "object" && !Object.prototype.hasOwnProperty.call(o.part, "annotations")) {
      o.part.annotations = [];
      changed = true;
    }
  } else if (type === "response.created" || type === "response.in_progress" || type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const output = o.response && Array.isArray(o.response.output) ? o.response.output : [];
    for (const it of output) { if (ensureAnnotationsField(it)) changed = true; }
  }
  return changed ? "data: " + JSON.stringify(o) : line;
}

export async function pipeRawStream(upstream, res, {
  protocol = "",
  model = "",
  idleTimeoutMs,
  onError = null,
  retryUpstream = null,
  preludeRetryAttempts = 1,
  preludeRetryBackoffMs = [],
  injectAnnotations = false,
  onStreamSummary = null
} = {}) {
  writeRawStreamHeaders(res, upstream);
  const heartbeat = startStreamKeepalive(res, {
    intervalMs: protocol === "responses" ? CODEX_RESPONSES_HEARTBEAT_MS : 15_000,
    writeHeartbeat: protocol === "responses"
      ? writeCodexResponsesHeartbeat
      : (response) => response.write(`: switchyard keepalive ${Date.now()}\n\n`)
  });
  let wroteUpstreamChunk = false;
  const streamState = { sawTerminalEvent: false, sawMeaningfulEvent: false, terminalState: "", terminalReason: "" };
  // 始终建 diag，以便提取流式 usage（chat/responses 均可）
  const streamDiagnostics = createStreamDiagnostics(protocol || "responses");
  let streamObserver = createSseObserver(streamDiagnostics, protocol || "responses", streamState);
  let preludeRetries = 0;
  let pendingPreludeChunks = [];
  let pendingPreludeBytes = 0;
  const bufferResponsesPrelude = protocol === "responses";
  const preludeBufferLimit = 128 * 1024;
  const annDecoder = new TextDecoder();
  const annLineState = { buffer: "" };
  const normalizeChunk = (chunk) => {
    if (!injectAnnotations || protocol !== "responses") return chunk;
    const text = typeof chunk === "string" ? chunk : annDecoder.decode(chunk, { stream: true });
    const parts = [];
    consumeSseLines(annLineState, text, { onLine: (ln) => {
      parts.push(normalizeResponsesAnnotationLine(ln) + "\n");
    } });
    return parts.join("");
  };
  const writeChunk = (chunk) => {
    if (bufferResponsesPrelude && !streamState.sawMeaningfulEvent && !streamState.sawTerminalEvent && pendingPreludeBytes < preludeBufferLimit) {
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
        if (!upstream.body) {
          const incomplete = new Error("Responses stream ended before emitting completion");
          incomplete.code = "SWITCHYARD_INCOMPLETE_STREAM";
          throw incomplete;
        }
        for await (const chunk of iterateUpstreamBody(upstream.body, {
          timeoutMs: idleTimeoutMs,
          label: `${protocol || "Upstream"} stream`
        })) {
          heartbeat.touch();
          if (chunkHasBytes(chunk)) wroteUpstreamChunk = true;
          if (streamDiagnostics) {
            streamDiagnostics.chunkCount += 1;
            streamDiagnostics.byteCount += chunk?.byteLength || chunk?.length || 0;
          }
          streamObserver.push(chunk);
          writeChunk(normalizeChunk(chunk));
        }
        streamObserver.flush();
        if (injectAnnotations && protocol === "responses") {
          const tail = annDecoder.decode();
          if (tail) {
            const parts = [];
            consumeSseLines(annLineState, tail, { flush: true, onLine: (ln) => parts.push(normalizeResponsesAnnotationLine(ln) + "\n"), });
            if (parts.length) writeChunk(parts.join(""));
          }
        }
        if ((protocol === "responses" || upstream?.switchyardRequireTerminal) && !streamState.sawTerminalEvent) {
          const incomplete = new Error(wroteUpstreamChunk
            ? "Responses stream disconnected before completion"
            : "Responses stream ended before emitting completion");
          incomplete.code = "SWITCHYARD_INCOMPLETE_STREAM";
          throw incomplete;
        }
        if (pendingPreludeChunks.length) {
          for (const pending of pendingPreludeChunks) res.write(pending);
          resetBufferedPrelude();
        }
        markStreamTerminal(streamState, "completed", "protocol_terminal");
        return;
      } catch (err) {
        if (streamState.sawTerminalEvent) {
          markStreamTerminal(streamState, "completed", "protocol_terminal");
          return;
        }
        const retryable = shouldRetryStreamError(err) || err?.code === "SWITCHYARD_INCOMPLETE_STREAM";
        if (!streamState.sawMeaningfulEvent && preludeRetries < preludeRetryAttempts && typeof retryUpstream === "function" && retryable) {
          if (streamDiagnostics) {
            streamDiagnostics.retryCount += 1;
            streamDiagnostics.preludeRetryCount += 1;
          }
          streamState.sawTerminalEvent = false;
          streamState.sawMeaningfulEvent = false;
          wroteUpstreamChunk = false;
          streamObserver = createSseObserver(streamDiagnostics, protocol || "responses", streamState);
          resetBufferedPrelude();
          const retryDelayMs = resolvePreludeRetryDelay(preludeRetryBackoffMs, preludeRetries);
          preludeRetries += 1;
          if (retryDelayMs > 0) await delay(retryDelayMs);
          upstream = await retryUpstream(err);
          writeRawStreamHeaders(res, upstream);
          continue;
        }
        markStreamTerminalFromError(streamState, err);
        try { if (typeof onError === "function") onError(err); } catch {}
        writeStreamError(res, err, { protocol, model });
        return;
      }
    }
  } catch (err) {
    markStreamTerminalFromError(streamState, err);
    try { if (typeof onError === "function") onError(err); } catch {}
    writeStreamError(res, err, { protocol, model });
  } finally {
    try {
      if (typeof onStreamSummary === "function") {
        onStreamSummary(publicStreamDiagnostics(streamDiagnostics, streamState));
      }
    } catch {}
    heartbeat.stop();
    res.end();
  }
}

function resolvePreludeRetryDelay(backoffMs, attempt) {
  if (!Array.isArray(backoffMs) || backoffMs.length === 0) return 0;
  const value = Number(backoffMs[Math.min(Math.max(0, attempt), backoffMs.length - 1)]);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeStreamError(res, err, { protocol = "", model = "" } = {}) {
  if (res.destroyed || res.writableEnded) return;
  const message = errorMessage(err);
  if (protocol === "responses") {
    const incomplete = err?.code === "SWITCHYARD_STREAM_IDLE_TIMEOUT" ||
      err?.code === "SWITCHYARD_INCOMPLETE_STREAM";
    const response = {
      id: `resp_${incomplete ? "incomplete" : "failed"}_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: incomplete ? "incomplete" : "failed",
      model,
      output: [],
      ...(incomplete
        ? { incomplete_details: { reason: err.code === "SWITCHYARD_STREAM_IDLE_TIMEOUT" ? "upstream_stall_timeout" : "adapter_eof" } }
        : { error: { type: "upstream_stream_error", message } })
    };
    writeSse(res, incomplete ? "response.incomplete" : "response.failed", {
      type: incomplete ? "response.incomplete" : "response.failed",
      response
    });
    return;
  }
  res.write("\n\n");
  writeSse(res, "error", {
    type: "error",
    error: {
      type: "upstream_stream_error",
      message
    }
  });
}

async function handleAnthropicMessages(config, req, res, clientId, emit, requestRecord, withDispatchOpts = dispatchOptsFromReq) {
  const body = await readJsonBody(req);
  const route = resolveRequestRoute(config, body.model || "", clientId, requestRecord, emit);
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
  recordRequestSummary(requestRecord, chatBody, route, "anthropic_messages", config);
  maybeCaptureClaudeDebugRequest(requestRecord, body, route, "anthropic_messages");
  emitTraceStart(emit, requestRecord);
  if (body.stream) {
    // Anthropic upstreams can use the existing non-stream fallback. OpenAI
    // Responses must stay streaming and be translated directly below: forcing
    // them through a synthetic chat response loses partial output and turns a
    // mid-stream disconnect into a blank Claude Code turn.
    if ((route.provider.apiFormat || "openai_chat") === "anthropic_messages") {
      let result = null;
      try {
      result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: false }, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
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
      maybeCaptureClaudeDebugResponse(requestRecord, responsePayload, { status: result.status, stream: true, stage: "handleAnthropicMessages:synthetic-stream" });
      return streamMessageAsAnthropic(chatToAnthropic(result.payload, body.model), res);
    }
    const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
    if (result.kind !== "stream") {
      const message = result.kind === "error"
        ? (requestPayloadError(result.payload) || `status ${result.status}`)
        : "Anthropic stream dispatcher returned an unexpected result";
      requestRecord.error = message;
      recordResponseSummary(requestRecord, result.kind === "error" ? result.payload : null, { stream: true, status: result.status || 0, error: message });
      return streamAnthropicError(res, new Error(message));
    }
    if (!result.upstream?.ok) {
      const payload = await readJsonResponse(result.upstream);
      requestRecord.error = requestPayloadError(payload) || `status ${result.upstream.status || 502}`;
      recordResponseSummary(requestRecord, payload, { stream: true, status: result.upstream.status || 502, error: requestRecord.error });
      return streamAnthropicError(res, new Error(requestRecord.error));
    }
    recordResponseSummary(requestRecord, null, { stream: true, status: result.upstream?.status || 0 });
    if (result.translate === "responses") {
      return streamResponsesAsAnthropic(result.upstream, res, body.model, {
        idleTimeoutMs: streamIdleTimeoutMs(config, route),
        onStreamSummary: (summary) => {
          recordStreamDiagnostics(requestRecord, summary, { status: result.upstream?.status || 0 });
        }
      });
    }
    return streamChatAsAnthropic(result.upstream, res, body.model, {
      idleTimeoutMs: streamIdleTimeoutMs(config, route)
    });
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, withDispatchOpts(req, { clientId, model: route.model, proxyUrl: route.model.proxyUrl }));
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
  maybeCaptureClaudeDebugResponse(requestRecord, responsePayload, { status: result.status, stream: false, stage: "handleAnthropicMessages:json" });
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
  if (!upstream.body) {
    if (typeof ctx?.onStreamSummary === "function") {
      try {
        ctx.onStreamSummary({
          protocol: "chat",
          usage: null,
          terminalState: "incomplete",
          terminalReason: "adapter_eof",
          sawTerminalEvent: false,
          sawMeaningfulEvent: false
        });
      } catch {}
    }
    writeStreamError(res, new Error("Chat stream ended before emitting completion"), { protocol: "chat" });
    res.end();
    return;
  }
  const decoder = new TextDecoder();
  const lineState = { buffer: "" };
  const streamDiagnostics = createStreamDiagnostics("chat");
  const streamState = { sawTerminalEvent: false, sawMeaningfulEvent: false, terminalState: "", terminalReason: "" };
  const streamObserver = createSseObserver(streamDiagnostics, "chat", streamState);
  const writeLine = (line) => {
    if (line === "") {
      res.write("\n");
      return;
    }
    const transformed = ctx ? applyStreamLine(line, ctx) : line;
    if (transformed != null) res.write(transformed + "\n");
  };
  try {
    for await (const chunk of iterateUpstreamBody(upstream.body, {
      timeoutMs: ctx?.idleTimeoutMs,
      label: "Chat stream"
    })) {
      streamDiagnostics.chunkCount += 1;
      streamDiagnostics.byteCount += chunk?.byteLength || chunk?.length || 0;
      streamObserver.push(chunk);
      consumeSseLines(lineState, typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }), { onLine: writeLine });
    }
    const decoderTail = decoder.decode();
    consumeSseLines(lineState, decoderTail, { flush: true, onLine: writeLine });
    streamObserver.flush();
    if (!streamState.sawTerminalEvent) {
      const incomplete = new Error("Chat stream disconnected before completion");
      incomplete.code = "SWITCHYARD_INCOMPLETE_STREAM";
      markStreamTerminalFromError(streamState, incomplete);
      writeStreamError(res, incomplete, { protocol: "chat" });
    } else {
      markStreamTerminal(streamState, "completed", "protocol_terminal");
    }
  } catch (err) {
    if (!streamState.sawTerminalEvent) {
      markStreamTerminalFromError(streamState, err);
      writeStreamError(res, err, { protocol: "chat" });
    } else {
      markStreamTerminal(streamState, "completed", "protocol_terminal");
    }
  } finally {
    if (typeof ctx?.onStreamSummary === "function") {
      try {
        ctx.onStreamSummary(publicStreamDiagnostics(streamDiagnostics, streamState));
      } catch {}
    }
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

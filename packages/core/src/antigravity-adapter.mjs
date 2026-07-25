// Native Google Antigravity / Cloud Code Assist adapter.
//
// Switchyard keeps OpenAI Chat Completions as its canonical internal shape.
// This module owns the only non-OpenAI boundary for Antigravity:
//   Chat request -> CCA generateContent envelope
//   CCA JSON/SSE -> Chat completion JSON/SSE
//
// Keeping the output as Chat SSE lets the existing Codex Responses and
// Anthropic Messages adapters reuse the same streamed result. In particular it
// avoids a separate, lossy CCA -> Claude Code streaming path.
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";
import { SseParser } from "./sse-parser.mjs";

const CCA_DEFAULT_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
const REPLAY_TTL_MS = 60 * 60 * 1000;
const REPLAY_MAX_SESSIONS = 2048;
const replayCache = new Map();

const COMPAT_MODEL_ALIASES = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gemini-3.1-pro-preview": "gemini-pro-agent",
  "gemini-3.5-flash-extra-low": "gemini-3.6-flash-low",
  "gemini-3.5-flash-low": "gemini-3.6-flash-medium",
  "gemini-3.5-flash-mid": "gemini-3.6-flash-medium",
  "gemini-3.5-flash-high": "gemini-3.6-flash-high",
  "gemini-3-flash-agent": "gemini-3.6-flash-high",
  // Earlier Switchyard presets used this picker id. Keep saved selections
  // usable while directing them to the current Antigravity wire family.
  "gemini-3-flash": "gemini-3.6-flash-high"
};

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseDataUrl(url) {
  const matched = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/s.exec(String(url || ""));
  if (!matched) return null;
  return { mimeType: matched[1], data: matched[2].replace(/\s/g, "") };
}

function normalizeToolCallId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
  if (cleaned === value) return cleaned;
  return `${cleaned}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 8)}`;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function functionCallKey(call) {
  const name = String(call?.name || "").trim();
  if (!name) return "";
  try {
    return `${name}::${canonicalJson(call.args || {})}`;
  } catch {
    return "";
  }
}

function extractSignature(part) {
  const sig = part?.thoughtSignature || part?.thought_signature;
  return typeof sig === "string" && sig.length >= 16 ? sig : "";
}

function replayKey(model, sessionId) {
  return `${model}::${sessionId}`;
}

function evictReplayCache() {
  const now = Date.now();
  for (const [key, entry] of replayCache) {
    if (entry.expiresAt <= now) replayCache.delete(key);
  }
  if (replayCache.size <= REPLAY_MAX_SESSIONS) return;
  const overflow = [...replayCache.entries()]
    .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
    .slice(0, replayCache.size - REPLAY_MAX_SESSIONS);
  for (const [key] of overflow) replayCache.delete(key);
}

export function antigravityUsesReplayCache(model) {
  return !/claude/i.test(String(model || ""));
}

export function observeAntigravityReplay(model, sessionId, parts) {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(parts)) return;
  const key = replayKey(model, sessionId);
  const entry = replayCache.get(key) || { byCall: new Map(), expiresAt: 0 };
  let changed = false;
  for (const part of parts) {
    if (!isPlainObject(part) || !isPlainObject(part.functionCall)) continue;
    const signature = extractSignature(part);
    const callKey = functionCallKey(part.functionCall);
    if (!signature || !callKey) continue;
    if (entry.byCall.get(callKey) !== signature) {
      entry.byCall.set(callKey, signature);
      changed = true;
    }
  }
  if (!changed && replayCache.has(key)) return;
  entry.expiresAt = Date.now() + REPLAY_TTL_MS;
  replayCache.set(key, entry);
  evictReplayCache();
}

export function applyAntigravityReplay(model, sessionId, contents) {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(contents)) return contents;
  const key = replayKey(model, sessionId);
  const entry = replayCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) replayCache.delete(key);
    return contents;
  }
  for (const content of contents) {
    if (!isPlainObject(content) || content.role !== "model" || !Array.isArray(content.parts)) continue;
    for (const part of content.parts) {
      if (!isPlainObject(part) || !isPlainObject(part.functionCall)) continue;
      if (part.thoughtSignature || part.thought_signature) continue;
      const signature = entry.byCall.get(functionCallKey(part.functionCall));
      if (signature) part.thoughtSignature = signature;
    }
  }
  return contents;
}

export function clearAntigravityReplay(model, sessionId) {
  replayCache.delete(replayKey(model, sessionId));
}

export function __resetAntigravityReplayCache() {
  replayCache.clear();
}

function isLikelyRealThoughtSignature(signature) {
  const value = String(signature || "");
  return value.length >= 16 &&
    !/^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|toolu|tool|func|function)[-_]/i.test(value) &&
    /^[A-Za-z0-9+/_=-]+$/.test(value);
}

function sanitizeClaudeSignatures(contents) {
  for (const content of contents || []) {
    if (!isPlainObject(content) || !Array.isArray(content.parts)) continue;
    if (content.role !== "model") {
      for (const part of content.parts) {
        if (isPlainObject(part)) {
          delete part.thoughtSignature;
          delete part.thought_signature;
        }
      }
      continue;
    }
    content.parts = content.parts.filter((part) => !(
      isPlainObject(part) &&
      part.thought === true &&
      !part.thoughtSignature &&
      !part.thought_signature
    ));
  }
  return contents;
}

function flattenToolDefinitions(tools) {
  const definitions = [];
  for (const tool of tools || []) {
    if (!isPlainObject(tool)) continue;
    if (tool.type === "namespace") {
      const namespace = String(tool.name || "");
      for (const child of tool.functions || tool.tools || []) {
        if (!isPlainObject(child) || !child.name) continue;
        definitions.push({
          name: namespace ? `${namespace}__${child.name}` : child.name,
          description: child.description || "",
          parameters: sanitizeGeminiSchema(child.parameters || child.input_schema || { type: "object", properties: {} })
        });
      }
      continue;
    }
    const fn = tool.function || tool;
    if (!isPlainObject(fn) || !fn.name) continue;
    definitions.push({
      name: fn.name,
      description: fn.description || "",
      parameters: sanitizeGeminiSchema(fn.parameters || fn.input_schema || { type: "object", properties: {} })
    });
  }
  return definitions;
}

function sanitizeGeminiSchema(value) {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!isPlainObject(value)) return value;
  const out = {};
  let nullable = value.nullable === true;
  for (const [key, item] of Object.entries(value)) {
    // These Draft JSON Schema / OpenAI-only fields are rejected by the Gemini
    // function declaration parser and do not alter the callable shape.
    if (["$schema", "$id", "default", "examples", "title", "nullable"].includes(key)) continue;
    // OpenAI-compatible clients frequently describe optional values with
    // JSON Schema unions, e.g. `type: ["string", "null"]`. CCA's Schema
    // proto accepts one scalar type plus a separate `nullable` boolean; if
    // the array is forwarded untouched, its JSON parser aborts the whole
    // request before the model gets a chance to answer.
    if (key === "type" && Array.isArray(item)) {
      const types = item.filter((type) => typeof type === "string");
      if (types.includes("null")) nullable = true;
      const concreteTypes = types.filter((type) => type !== "null");
      if (concreteTypes.length) out.type = concreteTypes[0];
      continue;
    }
    if (key === "type" && item === "null") {
      nullable = true;
      continue;
    }
    // CCA's enum field does not accept null values. This commonly accompanies
    // a nullable OpenAI JSON Schema union, so remove only null and preserve
    // the actual choices.
    if (key === "enum" && Array.isArray(item)) {
      const values = item.filter((entry) => entry != null);
      if (values.length) out.enum = sanitizeGeminiSchema(values);
      continue;
    }
    // OpenAI JSON Schema permits tuple validation (`items: [...]`), while
    // CCA expects one item schema. Use the first concrete item as the stable
    // conservative representation instead of sending a proto-invalid list.
    if (key === "items" && Array.isArray(item)) {
      const firstSchema = item.find(isPlainObject);
      if (firstSchema) out.items = sanitizeGeminiSchema(firstSchema);
      continue;
    }
    out[key] = sanitizeGeminiSchema(item);
  }
  // CCA validates every `required` entry against this exact object's
  // `properties` map. Tool manifests from Codex/MCP can legitimately retain
  // stale required names after schema composition or flattening, which makes
  // Google reject the entire request. Prune at *every* object depth, including
  // array items, before the envelope is sent.
  if (Array.isArray(out.required)) {
    const properties = isPlainObject(out.properties) ? out.properties : null;
    if (!properties) {
      delete out.required;
    } else {
      const valid = [...new Set(out.required.filter((name) =>
        typeof name === "string" && Object.prototype.hasOwnProperty.call(properties, name)
      ))];
      if (valid.length) out.required = valid;
      else delete out.required;
    }
  }
  if (!out.type && (out.properties || out.required)) out.type = "object";
  if (nullable) out.nullable = true;
  return out;
}

function contentToGeminiParts(content) {
  if (!Array.isArray(content)) {
    const text = contentToText(content);
    return text ? [{ text }] : [];
  }
  const parts = [];
  for (const part of content) {
    if (!isPlainObject(part)) {
      const text = contentToText(part);
      if (text) parts.push({ text });
      continue;
    }
    if (part.type === "image_url" || part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url || part.image_url;
      const data = parseDataUrl(url);
      if (data) {
        parts.push({ inline_data: { mime_type: data.mimeType, data: data.data } });
      } else if (url) {
        parts.push({ text: `[image: ${url}]` });
      }
      continue;
    }
    const text = contentToText(part);
    if (text) parts.push({ text });
  }
  return parts;
}

function chatMessagesToGemini(messages) {
  const contents = [];
  const callNames = new Map();
  let systemText = "";
  for (const message of messages || []) {
    if (!isPlainObject(message)) continue;
    if (message.role === "system") {
      const text = contentToText(message.content);
      if (text) systemText = systemText ? `${systemText}\n\n${text}` : text;
      continue;
    }
    if (message.role === "assistant") {
      const parts = contentToGeminiParts(message.content);
      for (const call of message.tool_calls || []) {
        if (!isPlainObject(call)) continue;
        const originalId = String(call.id || "");
        const id = normalizeToolCallId(originalId);
        const name = String(call.function?.name || call.name || "");
        if (!name) continue;
        let args = call.function?.arguments ?? call.arguments ?? {};
        if (typeof args === "string") args = safeJsonParse(args, {});
        const functionCall = { name, args: isPlainObject(args) || Array.isArray(args) ? args : {} };
        if (id) functionCall.id = id;
        const part = { functionCall };
        if (isLikelyRealThoughtSignature(call.thoughtSignature)) part.thoughtSignature = call.thoughtSignature;
        parts.push(part);
        if (originalId) callNames.set(originalId, name);
        if (id) callNames.set(id, name);
      }
      if (parts.length) contents.push({ role: "model", parts });
      continue;
    }
    if (message.role === "tool") {
      const rawId = String(message.tool_call_id || message.id || "");
      const id = normalizeToolCallId(rawId);
      const name = String(message.name || callNames.get(rawId) || callNames.get(id) || "tool");
      const functionResponse = {
        name,
        response: { result: contentToText(message.content) }
      };
      if (id) functionResponse.id = id;
      contents.push({ role: "user", parts: [{ functionResponse }] });
      continue;
    }
    const parts = contentToGeminiParts(message.content);
    if (parts.length) contents.push({ role: "user", parts });
  }
  return {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {})
  };
}

function reasoningEffort(body) {
  const value = body?.reasoning?.effort ?? body?.reasoning_effort;
  return typeof value === "string" ? value.toLowerCase() : "";
}

export function resolveAntigravityWireModel(model, effort = "") {
  const id = String(model || "").trim();
  if (COMPAT_MODEL_ALIASES[id]) return { wireModel: COMPAT_MODEL_ALIASES[id], thinkingLevel: "" };
  if (/^gemini-3\.6-flash-(low|medium|high)$/.test(id) || id === "gemini-3.1-pro-low" || id === "gemini-pro-agent") {
    return { wireModel: id, thinkingLevel: "" };
  }
  if (id === "gemini-3.6-flash") {
    const level = ["low", "medium", "high"].includes(effort) ? effort : "medium";
    return { wireModel: `gemini-3.6-flash-${level}`, thinkingLevel: effort ? level : "" };
  }
  if (id === "gemini-3.1-pro") {
    const level = effort === "low" ? "low" : "high";
    return { wireModel: level === "low" ? "gemini-3.1-pro-low" : "gemini-pro-agent", thinkingLevel: effort ? level : "" };
  }
  if (/^claude-/i.test(id)) {
    return { wireModel: id, thinkingLevel: ["low", "medium", "high", "max"].includes(effort) ? effort : "" };
  }
  return { wireModel: id, thinkingLevel: "" };
}

function firstUserText(messages) {
  for (const message of messages || []) {
    if (message?.role !== "user") continue;
    const text = contentToText(message.content);
    if (text) return text;
  }
  return "";
}

export function antigravitySessionKey(chatBody, opts = {}) {
  const headers = opts?.incomingHeaders || opts?.clientHeaders || {};
  const readHeader = (...names) => {
    for (const name of names) {
      const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
      if (Array.isArray(value) ? value[0] : value) return String(Array.isArray(value) ? value[0] : value).trim();
    }
    return "";
  };
  return readHeader("x-codex-parent-thread-id", "x-codex-thread-id", "x-session-id") ||
    String(chatBody?.session_id || chatBody?.metadata?.session_id || "").trim() ||
    firstUserText(chatBody?.messages) ||
    crypto.randomUUID();
}

export function antigravitySessionId(chatBody, opts = {}) {
  const digest = crypto.createHash("sha256").update(antigravitySessionKey(chatBody, opts), "utf8").digest();
  const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return `-${value.toString()}`;
}

export function buildAntigravityEnvelope(provider, upstreamModel, chatBody, opts = {}) {
  const { contents, systemInstruction } = chatMessagesToGemini(chatBody.messages);
  const { wireModel, thinkingLevel } = resolveAntigravityWireModel(upstreamModel, reasoningEffort(chatBody));
  const sessionId = antigravitySessionId(chatBody, opts);
  const request = { contents, sessionId };
  if (systemInstruction) request.systemInstruction = systemInstruction;
  const declarations = flattenToolDefinitions(chatBody.tools);
  if (declarations.length) request.tools = [{ functionDeclarations: declarations }];
  if (chatBody.max_tokens != null) request.generationConfig = { maxOutputTokens: chatBody.max_tokens };
  if (chatBody.temperature !== undefined) {
    request.generationConfig = { ...(request.generationConfig || {}), temperature: chatBody.temperature };
  }
  if (thinkingLevel) {
    request.generationConfig = {
      ...(request.generationConfig || {}),
      thinkingConfig: { thinkingLevel }
    };
  }
  if (antigravityUsesReplayCache(wireModel)) {
    applyAntigravityReplay(wireModel, sessionId, contents);
  } else {
    sanitizeClaudeSignatures(contents);
    // Claude-on-Antigravity validates tool call/result pairing and rejects
    // otherwise-valid OpenAI tool sequences unless this is explicitly set.
    if (declarations.length) request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  const project = String(provider?._antigravityProjectId || provider?.projectId || provider?.project || "").trim();
  if (!project) {
    throw new Error("Antigravity 账号缺少 Cloud Code Assist projectId；请重新导入含 project_id 的凭证，或完成 Antigravity 登录。");
  }
  return {
    wireModel,
    sessionId,
    envelope: {
      model: wireModel,
      userAgent: "antigravity",
      requestType: "agent",
      project,
      requestId: `agent-${crypto.randomUUID()}`,
      request
    }
  };
}

function unwrapCcaPayload(payload) {
  if (!isPlainObject(payload)) return null;
  if (isPlainObject(payload.response)) return payload.response;
  return payload;
}

function ccaErrorMessage(payload) {
  const error = payload?.error;
  if (typeof error === "string") return error;
  if (isPlainObject(error)) return String(error.message || error.status || "Antigravity upstream error");
  return "";
}

function usageFromCca(payload) {
  const usage = payload?.usageMetadata;
  if (!isPlainObject(usage)) return null;
  const prompt = Number(usage.promptTokenCount || 0) || 0;
  const completion = Number(usage.candidatesTokenCount || 0) || 0;
  const reasoning = Number(usage.thoughtsTokenCount || 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(reasoning ? { reasoning_tokens: reasoning } : {})
  };
}

function finishReasonFromCca(reason, sawToolCall) {
  if (sawToolCall || /function|tool/i.test(String(reason || ""))) return "tool_calls";
  if (/max|length/i.test(String(reason || ""))) return "length";
  return "stop";
}

function chatToolCall(part, fallbackIndex = 0) {
  const call = part?.functionCall;
  if (!isPlainObject(call) || !call.name) return null;
  return {
    index: fallbackIndex,
    id: String(call.id || `call_${crypto.randomUUID()}`),
    type: "function",
    function: {
      name: String(call.name),
      arguments: JSON.stringify(call.args || {})
    }
  };
}

export function antigravityPayloadToChatResponse(payload, requestedModel, { wireModel, sessionId } = {}) {
  const root = unwrapCcaPayload(payload);
  const error = ccaErrorMessage(root);
  if (error) {
    if (/signature|invalid_argument|invalid argument/i.test(error)) clearAntigravityReplay(wireModel, sessionId);
    throw new Error(error);
  }
  const candidate = Array.isArray(root?.candidates) ? root.candidates[0] : null;
  if (!candidate) throw new Error("Antigravity response contained no candidates");
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  observeAntigravityReplay(wireModel, sessionId, parts);
  const text = [];
  const toolCalls = [];
  for (const part of parts) {
    if (typeof part?.text === "string") text.push(part.text);
    const tool = chatToolCall(part, toolCalls.length);
    if (tool) toolCalls.push(tool);
  }
  const message = { role: "assistant", content: text.join("") };
  if (toolCalls.length) message.tool_calls = toolCalls.map(({ index, ...tool }) => tool);
  return {
    id: `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestedModel,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFromCca(candidate.finishReason, toolCalls.length > 0)
    }],
    usage: usageFromCca(root)
  };
}

function sseData(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chatChunk(id, model, delta, finishReason = null, usage = undefined) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}

/**
 * Convert CCA SSE to standard Chat Completions SSE before server.mjs sees it.
 * Existing `pipeStream`, `streamChatAsResponses`, and `streamChatAsAnthropic`
 * then provide Codex, Claude Code, and generic OpenAI parity automatically.
 */
export function antigravityStreamToChatResponse(upstream, requestedModel, { wireModel, sessionId } = {}) {
  if (!upstream?.body || !upstream.ok) return upstream;
  const responseId = `chatcmpl_${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let terminal = false;
      let sawToolCall = false;
      let toolIndex = 0;
      let lastUsage = null;
      const emit = (payload) => controller.enqueue(encoder.encode(sseData(payload)));
      const emitDone = () => controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      emit(chatChunk(responseId, requestedModel, { role: "assistant", content: "" }));
      const fail = (message) => {
        if (/signature|invalid_argument|invalid argument/i.test(message)) clearAntigravityReplay(wireModel, sessionId);
        emit({ error: { message, type: "upstream_error" } });
        // Do not fabricate a successful `stop` after an inline CCA error.
        // The existing Chat -> Responses / Anthropic stream adapters recognize
        // this OpenAI-style error frame and emit their protocol-native failure.
        terminal = true;
      };
      const finish = (reason = "") => {
        if (terminal) return;
        terminal = true;
        emit(chatChunk(responseId, requestedModel, {}, finishReasonFromCca(reason, sawToolCall), lastUsage));
        emitDone();
      };
      const parser = new SseParser((record) => {
        const data = String(record.data || "").trim();
        if (!data || terminal) return;
        if (data === "[DONE]") {
          finish();
          return;
        }
        const raw = safeJsonParse(data);
        if (!raw) return;
        const root = unwrapCcaPayload(raw);
        const error = ccaErrorMessage(root);
        if (error) {
          fail(error);
          return;
        }
        const usage = usageFromCca(root);
        if (usage) lastUsage = usage;
        const candidate = Array.isArray(root?.candidates) ? root.candidates[0] : null;
        if (!candidate) return;
        const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
        observeAntigravityReplay(wireModel, sessionId, parts);
        for (const part of parts) {
          if (typeof part?.text === "string" && part.text) {
            emit(chatChunk(responseId, requestedModel, { content: part.text }));
          }
          const tool = chatToolCall(part, toolIndex);
          if (tool) {
            sawToolCall = true;
            toolIndex += 1;
            emit(chatChunk(responseId, requestedModel, { tool_calls: [tool] }));
          }
        }
        if (candidate.finishReason) finish(candidate.finishReason);
      });
      try {
        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(value);
        }
        parser.flush();
        finish();
        controller.close();
      } catch (err) {
        fail(err?.message || String(err));
        controller.close();
      }
    }
  });
  return new Response(stream, {
    status: upstream.status,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform"
    }
  });
}

export { CCA_DEFAULT_BASE_URL };

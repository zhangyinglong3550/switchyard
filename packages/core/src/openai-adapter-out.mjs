// Outbound chat→responses (used when a chat-style client targets an OpenAI
// Responses upstream) and responses→chat (inbound: read Responses payload and
// produce a chat-style payload that the client adapter can finish).
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";
import { SseParser } from "./sse-parser.mjs";
import { iterateUpstreamBody } from "./stream-idle-timeout.mjs";
import { encodeAnthropicThinkingBlocks, reasoningBlocksFromMessage, thinkingSummaryText } from "./reasoning.mjs";

function contentToResponsesContent(content) {
  if (!Array.isArray(content)) return contentToText(content);
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) {
        hasImage = true;
        parts.push({ type: "input_image", image_url: url, ...(part.image_url?.detail || part.detail ? { detail: part.image_url?.detail || part.detail } : {}) });
        continue;
      }
    }
    if (part.type === "input_image" && part.image_url) {
      hasImage = true;
      parts.push(part);
      continue;
    }
    const text = contentToText(part);
    if (text) parts.push({ type: "input_text", text });
  }
  return hasImage ? parts : contentToText(content);
}

function toolChoiceToResponsesToolChoice(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (typeof toolChoice !== "object") return toolChoice;
  if (toolChoice.type === "function") {
    const name = toolChoice.name || toolChoice.function?.name;
    return name ? { type: "function", name } : toolChoice;
  }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", name: toolChoice.name };
  }
  return toolChoice;
}

export function chatToResponses(body, upstreamModel) {
  const out = { model: upstreamModel, input: [], stream: Boolean(body.stream) };
  const sys = (body.messages || []).filter((m) => m.role === "system").map((m) => contentToText(m.content)).filter(Boolean).join("\n");
  if (sys) out.instructions = sys;
  for (const msg of body.messages || []) {
    if (msg.role === "system") continue;
    if (msg.role === "tool") {
      out.input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: contentToText(msg.content)
      });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      out.input.push(...reasoningItemsFromChatMessage(msg));
      for (const tc of msg.tool_calls) {
        out.input.push({
          type: "function_call",
          call_id: tc.id || `call_${crypto.randomUUID()}`,
          name: tc.function?.name,
          arguments: tc.function?.arguments || "{}"
        });
      }
      const text = contentToText(msg.content || "");
      if (text) out.input.push({ type: "message", role: "assistant", content: text });
      continue;
    }
    if (msg.role === "assistant") out.input.push(...reasoningItemsFromChatMessage(msg));
    out.input.push({ type: "message", role: msg.role || "user", content: contentToResponsesContent(msg.content) });
  }
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t) => t.type === "function")
      .map((t) => ({ type: "function", name: t.function?.name || t.name, description: t.function?.description || t.description, parameters: t.function?.parameters || t.parameters }));
  }
  if (body.tool_choice !== undefined) out.tool_choice = toolChoiceToResponsesToolChoice(body.tool_choice);
  applyChatReasoningToResponses(out, body);
  if (body.service_tier !== undefined) out.service_tier = body.service_tier;
  return out;
}

/**
 * Chat 客户端（Hermes / OpenCode / Grok 等）→ Responses 上游时，把思考档位写回
 * Responses 原生 `reasoning` 对象。对齐 CC Switch / Codex++：转换层必须显式处理 effort，
 * 不能只搬 messages。
 *
 * 接受形态：
 * - reasoning: { effort, summary, ... }  → 原样（浅拷贝）
 * - reasoning: "high" / true / false     → 归一成 { effort }
 * - reasoning_effort: "low"              → { effort: "low" }
 * reasoning 对象优先于顶层 reasoning_effort。
 */
function applyChatReasoningToResponses(out, body) {
  if (!body || typeof body !== "object") return;

  if (Object.prototype.hasOwnProperty.call(body, "reasoning") && body.reasoning !== undefined) {
    const reasoning = body.reasoning;
    if (reasoning == null || reasoning === false) {
      out.reasoning = { effort: "none" };
      return;
    }
    if (typeof reasoning === "string") {
      out.reasoning = { effort: reasoning };
      return;
    }
    if (typeof reasoning === "object" && !Array.isArray(reasoning)) {
      out.reasoning = { ...reasoning };
      return;
    }
    if (reasoning === true) {
      out.reasoning = { effort: "high" };
      return;
    }
  }

  if (body.reasoning_effort !== undefined && body.reasoning_effort !== null && body.reasoning_effort !== "") {
    out.reasoning = { effort: String(body.reasoning_effort) };
  }
}

function reasoningItemsFromChatMessage(message) {
  const blocks = reasoningBlocksFromMessage(message);
  if (!blocks.length) return [];
  const summary = thinkingSummaryText(blocks);
  return [{
    type: "reasoning",
    id: `rs_${crypto.randomUUID()}`,
    status: "completed",
    summary: summary ? [{ type: "summary_text", text: summary }] : [],
    content: summary ? [{ type: "reasoning_text", text: summary }] : [],
    encrypted_content: encodeAnthropicThinkingBlocks(blocks)
  }];
}

function withCodexReasoningInclude(value) {
  const include = Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
  return include;
}

export function normalizeChatgptCodexResponsesBody(body) {
  const next = { ...body };
  next.include = withCodexReasoningInclude(next.include);
  if (!Array.isArray(next.input)) return next;
  next.input = next.input.map((item) => {
    if (!item || typeof item !== "object") return item;
    if (item.type === "reasoning" || item.type === "function_call" || item.type === "function_call_output") return item;
    // ChatGPT Codex 后端不接受 Responses input 里的 system 角色，只接受 developer。
    // Grok 等客户端会带 role: system，原生透传会被上游 400 拒绝（System messages are not allowed）。
    if (item.role === "system") return { ...item, role: "developer" };
    const content = Array.isArray(item.content) ? item.content : [];
    const hasAssistantOutputContent = content.some((part) => (
      part &&
      typeof part === "object" &&
      (part.type === "output_text" || part.type === "reasoning_text" || part.type === "summary_text")
    ));
    if (item.role !== "assistant" && !hasAssistantOutputContent) return item;
    const text = contentToText(item.content ?? item.output ?? item.text ?? "");
    if (!text) return { ...item, type: "message", role: "assistant", content: [] };
    return {
      type: "message",
      role: "user",
      content: `Previous assistant response:\n${text}`
    };
  });
  return next;
}

function toolCallToChatToolCall(call) {
  if (!call || typeof call !== "object") return null;
  const name = call.name || call.function?.name || "";
  if (!name) return null;
  const argumentsValue = call.arguments ?? call.function?.arguments ?? call.input ?? {};
  return {
    id: call.call_id || call.id || `call_${crypto.randomUUID()}`,
    type: "function",
    function: {
      name,
      arguments: typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {})
    }
  };
}

export function responsesToChatResponse(payload, upstreamModel) {
  // Flatten an OpenAI Responses non-stream payload into a chat-completions
  // payload. The client adapter will finish formatting for the target client.
  const choice = payload?.choices?.[0] || {};
  const fallbackMessage = choice.message || {};
  const message = { role: "assistant", content: "" };
  const tool_calls = [];
  const payloadText = outputTextFromResponsesPayload(payload);
  for (const item of payload.output || []) {
    if (item?.type === "function_call") {
      const mapped = toolCallToChatToolCall(item);
      if (mapped) tool_calls.push(mapped);
    }
  }
  if (!tool_calls.length && Array.isArray(fallbackMessage.tool_calls)) {
    for (const call of fallbackMessage.tool_calls) {
      const mapped = toolCallToChatToolCall(call);
      if (mapped) tool_calls.push(mapped);
    }
  }
  // OpenAI Responses `text` is output config ({ format, verbosity }), not assistant
  // content. Never fall back to payload.text — tool-only turns would stringify it
  // into garbage like {"format":{"type":"text"},"verbosity":"medium"}.
  const fallbackContent = fallbackMessage.content ?? (
    typeof payload?.content === "string" || Array.isArray(payload?.content)
      ? payload.content
      : ""
  );
  message.content = payloadText || contentToText(fallbackContent || "");
  if (tool_calls.length) message.tool_calls = tool_calls;
  return {
    id: payload.id || choice.id || `chatcmpl_${crypto.randomUUID()}`,
    object: payload.object === "chat.completion" ? payload.object : "chat.completion",
    created: payload.created_at || payload.created || Math.floor(Date.now() / 1000),
    model: payload.model || upstreamModel,
    choices: [{
      index: 0,
      message,
      finish_reason: choice.finish_reason || (tool_calls.length ? "tool_calls" : "stop")
    }],
    usage: payload.usage || null
  };
}

function textFromResponsesContentPart(part) {
  if (!part || typeof part !== "object") return "";
  if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") return part.text;
  if (part.type === "refusal") return part.refusal || part.text || "";
  return contentToText(part);
}

function outputTextFromResponsesPayload(payload) {
  const parts = [];
  if (typeof payload?.output_text === "string") parts.push(payload.output_text);
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      const text = textFromResponsesContentPart(part);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function functionCallFromResponsesItem(item) {
  if (!item || item.type !== "function_call") return null;
  return {
    id: item.id || item.call_id || `fc_${crypto.randomUUID()}`,
    call_id: item.call_id || item.id || "",
    name: item.name || "",
    arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})
  };
}

export async function responsesStreamToChatResponse(upstream, upstreamModel, options = {}) {
  let responsePayload = null;
  let text = "";
  let terminalSeen = false;
  let terminalKind = null;
  let failedSeen = false;
  let sawMeaningfulEvent = false;
  let streamError = null;
  const functionCalls = new Map();
  const contentParts = new Map();
  const functionCallKey = (event = {}, item = null) => {
    if (Number.isInteger(event.output_index)) return `output:${event.output_index}`;
    if (Number.isInteger(event.index)) return `output:${event.index}`;
    if (event.item_id) return event.item_id;
    if (item?.id) return item.id;
    if (item?.call_id) return item.call_id;
    return "output:0";
  };
  const mergeFunctionCall = (key, patch) => {
    const prev = functionCalls.get(key) || { id: "", call_id: "", name: "", arguments: "" };
    functionCalls.set(key, { ...prev, ...patch });
  };
  const contentPartKey = (event = {}) => {
    const outputIndex = Number.isInteger(event.output_index) ? event.output_index : 0;
    const contentIndex = Number.isInteger(event.content_index) ? event.content_index : 0;
    return `${outputIndex}:${contentIndex}`;
  };
  const handleData = (data) => {
    if (!data) return;
    if (data === "[DONE]") {
      terminalSeen = true;
      terminalKind = terminalKind || "done";
      return;
    }
    const event = safeJsonParse(data);
    if (!event || typeof event !== "object") return;
    if (event.type === "error" || event.error) {
      failedSeen = true;
      const message = event.error?.message || event.message || "Responses stream returned an error";
      throw new Error(message);
    }
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "response.cancelled") {
      failedSeen = true;
      const message = event.response?.error?.message || event.error?.message || event.response?.incomplete_details?.reason || "Responses stream failed";
      throw new Error(message);
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      terminalSeen = true;
      terminalKind = terminalKind || event.type;
      if (event.response) {
        responsePayload = event.response;
        const payloadText = outputTextFromResponsesPayload(event.response);
        if (payloadText) text = payloadText;
      }
      return;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      if (event.delta) sawMeaningfulEvent = true;
      text += event.delta;
      return;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      if (event.text) sawMeaningfulEvent = true;
      text = event.text;
      return;
    }
    if (event.type === "response.content_part.done" && event.part) {
      const partText = textFromResponsesContentPart(event.part);
      if (partText) {
        sawMeaningfulEvent = true;
        contentParts.set(contentPartKey(event), partText);
      }
      return;
    }
    if (event.type === "response.output_item.done" && event.item) {
      sawMeaningfulEvent = true;
      const payloadText = outputTextFromResponsesPayload({ output: [event.item] });
      if (payloadText) text = payloadText;
      const call = functionCallFromResponsesItem(event.item);
      if (call) mergeFunctionCall(functionCallKey(event, event.item), call);
      return;
    }
    if (event.type === "response.output_item.added" && event.item) {
      sawMeaningfulEvent = true;
      const call = functionCallFromResponsesItem(event.item);
      if (call) mergeFunctionCall(functionCallKey(event, event.item), call);
      return;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const key = functionCallKey(event);
      const prev = functionCalls.get(key) || { id: event.item_id || "", call_id: "", name: event.name || "", arguments: "" };
      const delta = event.delta || event.arguments_delta || event.partial_json || "";
      if (delta) sawMeaningfulEvent = true;
      functionCalls.set(key, { ...prev, arguments: `${prev.arguments || ""}${delta}` });
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      const key = functionCallKey(event);
      mergeFunctionCall(key, {
        id: event.item_id || functionCalls.get(key)?.id || "",
        name: event.name || functionCalls.get(key)?.name || "",
        arguments: event.arguments || functionCalls.get(key)?.arguments || "{}"
      });
      sawMeaningfulEvent = true;
    }
  };

  const parser = new SseParser((record) => handleData(String(record.data || "").trim()));
  try {
    for await (const chunk of iterateUpstreamBody(upstream?.body, {
      timeoutMs: options.idleTimeoutMs,
      label: "Responses stream"
    })) parser.push(chunk);
    parser.flush();
  } catch (err) {
    // Once a terminal event was observed, an iterator failure is usually the
    // provider closing the socket after its final SSE frame. Do not turn that
    // into a false negative, but never hide an explicit provider error event.
    if (!terminalSeen || failedSeen) streamError = err;
  }

  if (!terminalSeen && !streamError) {
    streamError = new Error("Responses stream ended before completion");
  }
  if (streamError) throw streamError;
  if (!text && contentParts.size) {
    text = Array.from(contentParts.entries())
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([, value]) => value)
      .join("\n");
  }

  const streamedFunctionCalls = Array.from(functionCalls.values()).filter((call) => call.name);
  const output = [];
  if (text) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    });
  }
  for (const call of streamedFunctionCalls) {
    output.push({
      type: "function_call",
      id: call.id || call.call_id || `fc_${crypto.randomUUID()}`,
      call_id: call.call_id || call.id || `call_${crypto.randomUUID()}`,
      name: call.name,
      arguments: call.arguments || "{}"
    });
  }
  const payload = responsePayload || {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: upstreamModel,
    output,
    usage: null
  };
  if (text && !outputTextFromResponsesPayload(payload)) {
    payload.output = [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }];
  }
  if (streamedFunctionCalls.length) {
    const existing = new Set((payload.output || [])
      .filter((item) => item?.type === "function_call")
      .map((item) => item.call_id || item.id)
      .filter(Boolean));
    const missing = streamedFunctionCalls
      .filter((call) => !existing.has(call.call_id || call.id))
      .map((call) => ({
        type: "function_call",
        id: call.id || call.call_id || `fc_${crypto.randomUUID()}`,
        call_id: call.call_id || call.id || `call_${crypto.randomUUID()}`,
        name: call.name,
        arguments: call.arguments || "{}"
      }));
    if (missing.length) payload.output = [...(payload.output || []), ...missing];
  }
  return responsesToChatResponse(payload, upstreamModel);
}

/**
 * 将 OpenAI Responses SSE 实时翻译为 Chat Completions SSE。
 * Grok / OpenCode 等 chat 客户端请求 stream=true 且上游是 openai_responses（含 Codex OAuth）时必须走这条路径；
 * 若原样 pipe Responses 事件，客户端会按 chat.completion.chunk 反序列化并报 missing field `id`。
 */
export async function streamResponsesAsChat(upstream, res, requestedModel, options = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let finishReason = null;
  let usage = null;
  let roleSent = false;
  let contentEmitted = false;
  let terminalSeen = false;
  let terminalKind = null;
  let failed = false;
  let sawMeaningfulEvent = false;
  let streamError = null;
  const functionCalls = new Map(); // key → { chatIndex, id, name, arguments }
  let nextToolIndex = 0;

  const writeChatChunk = (delta, opts = {}) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model: requestedModel,
      choices: [{
        index: 0,
        delta,
        finish_reason: opts.finishReason ?? null
      }]
    };
    if (opts.usage) chunk.usage = opts.usage;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const ensureRole = () => {
    if (roleSent) return;
    writeChatChunk({ role: "assistant", content: "" });
    roleSent = true;
  };

  const functionCallKey = (event = {}, item = null) => {
    if (Number.isInteger(event.output_index)) return `output:${event.output_index}`;
    if (Number.isInteger(event.index)) return `output:${event.index}`;
    if (event.item_id) return event.item_id;
    if (item?.id) return item.id;
    if (item?.call_id) return item.call_id;
    return "output:0";
  };

  const ensureFunctionCall = (key, patch = {}) => {
    let prev = functionCalls.get(key);
    if (!prev) {
      prev = {
        chatIndex: nextToolIndex++,
        id: "",
        name: "",
        arguments: "",
        announced: false
      };
      functionCalls.set(key, prev);
    }
    Object.assign(prev, patch);
    return prev;
  };

  const announceFunctionCall = (call) => {
    if (call.announced || !call.name) return;
    ensureRole();
    writeChatChunk({
      tool_calls: [{
        index: call.chatIndex,
        id: call.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: { name: call.name, arguments: "" }
      }]
    });
    call.announced = true;
    finishReason = "tool_calls";
  };

  const mapUsage = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const prompt = raw.prompt_tokens ?? raw.input_tokens;
    const completion = raw.completion_tokens ?? raw.output_tokens;
    const total = raw.total_tokens ?? (
      (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0) || null
    );
    if (prompt == null && completion == null && total == null) return null;
    return {
      prompt_tokens: prompt ?? 0,
      completion_tokens: completion ?? 0,
      total_tokens: total ?? 0
    };
  };

  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "error" || event.error) {
      failed = true;
      const message = event.error?.message || event.message || "Responses stream returned an error";
      throw new Error(message);
    }
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "response.cancelled") {
      failed = true;
      const message = event.response?.error?.message || event.error?.message || event.response?.incomplete_details?.reason || "Responses stream failed";
      throw new Error(message);
    }
    if (event.type === "response.created" || event.type === "response.in_progress") {
      ensureRole();
      return;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      ensureRole();
      if (event.delta) {
        writeChatChunk({ content: event.delta });
        contentEmitted = true;
        sawMeaningfulEvent = true;
      }
      if (!finishReason) finishReason = "stop";
      return;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      // delta 路径已推送；仅当从未收到 delta 时补一次全文（少见）
      if (event.text && !contentEmitted) {
        ensureRole();
        writeChatChunk({ content: event.text });
        contentEmitted = true;
        sawMeaningfulEvent = true;
        if (!finishReason) finishReason = "stop";
      }
      return;
    }
    if (event.type === "response.content_part.done" && event.part) {
      const partText = textFromResponsesContentPart(event.part);
      // 若只有 done 没有 delta，补全文（与 responsesStreamToChatResponse 一致）
      if (partText && !contentEmitted) {
        ensureRole();
        writeChatChunk({ content: partText });
        contentEmitted = true;
        sawMeaningfulEvent = true;
        if (!finishReason) finishReason = "stop";
      }
      return;
    }
    if (event.type === "response.output_item.added" && event.item) {
      sawMeaningfulEvent = true;
      const call = functionCallFromResponsesItem(event.item);
      if (call) {
        const key = functionCallKey(event, event.item);
        const state = ensureFunctionCall(key, {
          id: call.call_id || call.id,
          name: call.name,
          arguments: call.arguments || ""
        });
        announceFunctionCall(state);
      } else if (event.item?.type === "message") {
        ensureRole();
      }
      return;
    }
    if (event.type === "response.output_item.done" && event.item) {
      sawMeaningfulEvent = true;
      const call = functionCallFromResponsesItem(event.item);
      if (call) {
        const key = functionCallKey(event, event.item);
        const state = ensureFunctionCall(key, {
          id: call.call_id || call.id || functionCalls.get(key)?.id,
          name: call.name || functionCalls.get(key)?.name,
          arguments: call.arguments || functionCalls.get(key)?.arguments || "{}"
        });
        announceFunctionCall(state);
      }
      return;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const key = functionCallKey(event);
      const delta = event.delta || event.arguments_delta || event.partial_json || "";
      const state = ensureFunctionCall(key, {
        id: event.item_id || functionCalls.get(key)?.id || "",
        name: event.name || functionCalls.get(key)?.name || ""
      });
      if (event.name) state.name = event.name;
      if (event.item_id) state.id = state.id || event.item_id;
      announceFunctionCall(state);
      if (delta) {
        sawMeaningfulEvent = true;
        state.arguments = `${state.arguments || ""}${delta}`;
        writeChatChunk({
          tool_calls: [{
            index: state.chatIndex,
            function: { arguments: delta }
          }]
        });
      }
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      sawMeaningfulEvent = true;
      const key = functionCallKey(event);
      const state = ensureFunctionCall(key, {
        id: event.item_id || functionCalls.get(key)?.id || "",
        name: event.name || functionCalls.get(key)?.name || "",
        arguments: event.arguments || functionCalls.get(key)?.arguments || "{}"
      });
      announceFunctionCall(state);
      return;
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      terminalSeen = true;
      terminalKind = terminalKind || event.type;
      if (!event.response) {
        if (!finishReason) finishReason = functionCalls.size ? "tool_calls" : "stop";
        return;
      }
      const mapped = mapUsage(event.response.usage);
      if (mapped) usage = mapped;
      // 若流里只有 completed 里的全文、没有 delta，补推一次
      const payloadText = outputTextFromResponsesPayload(event.response);
      if (payloadText && !contentEmitted) {
        ensureRole();
        writeChatChunk({ content: payloadText });
        contentEmitted = true;
        if (!finishReason) finishReason = "stop";
      }
      // completed 里可能有 function_call 而流式未完整推过
      for (const item of event.response.output || []) {
        const call = functionCallFromResponsesItem(item);
        if (!call) continue;
        const key = functionCallKey({ output_index: undefined }, item) || call.call_id || call.id;
        const state = ensureFunctionCall(key, {
          id: call.call_id || call.id,
          name: call.name,
          arguments: call.arguments || "{}"
        });
        if (!state.announced) {
          announceFunctionCall(state);
          if (state.arguments) {
            writeChatChunk({
              tool_calls: [{
                index: state.chatIndex,
                function: { arguments: state.arguments }
              }]
            });
          }
        }
      }
      if (!finishReason) {
        finishReason = functionCalls.size ? "tool_calls" : "stop";
      }
    }
  };

  const parser = new SseParser((record) => {
    const data = String(record.data || "").trim();
    if (!data) return;
    if (data === "[DONE]") {
      terminalSeen = true;
      terminalKind = terminalKind || "done";
      return;
    }
    const event = safeJsonParse(data);
    handleEvent(event);
  });

  try {
    if (!upstream?.body) {
      throw new Error(`Responses stream empty (status ${upstream?.status || 0})`);
    }
    for await (const chunk of iterateUpstreamBody(upstream?.body, {
      timeoutMs: options.idleTimeoutMs,
      label: "Responses stream"
    })) {
      parser.push(chunk);
    }
    parser.flush();
  } catch (err) {
    if (!terminalSeen || failed) streamError = err;
  }

  if (!terminalSeen && !streamError) {
    streamError = new Error("Responses stream ended before completion");
  }
  if (streamError || failed) {
    writeChatStreamError(res, streamError || new Error("Responses stream returned an error"));
  } else {
    ensureRole();
    const finalFinish = finishReason || (functionCalls.size ? "tool_calls" : "stop");
    writeChatChunk({}, { finishReason: finalFinish, usage: usage || undefined });
    res.write("data: [DONE]\n\n");
  }
  res.end();

  if (typeof options.onStreamSummary === "function") {
    try {
      options.onStreamSummary({
        protocol: "chat",
        usage,
        sawTerminalEvent: terminalSeen,
        sawMeaningfulEvent: sawMeaningfulEvent || contentEmitted || functionCalls.size > 0,
        failed: Boolean(streamError || failed),
        terminalKind
      });
    } catch {}
  }
}

function writeChatStreamError(res, err) {
  if (res.destroyed || res.writableEnded) return;
  res.write("event: error\n");
  res.write(`data: ${JSON.stringify({
    type: "error",
    error: {
      type: "upstream_stream_error",
      message: err?.message || String(err)
    }
  })}\n\n`);
}

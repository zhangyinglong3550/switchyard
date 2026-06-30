// Outbound chat→responses (used when a chat-style client targets an OpenAI
// Responses upstream) and responses→chat (inbound: read Responses payload and
// produce a chat-style payload that the client adapter can finish).
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";
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
  return out;
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
  message.content = payloadText || contentToText(fallbackMessage.content || payload?.content || payload?.text || "");
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

export async function responsesStreamToChatResponse(upstream, upstreamModel) {
  const decoder = new TextDecoder();
  let buf = "";
  let responsePayload = null;
  let text = "";
  let sawDone = false;
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
      sawDone = true;
      return;
    }
    const event = safeJsonParse(data);
    if (!event || typeof event !== "object") return;
    if (event.type === "error" || event.error) {
      const message = event.error?.message || event.message || "Responses stream returned an error";
      throw new Error(message);
    }
    if (event.type === "response.failed") {
      const message = event.response?.error?.message || event.error?.message || "Responses stream failed";
      throw new Error(message);
    }
    if ((event.type === "response.completed" || event.type === "response.done") && event.response) {
      responsePayload = event.response;
      const payloadText = outputTextFromResponsesPayload(event.response);
      if (payloadText) text = payloadText;
      sawDone = true;
      return;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      return;
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      text = event.text;
      return;
    }
    if (event.type === "response.content_part.done" && event.part) {
      const partText = textFromResponsesContentPart(event.part);
      if (partText) contentParts.set(contentPartKey(event), partText);
      return;
    }
    if (event.type === "response.output_item.done" && event.item) {
      const payloadText = outputTextFromResponsesPayload({ output: [event.item] });
      if (payloadText) text = payloadText;
      const call = functionCallFromResponsesItem(event.item);
      if (call) mergeFunctionCall(functionCallKey(event, event.item), call);
      return;
    }
    if (event.type === "response.output_item.added" && event.item) {
      const call = functionCallFromResponsesItem(event.item);
      if (call) mergeFunctionCall(functionCallKey(event, event.item), call);
      return;
    }
    if (event.type === "response.function_call_arguments.delta") {
      const key = functionCallKey(event);
      const prev = functionCalls.get(key) || { id: event.item_id || "", call_id: "", name: event.name || "", arguments: "" };
      const delta = event.delta || event.arguments_delta || event.partial_json || "";
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
    }
  };

  try {
    for await (const chunk of upstream.body || []) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        handleData(line.slice(5).trim());
      }
    }
    if (buf.startsWith("data:")) handleData(buf.slice(5).trim());
  } catch (err) {
    streamError = err;
  }
  const flushed = decoder.decode();
  if (flushed) {
    try {
      buf += flushed;
      if (buf.startsWith("data:")) handleData(buf.slice(5).trim());
    } catch (err) {
      streamError = streamError || err;
    }
  }

  if (streamError && !text && !responsePayload) throw streamError;
  if (!sawDone && !text && !responsePayload) throw new Error("Responses stream ended before completion");
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

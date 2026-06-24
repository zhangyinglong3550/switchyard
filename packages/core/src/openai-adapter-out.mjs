// Outbound chat→responses (used when a chat-style client targets an OpenAI
// Responses upstream) and responses→chat (inbound: read Responses payload and
// produce a chat-style payload that the client adapter can finish).
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";

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
    out.input.push({ type: "message", role: msg.role || "user", content: contentToResponsesContent(msg.content) });
  }
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.max_tokens !== undefined) out.max_output_tokens = body.max_tokens;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t) => t.type === "function")
      .map((t) => ({ type: "function", name: t.function?.name || t.name, description: t.function?.description || t.description, parameters: t.function?.parameters || t.parameters }));
  }
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  return out;
}

export function responsesToChatResponse(payload, upstreamModel) {
  // Flatten an OpenAI Responses non-stream payload into a chat-completions
  // payload. The client adapter will finish formatting for the target client.
  const message = { role: "assistant", content: "" };
  const text = [];
  const tool_calls = [];
  for (const item of payload.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" && typeof part.text === "string") text.push(part.text);
      }
    } else if (item.type === "function_call") {
      tool_calls.push({
        id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) }
      });
    }
  }
  message.content = text.join("\n");
  if (tool_calls.length) message.tool_calls = tool_calls;
  return {
    id: payload.id || `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: payload.created_at || Math.floor(Date.now() / 1000),
    model: payload.model || upstreamModel,
    choices: [{
      index: 0,
      message,
      finish_reason: tool_calls.length ? "tool_calls" : "stop"
    }],
    usage: payload.usage || null
  };
}

function outputTextFromResponsesPayload(payload) {
  const parts = [];
  for (const item of payload?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      if ((part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
  }
  return parts.join("\n");
}

export async function responsesStreamToChatResponse(upstream, upstreamModel) {
  const decoder = new TextDecoder();
  let buf = "";
  let responsePayload = null;
  let text = "";
  let sawDone = false;
  let streamError = null;
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
    if (event.type === "response.output_item.done" && event.item) {
      const payloadText = outputTextFromResponsesPayload({ output: [event.item] });
      if (payloadText) text = payloadText;
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

  const payload = responsePayload || {
    id: `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: upstreamModel,
    output: text ? [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }] : [],
    usage: null
  };
  if (text && !outputTextFromResponsesPayload(payload)) {
    payload.output = [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }]
    }];
  }
  return responsesToChatResponse(payload, upstreamModel);
}

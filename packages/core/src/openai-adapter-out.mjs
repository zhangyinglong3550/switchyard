// Outbound chat→responses (used when a chat-style client targets an OpenAI
// Responses upstream) and responses→chat (inbound: read Responses payload and
// produce a chat-style payload that the client adapter can finish).
import crypto from "node:crypto";
import { contentToText } from "./utils.mjs";

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
    out.input.push({ type: "message", role: msg.role || "user", content: contentToText(msg.content) });
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

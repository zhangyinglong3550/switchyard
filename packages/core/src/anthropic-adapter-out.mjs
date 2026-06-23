// Outbound chat→anthropic (used when a chat-style client targets an Anthropic
// Messages upstream) and anthropic→chat reverse (read Anthropic payload and
// produce a chat-style payload for the client adapter to finish).
import crypto from "node:crypto";
import { contentToText } from "./utils.mjs";

export function chatToAnthropicMessages(body, upstreamModel) {
  const messages = [];
  let system = "";
  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      const text = contentToText(msg.content);
      if (text) system = system ? `${system}\n${text}` : text;
      continue;
    }
    if (msg.role === "tool") {
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: contentToText(msg.content) }]
      });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const blocks = [];
      const text = contentToText(msg.content || "");
      if (text) blocks.push({ type: "text", text });
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: tc.id || `call_${crypto.randomUUID()}`, name: tc.function?.name, input });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: contentToText(msg.content) });
  }
  const out = {
    model: upstreamModel,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: Boolean(body.stream)
  };
  if (system) out.system = system;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (Array.isArray(body.tools)) {
    out.tools = body.tools.map((t) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || "",
      input_schema: t.function?.parameters || t.parameters || { type: "object", properties: {} }
    }));
  }
  if (body.tool_choice) {
    if (typeof body.tool_choice === "string") {
      if (body.tool_choice === "required") out.tool_choice = { type: "any" };
      else if (body.tool_choice === "auto") out.tool_choice = { type: "auto" };
    } else if (typeof body.tool_choice === "object" && body.tool_choice.function) {
      out.tool_choice = { type: "tool", name: body.tool_choice.function.name };
    }
  }
  return out;
}

export function anthropicMessagesToChatResponse(payload, upstreamModel) {
  // Take an Anthropic Messages non-stream payload and flatten to chat-style.
  const message = { role: "assistant", content: "" };
  const text = [];
  const tool_calls = [];
  for (const block of payload.content || []) {
    if (block.type === "text") text.push(block.text || "");
    else if (block.type === "tool_use") {
      tool_calls.push({
        id: block.id || `call_${crypto.randomUUID()}`,
        type: "function",
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      });
    }
  }
  message.content = text.join("\n");
  if (tool_calls.length) message.tool_calls = tool_calls;
  return {
    id: payload.id || `chatcmpl_${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model || upstreamModel,
    choices: [{
      index: 0,
      message,
      finish_reason: payload.stop_reason === "tool_use" ? "tool_calls" : "stop"
    }],
    usage: payload.usage ? {
      prompt_tokens: payload.usage.input_tokens || 0,
      completion_tokens: payload.usage.output_tokens || 0
    } : null
  };
}

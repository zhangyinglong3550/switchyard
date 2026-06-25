// Outbound chat→anthropic (used when a chat-style client targets an Anthropic
// Messages upstream) and anthropic→chat reverse (read Anthropic payload and
// produce a chat-style payload for the client adapter to finish).
import crypto from "node:crypto";
import { contentToText } from "./utils.mjs";
import { SWITCHYARD_THINKING_KEY, cloneAnthropicThinkingBlocks, reasoningBlocksFromMessage } from "./reasoning.mjs";

function parseDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(url || ""));
  if (!m) return null;
  return { media_type: m[1], data: m[2] };
}

function contentToAnthropicContent(content) {
  if (!Array.isArray(content)) {
    const text = contentToText(content);
    return text ? [{ type: "text", text }] : "";
  }
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      const data = parseDataUrl(url);
      if (data) {
        blocks.push({ type: "image", source: { type: "base64", media_type: data.media_type, data: data.data } });
        continue;
      }
      if (url) {
        blocks.push({ type: "text", text: `[image: ${url}]` });
        continue;
      }
    }
    const text = contentToText(part);
    if (text) blocks.push({ type: "text", text });
  }
  return blocks.length ? blocks : contentToText(content);
}

export function chatToAnthropicMessages(body, upstreamModel) {
  const messages = [];
  let system = "";
  const inputMessages = body.messages || [];
  for (let i = 0; i < inputMessages.length; i += 1) {
    const msg = inputMessages[i];
    if (msg.role === "system") {
      const text = contentToText(msg.content);
      if (text) system = system ? `${system}\n${text}` : text;
      continue;
    }
    if (msg.role === "tool") {
      const content = [];
      while (i < inputMessages.length && inputMessages[i]?.role === "tool") {
        const toolMsg = inputMessages[i];
        content.push({ type: "tool_result", tool_use_id: toolMsg.tool_call_id || "", content: contentToText(toolMsg.content) });
        i += 1;
      }
      i -= 1;
      messages.push({ role: "user", content });
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const blocks = [];
      blocks.push(...reasoningBlocksFromMessage(msg));
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
    const role = msg.role === "assistant" ? "assistant" : "user";
    let content = contentToAnthropicContent(msg.content);
    if (role === "assistant") {
      const thinking = reasoningBlocksFromMessage(msg);
      if (thinking.length) {
        const contentBlocks = Array.isArray(content) ? content : (content ? [{ type: "text", text: content }] : []);
        content = [...thinking, ...contentBlocks];
      }
    }
    messages.push({ role, content });
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
  const thinking = [];
  for (const block of payload.content || []) {
    if (block.type === "text") text.push(block.text || "");
    else if (block.type === "thinking" || block.type === "redacted_thinking") thinking.push({ ...block });
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
  if (thinking.length) message[SWITCHYARD_THINKING_KEY] = thinking;
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

// Adapter between Anthropic Messages API and OpenAI Chat Completions.
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";

function contentToChatContent(content) {
  if (!Array.isArray(content)) return contentToText(content);
  const parts = [];
  let hasImage = false;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" && block.source?.type === "base64" && block.source?.data) {
      hasImage = true;
      parts.push({
        type: "image_url",
        image_url: { url: `data:${block.source.media_type || "image/png"};base64,${block.source.data}` }
      });
      continue;
    }
    if (block.type === "image_url" && block.image_url) {
      hasImage = true;
      parts.push(block);
      continue;
    }
    const text = contentToText(block);
    if (text) parts.push({ type: "text", text });
  }
  return hasImage ? parts : contentToText(content);
}

export function anthropicToChat(body, upstreamModel) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: contentToText(body.system) });
  for (const msg of body.messages || []) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : (msg.role === "system" ? "system" : "user");
    // Detect Anthropic tool_use / tool_result blocks.
    if (Array.isArray(msg.content)) {
      const toolUses = msg.content.filter((b) => b && b.type === "tool_use");
      const toolResults = msg.content.filter((b) => b && b.type === "tool_result");
      const textContent = contentToText(msg.content.filter((b) => !b || (b.type !== "tool_use" && b.type !== "tool_result")));
      if (role === "assistant" && toolUses.length) {
        messages.push({
          role: "assistant",
          content: textContent,
          tool_calls: toolUses.map((u) => ({
            id: u.id || `call_${crypto.randomUUID()}`,
            type: "function",
            function: { name: u.name, arguments: JSON.stringify(u.input || {}) }
          }))
        });
        continue;
      }
      if (toolResults.length) {
        for (const r of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: r.tool_use_id || r.id || "",
            content: contentToText(r.content)
          });
        }
        if (textContent) messages.push({ role, content: textContent });
        continue;
      }
    }
    messages.push({ role, content: contentToChatContent(msg.content) });
  }
  const chat = {
    model: upstreamModel,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: Boolean(body.stream)
  };
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.max_tokens !== undefined) chat.max_tokens = body.max_tokens;
  if (Array.isArray(body.tools)) {
    chat.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.input_schema || { type: "object", properties: {} }
      }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice.type === "tool") chat.tool_choice = { type: "function", function: { name: body.tool_choice.name } };
    else if (body.tool_choice.type === "auto") chat.tool_choice = "auto";
    else if (body.tool_choice.type === "any") chat.tool_choice = "required";
  }
  return chat;
}

export function chatToAnthropic(payload, requestedModel) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  const text = contentToText(message.content || "");
  if (text) content.push({ type: "text", text });
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      content.push({
        type: "tool_use",
        id: call.id || `call_${crypto.randomUUID()}`,
        name: call.function?.name,
        input: safeJsonParse(call.function?.arguments || "{}", {})
      });
    }
  }
  return {
    id: payload.id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model: requestedModel,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: choice.finish_reason === "tool_calls" ? "tool_use" : (choice.finish_reason || "end_turn"),
    stop_sequence: null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens || 0,
      output_tokens: payload.usage?.completion_tokens || 0
    }
  };
}

export async function streamChatAsAnthropic(upstream, res, requestedModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const id = `msg_${crypto.randomUUID()}`;
  writeEvent(res, "message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: requestedModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  writeEvent(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  let streamError = null;
  try {
    for await (const chunk of upstream.body) {
      const raw = Buffer.from(chunk).toString("utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const event = safeJsonParse(data);
        if (!event) continue;
        const delta = event.choices?.[0]?.delta?.content;
        const deltaText = typeof delta === "string" ? delta : contentToText(delta);
        if (!deltaText) continue;
        writeEvent(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: deltaText } });
      }
    }
  } catch (err) {
    streamError = err;
  }
  writeEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
  if (streamError) writeAnthropicErrorEvent(res, streamError);
  writeEvent(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 } });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

export function streamAnthropicError(res, err) {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
  }
  writeAnthropicErrorEvent(res, err);
  res.end();
}

export function streamMessageAsAnthropic(message, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const id = message.id || `msg_${crypto.randomUUID()}`;
  const content = Array.isArray(message.content) ? message.content : [];
  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: message.role || "assistant",
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: message.usage?.input_tokens || 0, output_tokens: 0 }
    }
  });
  content.forEach((block, index) => {
    if (block?.type === "text") {
      writeEvent(res, "content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
      if (block.text) writeEvent(res, "content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
    } else if (block?.type === "tool_use") {
      writeEvent(res, "content_block_start", { type: "content_block_start", index, content_block: block });
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
    }
  });
  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: message.stop_sequence || null },
    usage: { output_tokens: message.usage?.output_tokens || 0 }
  });
  writeEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

export function countTokensApprox(body) {
  const text = [...(body.messages || []).map((m) => contentToText(m.content)), contentToText(body.system || "")].join("\n");
  return { input_tokens: Math.ceil(text.length / 4) };
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeAnthropicErrorEvent(res, err) {
  const message = err?.message || String(err);
  writeEvent(res, "error", {
    type: "error",
    error: {
      type: "api_error",
      message
    }
  });
}

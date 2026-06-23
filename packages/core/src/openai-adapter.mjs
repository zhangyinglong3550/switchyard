// Adapter between OpenAI Responses API and Chat Completions, including streaming.
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";

function flattenContent(content) {
  if (typeof content === "string") return content;
  return contentToText(content);
}

export function responsesToChat(body, upstreamModel) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: flattenContent(body.instructions) });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message" || item.role) {
        messages.push({
          role: item.role || "user",
          content: flattenContent(item.content ?? item.text ?? "")
        });
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
              type: "function",
              function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) }
            }
          ]
        });
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id || "",
          content: flattenContent(item.output || item.content || "")
        });
      }
    }
  }
  const chat = {
    model: upstreamModel,
    messages: messages.length ? messages : [{ role: "user", content: "" }],
    stream: Boolean(body.stream)
  };
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (Array.isArray(body.tools)) {
    chat.tools = body.tools
      .filter((t) => t && t.type === "function")
      .map((t) => ({ type: "function", function: t.function ? t.function : { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  return chat;
}

export function chatToResponse(payload, requestedModel) {
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const text = flattenContent(message.content || "");
  if (text) {
    output.push({
      type: "message",
      id: `msg_${crypto.randomUUID()}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${crypto.randomUUID()}`,
        call_id: call.id || `call_${crypto.randomUUID()}`,
        status: "completed",
        name: call.function?.name,
        arguments: call.function?.arguments || "{}"
      });
    }
  }
  return {
    id: payload.id || `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: payload.usage || null
  };
}

export async function streamChatAsResponses(upstream, res, requestedModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const responseId = `resp_${crypto.randomUUID()}`;
  const itemId = `msg_${crypto.randomUUID()}`;
  const baseResponse = { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: requestedModel, output: [] };
  writeEvent(res, "response.created", { type: "response.created", response: baseResponse });
  writeEvent(res, "response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
  writeEvent(res, "response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  let text = "";
  for await (const chunk of upstream.body) {
    const raw = Buffer.from(chunk).toString("utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const event = safeJsonParse(data);
      if (!event) continue;
      const delta = event.choices?.[0]?.delta?.content;
      const deltaText = typeof delta === "string" ? delta : flattenContent(delta);
      if (!deltaText) continue;
      text += deltaText;
      writeEvent(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta: deltaText });
    }
  }
  writeEvent(res, "response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text });
  writeEvent(res, "response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } });
  writeEvent(res, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { id: itemId, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } });
  writeEvent(res, "response.completed", { type: "response.completed", response: { ...baseResponse, status: "completed", output: [] } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

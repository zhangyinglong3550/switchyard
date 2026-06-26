// Adapter between Anthropic Messages API and OpenAI Chat Completions.
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";
import { SWITCHYARD_THINKING_KEY, cloneAnthropicThinkingBlocks, reasoningBlocksFromMessage } from "./reasoning.mjs";

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
      const thinkingBlocks = cloneAnthropicThinkingBlocks(msg.content);
      const textContent = contentToText(msg.content.filter((b) => !b || (b.type !== "tool_use" && b.type !== "tool_result")));
      if (role === "assistant" && toolUses.length) {
        const message = {
          role: "assistant",
          content: textContent,
          tool_calls: toolUses.map((u) => ({
            id: u.id || `call_${crypto.randomUUID()}`,
            type: "function",
            function: { name: u.name, arguments: JSON.stringify(u.input || {}) }
          }))
        };
        if (thinkingBlocks.length) message[SWITCHYARD_THINKING_KEY] = thinkingBlocks;
        messages.push(message);
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
      if (role === "assistant" && thinkingBlocks.length) {
        messages.push({
          role,
          content: contentToChatContent(msg.content),
          [SWITCHYARD_THINKING_KEY]: thinkingBlocks
        });
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
  content.push(...reasoningBlocksFromMessage(message));
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
        const choice = event.choices?.[0] || {};
        const delta = choice.delta || {};
        const deltaContent = delta.content;
        const deltaReasoning = delta.reasoning_content;
        let deltaText = typeof deltaContent === "string" ? deltaContent : contentToText(deltaContent);
        if (!deltaText && typeof deltaReasoning === "string" && deltaReasoning.length > 0) {
          deltaText = deltaReasoning;
        }
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
    } else if (block?.type === "thinking") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "", signature: "" }
      });
      if (block.thinking || block.text) {
        writeEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: block.thinking || block.text || "" }
        });
      }
      if (block.signature) {
        writeEvent(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature }
        });
      }
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
    } else if (block?.type === "redacted_thinking") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: { ...block }
      });
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index });
    } else if (block?.type === "tool_use") {
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id || `toolu_${crypto.randomUUID()}`,
          name: block.name,
          input: {}
        }
      });
      const partialJson = JSON.stringify(block.input && typeof block.input === "object" ? block.input : {});
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: partialJson }
      });
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

// Anthropic SSE → OpenAI Chat SSE 实时流式翻译器。
// 读取 Anthropic Messages stream（event: xxx / data: {...} 格式），
// 逐事件翻译成 OpenAI Chat Completions stream（data: {...} 格式）。
export async function streamAnthropicAsChat(upstream, res, requestedModel) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const id = `chatcmpl_${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  // 追踪 content_block index → tool_call 状态
  const toolCalls = new Map(); // blockIndex → { id, name, argumentsBuffer, chatIndex }
  let nextToolCallIndex = 0;
  let finishReason = null;
  let streamError = null;
  const decoder = new TextDecoder();
  let buffer = "";

  // 写入一条 Chat SSE data 事件
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

  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      // SSE 记录以空行分隔
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() || "";
      for (const record of records) {
        const parsed = parseAnthropicSseRecord(record);
        if (!parsed) continue;
        handleAnthropicEvent(parsed, { writeChatChunk, toolCalls, getNextToolCallIndex: () => nextToolCallIndex++ });
      }
    }
    // 处理剩余 buffer
    buffer += decoder.decode();
    if (buffer.trim()) {
      const parsed = parseAnthropicSseRecord(buffer);
      if (parsed) handleAnthropicEvent(parsed, { writeChatChunk, toolCalls, getNextToolCallIndex: () => nextToolCallIndex++ });
    }
  } catch (err) {
    streamError = err;
  }

  // 如果上游报错或中断，发一个错误 delta
  if (streamError) {
    writeChatChunk({ content: `\n[stream error: ${streamError?.message || streamError}]` });
  }

  // 发送结束 chunk
  writeChatChunk({}, { finishReason: finishReason || "stop" });
  res.write("data: [DONE]\n\n");
  res.end();
}

// 解析一条 Anthropic SSE 记录，返回 { event, data } 或 null
function parseAnthropicSseRecord(record) {
  let eventName = "";
  const dataLines = [];
  for (const line of record.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!eventName && !dataLines.length) return null;
  const dataText = dataLines.join("\n");
  const data = dataText ? safeJsonParse(dataText) : {};
  if (!data) return null;
  return { event: eventName, data };
}

// 处理单个 Anthropic 事件，翻译成 Chat SSE chunk
function handleAnthropicEvent({ event, data }, ctx) {
  const { writeChatChunk, toolCalls, getNextToolCallIndex } = ctx;

  switch (event) {
    case "message_start": {
      // 发送初始 chunk，带 role
      writeChatChunk({ role: "assistant", content: "" });
      break;
    }
    case "content_block_start": {
      const block = data.content_block || {};
      const index = data.index ?? 0;
      if (block.type === "tool_use") {
        const chatIndex = getNextToolCallIndex();
        toolCalls.set(index, {
          id: block.id || `call_${crypto.randomUUID()}`,
          name: block.name || "",
          argumentsBuffer: "",
          chatIndex
        });
        // 发送 tool_call 起始 delta
        writeChatChunk({
          tool_calls: [{
            index: chatIndex,
            id: block.id || `call_${crypto.randomUUID()}`,
            type: "function",
            function: { name: block.name || "", arguments: "" }
          }]
        });
      }
      // text 块不需要起始 delta，等 delta 事件推送内容
      break;
    }
    case "content_block_delta": {
      const delta = data.delta || {};
      const index = data.index ?? 0;
      if (delta.type === "text_delta") {
        writeChatChunk({ content: delta.text || "" });
      } else if (delta.type === "thinking_delta") {
        // thinking 内容映射到 reasoning_content（OpenAI 扩展字段）
        writeChatChunk({ reasoning_content: delta.thinking || "" });
      } else if (delta.type === "input_json_delta") {
        // tool_use 参数增量
        const entry = toolCalls.get(index);
        if (entry) {
          entry.argumentsBuffer += delta.partial_json || "";
          writeChatChunk({
            tool_calls: [{
              index: entry.chatIndex,
              function: { arguments: delta.partial_json || "" }
            }]
          });
        }
      } else if (delta.type === "signature_delta") {
        // signature 不映射到 chat 格式，跳过
      }
      break;
    }
    case "content_block_stop": {
      // tool_use block 结束时不需要额外操作
      break;
    }
    case "message_delta": {
      const delta = data.delta || {};
      if (delta.stop_reason === "tool_use") {
        finishReason = "tool_calls";
      } else if (delta.stop_reason === "end_turn" || delta.stop_reason === "stop_sequence") {
        finishReason = "stop";
      } else if (delta.stop_reason === "max_tokens") {
        finishReason = "length";
      }
      break;
    }
    case "message_stop": {
      // finishReason 已在 message_delta 中设置
      break;
    }
    case "error": {
      const msg = data?.error?.message || data?.error || "upstream error";
      writeChatChunk({ content: `\n[upstream error: ${msg}]` });
      break;
    }
    case "ping":
    default:
      // 忽略 ping 和未知事件
      break;
  }
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

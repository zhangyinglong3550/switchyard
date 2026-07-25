// Adapter between Anthropic Messages API and OpenAI Chat Completions.
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";
import { SseParser } from "./sse-parser.mjs";
import { iterateUpstreamBody } from "./stream-idle-timeout.mjs";
import {
  ANTHROPIC_PING_MS,
  startStreamKeepalive,
  writeAnthropicPing
} from "./stream-keepalive.mjs";
import {
  SWITCHYARD_THINKING_KEY,
  cloneAnthropicThinkingBlocks,
  reasoningBlocksFromMessage,
  resolveReasoningEffortFromAnthropic
} from "./reasoning.mjs";

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
  // Claude Code 思考档位 → Chat reasoning，供 reasoning-options / chatToResponses 继续映射
  applyAnthropicReasoningToChat(chat, body);
  return chat;
}

/**
 * Anthropic 请求级 thinking / output_config → Chat `reasoning` 对象。
 * 对齐 CC Switch resolve_reasoning_effort；未知值不注入。
 */
function applyAnthropicReasoningToChat(chat, body) {
  const effort = resolveReasoningEffortFromAnthropic(body);
  if (effort == null) return;
  if (effort === "none") {
    chat.reasoning = { effort: "none" };
    return;
  }
  chat.reasoning = { effort };
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

export async function streamChatAsAnthropic(upstream, res, requestedModel, options = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const id = `msg_${crypto.randomUUID()}`;
  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });

  let streamError = null;
  let terminalSeen = false;
  let finishReason = null; // first non-null wins
  let textStarted = false;
  let textBlockStopped = false;
  let nextBlockIndex = 0;
  const toolBlocks = new Map(); // delta.index -> { blockIndex, id, name, input }

  const ensureTextBlock = () => {
    if (!textStarted) {
      textStarted = true;
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" }
      });
      nextBlockIndex = Math.max(nextBlockIndex, 1);
    }
    return 0;
  };

  const ensureToolBlock = (deltaTool) => {
    const key = Number.isInteger(deltaTool?.index) ? deltaTool.index : 0;
    const existing = toolBlocks.get(key);
    if (existing) return existing;
    const entry = {
      blockIndex: nextBlockIndex++,
      id: deltaTool?.id || `call_${crypto.randomUUID()}`,
      name: deltaTool?.function?.name || "unknown_tool",
      input: ""
    };
    toolBlocks.set(key, entry);
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: entry.blockIndex,
      content_block: {
        type: "tool_use",
        id: entry.id,
        name: entry.name,
        input: {}
      }
    });
    return entry;
  };

  const finalizeToolBlocks = () => {
    for (const [, entry] of toolBlocks) {
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index: entry.blockIndex });
    }
  };

  const parser = new SseParser((record) => {
    const data = String(record.data || "").trim();
    if (!data) return;
    if (data === "[DONE]") {
      terminalSeen = true;
      return;
    }
    const event = safeJsonParse(data);
    if (!event) return;
    if (event.type === "error" || event.error) {
      streamError = new Error(event.error?.message || event.message || "Chat stream returned an error");
      return;
    }
    const choice = event.choices?.[0] || {};
    const delta = choice.delta || {};

    if (finishReason == null && choice.finish_reason != null) {
      finishReason = choice.finish_reason;
      terminalSeen = true;
    }

    const deltaContent = delta.content;
    const deltaReasoning = delta.reasoning_content;
    let deltaText = typeof deltaContent === "string" ? deltaContent : contentToText(deltaContent);
    if (!deltaText && typeof deltaReasoning === "string" && deltaReasoning.length > 0) {
      deltaText = deltaReasoning;
    }
    if (deltaText) {
      const idx = ensureTextBlock();
      writeEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: idx,
        delta: { type: "text_delta", text: deltaText }
      });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const entry = ensureToolBlock(tc);
        if (tc?.id) entry.id = tc.id;
        if (tc?.function?.name) entry.name = tc.function.name;
        const argDelta = tc?.function?.arguments || "";
        if (argDelta) {
          entry.input += argDelta;
          writeEvent(res, "content_block_delta", {
            type: "content_block_delta",
            index: entry.blockIndex,
            delta: { type: "input_json_delta", partial_json: argDelta }
          });
        }
      }
    }
  });

  const keepalive = startStreamKeepalive(res, {
    intervalMs: options.heartbeatMs || ANTHROPIC_PING_MS,
    writeHeartbeat: writeAnthropicPing
  });
  try {
    for await (const chunk of iterateUpstreamBody(upstream?.body, {
      timeoutMs: options.idleTimeoutMs,
      label: "Chat stream"
    })) {
      keepalive.touch();
      parser.push(chunk);
    }
    parser.flush();
  } catch (err) {
    streamError = err;
  } finally {
    keepalive.stop();
  }

  if (!terminalSeen && !streamError) {
    streamError = new Error("Chat stream ended before completion");
  }

  if (terminalSeen && !streamError) {
    if (textStarted && !textBlockStopped) {
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      textBlockStopped = true;
    }
    finalizeToolBlocks();
    const stopReason = finishReason === "tool_calls" ? "tool_use" : (finishReason || "end_turn");
    writeEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 }
    });
    writeEvent(res, "message_stop", { type: "message_stop" });
  } else {
    writeAnthropicErrorEvent(res, streamError || new Error("Chat stream failed"));
  }
  res.end();
}

// OpenAI Responses SSE → Anthropic Messages SSE. This is intentionally direct
// instead of Responses → Chat → Anthropic: forwarding a second generated SSE
// stream loses terminal/error semantics and is where Claude Code used to hang
// after a partial response.
export async function streamResponsesAsAnthropic(upstream, res, requestedModel, options = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const id = `msg_${crypto.randomUUID()}`;
  let textStarted = false;
  let textEmitted = false;
  let textBlockIndex = -1;
  let terminalSeen = false;
  let failed = false;
  let streamError = null;
  let nextBlockIndex = 0;
  let outputTokens = 0;
  const toolBlocks = new Map();

  const writeStart = () => writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: requestedModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  const ensureTextBlock = () => {
    if (!textStarted) {
      textStarted = true;
      textBlockIndex = nextBlockIndex;
      writeEvent(res, "content_block_start", {
        type: "content_block_start",
        index: textBlockIndex,
        content_block: { type: "text", text: "" }
      });
      nextBlockIndex += 1;
    }
    return textBlockIndex;
  };
  const toolKey = (event, item) => (
    Number.isInteger(event?.output_index) ? `output:${event.output_index}` :
      Number.isInteger(event?.index) ? `output:${event.index}` :
        event?.item_id || item?.id || item?.call_id || "output:0"
  );
  const ensureTool = (key, patch = {}) => {
    let state = toolBlocks.get(key);
    if (!state) {
      state = { blockIndex: nextBlockIndex++, id: "", name: "", arguments: "", started: false, sentArguments: false };
      toolBlocks.set(key, state);
    }
    Object.assign(state, patch);
    return state;
  };
  const announceTool = (state) => {
    if (state.started || !state.name) return;
    state.started = true;
    writeEvent(res, "content_block_start", {
      type: "content_block_start",
      index: state.blockIndex,
      content_block: {
        type: "tool_use",
        id: state.id || `toolu_${crypto.randomUUID()}`,
        name: state.name,
        input: {}
      }
    });
  };
  const emitToolArguments = (state, value, { replace = false } = {}) => {
    if (!value) return;
    announceTool(state);
    if (!state.started) return;
    state.arguments = replace ? value : `${state.arguments || ""}${value}`;
    state.sentArguments = true;
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndex,
      delta: { type: "input_json_delta", partial_json: value }
    });
  };
  const emitText = (value) => {
    if (!value) return;
    const index = ensureTextBlock();
    textEmitted = true;
    writeEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text: value }
    });
  };
  const textFromResponse = (response) => (response?.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .map((part) => part?.text || part?.output_text || "")
    .filter(Boolean)
    .join("");
  const addCompletedTools = (response) => {
    for (const item of response?.output || []) {
      if (item?.type !== "function_call") continue;
      const state = ensureTool(toolKey({}, item), {
        id: item.call_id || item.id || "",
        name: item.name || "",
        arguments: item.arguments || ""
      });
      announceTool(state);
      if (!state.sentArguments && state.arguments) emitToolArguments(state, state.arguments, { replace: true });
    }
  };

  writeStart();
  const handleEvent = (event) => {
    if (!event || typeof event !== "object") return;
    if (event.type === "error" || event.error || event.type === "response.failed" || event.type === "response.incomplete" || event.type === "response.cancelled") {
      failed = true;
      throw new Error(event.response?.error?.message || event.error?.message || event.response?.incomplete_details?.reason || event.message || "Responses stream failed");
    }
    if (event.type === "response.output_text.delta") {
      emitText(typeof event.delta === "string" ? event.delta : "");
      return;
    }
    if (event.type === "response.output_text.done") {
      if (!textEmitted) emitText(typeof event.text === "string" ? event.text : "");
      return;
    }
    if (event.type === "response.content_part.done" && !textEmitted) {
      emitText(event.part?.text || event.part?.output_text || "");
      return;
    }
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const item = event.item;
      if (item?.type !== "function_call") return;
      const state = ensureTool(toolKey(event, item), {
        id: item.call_id || item.id || "",
        name: item.name || "",
        arguments: item.arguments || ""
      });
      announceTool(state);
      if (event.type === "response.output_item.done" && !state.sentArguments && state.arguments) {
        emitToolArguments(state, state.arguments, { replace: true });
      }
      return;
    }
    if (event.type === "response.function_call_arguments.delta" || event.type === "response.function_call_arguments.done") {
      const value = event.type === "response.function_call_arguments.done"
        ? (event.arguments || "")
        : (event.delta || event.arguments_delta || event.partial_json || "");
      const state = ensureTool(toolKey(event), {
        id: event.call_id || event.item_id || "",
        name: event.name || ""
      });
      if (event.type === "response.function_call_arguments.done" && !state.sentArguments) {
        emitToolArguments(state, value, { replace: true });
      } else if (event.type === "response.function_call_arguments.delta") {
        emitToolArguments(state, value);
      }
      return;
    }
    if (event.type === "response.completed" || event.type === "response.done") {
      terminalSeen = true;
      const response = event.response || {};
      outputTokens = response.usage?.output_tokens ?? response.usage?.completion_tokens ?? outputTokens;
      if (!textEmitted) emitText(textFromResponse(response));
      addCompletedTools(response);
    }
  };

  const parser = new SseParser((record) => {
    const data = String(record.data || "").trim();
    if (!data) return;
    if (data === "[DONE]") {
      terminalSeen = true;
      return;
    }
    handleEvent(safeJsonParse(data));
  });

  const keepalive = startStreamKeepalive(res, {
    intervalMs: options.heartbeatMs || ANTHROPIC_PING_MS,
    writeHeartbeat: writeAnthropicPing
  });
  try {
    if (!upstream?.body) throw new Error(`Responses stream empty (status ${upstream?.status || 0})`);
    for await (const chunk of iterateUpstreamBody(upstream?.body, {
      timeoutMs: options.idleTimeoutMs,
      label: "Responses stream"
    })) {
      keepalive.touch();
      parser.push(chunk);
    }
    parser.flush();
  } catch (err) {
    if (!terminalSeen || failed) streamError = err;
  } finally {
    keepalive.stop();
  }

  if (!terminalSeen && !streamError) streamError = new Error("Responses stream ended before completion");
  if (streamError || failed) {
    writeAnthropicErrorEvent(res, streamError || new Error("Responses stream failed"));
  } else {
    if (textStarted) {
      writeEvent(res, "content_block_stop", { type: "content_block_stop", index: textBlockIndex });
    }
    for (const state of toolBlocks.values()) {
      if (state.started) writeEvent(res, "content_block_stop", { type: "content_block_stop", index: state.blockIndex });
    }
    writeEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: toolBlocks.size ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: outputTokens || 0 }
    });
    writeEvent(res, "message_stop", { type: "message_stop" });
  }
  res.end();

  try {
    options.onStreamSummary?.({
      protocol: "anthropic_messages",
      usage: outputTokens ? { output_tokens: outputTokens } : null,
      sawTerminalEvent: terminalSeen,
      sawMeaningfulEvent: textEmitted || Array.from(toolBlocks.values()).some((state) => state.started),
      failed: Boolean(streamError || failed)
    });
  } catch {}
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
export async function streamAnthropicAsChat(upstream, res, requestedModel, options = {}) {
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
  const state = { finishReason: null, terminalSeen: false, failed: false };
  let streamError = null;

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

  const parser = new SseParser((record) => {
    const dataText = String(record.data || "").trim();
    if (dataText === "[DONE]") {
      state.terminalSeen = true;
      return;
    }
    const data = dataText ? safeJsonParse(dataText) : {};
    if (!data) return;
    handleAnthropicEvent(
      { event: record.event || "message", data },
      { writeChatChunk, toolCalls, getNextToolCallIndex: () => nextToolCallIndex++, state }
    );
  });

  try {
    for await (const chunk of iterateUpstreamBody(upstream?.body, {
      timeoutMs: options.idleTimeoutMs,
      label: "Anthropic stream"
    })) parser.push(chunk);
    parser.flush();
  } catch (err) {
    streamError = err;
  }

  if (!state.terminalSeen && !streamError && !state.failed) {
    streamError = new Error("Anthropic stream ended before message_stop");
  }

  if (streamError || state.failed) {
    writeChatErrorEvent(res, streamError || new Error("Anthropic stream returned an error"));
  } else {
    writeChatChunk({}, { finishReason: state.finishReason || "stop" });
    res.write("data: [DONE]\n\n");
  }
  res.end();
}

// 处理单个 Anthropic 事件，翻译成 Chat SSE chunk
function handleAnthropicEvent({ event, data }, ctx) {
  const { writeChatChunk, toolCalls, getNextToolCallIndex, state } = ctx;

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
        state.finishReason = "tool_calls";
      } else if (delta.stop_reason === "end_turn" || delta.stop_reason === "stop_sequence") {
        state.finishReason = "stop";
      } else if (delta.stop_reason === "max_tokens") {
        state.finishReason = "length";
      }
      break;
    }
    case "message_stop": {
      state.terminalSeen = true;
      break;
    }
    case "error": {
      state.failed = true;
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

function writeChatErrorEvent(res, err) {
  const message = err?.message || String(err);
  res.write("event: error\n");
  res.write(`data: ${JSON.stringify({
    type: "error",
    error: {
      type: "upstream_stream_error",
      message
    }
  })}\n\n`);
}

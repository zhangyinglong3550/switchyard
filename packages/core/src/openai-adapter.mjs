// Adapter between OpenAI Responses API and Chat Completions, including streaming.
import crypto from "node:crypto";
import { contentToText, safeJsonParse } from "./utils.mjs";
import {
  SWITCHYARD_THINKING_KEY,
  cloneAnthropicThinkingBlocks,
  encodeAnthropicThinkingBlocks,
  decodeAnthropicThinkingBlocks,
  thinkingSummaryText,
  extractReasoningSummaryText,
  reasoningBlocksFromMessage,
  contentWithoutLeadingThink
} from "./reasoning.mjs";

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (typeof content.output_text === "string") return content.output_text;
    if (Array.isArray(content.parts)) return contentToText(content.parts);
    if (Array.isArray(content.content)) return contentToText(content.content);
  }
  return contentToText(content);
}

function contentToChatContent(content) {
  if (!Array.isArray(content)) return flattenContent(content);
  const parts = [];
  let hasImage = false;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "input_image" && part.image_url) {
      hasImage = true;
      parts.push({ type: "image_url", image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } });
      continue;
    }
    if (part.type === "image_url" && part.image_url) {
      hasImage = true;
      parts.push(part);
      continue;
    }
    const text = contentToText(part);
    if (text) parts.push({ type: "text", text });
  }
  return hasImage ? parts : contentToText(content);
}

function responsesRoleToChatRole(role) {
  if (role === "developer") return "system";
  if (["system", "user", "assistant", "tool"].includes(role)) return role;
  return "user";
}

// Codex App 把插件工具（如 @Chrome）作为 namespace 工具下发。第三方 Chat 模型不认识
// namespace，需要把它们拍平成 `namespace__fn` 形式的普通函数；回包时再还原。
export function extractNamespaceMap(tools) {
  if (!Array.isArray(tools)) return {};
  const map = {};
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || tool.type !== "namespace") continue;
    const namespace = tool.name || "";
    const functions = tool.functions || tool.tools || [];
    for (const fn of functions) {
      if (fn && typeof fn === "object" && fn.name) {
        map[`${namespace}__${fn.name}`] = { namespace, name: fn.name };
      }
    }
  }
  return map;
}

function unflattenToolName(name, namespaceMap = {}) {
  // 1. 精确命中（上游原样回传我们拍平的名字）
  if (namespaceMap[name]) return namespaceMap[name];
  // 2. 兜底：部分上游（如 StepFun）会改写工具名里的下划线数量（把 `__` 变成 `___`），
  //    导致精确匹配失败。对连续下划线归一化后再匹配，避免工具名被拆错。
  if (name.includes("_")) {
    const norm = (s) => s.replace(/_+/g, "_");
    const normName = norm(name);
    for (const key of Object.keys(namespaceMap)) {
      if (norm(key) === normName) return namespaceMap[key];
    }
  }
  // 3. 没有 namespaceMap 信息时，按 `__` 拆分（最后一段为函数名）
  if (name.includes("__")) {
    const parts = name.split("__");
    return { namespace: parts.slice(0, -1).join("__"), name: parts[parts.length - 1] };
  }
  return { namespace: null, name };
}

export function responsesToChat(body, upstreamModel) {
  const messages = [];
  let pendingThinking = [];
  let lastFunctionCallMessage = null;
  const takePendingThinking = () => {
    const out = pendingThinking;
    pendingThinking = [];
    return out;
  };
  const attachThinking = (message) => {
    const thinking = takePendingThinking();
    if (thinking.length) message[SWITCHYARD_THINKING_KEY] = thinking;
    return message;
  };
  if (body.instructions) messages.push({ role: "system", content: flattenContent(body.instructions) });
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "reasoning") {
        const encrypted = decodeAnthropicThinkingBlocks(item.encrypted_content);
        if (encrypted.length) {
          pendingThinking.push(...encrypted);
        } else {
          const summary = extractReasoningSummaryText(item);
          if (summary) pendingThinking.push({ type: "thinking", thinking: summary });
        }
        lastFunctionCallMessage = null;
        continue;
      }
      if (item.type === "message" || item.role) {
        const message = {
          role: responsesRoleToChatRole(item.role || "user"),
          content: contentToChatContent(item.content ?? item.text ?? "")
        };
        messages.push(message.role === "assistant" ? attachThinking(message) : message);
        lastFunctionCallMessage = null;
      } else if (item.type === "function_call") {
        const call = {
          id: item.call_id || item.id || `call_${crypto.randomUUID()}`,
          type: "function",
          function: { name: item.name, arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}) }
        };
        if (lastFunctionCallMessage) {
          lastFunctionCallMessage.tool_calls.push(call);
        } else {
          lastFunctionCallMessage = attachThinking({ role: "assistant", content: "", tool_calls: [call] });
          messages.push(lastFunctionCallMessage);
        }
      } else if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id || "",
          content: flattenContent(item.output || item.content || "")
        });
        lastFunctionCallMessage = null;
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
    const flatTools = [];
    for (const tool of body.tools) {
      if (!tool || typeof tool !== "object") continue;
      if (tool.type === "function" && (tool.name || tool.function?.name)) {
        flatTools.push({
          type: "function",
          function: tool.function
            ? tool.function
            : { name: tool.name, description: tool.description, parameters: tool.parameters }
        });
      } else if (tool.type === "namespace") {
        // 把 namespace 工具拍平成单独的函数，避免被丢弃（@Chrome 等插件工具就走这里）
        const namespace = tool.name || "";
        const functions = tool.functions || tool.tools || [];
        for (const fn of functions) {
          if (!fn || typeof fn !== "object" || !fn.name) continue;
          flatTools.push({
            type: "function",
            function: {
              name: `${namespace}__${fn.name}`,
              description: fn.description || "",
              parameters: fn.parameters || fn.input_schema || { type: "object", properties: {} }
            }
          });
        }
      }
      // tool_search 及其他 hosted 工具（web_search 等）无法转发给第三方 Chat 模型，直接跳过。
    }
    chat.tools = flatTools;
  }
  if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
  if (body.reasoning !== undefined) chat.reasoning = body.reasoning;
  if (body.reasoning_effort !== undefined) chat.reasoning_effort = body.reasoning_effort;
  return chat;
}

export function chatToResponse(payload, requestedModel, options = {}) {
  const namespaceMap = options.namespaceMap || {};
  const choice = payload.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const thinkingBlocks = reasoningBlocksFromMessage(message);
  if (thinkingBlocks.length) {
    const summary = thinkingSummaryText(thinkingBlocks);
    output.push({
      type: "reasoning",
      id: `rs_${crypto.randomUUID()}`,
      status: "completed",
      summary: summary ? [{ type: "summary_text", text: summary }] : [],
      content: summary ? [{ type: "reasoning_text", text: summary }] : [],
      encrypted_content: encodeAnthropicThinkingBlocks(thinkingBlocks)
    });
  }
  const text = flattenContent(contentWithoutLeadingThink(message.content || ""));
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
      const rawName = call.function?.name || call.name || "unknown";
      const resolved = unflattenToolName(rawName, namespaceMap);
      const item = {
        type: "function_call",
        id: `fc_${crypto.randomUUID()}`,
        call_id: call.id || `call_${crypto.randomUUID()}`,
        status: "completed",
        name: resolved.name || rawName,
        arguments: call.function?.arguments || "{}"
      };
      // 还原 namespace，让 Codex App 能把调用路由回插件工具（如 @Chrome）
      if (resolved.namespace) item.namespace = resolved.namespace;
      output.push(item);
    }
  }
  return {
    id: payload.id || `resp_${crypto.randomUUID()}`,
    object: "response",
    created_at: payload.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: requestedModel,
    output,
    usage: normalizeResponsesUsage(payload.usage)
  };
}

function firstNumber(...values) {
  for (const value of values) {
    if (Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

function normalizeResponsesUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = firstNumber(usage.input_tokens, usage.prompt_tokens);
  const output = firstNumber(usage.output_tokens, usage.completion_tokens);
  const total = firstNumber(usage.total_tokens, input + output);
  return {
    ...usage,
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    prompt_tokens: firstNumber(usage.prompt_tokens, input),
    completion_tokens: firstNumber(usage.completion_tokens, output)
  };
}

const THINK_OPEN_TAG = "<think>";
const THINK_CLOSE_TAG = "</think>";

function suffixPrefixLength(value, prefix) {
  const max = Math.min(value.length, prefix.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (value.endsWith(prefix.slice(0, len))) return len;
  }
  return 0;
}

class ThinkTagStreamSplitter {
  constructor() {
    this.mode = "answer";
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += String(chunk || "");
    let text = "";
    let reasoning = "";
    while (this.buffer.length) {
      if (this.mode === "answer") {
        const openIndex = this.buffer.indexOf(THINK_OPEN_TAG);
        if (openIndex >= 0) {
          text += this.buffer.slice(0, openIndex);
          this.buffer = this.buffer.slice(openIndex + THINK_OPEN_TAG.length);
          this.mode = "thinking";
          continue;
        }
        const keep = suffixPrefixLength(this.buffer, THINK_OPEN_TAG);
        text += keep ? this.buffer.slice(0, -keep) : this.buffer;
        this.buffer = keep ? this.buffer.slice(-keep) : "";
        break;
      }

      const closeIndex = this.buffer.indexOf(THINK_CLOSE_TAG);
      if (closeIndex >= 0) {
        reasoning += this.buffer.slice(0, closeIndex);
        this.buffer = this.buffer.slice(closeIndex + THINK_CLOSE_TAG.length);
        this.mode = "answer";
        continue;
      }
      const keep = suffixPrefixLength(this.buffer, THINK_CLOSE_TAG);
      reasoning += keep ? this.buffer.slice(0, -keep) : this.buffer;
      this.buffer = keep ? this.buffer.slice(-keep) : "";
      break;
    }
    return { text, reasoning };
  }

  flush() {
    if (!this.buffer) return { text: "", reasoning: "" };
    const out = this.mode === "thinking"
      ? { text: "", reasoning: this.buffer }
      : { text: this.buffer, reasoning: "" };
    this.buffer = "";
    this.mode = "answer";
    return out;
  }
}

export async function streamChatAsResponses(upstream, res, requestedModel, options = {}) {
  const namespaceMap = options.namespaceMap || {};
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  const responseId = `resp_${crypto.randomUUID()}`;
  const itemId = `msg_${crypto.randomUUID()}`;
  const reasoningItemId = `rs_${crypto.randomUUID()}`;
  const baseResponse = { id: responseId, object: "response", created_at: Math.floor(Date.now() / 1000), status: "in_progress", model: requestedModel, output: [] };
  writeEvent(res, "response.created", { type: "response.created", response: baseResponse });
  let text = "";
  let reasoning = "";
  let reasoningStarted = false;
  let messageStarted = false;
  let reasoningSummaryPartStarted = false;
  let reasoningContentPartStarted = false;
  let nextOutputIndex = 0;
  let reasoningOutputIndex = null;
  let messageOutputIndex = null;
  const thinkSplitter = new ThinkTagStreamSplitter();
  const ensureReasoningStarted = () => {
    if (reasoningStarted) return;
    reasoningStarted = true;
    reasoningOutputIndex = nextOutputIndex++;
    writeEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: reasoningOutputIndex,
      item: { id: reasoningItemId, type: "reasoning", status: "in_progress", summary: [], content: [], encrypted_content: null }
    });
  };
  const ensureReasoningSummaryPartStarted = () => {
    ensureReasoningStarted();
    if (reasoningSummaryPartStarted) return;
    reasoningSummaryPartStarted = true;
    writeEvent(res, "response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" }
    });
  };
  const ensureReasoningContentPartStarted = () => {
    ensureReasoningStarted();
    if (reasoningContentPartStarted) return;
    reasoningContentPartStarted = true;
    writeEvent(res, "response.content_part.added", {
      type: "response.content_part.added",
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: "" }
    });
  };
  const appendReasoning = (deltaText) => {
    const value = String(deltaText || "");
    if (!value) return;
    reasoning += value;
    ensureReasoningSummaryPartStarted();
    ensureReasoningContentPartStarted();
    writeEvent(res, "response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: 0,
      delta: value
    });
    writeEvent(res, "response.reasoning_text.delta", {
      type: "response.reasoning_text.delta",
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      content_index: 0,
      delta: value
    });
  };
  const ensureMessageStarted = () => {
    if (messageStarted) return;
    messageStarted = true;
    messageOutputIndex = nextOutputIndex++;
    const index = messageOutputIndex;
    writeEvent(res, "response.output_item.added", { type: "response.output_item.added", output_index: index, item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] } });
    writeEvent(res, "response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
  };
  const appendText = (deltaText) => {
    if (!deltaText) return;
    ensureMessageStarted();
    text += deltaText;
    writeEvent(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: messageOutputIndex, content_index: 0, delta: deltaText });
  };
  // Tool call streaming state
  const toolCalls = new Map(); // index -> { id, name, arguments, itemId, outputIndex, argumentsDone }
  const ensureToolCallStarted = (tc) => {
    const index = tc.index ?? 0;
    if (toolCalls.has(index)) return toolCalls.get(index);
    const tcItemId = `fc_${crypto.randomUUID()}`;
    const tcOutputIndex = nextOutputIndex++;
    const entry = {
      id: tc.id || `call_${crypto.randomUUID()}`,
      name: tc.function?.name || "",
      arguments: "",
      itemId: tcItemId,
      outputIndex: tcOutputIndex,
      argumentsDone: false
    };
    toolCalls.set(index, entry);
    const resolved = unflattenToolName(entry.name, namespaceMap);
    entry.resolvedName = resolved.name || entry.name;
    entry.namespace = resolved.namespace || null;
    const addedItem = {
      id: tcItemId,
      type: "function_call",
      status: "in_progress",
      call_id: entry.id,
      name: entry.resolvedName,
      arguments: ""
    };
    if (entry.namespace) addedItem.namespace = entry.namespace;
    writeEvent(res, "response.output_item.added", {
      type: "response.output_item.added",
      output_index: tcOutputIndex,
      item: addedItem
    });
    return entry;
  };
  const handleData = (data) => {
    if (!data || data === "[DONE]") return;
    const event = safeJsonParse(data);
    if (!event) return;
    const choice = event.choices?.[0] || {};
    const rawDelta = choice.delta || {};
    const finishReason = choice.finish_reason;
    const reasoningDelta = extractReasoningSummaryText(rawDelta);
    if (reasoningDelta) appendReasoning(reasoningDelta);
    // Handle streaming tool calls (OpenAI Chat SSE format)
    if (Array.isArray(rawDelta.tool_calls)) {
      for (const tc of rawDelta.tool_calls) {
        const entry = ensureToolCallStarted(tc);
        const argDelta = tc.function?.arguments || "";
        if (argDelta) {
          entry.arguments += argDelta;
          writeEvent(res, "response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            delta: argDelta
          });
        }
      }
    }
    const delta = rawDelta.content;
    if (delta !== undefined) {
      const deltaText = typeof delta === "string" ? delta : flattenContent(delta);
      if (deltaText) {
        const split = thinkSplitter.push(deltaText);
        appendReasoning(split.reasoning);
        appendText(split.text);
      }
    }
    // Mark tool call arguments complete when finish_reason signals tool_calls
    if (finishReason === "tool_calls") {
      for (const [, entry] of toolCalls) {
        if (!entry.argumentsDone) {
          entry.argumentsDone = true;
          writeEvent(res, "response.function_call_arguments.done", {
            type: "response.function_call_arguments.done",
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            arguments: entry.arguments
          });
        }
      }
    }
  };
  const processSseRecord = (record) => {
    if (!record.trim()) return;
    const dataLines = [];
    for (const line of record.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) handleData(dataLines.join("\n"));
  };
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError = null;
  const keepalive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(`: switchyard keepalive ${Date.now()}\n\n`);
    }
  }, 15000);
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() || "";
      for (const record of records) {
        processSseRecord(record);
      }
    }
  } catch (err) {
    streamError = err;
  } finally {
    clearInterval(keepalive);
  }
  if (streamError && !messageStarted && !reasoningStarted && !text && toolCalls.size === 0) {
    writeEvent(res, "response.failed", {
      type: "response.failed",
      response: { ...baseResponse, status: "failed", error: String(streamError?.message || streamError || "upstream stream error") }
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  buffer += decoder.decode();
  if (buffer.trim()) processSseRecord(buffer);
  const flushed = thinkSplitter.flush();
  appendReasoning(flushed.reasoning);
  appendText(flushed.text);
  const output = [];
  if (reasoningStarted) {
    const summary = reasoning ? [{ type: "summary_text", text: reasoning }] : [];
    const col = reasoning ? [{ type: "reasoning_text", text: reasoning }] : [];
    const completedReasoning = {
      id: reasoningItemId,
      type: "reasoning",
      status: "completed",
      summary,
      content: col,
      encrypted_content: encodeAnthropicThinkingBlocks([{ type: "thinking", thinking: reasoning }])
    };
    if (reasoningContentPartStarted) {
      writeEvent(res, "response.reasoning_text.done", {
        type: "response.reasoning_text.done",
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        content_index: 0,
        text: reasoning
      });
      writeEvent(res, "response.content_part.done", {
        type: "response.content_part.done",
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        content_index: 0,
        part: col[0] || { type: "reasoning_text", text: "" }
      });
    }
    if (reasoningSummaryPartStarted) {
      writeEvent(res, "response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        text: reasoning
      });
      writeEvent(res, "response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: summary[0] || { type: "summary_text", text: "" }
      });
    }
    output.push(completedReasoning);
    writeEvent(res, "response.output_item.done", { type: "response.output_item.done", output_index: reasoningOutputIndex, item: completedReasoning });
  }
  const completedItem = {
    id: itemId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }]
  };
  if (messageStarted || text) {
    ensureMessageStarted();
    writeEvent(res, "response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: messageOutputIndex, content_index: 0, text });
    writeEvent(res, "response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: messageOutputIndex, content_index: 0, part: { type: "output_text", text, annotations: [] } });
    writeEvent(res, "response.output_item.done", { type: "response.output_item.done", output_index: messageOutputIndex, item: completedItem });
    output.push(completedItem);
  }
  // Emit completed function_call items from streamed tool calls
  for (const [, entry] of toolCalls) {
    if (entry.id && entry.name) {
      if (!entry.argumentsDone) {
        writeEvent(res, "response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: entry.itemId,
          output_index: entry.outputIndex,
          arguments: entry.arguments
        });
      }
      const completedCall = {
        id: entry.itemId,
        type: "function_call",
        status: "completed",
        call_id: entry.id,
        name: entry.resolvedName || entry.name,
        arguments: entry.arguments
      };
      if (entry.namespace) completedCall.namespace = entry.namespace;
      writeEvent(res, "response.output_item.done", {
        type: "response.output_item.done",
        output_index: entry.outputIndex,
        item: completedCall
      });
      output.push(completedCall);
    }
  }
  writeEvent(res, "response.completed", { type: "response.completed", response: { ...baseResponse, status: "completed", output } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

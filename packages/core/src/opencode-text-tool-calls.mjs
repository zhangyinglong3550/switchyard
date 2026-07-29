// OpenCode Go's DeepSeek route can occasionally serialize a tool invocation
// into assistant text instead of OpenAI Chat's `delta.tool_calls` shape:
//
// <tool_calls><to_mcp><provider>chrome</provider> ... </to_mcp></tool_calls>
//
// Decode that dialect before the stream reaches the client protocol adapters.
// This keeps Codex / Claude Code on the normal tool-call path and prevents the
// raw XML from being displayed as an assistant answer.
import crypto from "node:crypto";
import { SseParser } from "./sse-parser.mjs";

const OPEN_TAG = "<tool_calls>";
const CLOSE_TAG = "</tool_calls>";

function normalizeToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function contentOf(xml, tag) {
  const matched = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i").exec(xml);
  return matched ? matched[1].trim() : "";
}

function longestOpenTagPrefix(value) {
  const max = Math.min(value.length, OPEN_TAG.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (OPEN_TAG.startsWith(value.slice(-size))) return size;
  }
  return 0;
}

function buildToolIndex(tools, restoreToolName) {
  const entries = [];
  for (const tool of tools || []) {
    const fn = tool?.function || tool;
    if (!fn?.name) continue;
    const wireName = String(fn.name);
    entries.push({
      wireName,
      clientName: restoreToolName(wireName),
      normalized: normalizeToken(wireName),
      clientNormalized: normalizeToken(restoreToolName(wireName))
    });
  }
  return entries;
}

function operationAlternatives(operation) {
  const normalized = normalizeToken(operation);
  const alternatives = new Set([normalized]);
  // OpenCode Go's DeepSeek route has used both names for the same Chrome
  // navigation tool. Resolve only this known semantic alias against a declared
  // tool; never invent a tool that was not in the original request.
  if (normalized === "navigate_to") alternatives.add("navigate_page");
  if (normalized === "navigate_page") alternatives.add("navigate_to");
  return [...alternatives].filter(Boolean);
}

function resolveToolName(provider, operation, index) {
  const normalizedProvider = normalizeToken(provider);
  const operations = operationAlternatives(operation);
  if (!operations.length) return "";
  const exact = operations.flatMap((normalizedOperation) => [
    normalizedOperation,
    normalizedProvider ? `${normalizedProvider}_${normalizedOperation}` : ""
  ]).filter(Boolean);
  for (const entry of index) {
    if (exact.includes(entry.normalized) || exact.includes(entry.clientNormalized)) return entry.clientName;
  }
  const candidates = index.filter((entry) => {
    return operations.some((normalizedOperation) => {
      const nameMatches = entry.normalized === normalizedOperation ||
        entry.normalized.endsWith(`_${normalizedOperation}`) ||
        entry.clientNormalized === normalizedOperation ||
        entry.clientNormalized.endsWith(`_${normalizedOperation}`);
      const providerMatches = !normalizedProvider ||
        entry.normalized.includes(`_${normalizedProvider}_`) ||
        entry.clientNormalized.includes(`_${normalizedProvider}_`);
      return nameMatches && providerMatches;
    });
  });
  return candidates.length === 1 ? candidates[0].clientName : "";
}

function resolveDirectToolName(rawName, index) {
  const normalized = normalizeToken(rawName);
  if (!normalized) return "";
  const direct = index.filter((entry) =>
    entry.normalized === normalized || entry.clientNormalized === normalized
  );
  if (direct.length === 1) return direct[0].clientName;

  // `mcp__chrome__navigate_to` -> provider=chrome, operation=navigate_to.
  // Also accepts the Codex namespace form after Switchyard's safe-name pass.
  const compact = normalized
    .replace(/^mcp_/, "")
    .replace(/^codex_apps_/, "");
  const [provider, ...operation] = compact.split("_");
  return resolveToolName(provider, operation.join("_"), index);
}

function xmlUnescape(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i, "$1")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function xmlAttributes(openTag) {
  const attributes = {};
  const regex = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let matched;
  while ((matched = regex.exec(openTag))) {
    attributes[matched[1].toLowerCase()] = xmlUnescape(matched[2] ?? matched[3] ?? "");
  }
  return attributes;
}

function parseArguments(raw) {
  const text = xmlUnescape(raw).trim();
  if (!text) return "{}";
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return "{}";
  }
}

function parseNamedParameters(xml) {
  const args = {};
  const regex = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;
  let matched;
  while ((matched = regex.exec(xml))) {
    const name = xmlAttributes(matched[1]).name;
    if (!name) continue;
    const raw = xmlUnescape(matched[2]).trim();
    if (!raw) {
      args[name] = "";
      continue;
    }
    try {
      args[name] = JSON.parse(raw);
    } catch {
      args[name] = raw;
    }
  }
  return Object.keys(args).length ? JSON.stringify(args) : "{}";
}

function makeToolCall(name, argumentsText) {
  return {
    id: `call_${crypto.randomUUID()}`,
    type: "function",
    function: { name, arguments: argumentsText }
  };
}

function parseToolCalls(xml, index) {
  const calls = [];
  const blocks = xml.match(/<to_mcp>[\s\S]*?<\/to_mcp>/gi) || [];
  for (const block of blocks) {
    const provider = contentOf(block, "provider");
    const operation = contentOf(block, "tool_call");
    const name = resolveToolName(provider, operation, index);
    if (!name) continue;
    calls.push(makeToolCall(name, parseArguments(contentOf(block, "tool_call_params"))));
  }
  // Another observed DeepSeek dialect:
  // <tool_call name="mcp__chrome__navigate_to">
  //   <parameter name="url">https://…</parameter>
  // </tool_call>
  const named = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
  let matched;
  while ((matched = named.exec(xml))) {
    const rawName = xmlAttributes(matched[1]).name;
    if (!rawName) continue; // This is the nested <tool_call> from <to_mcp>.
    const name = resolveDirectToolName(rawName, index);
    if (!name) continue;
    const body = matched[2];
    const rawArguments = contentOf(body, "tool_call_params") || contentOf(body, "arguments");
    calls.push(makeToolCall(
      name,
      rawArguments ? parseArguments(rawArguments) : parseNamedParameters(body)
    ));
  }
  return calls;
}

class TextToolCallDecoder {
  constructor(index) {
    this.index = index;
    this.buffer = "";
    this.toolBuffer = "";
    this.inToolCall = false;
    this.sawToolCall = false;
  }

  push(text) {
    this.buffer += String(text || "");
    if (this.inToolCall && this.buffer) {
      this.toolBuffer += this.buffer;
      this.buffer = "";
    }
    const out = { text: "", toolCalls: [] };
    // A complete <tool_calls> block is often emitted inside one SSE delta.
    // Continue while `inToolCall` is true so that, after moving `buffer` into
    // `toolBuffer`, we also inspect that same delta for its closing tag.
    while (this.buffer || this.inToolCall) {
      if (!this.inToolCall) {
        const start = this.buffer.indexOf(OPEN_TAG);
        if (start < 0) {
          const keep = longestOpenTagPrefix(this.buffer);
          out.text += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = keep ? this.buffer.slice(-keep) : "";
          break;
        }
        out.text += this.buffer.slice(0, start);
        this.toolBuffer = this.buffer.slice(start);
        this.buffer = "";
        this.inToolCall = true;
        continue;
      }

      const end = this.toolBuffer.indexOf(CLOSE_TAG);
      // Wait for the next SSE delta when the XML is split across chunks.
      if (end < 0) break;
      const complete = this.toolBuffer.slice(0, end + CLOSE_TAG.length);
      const calls = parseToolCalls(complete, this.index);
      if (calls.length) {
        this.sawToolCall = true;
        out.toolCalls.push(...calls);
      } else {
        // Unknown dialect / tool name: return it as text instead of silently
        // deleting model output.
        out.text += complete;
      }
      this.buffer = this.toolBuffer.slice(end + CLOSE_TAG.length);
      this.toolBuffer = "";
      this.inToolCall = false;
    }
    return out;
  }

  flush() {
    if (this.inToolCall) {
      const text = this.toolBuffer + this.buffer;
      this.toolBuffer = "";
      this.buffer = "";
      this.inToolCall = false;
      return { text, toolCalls: [] };
    }
    const text = this.buffer;
    this.buffer = "";
    return { text, toolCalls: [] };
  }
}

function choiceWithDelta(event, choiceIndex, delta, finishReason = undefined) {
  const choices = event.choices.map((choice, index) => {
    if (index !== choiceIndex) return choice;
    const next = { ...choice, delta };
    if (finishReason !== undefined) next.finish_reason = finishReason;
    return next;
  });
  return { ...event, choices };
}

function encodeData(controller, encoder, value) {
  controller.enqueue(encoder.encode(`data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`));
}

function transformEvent(event, decoder) {
  if (!event || !Array.isArray(event.choices)) return [event];
  const output = [];
  let changed = false;
  let emittedToolCallForTerminalChoice = false;
  event.choices.forEach((choice, choiceIndex) => {
    if (typeof choice?.delta?.content !== "string") return;
    const { content: _content, ...restDelta } = choice.delta;
    const decoded = decoder.push(choice.delta.content);
    changed = true;
    if (decoded.text || Object.keys(restDelta).length) {
      output.push(choiceWithDelta(event, choiceIndex, {
        ...restDelta,
        ...(decoded.text ? { content: decoded.text } : {})
      }, decoded.toolCalls.length && choice.finish_reason === "stop" ? null : undefined));
    }
    if (decoded.toolCalls.length) {
      const terminalToolCall = choice.finish_reason === "stop";
      output.push(choiceWithDelta(event, choiceIndex, {
        ...(choice.delta.role ? { role: choice.delta.role } : {}),
        tool_calls: decoded.toolCalls.map((call, index) => ({ ...call, index }))
      }, terminalToolCall ? "tool_calls" : undefined));
      if (terminalToolCall) emittedToolCallForTerminalChoice = true;
    }
  });

  const shouldMarkToolCalls = decoder.sawToolCall &&
    event.choices.some((choice) => choice?.finish_reason === "stop");
  // A model can place `</tool_calls>` and `finish_reason: "stop"` in the
  // same delta. In that case the transformed tool-call event above is already
  // the terminal event. Re-emitting the original choice would leak the XML
  // closing tags back to Codex/Claude Code as assistant text.
  if (shouldMarkToolCalls && !emittedToolCallForTerminalChoice) {
    changed = true;
    output.push({
      ...event,
      choices: event.choices.map((choice) => choice?.finish_reason === "stop"
        ? { ...choice, finish_reason: "tool_calls" }
        : choice)
    });
  }
  return changed ? output : [event];
}

export function extractOpenCodeTextToolCalls(text, {
  tools = [],
  restoreToolName = (name) => name
} = {}) {
  const decoder = new TextToolCallDecoder(buildToolIndex(tools, restoreToolName));
  const first = decoder.push(text);
  const tail = decoder.flush();
  return {
    text: `${first.text || ""}${tail.text || ""}`,
    toolCalls: first.toolCalls || []
  };
}

export function transformOpenCodeTextToolCalls(upstream, {
  tools = [],
  restoreToolName = (name) => name
} = {}) {
  if (!upstream?.body) return upstream;
  const encoder = new TextEncoder();
  const index = buildToolIndex(tools, restoreToolName);
  const decoder = new TextToolCallDecoder(index);
  const body = new ReadableStream({
    async start(controller) {
      const emit = (value) => encodeData(controller, encoder, value);
      const parser = new SseParser((record) => {
        const data = String(record.data || "").trim();
        if (!data) return;
        if (data === "[DONE]") {
          const tail = decoder.flush();
          if (tail.text) {
            emit({
              choices: [{
                index: 0,
                delta: { content: tail.text },
                finish_reason: null
              }]
            });
          }
          emit("[DONE]");
          return;
        }
        try {
          const event = JSON.parse(data);
          for (const transformed of transformEvent(event, decoder)) emit(transformed);
        } catch {
          emit(data);
        }
      });
      try {
        for await (const chunk of upstream.body) parser.push(chunk);
        parser.flush();
        const tail = decoder.flush();
        if (tail.text) {
          emit({
            choices: [{
              index: 0,
              delta: { content: tail.text },
              finish_reason: null
            }]
          });
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers
  });
}

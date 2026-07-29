const encoder = new TextEncoder();

function chunk(model, delta = {}, finishReason = null, usage = null) {
  const payload = {
    id: `chatcmpl_cursor_${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  };
  if (usage) payload.usage = usage;
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function parseXmlToolCalls(text) {
  const results = [];
  const regex = /<tool_call\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    let args = "{}";
    const argMatch = match[2].match(/<arguments>([\s\S]*?)<\/arguments>/);
    if (argMatch) {
      try { JSON.parse(argMatch[1].trim()); args = argMatch[1].trim(); }
      catch { args = "{}"; }
    }
    results.push({ name, arguments: args });
  }
  return results;
}

export function textFromCursorMessages(messages = []) {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return { role: message.role, content: message.content.map((part) => part.text).join("\n") };
  });
}

export function createCursorSubscriptionStream(model, events, { onCancel, onFinish, nativeToolCalls = true } = {}) {
  const stream = new ReadableStream({
    async start(controller) {
      let finished = false;
      let sawToolCall = false;
      let textBuffer = "";
      let usage = null;
      const finish = (error = null) => {
        if (finished) return;
        finished = true;
        onFinish?.(error);
      };
      try {
        for await (const event of events) {
          if (event?.type === "text" && event.text) {
            textBuffer += String(event.text);
            if (!textBuffer.includes("<tool_calls>")) {
              controller.enqueue(encoder.encode(chunk(model, { content: String(event.text) })));
            }
          }
          if (event?.type === "tool_call" && event.id && event.name) {
            sawToolCall = true;
            controller.enqueue(encoder.encode(chunk(model, {
              tool_calls: [{ index: Number(event.index || 0), id: String(event.id), type: "function", function: { name: String(event.name), arguments: String(event.arguments || "{}") } }]
            })));
          }
          if (event?.type === "usage" && event.usage) usage = event.usage;
          if (event?.type === "terminal") {
            if (textBuffer.includes("<tool_calls>")) {
              const tools = parseXmlToolCalls(textBuffer);
              if (tools.length) {
                sawToolCall = true;
                for (let i = 0; i < tools.length; i++) {
                  controller.enqueue(encoder.encode(chunk(model, {
                    tool_calls: [{ index: i, id: `call_${Date.now()}_${i}`, type: "function", function: { name: tools[i].name, arguments: tools[i].arguments || "{}" } }]
                  })));
                }
              }
            }
            if (usage) controller.enqueue(encoder.encode(chunk(model, {}, null, usage)));
            const finishReason = sawToolCall ? "tool_calls" : "stop";
            controller.enqueue(encoder.encode(chunk(model, {}, finishReason)));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          }
        }
        controller.close();
        finish();
      } catch (error) {
        controller.error(error);
        finish(error);
      }
    },
    cancel(reason) {
      onCancel?.();
      onFinish?.(reason instanceof Error ? reason : null);
    }
  });
  const response = new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  response.switchyardRequireTerminal = true;
  response.switchyardNativeToolCalls = true;
  return response;
}

export async function collectCursorSubscriptionResponse(model, events) {
  let content = "";
  const toolCalls = [];
  let terminal = false;
  let usage = null;
  for await (const event of events) {
    if (event?.type === "text") content += String(event.text || "");
    if (event?.type === "usage" && event.usage) usage = event.usage;
    if (event?.type === "tool_call" && event.id && event.name) toolCalls.push({ id: String(event.id), type: "function", function: { name: String(event.name), arguments: String(event.arguments || "{}") } });
    if (event?.type === "terminal") { terminal = true; break; }
  }
  if (!terminal) {
    const error = new Error("Cursor 上游在协议终态前结束");
    error.code = "SWITCHYARD_INCOMPLETE_STREAM";
    throw error;
  }
  // Parse XML tool calls from text if no native tool calls were received
  if (!toolCalls.length && content.includes("<tool_calls>")) {
    const parsed = parseXmlToolCalls(content);
    for (let i = 0; i < parsed.length; i++) {
      toolCalls.push({ id: `call_${Date.now()}_${i}`, type: "function", function: { name: parsed[i].name, arguments: parsed[i].arguments || "{}" } });
    }
    content = "";
  }
  const message = { role: "assistant", content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: `chatcmpl_cursor_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    ...(usage ? { usage } : {})
  };
}

const encoder = new TextEncoder();

function chunk(model, delta = {}, finishReason = null) {
  return `data: ${JSON.stringify({
    id: `chatcmpl_cursor_${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }]
  })}\n\n`;
}

export function textFromCursorMessages(messages = []) {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return { role: message.role, content: message.content.map((part) => part.text).join("\n") };
  });
}

export function createCursorSubscriptionStream(model, events, { onCancel } = {}) {
  const stream = new ReadableStream({
    async start(controller) {
      let terminal = false;
      try {
        for await (const event of events) {
          if (event?.type === "text" && event.text) controller.enqueue(encoder.encode(chunk(model, { content: String(event.text) })));
          if (event?.type === "terminal") {
            terminal = true;
            controller.enqueue(encoder.encode(chunk(model, {}, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            break;
          }
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { onCancel?.(); }
  });
  const response = new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
  response.switchyardRequireTerminal = true;
  return response;
}

export async function collectCursorSubscriptionResponse(model, events) {
  let content = "";
  let terminal = false;
  for await (const event of events) {
    if (event?.type === "text") content += String(event.text || "");
    if (event?.type === "terminal") terminal = true;
  }
  if (!terminal) {
    const error = new Error("Cursor 上游在协议终态前结束");
    error.code = "SWITCHYARD_INCOMPLETE_STREAM";
    throw error;
  }
  return {
    id: `chatcmpl_cursor_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }]
  };
}

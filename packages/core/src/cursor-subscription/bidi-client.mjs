import crypto from "node:crypto";
import http2 from "node:http2";

const AGENT_RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
const BIDI_APPEND_URL = "https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend";

function varint(value) {
  const bytes = []; let number = Number(value) >>> 0;
  while (number > 127) { bytes.push((number & 127) | 128); number >>>= 7; }
  bytes.push(number); return Buffer.from(bytes);
}
function bytes(field, value) { const body = Buffer.from(value || []); return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]); }
function frame(payload) { const size = Buffer.alloc(4); size.writeUInt32BE(payload.length); return Buffer.concat([Buffer.from([0]), size, payload]); }

/**
 * Cursor Agent CLI's current protocol: open RunSSE on the agent host, then
 * append AgentClientMessage protobuf bytes through BidiService. This replaces
 * the retired ChatService Unified endpoint used by older community projects.
 */
export async function* http2CursorBidiEvents({
  provider,
  credentials,
  message,
  headers,
  decodeFrameEvents,
  decodeFramePayload = (payload) => payload,
  onFrame,
  signal
} = {}) {
  const agentBase = String(provider?.baseUrl || "https://agentn.api5.cursor.sh").replace(/\/+$/, "");
  const url = new URL(`${agentBase}${AGENT_RUN_SSE_PATH}`);
  const requestId = crypto.randomUUID();
  const requestHeaders = headers(credentials, `cli-${String(provider?.cursorAgentVersion || "2026.07.23-e383d2b")}`);
  requestHeaders["x-cursor-client-type"] = "cli";
  requestHeaders["x-ghost-mode"] = "true";
  const session = http2.connect(url.origin);
  let request;
  let status = 0;
  let pending = Buffer.alloc(0);
  let appendError = null;
  let appendSeqno = 0;
  session.on("error", (error) => { appendError ||= error; });
  try {
    request = session.request({ ":method": "POST", ":path": url.pathname, ":authority": url.host, ...requestHeaders });
    request.on("response", (responseHeaders) => { status = Number(responseHeaders[":status"] || 0); });
    if (signal?.aborted) request.close(http2.constants.NGHTTP2_CANCEL);
    else signal?.addEventListener?.("abort", () => request.close(http2.constants.NGHTTP2_CANCEL), { once: true });
    request.end(frame(bytes(1, Buffer.from(requestId))));
    const append = async (data) => {
      const appendResponse = await fetch(BIDI_APPEND_URL, {
        method: "POST",
        headers: { ...requestHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          requestId: { requestId },
          appendSeqno: String(appendSeqno++),
          // BidiAppend expects AgentClientMessage bytes, without the outer
          // ConnectRPC five-byte envelope.
          dataBinary: Buffer.from(data).toString("base64")
        }),
        signal
      });
      if (!appendResponse.ok) {
        const error = new Error(`Cursor BidiAppend returned ${appendResponse.status}`);
        error.status = appendResponse.status;
        throw error;
      }
    };
    // Cursor's bridge sends the first client message immediately after opening
    // RunSSE. Waiting for a response here introduces an avoidable startup gap.
    await append(message);
    for await (const rawChunk of request) {
      if (status && status !== 200) { const error = new Error(`Cursor RunSSE returned ${status}`); error.status = status; throw error; }
      pending = Buffer.concat([pending, Buffer.from(rawChunk)]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const flags = pending[0];
        const size = pending.readUInt32BE(1);
        let payload = pending.subarray(5, 5 + size);
        pending = pending.subarray(5 + size);
        payload = decodeFramePayload(payload, flags);
        if (flags & 2) { yield { type: "terminal" }; return; }
        const replies = await onFrame?.(payload, flags);
        for (const reply of replies || []) await append(reply);
        for (const event of decodeFrameEvents(payload)) yield event;
      }
    }
    if (appendError) throw appendError;
  } finally {
    try { request?.close(); } catch {}
    try { session.close(); } catch {}
  }
}

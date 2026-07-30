import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import { pipeRawStream } from "../src/server.mjs";

function responseFromSse(lines) {
  const bytes = new TextEncoder().encode(lines.join("\n"));
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function captureResponse() {
  let body = "";
  const res = new Writable({
    write(chunk, _encoding, callback) {
      body += chunk.toString();
      callback();
    }
  });
  res.writeHead = () => {};
  return { res, body: () => body };
}

test("pipeRawStream retries two empty Responses preludes before completing", async () => {
  const emptyPrelude = () => responseFromSse([": upstream heartbeat", ""]);
  const completed = () => responseFromSse([
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    "",
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
    ""
  ]);
  let retryCalls = 0;
  let diagnostics = null;
  const { res, body } = captureResponse();

  await pipeRawStream(emptyPrelude(), res, {
    protocol: "responses",
    model: "ke/gpt-5.6-sol",
    preludeRetryAttempts: 2,
    preludeRetryBackoffMs: [0, 0],
    retryUpstream: async () => {
      retryCalls += 1;
      return retryCalls === 2 ? completed() : emptyPrelude();
    },
    onStreamSummary: (summary) => { diagnostics = summary; }
  });

  assert.equal(retryCalls, 2);
  assert.equal(diagnostics.retryCount, 2);
  assert.equal(diagnostics.preludeRetryCount, 2);
  assert.equal(diagnostics.terminalState, "completed");
  assert.match(body(), /event: response\.completed/);
  assert.doesNotMatch(body(), /event: response\.incomplete/);
});

test("pipeRawStream never retries after meaningful Responses output", async () => {
  const partial = responseFromSse([
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"partial"}',
    ""
  ]);
  let retryCalls = 0;
  const { res, body } = captureResponse();

  await pipeRawStream(partial, res, {
    protocol: "responses",
    preludeRetryAttempts: 2,
    retryUpstream: async () => {
      retryCalls += 1;
      return responseFromSse([]);
    }
  });

  assert.equal(retryCalls, 0);
  assert.match(body(), /event: response\.incomplete/);
});

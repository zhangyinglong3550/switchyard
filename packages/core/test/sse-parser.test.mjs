import { test } from "node:test";
import assert from "node:assert/strict";
import { SseParser } from "../src/sse-parser.mjs";

function bytes(value) {
  return new TextEncoder().encode(value);
}

test("SseParser preserves UTF-8 code points split between chunks", () => {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  const chunk = bytes("event: response.output_text.delta\ndata: {\"delta\":\"你好\"}\n\n");
  const split = chunk.indexOf(0xe5) + 1;
  parser.push(chunk.slice(0, split));
  parser.push(chunk.slice(split));
  parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "response.output_text.delta");
  assert.equal(events[0].data, "{\"delta\":\"你好\"}");
});

test("SseParser waits for a CRLF delimiter split across chunks", () => {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push("event: response.completed\r");
  parser.push("\ndata: {\"type\":\"response.completed\"}\r");
  assert.equal(events.length, 0);
  parser.push("\n\r");
  assert.equal(events.length, 0);
  parser.push("\n");
  parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "response.completed");
  assert.equal(events[0].data, "{\"type\":\"response.completed\"}");
});

test("SseParser supports comments, ids, retries, and multiple data lines", () => {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push(": keepalive\nid: 17\nretry: 1500\nevent: note\ndata: first\ndata: second\n\n");
  parser.flush();

  assert.deepEqual(events, [{
    event: "note",
    data: "first\nsecond",
    rawData: "first\nsecond",
    fields: {
      event: "note",
      id: "17",
      retry: "1500",
      comments: [" keepalive"]
    }
  }]);
});

test("SseParser flushes a final event without a trailing blank line", () => {
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.push("event: response.completed\ndata: {\"type\":\"response.completed\"}");
  parser.flush();

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "response.completed");
});

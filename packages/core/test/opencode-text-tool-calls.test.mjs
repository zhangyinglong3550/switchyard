import test from "node:test";
import assert from "node:assert/strict";
import { transformOpenCodeTextToolCalls } from "../src/opencode-text-tool-calls.mjs";

function chunkedResponse(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

function sseData(text) {
  return text.split(/\n\n/)
    .map((event) => event.match(/^data: ([\s\S]+)$/m)?.[1])
    .filter(Boolean)
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));
}

test("OpenCode Go text tool XML becomes standard Chat tool_calls across chunk boundaries", async () => {
  const upstream = chunkedResponse([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"我来帮你完成。\\n<tool_cal"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"ls><to_mcp><provider>chrome</provider><tool_call>navigate_page</tool_call><tool_call_params>{\\"url\\":\\"https://skills.home.ke.com/\\"}</tool_call_params></to_mcp></tool_calls>"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ]);

  const transformed = transformOpenCodeTextToolCalls(upstream, {
    tools: [{
      type: "function",
      function: { name: "mcp_codex_apps_chrome_navigate_page", parameters: { type: "object" } }
    }],
    restoreToolName: (name) => name === "mcp_codex_apps_chrome_navigate_page"
      ? "mcp__codex_apps__chrome___navigate_page"
      : name
  });
  const text = await transformed.text();
  const events = sseData(text);
  const content = events
    .flatMap((event) => event.choices || [])
    .map((choice) => choice.delta?.content || "")
    .join("");
  const callEvent = events.find((event) => event.choices?.[0]?.delta?.tool_calls?.length);
  const terminal = events.find((event) => event.choices?.[0]?.finish_reason);

  assert.equal(content, "我来帮你完成。\n");
  assert.doesNotMatch(text, /<tool_calls>|<to_mcp>|tool_call_params/);
  assert.equal(callEvent.choices[0].delta.tool_calls[0].function.name, "mcp__codex_apps__chrome___navigate_page");
  assert.equal(callEvent.choices[0].delta.tool_calls[0].function.arguments, "{\"url\":\"https://skills.home.ke.com/\"}");
  assert.equal(terminal.choices[0].finish_reason, "tool_calls");
  assert.match(text, /data: \[DONE\]/);
});

test("OpenCode Go named XML tool calls with parameters become standard Chat tool_calls", async () => {
  const upstream = chunkedResponse([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"我来按步骤完成。<tool_calls><tool_call name=\\"mcp__chrome__navigate_to\\"><parameter name=\\"url\\">https://skills.home.ke.com/</parameter></tool_call></tool_calls>"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    "data: [DONE]\n\n"
  ]);
  const transformed = transformOpenCodeTextToolCalls(upstream, {
    tools: [{
      type: "function",
      function: { name: "mcp_codex_apps_chrome_navigate_page", parameters: { type: "object" } }
    }],
    restoreToolName: (name) => name === "mcp_codex_apps_chrome_navigate_page"
      ? "mcp__codex_apps__chrome___navigate_page"
      : name
  });

  const text = await transformed.text();
  const events = sseData(text);
  const content = events.flatMap((event) => event.choices || [])
    .map((choice) => choice.delta?.content || "")
    .join("");
  const callEvent = events.find((event) => event.choices?.[0]?.delta?.tool_calls?.length);

  assert.equal(content, "我来按步骤完成。");
  assert.doesNotMatch(text, /<tool_calls>|<tool_call|<parameter/);
  assert.equal(callEvent.choices[0].delta.tool_calls[0].function.name, "mcp__codex_apps__chrome___navigate_page");
  assert.equal(callEvent.choices[0].delta.tool_calls[0].function.arguments, "{\"url\":\"https://skills.home.ke.com/\"}");
  assert.equal(events.find((event) => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
});

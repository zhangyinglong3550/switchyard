import test from "node:test";
import assert from "node:assert/strict";
import { extractOpenCodeTextToolCalls, transformOpenCodeTextToolCalls } from "../src/opencode-text-tool-calls.mjs";

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

test("Grok-style bare tool_call with first-line name stays out of assistant text", async () => {
  const decoded = extractOpenCodeTextToolCalls([
    "Bridge 已启动。",
    "<tool_call>",
    "mcp_switchyard_run_terminal_command",
    "<command>sbc doctor</command>",
    "<description>Recheck extension</description>",
    "</tool_call>",
    "<tool_result><tool_name>run_terminal_command</tool_name><result>ok</result></tool_result>"
  ].join("\n"), {
    tools: [{ type: "function", function: { name: "mcp_switchyard_run_terminal_command" } }]
  });
  assert.equal(decoded.text.trim(), "Bridge 已启动。");
  assert.equal(decoded.toolCalls.length, 1);
  assert.equal(decoded.toolCalls[0].function.name, "mcp_switchyard_run_terminal_command");
  assert.equal(JSON.parse(decoded.toolCalls[0].function.arguments).command, "sbc doctor");
});

test("assistant_tool_calls history wrapper is stripped, not shown as answer text", () => {
  const decoded = extractOpenCodeTextToolCalls([
    "页面已打开。",
    "<assistant_tool_calls>",
    '<tool_call name="mcp_switchyard_run_terminal_command" id="call_1"><arguments>{"command":"sbc doctor"}</arguments></tool_call>',
    "</assistant_tool_calls>"
  ].join("\n"), {
    tools: [{ type: "function", function: { name: "mcp_switchyard_run_terminal_command" } }]
  });
  assert.equal(decoded.text.trim(), "页面已打开。");
  assert.equal(decoded.toolCalls.length, 1);
  assert.equal(decoded.toolCalls[0].function.name, "mcp_switchyard_run_terminal_command");
});

test("glued </assistant<tool_call> still yields the next tool call", () => {
  const decoded = extractOpenCodeTextToolCalls([
    "Bridge 已启动。",
    "<tool_call>",
    "mcp_switchyard_run_terminal_command",
    "<command>sbc doctor</command>",
    "</tool_call>",
    "</assistant<tool_call>",
    "AwaitShell",
    "<block_until_ms>5000</block_until_ms>",
    "</tool_call>"
  ].join("\n"), {
    tools: [
      { type: "function", function: { name: "mcp_switchyard_run_terminal_command" } },
      { type: "function", function: { name: "AwaitShell" } }
    ]
  });
  assert.equal(decoded.text.trim(), "Bridge 已启动。");
  assert.equal(decoded.toolCalls.length, 2);
  assert.equal(decoded.toolCalls[0].function.name, "mcp_switchyard_run_terminal_command");
  assert.equal(decoded.toolCalls[1].function.name, "AwaitShell");
  assert.equal(JSON.parse(decoded.toolCalls[1].function.arguments).block_until_ms, "5000");
});

test("closing </tool_call> is not treated as a new tool block", () => {
  const decoded = extractOpenCodeTextToolCalls("先看结果。</tool_call>\n再继续。", {
    tools: [{ type: "function", function: { name: "read_file" } }]
  });
  assert.equal(decoded.text.replace(/\s+/g, ""), "先看结果。再继续。");
  assert.equal(decoded.toolCalls.length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToChat, chatToResponse } from "../src/openai-adapter.mjs";
import { anthropicToChat, chatToAnthropic } from "../src/anthropic-adapter.mjs";
import { chatToAnthropicMessages } from "../src/anthropic-adapter-out.mjs";

test("responsesToChat preserves system + user input", () => {
  const chat = responsesToChat({ instructions: "be brief", input: "hello" }, "u-model");
  assert.equal(chat.model, "u-model");
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].content, "hello");
});

test("responsesToChat maps Responses developer messages to Chat system role", () => {
  const chat = responsesToChat({
    input: [
      { type: "message", role: "developer", content: "Follow local instructions." },
      { type: "message", role: "user", content: "hello" }
    ]
  }, "u-model");
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "Follow local instructions.");
  assert.equal(chat.messages[1].role, "user");
});

test("responsesToChat preserves function_call_output as tool message", () => {
  const chat = responsesToChat({
    input: [
      { role: "user", content: "go" },
      { type: "function_call_output", call_id: "c1", output: "{\"ok\":1}" }
    ]
  }, "u");
  const toolMsg = chat.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "c1");
});

test("chatToResponse converts tool_calls to function_call output items", () => {
  const out = chatToResponse({
    choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{\"x\":1}" } }] } }]
  }, "m");
  const call = out.output.find((o) => o.type === "function_call");
  assert.equal(call.name, "f");
});

test("anthropicToChat lifts tool_use and tool_result into chat tool flow", () => {
  const chat = anthropicToChat({
    system: "be safe",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "search", input: { q: "kimi" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] }
    ]
  }, "u");
  const asst = chat.messages.find((m) => m.role === "assistant");
  assert.ok(asst.tool_calls?.length === 1);
  const tool = chat.messages.find((m) => m.role === "tool");
  assert.equal(tool.tool_call_id, "tu1");
});

test("chatToAnthropic converts tool_calls back to tool_use blocks", () => {
  const out = chatToAnthropic({
    choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{\"a\":1}" } }] } }],
    usage: { prompt_tokens: 1, completion_tokens: 2 }
  }, "m");
  assert.equal(out.stop_reason, "tool_use");
  const block = out.content.find((b) => b.type === "tool_use");
  assert.equal(block.name, "f");
  assert.deepEqual(block.input, { a: 1 });
});

test("chatToAnthropicMessages emits text content blocks", () => {
  const out = chatToAnthropicMessages({
    messages: [{ role: "user", content: "hello" }]
  }, "claude-test");
  assert.deepEqual(out.messages[0].content, [{ type: "text", text: "hello" }]);
});

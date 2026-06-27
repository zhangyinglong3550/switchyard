import { test } from "node:test";
import assert from "node:assert/strict";
import { responsesToChat, chatToResponse, extractNamespaceMap } from "../src/openai-adapter.mjs";
import { anthropicToChat, chatToAnthropic } from "../src/anthropic-adapter.mjs";
import { chatToAnthropicMessages, anthropicMessagesToChatResponse } from "../src/anthropic-adapter-out.mjs";
import { chatToResponses, normalizeChatgptCodexResponsesBody, responsesStreamToChatResponse } from "../src/openai-adapter-out.mjs";
import { SWITCHYARD_THINKING_KEY } from "../src/reasoning.mjs";

test("responsesToChat preserves system + user input", () => {
  const chat = responsesToChat({ instructions: "be brief", input: "hello" }, "u-model");
  assert.equal(chat.model, "u-model");
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[1].content, "hello");
});

test("responsesToChat preserves Codex reasoning request for provider compat translation", () => {
  const chat = responsesToChat({
    input: "hello",
    reasoning: { effort: "high" }
  }, "u-model");
  assert.deepEqual(chat.reasoning, { effort: "high" });
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

test("chatToResponse maps chat reasoning_content into Codex reasoning output", () => {
  const out = chatToResponse({
    choices: [{ message: { role: "assistant", reasoning_content: "Need to inspect files.", content: "Done" } }]
  }, "m");
  assert.equal(out.output[0].type, "reasoning");
  assert.equal(out.output[0].summary[0].text, "Need to inspect files.");
  assert.match(out.output[0].encrypted_content, /^switchyard:anthropic-thinking:v1:/);
  assert.equal(out.output[1].content[0].text, "Done");
});

test("chatToResponse maps MiniMax reasoning_details into Codex reasoning output", () => {
  const out = chatToResponse({
    choices: [{
      message: {
        role: "assistant",
        reasoning_details: [{ type: "reasoning_text", text: "Need to inspect the code." }],
        content: "Done"
      }
    }]
  }, "MiniMax-M2.7");
  assert.equal(out.output[0].type, "reasoning");
  assert.equal(out.output[0].summary[0].text, "Need to inspect the code.");
  assert.equal(out.output[1].content[0].text, "Done");
});

test("chatToResponse splits leading think tags into reasoning output", () => {
  const out = chatToResponse({
    choices: [{ message: { role: "assistant", content: "<think>Need to reason.</think>\nFinal answer" } }]
  }, "m");
  assert.equal(out.output[0].type, "reasoning");
  assert.equal(out.output[0].summary[0].text, "Need to reason.");
  assert.equal(out.output[1].content[0].text, "Final answer");
});

test("chatToResponses converts Chat tool_choice function shape for Responses", () => {
  const out = chatToResponses({
    messages: [{ role: "user", content: "go" }],
    tools: [{ type: "function", function: { name: "Skill", parameters: { type: "object" } } }],
    tool_choice: { type: "function", function: { name: "Skill" } }
  }, "gpt");
  assert.deepEqual(out.tool_choice, { type: "function", name: "Skill" });
});

test("Anthropic thinking history survives Chat to Codex Responses conversion", () => {
  const chat = anthropicToChat({
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "checked tool choice", signature: "sig_1" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.md" } }
      ]
    }]
  }, "gpt");
  assert.equal(chat.messages[0][SWITCHYARD_THINKING_KEY][0].signature, "sig_1");

  const responses = chatToResponses(chat, "gpt-5.5");
  assert.equal(responses.input[0].type, "reasoning");
  assert.match(responses.input[0].encrypted_content, /^switchyard:anthropic-thinking:v1:/);
  assert.equal(responses.input[1].type, "function_call");
  assert.equal(responses.input[1].call_id, "toolu_1");
});

test("normalizeChatgptCodexResponsesBody preserves reasoning items and requests encrypted reasoning", () => {
  const normalized = normalizeChatgptCodexResponsesBody({
    input: [
      {
        type: "reasoning",
        status: "completed",
        content: [{ type: "reasoning_text", text: "kept" }],
        encrypted_content: "switchyard:anthropic-thinking:v1:test"
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] }
    ],
    include: ["file_search_call.results"]
  });
  assert.deepEqual(normalized.include, ["file_search_call.results", "reasoning.encrypted_content"]);
  assert.equal(normalized.input[0].type, "reasoning");
  assert.equal(normalized.input[0].encrypted_content, "switchyard:anthropic-thinking:v1:test");
  assert.equal(normalized.input[1].role, "user");
  assert.equal(normalized.input[1].content, "Previous assistant response:\nold answer");
});

test("responsesStreamToChatResponse preserves streamed function_call arguments", async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode([
        "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call_1\",\"name\":\"Skill\",\"arguments\":\"\"}}",
        "",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"skill\\\":\"}",
        "",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"\\\"lark-minutes\\\"}\"}",
        "",
        "data: [DONE]",
        ""
      ].join("\n")));
      controller.close();
    }
  });
  const out = await responsesStreamToChatResponse({ body: stream }, "gpt");
  const call = out.choices[0].message.tool_calls[0];
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(call.function.name, "Skill");
  assert.equal(call.function.arguments, "{\"skill\":\"lark-minutes\"}");
});

test("responsesStreamToChatResponse keeps streamed function_call when completed output is empty", async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode([
        "data: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"arguments\":\"\",\"call_id\":\"call_1\",\"name\":\"Skill\"},\"output_index\":0}",
        "",
        "data: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{\\\"skill\\\":\\\"superpowers:using-superpowers\\\"}\",\"item_id\":\"fc_1\",\"output_index\":0}",
        "",
        "data: {\"type\":\"response.function_call_arguments.done\",\"arguments\":\"{\\\"skill\\\":\\\"superpowers:using-superpowers\\\"}\",\"item_id\":\"fc_1\",\"output_index\":0}",
        "",
        "data: {\"type\":\"response.output_item.done\",\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"arguments\":\"{\\\"skill\\\":\\\"superpowers:using-superpowers\\\"}\",\"call_id\":\"call_1\",\"name\":\"Skill\"},\"output_index\":0}",
        "",
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"object\":\"response\",\"created_at\":0,\"model\":\"gpt\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}",
        "",
        "data: [DONE]",
        ""
      ].join("\n")));
      controller.close();
    }
  });
  const out = await responsesStreamToChatResponse({ body: stream }, "gpt");
  const call = out.choices[0].message.tool_calls[0];
  assert.equal(out.choices[0].finish_reason, "tool_calls");
  assert.equal(call.id, "call_1");
  assert.equal(call.function.name, "Skill");
  assert.equal(call.function.arguments, "{\"skill\":\"superpowers:using-superpowers\"}");
});

test("responsesStreamToChatResponse reads completed response output_text fallback", async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode([
        "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"object\":\"response\",\"created_at\":0,\"model\":\"gpt\",\"output_text\":\"最终文本\"}}",
        "",
        "data: [DONE]",
        ""
      ].join("\n")));
      controller.close();
    }
  });
  const out = await responsesStreamToChatResponse({ body: stream }, "gpt");
  assert.equal(out.choices[0].message.content, "最终文本");
});

test("responsesStreamToChatResponse reads text from content_part.done events", async () => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode([
        "data: {\"type\":\"response.content_part.done\",\"item_id\":\"msg_1\",\"output_index\":0,\"content_index\":0,\"part\":{\"type\":\"output_text\",\"text\":\"最终文本\"}}",
        "",
        "data: [DONE]",
        ""
      ].join("\n")));
      controller.close();
    }
  });
  const out = await responsesStreamToChatResponse({ body: stream }, "gpt");
  assert.equal(out.choices[0].message.content, "最终文本");
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

test("chatToAnthropicMessages groups consecutive tool results for parallel tool_use", () => {
  const out = chatToAnthropicMessages({
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "Read", arguments: "{\"file_path\":\"a\"}" } },
          { id: "call_2", function: { name: "Read", arguments: "{\"file_path\":\"b\"}" } }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "file a" },
      { role: "tool", tool_call_id: "call_2", content: "file b" },
      { role: "user", content: "continue" }
    ]
  }, "claude-test");
  assert.equal(out.messages[0].content.length, 2);
  assert.equal(out.messages[0].content[0].type, "tool_use");
  assert.equal(out.messages[1].role, "user");
  assert.deepEqual(out.messages[1].content.map((block) => block.tool_use_id), ["call_1", "call_2"]);
  assert.equal(out.messages[2].content[0].text, "continue");
});

test("Codex Responses round-trips Anthropic thinking blocks before tool results", () => {
  const chatLike = anthropicMessagesToChatResponse({
    id: "msg_1",
    model: "deepseek-v4-pro",
    stop_reason: "tool_use",
    content: [
      { type: "thinking", thinking: "selected a tool", signature: "sig_123" },
      { type: "tool_use", id: "call_1", name: "Read", input: { file_path: "a" } }
    ]
  }, "deepseek-v4-pro");
  const response = chatToResponse(chatLike, "deepseek/deepseek-v4-pro");
  assert.equal(response.output[0].type, "reasoning");
  assert.match(response.output[0].encrypted_content, /^switchyard:anthropic-thinking:v1:/);
  assert.equal(response.output[1].type, "function_call");

  const chat = responsesToChat({
    input: [
      response.output[0],
      response.output[1],
      { type: "function_call_output", call_id: "call_1", output: "file a" }
    ]
  }, "deepseek-v4-pro");
  const out = chatToAnthropicMessages(chat, "deepseek-v4-pro");
  assert.deepEqual(out.messages[0].content[0], { type: "thinking", thinking: "selected a tool", signature: "sig_123" });
  assert.equal(out.messages[0].content[1].type, "tool_use");
  assert.equal(out.messages[1].content[0].type, "tool_result");
});

test("responsesToChat drops tool_search (cannot be bridged to chat models)", () => {
  const chat = responsesToChat({
    input: "use chrome",
    tools: [
      { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
      { type: "tool_search", execution: "client", description: "# Tool discovery", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }
    ]
  }, "u-model");
  const names = chat.tools.map((t) => t.function?.name);
  assert.ok(!names.includes("tool_search"), "tool_search must not be forwarded to chat models");
  assert.deepEqual(names, ["exec_command"]);
});

test("responsesToChat flattens namespace tools with namespace__fn names", () => {
  const chat = responsesToChat({
    input: "hi",
    tools: [
      { type: "namespace", name: "codex_app", tools: [
        { type: "function", name: "navigate_to_codex_page", description: "nav", parameters: { type: "object" } },
        { type: "function", name: "read_thread_terminal", description: "read", parameters: { type: "object" } }
      ] }
    ]
  }, "u-model");
  const names = chat.tools.map((t) => t.function?.name);
  assert.ok(names.includes("codex_app__navigate_to_codex_page"));
  assert.ok(names.includes("codex_app__read_thread_terminal"));
});

test("responsesToChat drops unsupported hosted tools (web_search)", () => {
  const chat = responsesToChat({
    input: "hi",
    tools: [
      { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
      { type: "web_search", external_web_access: true }
    ]
  }, "u-model");
  const names = chat.tools.map((t) => t.function?.name);
  assert.deepEqual(names, ["exec_command"]);
});

test("chatToResponse unflattens namespace tool call and preserves the namespace", () => {
  const namespaceMap = extractNamespaceMap([
    { type: "namespace", name: "codex_app", tools: [{ type: "function", name: "navigate_to_codex_page" }] }
  ]);
  const out = chatToResponse({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "codex_app__navigate_to_codex_page", arguments: "{\"url\":\"/x\"}" } }]
      }
    }]
  }, "u-model", { namespaceMap });
  const fc = out.output.find((o) => o.type === "function_call");
  assert.ok(fc, "function_call item should be emitted");
  assert.equal(fc.name, "navigate_to_codex_page");
  assert.equal(fc.namespace, "codex_app");
  assert.equal(fc.arguments, "{\"url\":\"/x\"}");
  assert.ok(!out.output.some((o) => o.type === "tool_search_call"), "no tool_search_call should be produced");
});

test("chatToResponse keeps normal tool calls as function_call without namespace", () => {
  const out = chatToResponse({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_2", function: { name: "exec_command", arguments: "{}" } }]
      }
    }]
  }, "u-model");
  const fc = out.output.find((o) => o.type === "function_call");
  assert.ok(fc, "function_call item should be emitted");
  assert.equal(fc.name, "exec_command");
  assert.equal(fc.namespace, undefined);
});

test("chatToResponse restores tool name when upstream rewrites underscore count (StepFun)", () => {
  // StepFun 会把拍平后的 `namespace__fn` 里的 `__` 改写成 `___`，导致精确匹配失败。
  // 下划线归一化兜底应能正确还原 name/namespace，避免 Codex 收到不存在的工具名而中断。
  const namespaceMap = extractNamespaceMap([
    { type: "namespace", name: "mcp__codex_apps__github", tools: [
      { type: "function", name: "get_user_login", parameters: { type: "object" } }
    ] }
  ]);
  // 上游回传的名字: github 和 get_user_login 之间是 3 个下划线(应为 2 个)
  const out = chatToResponse({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_3", function: { name: "mcp__codex_apps__github___get_user_login", arguments: "{}" } }]
      }
    }]
  }, "u-model", { namespaceMap });
  const fc = out.output.find((o) => o.type === "function_call");
  assert.ok(fc, "function_call item should be emitted");
  assert.equal(fc.name, "get_user_login", "工具名应还原为 get_user_login 而非 _get_user_login");
  assert.equal(fc.namespace, "mcp__codex_apps__github");
});

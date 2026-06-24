import test from "node:test";
import assert from "node:assert/strict";

test("test console parses system/user/assistant/tool transcript blocks", async () => {
  const { parseTestMessages } = await import("../../../apps/desktop/src/test-console.mjs");
  const messages = parseTestMessages([
    "system: You are terse.",
    "",
    "user: First question",
    "",
    "assistant: First answer",
    "",
    "tool: {\"ok\":true}",
    "",
    "用户：第二个问题"
  ].join("\n"));

  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "tool", "user"]);
  assert.equal(messages[1].content, "First question");
  assert.equal(messages[4].content, "第二个问题");
});

test("test console builds raw multi-turn requests for every protocol", async () => {
  const { buildTestRequest } = await import("../../../apps/desktop/src/test-console.mjs");
  const messages = [
    { role: "system", content: "You are terse." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: "Again" }
  ];

  const chat = buildTestRequest({ base: "http://127.0.0.1:17888", clientId: "generic-openai", protocol: "openai_chat", model: "p/m", messages, stream: false });
  assert.equal(chat.url, "http://127.0.0.1:17888/v1/chat/completions");
  assert.deepEqual(chat.body.messages, messages);

  const responses = buildTestRequest({ base: "http://127.0.0.1:17888", clientId: "codex", protocol: "openai_responses", model: "p/m", messages, stream: false });
  assert.equal(responses.url, "http://127.0.0.1:17888/codex/v1/responses");
  assert.equal(responses.body.instructions, "You are terse.");
  assert.equal(responses.body.input.length, 3);
  assert.equal(responses.body.input[0].role, "user");

  const anthropic = buildTestRequest({ base: "http://127.0.0.1:17888", clientId: "claude-code", protocol: "anthropic_messages", model: "p/m", messages, stream: false });
  assert.equal(anthropic.url, "http://127.0.0.1:17888/claude-code/v1/messages");
  assert.equal(anthropic.body.system, "You are terse.");
  assert.deepEqual(anthropic.body.messages.map((message) => message.role), ["user", "assistant", "user"]);
});

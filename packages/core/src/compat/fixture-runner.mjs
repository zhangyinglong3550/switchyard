import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { anthropicToChat } from "../anthropic-adapter.mjs";
import { chatToAnthropicMessages } from "../anthropic-adapter-out.mjs";
import { responsesToChat } from "../openai-adapter.mjs";
import { chatToResponses, normalizeChatgptCodexResponsesBody, responsesStreamToChatResponse } from "../openai-adapter-out.mjs";
import { registerBuiltinPatches, resetPatches, applyOutbound } from "./index.mjs";
import { rectifyUpstreamRequest } from "./runtime-rectifier.mjs";
import { stripInternalFieldsDeep } from "../upstream/dispatch.mjs";

export function loadCompatFixture(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function listCompatFixtureFiles(dirPath) {
  return fs.readdirSync(dirPath)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dirPath, name));
}

export async function runCompatFixture(fixture) {
  if (!fixture || typeof fixture !== "object") throw new Error("fixture must be an object");
  if (!fixture.id || typeof fixture.id !== "string") throw new Error("fixture.id is required");
  let output;
  switch (fixture.operation) {
    case "anthropic_to_chat": {
      output = anthropicToChat(fixture.input, fixture.upstreamModel || fixture.input?.model || "model");
      break;
    }
    case "anthropic_to_responses": {
      const chat = anthropicToChat(fixture.input, fixture.chatModel || fixture.upstreamModel || "model");
      output = chatToResponses(chat, fixture.upstreamModel || fixture.chatModel || "model");
      if (fixture.normalizeCodex === true) output = normalizeChatgptCodexResponsesBody(output);
      break;
    }
    case "responses_to_anthropic_messages": {
      const chat = responsesToChat(fixture.input, fixture.chatModel || fixture.upstreamModel || "model");
      output = chatToAnthropicMessages(chat, fixture.upstreamModel || fixture.chatModel || "model");
      break;
    }
    case "responses_stream_to_chat": {
      output = await responsesStreamToChatResponse({ body: streamFromFixture(fixture) }, fixture.upstreamModel || "model");
      break;
    }
    case "compat_outbound": {
      resetPatches();
      registerBuiltinPatches();
      try {
        output = applyOutbound(fixture.input, fixture.ctx || {});
      } finally {
        resetPatches();
        registerBuiltinPatches();
      }
      break;
    }
    case "runtime_rectifier": {
      output = rectifyUpstreamRequest({
        apiFormat: fixture.apiFormat,
        body: fixture.input,
        payload: fixture.errorPayload,
        status: fixture.status
      });
      break;
    }
    case "private_field_filter": {
      output = stripInternalFieldsDeep(fixture.input);
      break;
    }
    default:
      throw new Error(`Unsupported compat fixture operation: ${fixture.operation}`);
  }
  if (fixture.expect?.output !== undefined) assertMatches(output, fixture.expect.output, fixture.id);
  return { id: fixture.id, output };
}

function streamFromFixture(fixture) {
  const chunks = Array.isArray(fixture.sse)
    ? fixture.sse
    : (Array.isArray(fixture.events) ? fixture.events.map((event) => `data: ${JSON.stringify(event)}\n\n`) : []);
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    }
  });
}

export function assertMatches(actual, expected, label = "fixture") {
  matchValue(actual, expected, label);
}

function matchValue(actual, expected, pathLabel) {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (Object.hasOwn(expected, "$match")) {
      assert.match(String(actual ?? ""), new RegExp(expected.$match), pathLabel);
      return;
    }
    if (Object.hasOwn(expected, "$exists")) {
      assert.equal(actual !== undefined, Boolean(expected.$exists), pathLabel);
      return;
    }
    if (Object.hasOwn(expected, "$contains")) {
      matchContains(actual, expected.$contains, pathLabel);
      return;
    }
    assert.ok(actual && typeof actual === "object", `${pathLabel}: expected object`);
    for (const [key, value] of Object.entries(expected)) {
      matchValue(actual[key], value, `${pathLabel}.${key}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${pathLabel}: expected array`);
    assert.equal(actual.length, expected.length, `${pathLabel}: array length`);
    for (let i = 0; i < expected.length; i += 1) matchValue(actual[i], expected[i], `${pathLabel}[${i}]`);
    return;
  }
  assert.deepEqual(actual, expected, pathLabel);
}

function matchContains(actual, expected, pathLabel) {
  if (typeof actual === "string") {
    assert.ok(actual.includes(String(expected)), `${pathLabel}: expected string to contain ${expected}`);
    return;
  }
  assert.ok(Array.isArray(actual), `${pathLabel}: expected array or string for $contains`);
  const found = actual.some((item, index) => {
    try {
      matchValue(item, expected, `${pathLabel}[${index}]`);
      return true;
    } catch {
      return false;
    }
  });
  assert.ok(found, `${pathLabel}: expected array to contain matching item`);
}

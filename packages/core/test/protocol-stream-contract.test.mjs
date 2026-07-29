import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { responsesStreamToChatResponse } from "../src/openai-adapter-out.mjs";

const fixturePath = fileURLToPath(new URL("./fixtures/protocol-stream-contracts.json", import.meta.url));
const fixtures = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

function sseStream(events) {
  const source = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(source));
      controller.close();
    }
  });
}

for (const fixture of fixtures.responsesToChat || []) {
  test(`protocol fixture · ${fixture.id}`, async () => {
    const out = await responsesStreamToChatResponse({ body: sseStream(fixture.events) }, fixture.model);
    const choice = out.choices[0];
    assert.equal(choice.finish_reason, fixture.expect.finishReason);
    assert.equal(choice.message.tool_calls?.[0]?.function.name, fixture.expect.toolName);
    assert.equal(choice.message.tool_calls?.[0]?.function.arguments, fixture.expect.toolArguments);
  });
}

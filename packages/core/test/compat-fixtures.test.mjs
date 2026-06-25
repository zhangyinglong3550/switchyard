import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listCompatFixtureFiles, loadCompatFixture, runCompatFixture } from "../src/compat/fixture-runner.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, "compat-fixtures");

test("compat fixture runner executes all checked-in fixtures", async () => {
  const files = listCompatFixtureFiles(fixturesDir);
  assert.deepEqual(files.map((file) => path.basename(file)), [
    "claude-code-tool-concurrency.json",
    "codex-responses-to-deepseek-thinking.json",
    "openrouter-reasoning-effort.json",
    "private-field-filter-schema.json",
    "responses-function-call-stream.json",
    "siliconflow-enable-thinking.json",
    "thinking-signature-rectifier.json",
    "unsupported-image-reactive-retry.json"
  ]);

  for (const file of files) {
    const fixture = loadCompatFixture(file);
    const result = await runCompatFixture(fixture);
    assert.equal(result.id, fixture.id);
  }
});

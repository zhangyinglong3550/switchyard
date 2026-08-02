import test from "node:test";
import assert from "node:assert/strict";
import { previewText } from "../src/text-preview.mjs";

test("previewText keeps short text intact", () => {
  assert.equal(previewText("hello", 1200), "hello");
});

test("previewText head-tail keeps latest suffix", () => {
  const text = `${"A".repeat(900)}LATEST_TURN_MARKER${"B".repeat(100)}`;
  const out = previewText(text, 360);
  assert.match(out, /中间已省略 \d+ 字/);
  assert.ok(out.startsWith("A"));
  assert.ok(out.includes("LATEST_TURN_MARKER") || out.includes("BBBBB"));
  assert.ok(out.slice(-120).includes("LATEST_TURN_MARKER") || /B{20,}/.test(out.slice(-120)));
});

test("previewText head strategy only keeps prefix", () => {
  const text = `${"A".repeat(100)}TAIL_ONLY`;
  const out = previewText(text, 50, { strategy: "head" });
  assert.ok(out.startsWith("A"));
  assert.equal(out.includes("TAIL_ONLY"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeRequestBodyCaptureConfig,
  prepareRequestBodyForCapture,
  captureRequestBody,
  readCapturedRequestBody
} from "../src/request-body-capture.mjs";

test("normalizeRequestBodyCaptureConfig defaults disabled", () => {
  const cfg = normalizeRequestBodyCaptureConfig({});
  assert.equal(cfg.enabled, false);
  assert.ok(cfg.maxBytes >= 64 * 1024);
  assert.ok(cfg.maxFiles >= 10);
});

test("prepareRequestBodyForCapture redacts secrets and images", () => {
  const prepared = prepareRequestBodyForCapture({
    apiKey: "sk-secret-value-123456",
    messages: [
      {
        role: "user",
        content: "hello data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg== end"
      }
    ]
  });
  assert.equal(prepared.body.apiKey, "[REDACTED]");
  assert.match(prepared.body.messages[0].content, /图片base64已省略/);
  assert.equal(prepared.body.messages[0].content.includes("iVBORw0KGgo"), false);
});

test("captureRequestBody writes and reads when enabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-body-"));
  try {
    const captured = captureRequestBody({
      body: { messages: [{ role: "user", content: "完整请求体测试 " + "x".repeat(100) }] },
      captureConfig: { enabled: true, maxFiles: 20, maxBytes: 256 * 1024 },
      meta: { protocol: "openai_responses", clientId: "codex" },
      baseLogDir: dir
    });
    assert.ok(captured?.ref);
    assert.ok(fs.existsSync(captured.path));
    const read = readCapturedRequestBody(captured.ref, dir);
    assert.equal(read.ok, true);
    assert.equal(read.payload.meta.clientId, "codex");
    assert.match(read.payload.body.messages[0].content, /完整请求体测试/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("captureRequestBody noops when disabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sy-body-off-"));
  try {
    const captured = captureRequestBody({
      body: { ok: true },
      captureConfig: { enabled: false },
      baseLogDir: dir
    });
    assert.equal(captured, null);
    assert.equal(fs.existsSync(path.join(dir, "request-bodies")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

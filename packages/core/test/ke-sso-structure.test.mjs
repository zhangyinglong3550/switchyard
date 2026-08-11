import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("KE provider UI uses a dedicated persistent SSO session without a manual system-ID field", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.mjs"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/desktop/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/renderer.js"), "utf8");

  assert.match(main, /persist:ke-sso/);
  assert.match(main, /ke-sso:status/);
  assert.match(main, /ke-sso:login/);
  assert.match(main, /ke-sso:logout/);
  assert.match(main, /console\/userInfo/);
  assert.match(main, /data\?\.userId/);
  assert.match(html, /id="provider-ke-sso-panel"/);
  assert.doesNotMatch(html, /name="keUserId"/);
  assert.match(renderer, /ke-sso:status/);
  assert.match(renderer, /ke-sso:login/);
  assert.match(renderer, /ke-sso:logout/);
});

test("outbound request body capture is wired through desktop and renderer", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.mjs"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/renderer.js"), "utf8");
  const store = fs.readFileSync(path.join(root, "apps/desktop/src/request-log-store.mjs"), "utf8");
  const server = fs.readFileSync(path.join(root, "packages/core/src/server.mjs"), "utf8");
  const dispatch = fs.readFileSync(path.join(root, "packages/core/src/upstream/dispatch.mjs"), "utf8");
  const css = fs.readFileSync(path.join(root, "apps/desktop/renderer/styles.css"), "utf8");
  assert.match(dispatch, /captureRequestBody/);
  assert.match(dispatch, /outboundRequestBodyRef/);
  assert.match(server, /requestBodyCapture: config\?\.requestBodyCapture/);
  assert.match(server, /outboundRequestBodyCapture/);
  assert.match(store, /outboundRequestBodyCapture/);
  assert.match(renderer, /出站请求体/);
  assert.match(renderer, /traceOutboundBodyRef/);
  assert.match(css, /has-outbound/);
});

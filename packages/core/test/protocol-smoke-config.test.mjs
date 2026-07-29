import test from "node:test";
import assert from "node:assert/strict";
import { readProtocolSmokeConfig } from "../../../scripts/protocol-smoke.mjs";

test("protocol smoke config skips safely without explicit target", () => {
  const config = readProtocolSmokeConfig({});
  assert.equal(config.ready, false);
  assert.match(config.reason, /SWITCHYARD_PROTOCOL_SMOKE_URL/);
});

test("protocol smoke config accepts an explicit gateway target", () => {
  const config = readProtocolSmokeConfig({
    SWITCHYARD_PROTOCOL_SMOKE_URL: "http://127.0.0.1:17888",
    SWITCHYARD_PROTOCOL_SMOKE_MODEL: "ke/kimi-k3",
    SWITCHYARD_PROTOCOL_SMOKE_TOKEN: "test-token"
  });
  assert.deepEqual(config, {
    ready: true,
    baseUrl: "http://127.0.0.1:17888",
    model: "ke/kimi-k3",
    token: "test-token"
  });
});

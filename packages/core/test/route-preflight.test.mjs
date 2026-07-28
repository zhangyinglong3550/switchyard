import test from "node:test";
import assert from "node:assert/strict";
import { preflightRoute } from "../src/route-preflight.mjs";

test("route preflight reports disabled model without routing it", () => {
  const result = preflightRoute({ providers: [{ id: "p", apiFormat: "openai_chat" }], models: [{ id: "p/m", providerId: "p", upstreamModel: "m", enabled: false }], clients: { codex: { enabled: true, allowedModels: ["*"] } } }, { modelId: "p/m", clientId: "codex" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((row) => row.code === "MODEL_DISABLED"));
});

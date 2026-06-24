import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPatch, applyOutbound, applyInbound, listPatchIds, resetPatches, registerBuiltinPatches, listCompatPacks } from "../src/compat/index.mjs";

test("compat registry only applies patches whose match() returns true", () => {
  resetPatches();
  registerPatch("a", {
    match: ({ provider }) => provider?.id === "alpha",
    outbound: (body) => ({ ...body, marked: "alpha" })
  });
  registerPatch("b", {
    match: ({ provider }) => provider?.id === "beta",
    outbound: (body) => ({ ...body, marked: "beta" })
  });
  const out = applyOutbound({ x: 1 }, { provider: { id: "alpha" }, model: { id: "m" } });
  assert.equal(out.marked, "alpha");
  assert.deepEqual(listPatchIds().sort(), ["a", "b"]);
  resetPatches();
});

test("compat patches are isolated per request and do not bleed", () => {
  resetPatches();
  registerPatch("kimi", {
    match: ({ provider }) => provider?.id === "kimi",
    outbound: (body) => ({ ...body, sanitized: true })
  });
  const a = applyOutbound({}, { provider: { id: "kimi" } });
  const b = applyOutbound({}, { provider: { id: "other" } });
  assert.equal(a.sanitized, true);
  assert.equal(b.sanitized, undefined);
  resetPatches();
});

test("compat inbound is independent of outbound dispatch", () => {
  resetPatches();
  registerPatch("deepseek", {
    match: ({ model }) => model?.id?.startsWith("deepseek/"),
    inbound: (payload) => ({ ...payload, _patched: true })
  });
  const out = applyInbound({ ok: 1 }, { provider: { id: "p" }, model: { id: "deepseek/chat" } });
  assert.equal(out._patched, true);
  const out2 = applyInbound({ ok: 1 }, { provider: { id: "p" }, model: { id: "kimi/m" } });
  assert.equal(out2._patched, undefined);
  resetPatches();
});

test("compat packs can force provider/model scoped builtin patches", () => {
  resetPatches();
  registerBuiltinPatches();
  const packs = listCompatPacks().map((pack) => pack.id);
  assert.ok(packs.includes("glm"));
  assert.ok(packs.includes("kimi"));

  const glmOut = applyOutbound(
    { model: "custom-model", messages: [{ role: "user", content: "hi" }] },
    { provider: { id: "custom-provider", compatPacks: ["glm"] }, model: { id: "custom-provider/custom-model" } }
  );
  assert.ok(Array.isArray(glmOut.messages[0].content), "provider compat pack should activate GLM content normalization");

  const kimiOut = applyOutbound(
    { model: "custom-model", tools: [{ type: "function", function: { name: "f", parameters: { $schema: "x", type: "object" } } }] },
    { provider: { id: "custom-provider" }, model: { id: "custom-provider/custom-model", compatPacks: ["kimi"] } }
  );
  assert.equal(kimiOut.tools[0].function.parameters.$schema, undefined, "model compat pack should activate Kimi schema sanitizer");

  const vanilla = applyOutbound(
    { model: "custom-model", messages: [{ role: "user", content: "hi" }] },
    { provider: { id: "custom-provider" }, model: { id: "custom-provider/custom-model" } }
  );
  assert.equal(typeof vanilla.messages[0].content, "string", "unconfigured models stay untouched");
  resetPatches();
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_PROBE_MODEL_ID,
  isDiscoveryProbeRequest,
  resolveUsageModelKey
} from "../src/request-kind.mjs";

test("isDiscoveryProbeRequest · Hermes-style discovery paths", () => {
  const paths = [
    "/hermes/v1/models",
    "/hermes/api/tags",
    "/hermes/api/v1/models",
    "/hermes/props",
    "/hermes/v1/props",
    "/hermes/version",
    "/hermes/v1/models/codex/gpt-5.6-luna",
    "/grok/v1/models-v2"
  ];
  for (const path of paths) {
    assert.equal(
      isDiscoveryProbeRequest({ method: "GET", path }),
      true,
      path
    );
    assert.equal(
      resolveUsageModelKey({ method: "GET", path }),
      DISCOVERY_PROBE_MODEL_ID,
      path
    );
  }
  assert.equal(
    isDiscoveryProbeRequest({ method: "POST", path: "/hermes/api/show" }),
    true
  );
});

test("isDiscoveryProbeRequest · real chat is not discovery even without model", () => {
  assert.equal(
    isDiscoveryProbeRequest({ method: "POST", path: "/hermes/v1/chat/completions" }),
    false
  );
  assert.equal(
    resolveUsageModelKey({ method: "POST", path: "/hermes/v1/chat/completions" }),
    "(unknown)"
  );
  assert.equal(
    resolveUsageModelKey({
      method: "POST",
      path: "/hermes/v1/chat/completions",
      modelId: "codex/gpt-5.6-luna"
    }),
    "codex/gpt-5.6-luna"
  );
});

test("isDiscoveryProbeRequest · explicit model wins over GET path", () => {
  assert.equal(
    isDiscoveryProbeRequest({
      method: "GET",
      path: "/hermes/v1/models",
      modelId: "should-not-happen"
    }),
    false
  );
});

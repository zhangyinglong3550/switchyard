import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRetryPolicy,
  shouldRetryDispatchResult,
  isRetryableStatus,
  backoffForAttempt,
  withDispatchRetry,
  DEFAULT_RETRY_MAX_ATTEMPTS
} from "../src/upstream/retry-policy.mjs";
import { dispatchChat } from "../src/upstream/dispatch.mjs";
import http from "node:http";
import { resetPatches } from "../src/compat/index.mjs";

test("resolveRetryPolicy defaults to 3 attempts and 0/429/5xx", () => {
  const policy = resolveRetryPolicy();
  assert.equal(policy.enabled, true);
  assert.equal(policy.maxAttempts, DEFAULT_RETRY_MAX_ATTEMPTS);
  assert.equal(isRetryableStatus(0, policy), true);
  assert.equal(isRetryableStatus(429, policy), true);
  assert.equal(isRetryableStatus(503, policy), true);
  assert.equal(isRetryableStatus(400, policy), false);
  assert.equal(isRetryableStatus(401, policy), false);
});

test("resolveRetryPolicy model overrides provider; enabled false disables", () => {
  const policy = resolveRetryPolicy(
    { retry: { maxAttempts: 5, onStatus: [500] } },
    { retry: { maxAttempts: 2 } }
  );
  assert.equal(policy.maxAttempts, 2);
  assert.equal(isRetryableStatus(500, policy), true);
  assert.equal(isRetryableStatus(429, policy), false);

  const off = resolveRetryPolicy(null, { retry: { enabled: false } });
  assert.equal(off.enabled, false);
  assert.equal(off.maxAttempts, 1);
});

test("shouldRetryDispatchResult: error recoverable; stream only when not ok", () => {
  const policy = resolveRetryPolicy();
  assert.equal(shouldRetryDispatchResult({ kind: "error", status: 503 }, policy), true);
  assert.equal(shouldRetryDispatchResult({ kind: "error", status: 400 }, policy), false);
  assert.equal(shouldRetryDispatchResult({ kind: "json", status: 200 }, policy), false);
  assert.equal(shouldRetryDispatchResult({ kind: "stream", upstream: { ok: false, status: 502 } }, policy), true);
  assert.equal(shouldRetryDispatchResult({ kind: "stream", upstream: { ok: true, status: 200 } }, policy), false);
  assert.equal(shouldRetryDispatchResult({ kind: "stream", upstream: null }, policy), true);
});

test("backoffForAttempt uses ladder then clamps", () => {
  const policy = resolveRetryPolicy(null, null, { retry: { backoffMs: [10, 20, 30] } });
  assert.equal(backoffForAttempt(policy, 0), 10);
  assert.equal(backoffForAttempt(policy, 1), 20);
  assert.equal(backoffForAttempt(policy, 2), 30);
  assert.equal(backoffForAttempt(policy, 9), 30);
});

test("withDispatchRetry retries recoverable failures then succeeds", async () => {
  let n = 0;
  const result = await withDispatchRetry(
    null,
    { retry: { maxAttempts: 3, backoffMs: [0, 0, 0] } },
    {},
    async () => {
      n += 1;
      if (n < 3) return { kind: "error", status: 503, payload: { error: "busy" } };
      return { kind: "json", status: 200, payload: { ok: true } };
    }
  );
  assert.equal(n, 3);
  assert.equal(result.kind, "json");
  assert.equal(result.retryCount, 2);
  assert.equal(result.retryAttempts.length, 3);
});

test("withDispatchRetry does not retry client errors", async () => {
  let n = 0;
  const result = await withDispatchRetry(
    null,
    { retry: { maxAttempts: 5, backoffMs: [0] } },
    {},
    async () => {
      n += 1;
      return { kind: "error", status: 400, payload: { error: "bad" } };
    }
  );
  assert.equal(n, 1);
  assert.equal(result.status, 400);
  assert.equal(result.retryCount, 0);
});

test("withDispatchRetry retries thrown network errors as status 0", async () => {
  let n = 0;
  const result = await withDispatchRetry(
    null,
    { retry: { maxAttempts: 3, backoffMs: [0, 0] } },
    {},
    async () => {
      n += 1;
      if (n < 2) throw new Error("socket hang up");
      return { kind: "json", status: 200, payload: { ok: true } };
    }
  );
  assert.equal(n, 2);
  assert.equal(result.kind, "json");
  assert.equal(result.retryCount, 1);
});

test("withDispatchRetry does not retry successful stream", async () => {
  let n = 0;
  const result = await withDispatchRetry(
    null,
    { retry: { maxAttempts: 3, backoffMs: [0] } },
    {},
    async () => {
      n += 1;
      return { kind: "stream", upstream: { ok: true, status: 200, body: null } };
    }
  );
  assert.equal(n, 1);
  assert.equal(result.retryCount, 0);
});

test("withDispatchRetry retries failed stream before client content", async () => {
  let n = 0;
  const result = await withDispatchRetry(
    null,
    { retry: { maxAttempts: 3, backoffMs: [0, 0] } },
    {},
    async () => {
      n += 1;
      if (n < 2) {
        return {
          kind: "stream",
          upstream: {
            ok: false,
            status: 503,
            body: { cancel: async () => {} }
          }
        };
      }
      return { kind: "stream", upstream: { ok: true, status: 200, body: null } };
    }
  );
  assert.equal(n, 2);
  assert.equal(result.upstream.ok, true);
  assert.equal(result.retryCount, 1);
});

function spawnUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => (buf += c));
      req.on("end", () => handler(req, res, buf));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((r) => server.close(r));
}

test("dispatchChat integrates retry on 503 then success", async (t) => {
  resetPatches();
  let hits = 0;
  const up = await spawnUpstream((req, res) => {
    hits += 1;
    if (hits < 2) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "overloaded" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: "u-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
    }));
  });
  t.after(() => close(up));
  const provider = {
    id: "p",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${up.address().port}/v1`
  };
  const result = await dispatchChat(
    provider,
    "u-model",
    { messages: [{ role: "user", content: "go" }] },
    { model: { id: "p/u-model", retry: { maxAttempts: 3, backoffMs: [0, 0] } } }
  );
  assert.equal(result.kind, "json");
  assert.equal(result.payload.choices[0].message.content, "ok");
  assert.ok(result.retryCount >= 1);
  assert.equal(hits, 2);
});

test("dispatchChat does not retry 400", async (t) => {
  resetPatches();
  let hits = 0;
  const up = await spawnUpstream((req, res) => {
    hits += 1;
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad request" }));
  });
  t.after(() => close(up));
  const provider = {
    id: "p",
    apiFormat: "openai_chat",
    baseUrl: `http://127.0.0.1:${up.address().port}/v1`
  };
  const result = await dispatchChat(
    provider,
    "u-model",
    { messages: [{ role: "user", content: "go" }] },
    { model: { id: "p/u-model", retry: { maxAttempts: 3, backoffMs: [0] } } }
  );
  assert.equal(result.kind, "error");
  assert.equal(result.status, 400);
  assert.equal(hits, 1);
  assert.equal(result.retryCount, 0);
});

test("retry policy honors a bounded Retry-After header over its local backoff", async () => {
  const { retryDelayForResult } = await import("../src/upstream/retry-policy.mjs");
  const policy = resolveRetryPolicy(null, null, { retry: { backoffMs: [50], maxRetryAfterMs: 10_000 } });
  const delay = retryDelayForResult(
    { kind: "error", status: 429, headers: new Headers({ "retry-after": "2" }) },
    policy,
    0,
    Date.parse("2026-07-28T00:00:00Z")
  );
  assert.equal(delay, 2_000);
});

test("retry policy falls back to local backoff for invalid Retry-After", async () => {
  const { retryDelayForResult } = await import("../src/upstream/retry-policy.mjs");
  const policy = resolveRetryPolicy(null, null, { retry: { backoffMs: [125] } });
  const delay = retryDelayForResult(
    { kind: "stream", upstream: new Response("busy", { status: 503, headers: { "retry-after": "not-a-delay" } }) },
    policy,
    0,
    Date.parse("2026-07-28T00:00:00Z")
  );
  assert.equal(delay, 125);
});

test("dispatchChat carries upstream Retry-After into its retry decision", async (t) => {
  resetPatches();
  let hits = 0;
  const up = await spawnUpstream((req, res) => {
    hits += 1;
    if (hits === 1) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0.01" });
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: "u-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]
    }));
  });
  t.after(() => close(up));
  const result = await dispatchChat(
    { id: "p", apiFormat: "openai_chat", baseUrl: `http://127.0.0.1:${up.address().port}/v1` },
    "u-model",
    { messages: [{ role: "user", content: "go" }] },
    { model: { id: "p/u-model", retry: { maxAttempts: 2, backoffMs: [0], maxRetryAfterMs: 1_000 } } }
  );
  assert.equal(result.kind, "json");
  assert.equal(hits, 2);
  assert.ok(result.retryAttempts[0].waitMs >= 10);
});

import test from "node:test";
import assert from "node:assert/strict";

test("provider health monitor records healthy and unhealthy snapshots", async () => {
  const { createProviderHealthMonitor } = await import("../../../apps/desktop/src/provider-health.mjs");
  const outcomes = new Map([
    ["ok", { ok: true, status: 200, url: "https://ok.example.com/models" }],
    ["bad", { ok: false, status: 401, error: "invalid api key", url: "https://bad.example.com/models" }]
  ]);
  let ticks = 0;
  const monitor = createProviderHealthMonitor({
    listProviders: () => [{ id: "ok" }, { id: "bad" }],
    probeProvider: async (provider) => outcomes.get(provider.id),
    now: () => new Date(`2026-06-24T00:00:0${++ticks}.000Z`).getTime(),
    intervalMs: 60_000
  });

  const rows = await monitor.refresh();
  assert.equal(rows.length, 2);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.ok.status, "healthy");
  assert.equal(snapshot.ok.successes, 1);
  assert.equal(snapshot.bad.status, "unhealthy");
  assert.equal(snapshot.bad.failures, 1);
  assert.equal(snapshot.bad.error, "invalid api key");
});

test("provider health monitor preserves last state and resets removed providers", async () => {
  const { createProviderHealthMonitor } = await import("../../../apps/desktop/src/provider-health.mjs");
  let providers = [{ id: "p1" }, { id: "p2" }];
  const monitor = createProviderHealthMonitor({
    listProviders: () => providers,
    probeProvider: async (provider) => ({ ok: provider.id === "p1", status: provider.id === "p1" ? 200 : 500 }),
    intervalMs: 60_000
  });

  await monitor.refresh();
  providers = [{ id: "p1" }];
  const rows = await monitor.refresh();

  assert.deepEqual(rows.map((row) => row.providerId), ["p1"]);
  assert.equal(monitor.snapshot().p2, undefined);
  assert.equal(monitor.snapshot().p1.status, "healthy");
});

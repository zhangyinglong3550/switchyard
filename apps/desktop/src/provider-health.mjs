export function createProviderHealthMonitor({
  listProviders,
  probeProvider,
  intervalMs = 5 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  if (typeof listProviders !== "function") throw new Error("listProviders is required");
  if (typeof probeProvider !== "function") throw new Error("probeProvider is required");

  const state = new Map();
  let timer = null;
  let running = false;

  async function refresh(providerId = "") {
    const providers = (await listProviders()) || [];
    const targets = providerId ? providers.filter((provider) => provider.id === providerId) : providers;
    const targetIds = new Set(targets.map((provider) => provider.id).filter(Boolean));
    if (!providerId) {
      const liveIds = new Set(providers.map((provider) => provider.id).filter(Boolean));
      for (const id of state.keys()) {
        if (!liveIds.has(id)) state.delete(id);
      }
    }

    const rows = [];
    for (const provider of targets) {
      if (!provider?.id) continue;
      state.set(provider.id, {
        ...defaultRow(provider.id, state.get(provider.id)),
        status: "checking"
      });
      const started = now();
      try {
        const result = await probeProvider(provider);
        const finished = now();
        const row = rowFromProbe(provider.id, result, {
          previous: state.get(provider.id),
          latencyMs: Math.max(0, finished - started),
          checkedAt: new Date(finished).toISOString()
        });
        state.set(provider.id, row);
        rows.push(row);
      } catch (err) {
        const finished = now();
        const previous = state.get(provider.id);
        const row = {
          ...defaultRow(provider.id, previous),
          status: "unhealthy",
          ok: false,
          latencyMs: Math.max(0, finished - started),
          lastChecked: new Date(finished).toISOString(),
          error: err?.message || String(err),
          failures: Number(previous?.failures || 0) + 1
        };
        state.set(provider.id, row);
        rows.push(row);
      }
    }
    if (providerId && !targetIds.size) state.delete(providerId);
    return rows;
  }

  function snapshot() {
    return Object.fromEntries(Array.from(state.entries()).map(([id, row]) => [id, { ...row }]));
  }

  function start({ immediate = true } = {}) {
    if (running) return { ok: true, running };
    running = true;
    if (immediate) refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return { ok: true, running };
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    running = false;
    return { ok: true, running };
  }

  return { refresh, snapshot, start, stop };
}

function defaultRow(providerId, previous = {}) {
  return {
    providerId,
    status: previous.status || "unknown",
    ok: previous.ok ?? null,
    statusCode: previous.statusCode ?? null,
    url: previous.url || "",
    latencyMs: previous.latencyMs ?? null,
    lastChecked: previous.lastChecked || "",
    error: previous.error || "",
    successes: Number(previous.successes || 0),
    failures: Number(previous.failures || 0)
  };
}

function rowFromProbe(providerId, result = {}, { previous = {}, latencyMs = 0, checkedAt = "" } = {}) {
  const ok = Boolean(result.ok);
  return {
    ...defaultRow(providerId, previous),
    status: ok ? "healthy" : "unhealthy",
    ok,
    statusCode: Number.isFinite(Number(result.status)) ? Number(result.status) : null,
    url: result.url || previous.url || "",
    latencyMs,
    lastChecked: checkedAt,
    error: ok ? "" : (result.error || result.bodyPreview || `status ${result.status || "n/a"}`),
    successes: Number(previous.successes || 0) + (ok ? 1 : 0),
    failures: Number(previous.failures || 0) + (ok ? 0 : 1)
  };
}

// 供应商健康监控器。
//
// 定期对每个供应商发起探测请求，记录 healthy/unhealthy/checking/unknown 状态，
// 跟踪延迟、成功/失败计数与错误信息。可选注入 checkBalance，在每次刷新时
// 并行查询供应商余额/用量，结果存入 row.balance（独立于连通性，失败不影响健康状态）。
export function createProviderHealthMonitor({
  listProviders,
  probeProvider,
  checkBalance,
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
      let row;
      try {
        const result = await probeProvider(provider);
        const finished = now();
        row = rowFromProbe(provider.id, result, {
          previous: state.get(provider.id),
          latencyMs: Math.max(0, finished - started),
          checkedAt: new Date(finished).toISOString()
        });
      } catch (err) {
        const finished = now();
        const previous = state.get(provider.id);
        row = {
          ...defaultRow(provider.id, previous),
          status: "unhealthy",
          ok: false,
          latencyMs: Math.max(0, finished - started),
          lastChecked: new Date(finished).toISOString(),
          error: err?.message || String(err),
          failures: Number(previous?.failures || 0) + 1
        };
      }
      // 余额查询独立于连通性：余额 API 与 /models 探测端点不同，
      // 即使连通性探测失败也尝试查询余额。失败不影响健康状态。
      row.balance = await safeCheckBalance(provider);
      state.set(provider.id, row);
      rows.push(row);
    }
    if (providerId && !targetIds.size) state.delete(providerId);
    return rows;
  }

  async function safeCheckBalance(provider) {
    if (typeof checkBalance !== "function") return null;
    try {
      return await checkBalance(provider);
    } catch (err) {
      return {
        success: false,
        error: err?.message || String(err),
        data: [],
        status: "error"
      };
    }
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
    failures: Number(previous.failures || 0),
    balance: previous.balance ?? null
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

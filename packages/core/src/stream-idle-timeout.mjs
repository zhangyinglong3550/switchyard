// Shared upstream stream watchdog. Downstream SSE keepalives only keep a
// client socket open; they must never be mistaken for upstream activity.

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_STREAM_IDLE_TIMEOUT_MS = 1_000;
const MAX_STREAM_IDLE_TIMEOUT_MS = 60 * 60 * 1000;

export class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs, label = "Upstream stream") {
    super(`${label} was idle for ${timeoutMs}ms`);
    this.name = "StreamIdleTimeoutError";
    this.code = "SWITCHYARD_STREAM_IDLE_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export function resolveStreamIdleTimeoutMs(...sources) {
  for (const source of sources) {
    const value = source && typeof source === "object"
      ? (source.streamIdleTimeoutMs ?? source.stream_idle_timeout_ms)
      : source;
    if (value == null || value === "") continue;
    const timeoutMs = Number(value);
    if (!Number.isFinite(timeoutMs)) continue;
    // Explicit zero disables the watchdog for an upstream that cannot provide
    // periodic bytes (for example a legacy long-running batch endpoint).
    if (timeoutMs === 0) return 0;
    return Math.min(MAX_STREAM_IDLE_TIMEOUT_MS, Math.max(MIN_STREAM_IDLE_TIMEOUT_MS, Math.floor(timeoutMs)));
  }
  return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function readWithTimeout(read, timeoutMs, label) {
  if (!timeoutMs) return read();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StreamIdleTimeoutError(timeoutMs, label)), timeoutMs);
  });
  return Promise.race([read(), timeout]).finally(() => clearTimeout(timer));
}

async function cancelBody(body, reader, iterator, reason) {
  try {
    if (typeof reader?.cancel === "function") await reader.cancel(reason);
  } catch {}
  try {
    if (typeof iterator?.return === "function") await iterator.return();
  } catch {}
  try {
    if (typeof body?.cancel === "function") await body.cancel(reason);
  } catch {}
  try {
    if (typeof body?.destroy === "function") body.destroy(reason);
  } catch {}
}

// Iterate chunks while enforcing an inactivity deadline between *upstream*
// bytes. It works with fetch's ReadableStream as well as test/custom async
// iterables, and cancels the source before surfacing a timeout.
export async function* iterateUpstreamBody(body, { timeoutMs, label = "Upstream stream" } = {}) {
  if (!body) return;
  const effectiveTimeoutMs = resolveStreamIdleTimeoutMs(timeoutMs);
  const reader = typeof body.getReader === "function" ? body.getReader() : null;
  const iterator = reader || body[Symbol.asyncIterator]?.();
  if (!iterator) throw new TypeError("Upstream response body is not readable");

  try {
    while (true) {
      const result = await readWithTimeout(
        reader ? () => reader.read() : () => iterator.next(),
        effectiveTimeoutMs,
        label
      );
      if (result?.done) return;
      yield result?.value;
    }
  } catch (err) {
    if (err?.code === "SWITCHYARD_STREAM_IDLE_TIMEOUT") {
      await cancelBody(body, reader, reader ? null : iterator, err);
    }
    throw err;
  } finally {
    try { reader?.releaseLock?.(); } catch {}
  }
}

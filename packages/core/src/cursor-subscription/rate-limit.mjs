export class CursorSubscriptionBusyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CursorSubscriptionBusyError";
    this.code = code;
  }
}

export function createCursorSubscriptionLane({ maxConcurrentRequests = 2, cooldownMs = 30_000, failureThreshold = 5, now = () => Date.now() } = {}) {
  const concurrency = Math.min(3, Math.max(1, Math.floor(Number(maxConcurrentRequests) || 2)));
  let running = 0;
  let queued = 0;
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  const waiters = [];

  const drain = () => {
    while (running < concurrency && waiters.length) {
      running += 1;
      waiters.shift()();
    }
  };

  const snapshot = () => ({
    state: circuitOpenUntil > now() ? "circuit_open" : (running || queued ? "busy" : "connected"),
    running,
    queued,
    maxConcurrentRequests: concurrency,
    consecutiveFailures,
    circuitOpenUntil
  });

  const recordFailure = (error) => {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return snapshot();
    // Cursor reports subscription quota / transient capacity through 429.
    // That needs to reach the caller unchanged; treating it as a transport
    // fault makes subsequent manual tests fail locally before reaching Cursor.
    if (Number(error?.status) === 429 || /RESOURCE_EXHAUSTED/i.test(String(error?.code || ""))) return snapshot();
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) circuitOpenUntil = now() + cooldownMs;
    return snapshot();
  };

  const recordSuccess = () => {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    return snapshot();
  };

  const acquire = async () => {
    if (circuitOpenUntil > now()) throw new CursorSubscriptionBusyError("CURSOR_SUBSCRIPTION_CIRCUIT_OPEN", "Cursor 订阅通道暂时熔断，请稍后重试");
    queued += 1;
    await new Promise((resolve) => {
      waiters.push(resolve);
      drain();
    });
    queued -= 1;
    if (circuitOpenUntil > now()) {
      running -= 1;
      drain();
      throw new CursorSubscriptionBusyError("CURSOR_SUBSCRIPTION_CIRCUIT_OPEN", "Cursor 订阅通道暂时熔断，请稍后重试");
    }
    let released = false;
    return {
      release(error = null) {
        if (released) return snapshot();
        released = true;
        if (error) recordFailure(error);
        else recordSuccess();
        running -= 1;
        drain();
        return snapshot();
      }
    };
  };

  const run = async (task) => {
    const lease = await acquire();
    try {
      const value = await task();
      lease.release();
      return value;
    } catch (error) {
      lease.release(error);
      throw error;
    }
  };

  return { acquire, run, recordFailure, recordSuccess, snapshot, maxConcurrentRequests: concurrency };
}

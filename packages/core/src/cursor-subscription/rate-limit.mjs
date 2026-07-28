export class CursorSubscriptionBusyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CursorSubscriptionBusyError";
    this.code = code;
  }
}

export function createCursorSubscriptionLane({ cooldownMs = 60_000, failureThreshold = 2, now = () => Date.now() } = {}) {
  let running = 0;
  let queued = 0;
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  let tail = Promise.resolve();

  const snapshot = () => ({
    state: circuitOpenUntil > now() ? "circuit_open" : (running || queued ? "busy" : "connected"),
    running,
    queued,
    consecutiveFailures,
    circuitOpenUntil
  });

  const recordFailure = (error) => {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return snapshot();
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) circuitOpenUntil = now() + cooldownMs;
    return snapshot();
  };

  const recordSuccess = () => {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
    return snapshot();
  };

  const run = async (task) => {
    if (circuitOpenUntil > now()) throw new CursorSubscriptionBusyError("CURSOR_SUBSCRIPTION_CIRCUIT_OPEN", "Cursor 订阅通道暂时熔断，请稍后重试");
    queued += 1;
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    queued -= 1;
    if (circuitOpenUntil > now()) {
      release();
      throw new CursorSubscriptionBusyError("CURSOR_SUBSCRIPTION_CIRCUIT_OPEN", "Cursor 订阅通道暂时熔断，请稍后重试");
    }
    running = 1;
    try {
      const value = await task();
      recordSuccess();
      return value;
    } catch (error) {
      recordFailure(error);
      throw error;
    } finally {
      running = 0;
      release();
    }
  };

  return { run, recordFailure, recordSuccess, snapshot };
}

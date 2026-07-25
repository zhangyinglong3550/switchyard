// Downstream stream keepalives. They are intentionally separate from the
// upstream idle watchdog: a keepalive keeps the client connection alive, but
// never counts as upstream activity.

export const CODEX_RESPONSES_HEARTBEAT_MS = 2_000;
export const ANTHROPIC_PING_MS = 15_000;

export function startStreamKeepalive(res, {
  intervalMs,
  writeHeartbeat
} = {}) {
  const interval = Math.max(1, Number(intervalMs) || 15_000);
  let sawUpstreamActivity = false;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || res.destroyed || res.writableEnded) return;
    if (sawUpstreamActivity) {
      sawUpstreamActivity = false;
      return;
    }
    try {
      writeHeartbeat?.(res);
    } catch {
      // A torn-down downstream socket is handled by the request abort path.
    }
  }, interval);
  timer.unref?.();

  return {
    touch() {
      sawUpstreamActivity = true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    }
  };
}

export function writeCodexResponsesHeartbeat(res) {
  // Codex resets its SSE idle timer for parser-visible events. A comment frame
  // is not sufficient here; unknown response events are ignored safely.
  res.write('event: response.heartbeat\ndata: {"type":"response.heartbeat"}\n\n');
}

export function writeAnthropicPing(res) {
  // `ping` is part of the Anthropic Messages SSE vocabulary and is ignored by
  // Claude Code when no client-side action is required.
  res.write('event: ping\ndata: {"type":"ping"}\n\n');
}

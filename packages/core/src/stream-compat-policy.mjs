// Conservative compatibility rules for upstreams with imperfect SSE termination.
// Explicit model/provider configuration always wins; built-ins merely provide a
// safe default for known relays and never retry after visible output.
import { resolveStreamIdleTimeoutMs } from "./stream-idle-timeout.mjs";

export function streamCompatPolicy({ config = {}, provider = {}, model = {}, protocol = "" } = {}) {
  const explicit = model.streamCompat || provider.streamCompat || {};
  const isKeKimiK3 = provider?.id === "ke" && model?.upstreamModel === "kimi-k3";
  const idleTimeoutMs = resolveStreamIdleTimeoutMs(
    explicit.idleTimeoutMs,
    model.streamIdleTimeoutMs,
    provider.streamIdleTimeoutMs,
    config.streamIdleTimeoutMs
  );
  return {
    idleTimeoutMs,
    // Kimi K3's relay sometimes sends a usage footer then EOF. Treat it as
    // incomplete unless an actual terminal SSE event arrived.
    acceptUsageFooterAsTerminal: explicit.acceptUsageFooterAsTerminal ?? !isKeKimiK3,
    // A retry is safe only before any meaningful upstream output is exposed.
    retryPreludeOnEof: explicit.retryPreludeOnEof ?? (protocol === "responses" || isKeKimiK3),
    knownNonstandardSse: isKeKimiK3
  };
}

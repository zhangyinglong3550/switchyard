// Conservative compatibility rules for upstreams with imperfect SSE termination.
// Explicit model/provider configuration always wins; built-ins merely provide a
// safe default for known relays and never retry after visible output.
import { resolveStreamIdleTimeoutMs } from "./stream-idle-timeout.mjs";

export function streamCompatPolicy({ config = {}, provider = {}, model = {}, protocol = "" } = {}) {
  const explicit = model.streamCompat || provider.streamCompat || {};
  const isKeKimiK3 = provider?.id === "ke" && model?.upstreamModel === "kimi-k3";
  // KE 的 GPT-5.6 Sol 在 Codex 工具调用后的续轮偶发“200 + 空 SSE
  // prelude + EOF”。因为尚未向客户端暴露任何模型事件，带短退避地重发
  // 同一续轮是安全的；不把这个规则泛化到其他 KE 模型，避免放大请求量。
  const isKeGpt56Sol = provider?.id === "ke" && model?.upstreamModel === "gpt-5.6-sol";
  const retryPreludeOnEof = explicit.retryPreludeOnEof ?? (protocol === "responses" || isKeKimiK3);
  const explicitRetryAttempts = Number(explicit.preludeRetryAttempts);
  const preludeRetryAttempts = retryPreludeOnEof
    ? (Number.isFinite(explicitRetryAttempts)
        ? Math.max(0, Math.floor(explicitRetryAttempts))
        : (isKeGpt56Sol ? 2 : 1))
    : 0;
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
    retryPreludeOnEof,
    preludeRetryAttempts,
    preludeRetryBackoffMs: explicit.preludeRetryBackoffMs ?? (isKeGpt56Sol ? [250, 750] : []),
    knownNonstandardSse: isKeKimiK3 || isKeGpt56Sol
  };
}

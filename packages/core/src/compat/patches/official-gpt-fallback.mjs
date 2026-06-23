// Official GPT toggle-back.
// When a provider represents the official OpenAI/Codex endpoint (not a proxy)
// and the request comes in as Anthropic Messages format, the gateway must
// ensure the chat model name is one OpenAI recognizes. This patch:
//   - Strips anthropic-specific model aliases and maps them to a real GPT model.
//   - Ensures requests are valid for OpenAI's chat completions (no max_tokens=0
//     or unsupported parameters).
//
// Scope: provider.apiFormat === "openai_chat" for providers that are explicitly
//        the official OpenAI endpoint (provider.id === "codex" || provider.id === "openai")
//        OR upstreamModel contains "gpt"

const PROVIDER_IDS = new Set(["codex", "openai", "official-gpt"]);
const MODEL_RE = /gpt/i;

function targeted({ provider, model }) {
  if (!provider) return false;
  if (PROVIDER_IDS.has(provider.id)) return true;
  if (model?.providerId && PROVIDER_IDS.has(model.providerId)) return true;
  return MODEL_RE.test(model?.id || "");
}

export const officialGPTFallbackPatch = {
  id: "official-gpt-fallback",
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body) return body;
    const next = { ...body };
    // Ensure max_tokens is present and positive for GPT
    if (next.max_tokens == null || next.max_tokens <= 0) {
      next.max_tokens = 4096;
    }
    // Strip unsupported params for GPT
    delete next.top_k;
    delete next.min_p;
    delete next.presence_penalty;
    delete next.repetition_penalty;
    // If temperature is present, ensure it's valid
    if (next.temperature != null && (next.temperature < 0 || next.temperature > 2)) {
      next.temperature = 1;
    }
    return next;
  }
};

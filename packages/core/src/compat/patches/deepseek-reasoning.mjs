// DeepSeek reasoning_content handler.
// DeepSeek chat completions returns `reasoning_content` alongside `content`
// in both normal and stream (delta) responses. Non-DeepSeek-native clients
// (Codex, Claude Code) may choke on the extra field. This strips it before
// the response reaches the client.
//
// Scope: provider.id === "deepseek" || upstreamModel/aliases includes /deepseek/i

const NAME_RE = /deepseek/i;

function targeted({ provider, model }) {
  if (!provider) return false;
  if (provider.id === "deepseek") return true;
  if (model?.providerId === "deepseek") return true;
  return NAME_RE.test(model?.id || "");
}

export const deepseekReasoningPatch = {
  id: "deepseek-reasoning",
  match(ctx) { return targeted(ctx); },
  inbound(payload) {
    if (!payload || !Array.isArray(payload.choices)) return payload;
    const choices = payload.choices.map((c) => {
      if (!c) return c;
      const msg = c.message;
      if (!msg) return c;
      if (msg.reasoning_content !== undefined) {
        const { reasoning_content, ...rest } = msg;
        return { ...c, message: rest };
      }
      return c;
    });
    return { ...payload, choices };
  },
  streamLine(line) {
    const data = line.startsWith("data: ") ? line.slice(6) : line;
    if (!data || data === "[DONE]") return line;
    try {
      const parsed = JSON.parse(data);
      const choices = parsed.choices;
      if (!Array.isArray(choices)) return line;
      let changed = false;
      for (const c of choices) {
        if (c?.delta?.reasoning_content !== undefined) {
          const { reasoning_content, ...rest } = c.delta;
          c.delta = rest;
          changed = true;
        }
      }
      if (changed) return "data: " + JSON.stringify(parsed);
      return line;
    } catch {
      return line;
    }
  }
};

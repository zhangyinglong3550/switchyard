const TARGET_RE = /kimi|moonshot|opencode|openrouter|dashscope|bailian|aliyun|qwen|together|fireworks|groq|ollama|lm[-_ ]?studio|local/i;

function haystack({ provider, model }) {
  return [
    provider?.id,
    provider?.name,
    provider?.displayName,
    provider?.baseUrl,
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(model?.aliases || [])
  ].filter(Boolean).join(" ");
}

function targeted(ctx) {
  return TARGET_RE.test(haystack(ctx));
}

function ensureState(ctx) {
  if (!ctx._switchyardToolNameRawToSafe) ctx._switchyardToolNameRawToSafe = new Map();
  if (!ctx._switchyardToolNameSafeToRaw) ctx._switchyardToolNameSafeToRaw = new Map();
  return {
    rawToSafe: ctx._switchyardToolNameRawToSafe,
    safeToRaw: ctx._switchyardToolNameSafeToRaw
  };
}

export function safeToolName(name, used = new Set()) {
  const raw = String(name || "").trim() || "tool";
  let safe = raw.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) safe = "tool";
  if (!/^[A-Za-z]/.test(safe)) safe = `fn_${safe}`;
  let candidate = safe.slice(0, 96);
  let idx = 2;
  while (used.has(candidate)) {
    const suffix = `_${idx++}`;
    candidate = `${safe.slice(0, Math.max(1, 96 - suffix.length))}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function mapName(name, state, used) {
  const raw = String(name || "").trim();
  if (!raw) return safeToolName("tool", used);
  const existing = state.rawToSafe.get(raw);
  if (existing) {
    used.add(existing);
    return existing;
  }
  const safe = safeToolName(raw, used);
  state.rawToSafe.set(raw, safe);
  state.safeToRaw.set(safe, raw);
  return safe;
}

function restoreName(name, ctx) {
  const value = String(name || "");
  return ctx._switchyardToolNameSafeToRaw?.get(value) || value;
}

function normalizeTool(tool, state, used) {
  if (!tool || typeof tool !== "object") return tool;
  if (tool.type === "function" || tool.function || tool.name) {
    const fn = tool.function || {};
    const rawName = fn.name || tool.name;
    const name = mapName(rawName, state, used);
    return {
      ...tool,
      type: "function",
      function: { ...fn, name }
    };
  }
  return tool;
}

function normalizeToolChoice(choice, state, used) {
  if (!choice || typeof choice !== "object") return choice;
  if (choice.type === "function" || choice.function) {
    const fn = choice.function || {};
    const rawName = fn.name || choice.name;
    const name = rawName ? mapName(rawName, state, used) : rawName;
    return { ...choice, function: { ...fn, name } };
  }
  if (choice.type === "tool" && choice.name) {
    return { ...choice, name: mapName(choice.name, state, used) };
  }
  return choice;
}

function normalizeMessages(messages, state, used) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object" || !Array.isArray(message.tool_calls)) return message;
    const toolCalls = message.tool_calls.map((call) => {
      if (!call || typeof call !== "object") return call;
      const fn = call.function || {};
      const rawName = fn.name || call.name;
      if (!rawName) return call;
      return { ...call, function: { ...fn, name: mapName(rawName, state, used) } };
    });
    return { ...message, tool_calls: toolCalls };
  });
}

function restorePayload(payload, ctx) {
  if (!payload || !Array.isArray(payload.choices)) return payload;
  let changed = false;
  const choices = payload.choices.map((choice) => {
    const message = choice?.message;
    if (!message || !Array.isArray(message.tool_calls)) return choice;
    const toolCalls = message.tool_calls.map((call) => {
      const fn = call?.function;
      if (!fn?.name) return call;
      const restored = restoreName(fn.name, ctx);
      if (restored === fn.name) return call;
      changed = true;
      return { ...call, function: { ...fn, name: restored } };
    });
    return { ...choice, message: { ...message, tool_calls: toolCalls } };
  });
  return changed ? { ...payload, choices } : payload;
}

function restoreStreamLine(line, ctx) {
  const data = line.startsWith("data: ") ? line.slice(6) : line;
  if (!data || data === "[DONE]") return line;
  try {
    const parsed = JSON.parse(data);
    const choices = parsed.choices;
    if (!Array.isArray(choices)) return line;
    let changed = false;
    for (const choice of choices) {
      const calls = choice?.delta?.tool_calls;
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!call?.function?.name) continue;
        const restored = restoreName(call.function.name, ctx);
        if (restored !== call.function.name) {
          call.function.name = restored;
          changed = true;
        }
      }
    }
    return changed ? "data: " + JSON.stringify(parsed) : line;
  } catch {
    return line;
  }
}

export const toolNameNormalizePatch = {
  id: "tool-name-normalize",
  label: "工具名安全化",
  description: "把 namespace、MCP 或包含特殊字符的工具名改成常见 OpenAI-compatible 上游可接受的 function name。",
  trigger: "provider/model/baseUrl 命中 Kimi、OpenCode、OpenRouter、本地 OpenAI-compatible 服务等，或手动启用。",
  changes: [
    "把工具名改写为 [A-Za-z][A-Za-z0-9_-]*",
    "同步改写 tools、tool_choice 和 assistant tool_calls",
    "在同一请求上下文内把上游响应里的安全名恢复为原始工具名"
  ],
  risk: "流式响应跨进程或跨请求恢复时只能依赖当前请求上下文；不应把该规则用于需要长期持久化工具名映射的场景。",
  tests: [
    "tool-name-normalize · sanitizes namespaced tool names and restores response tool_calls",
    "tool-name-normalize · avoids collisions when two raw names normalize to the same safe name"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body, ctx) {
    if (!body || (!Array.isArray(body.tools) && !Array.isArray(body.messages) && body.tool_choice === undefined)) return body;
    const state = ensureState(ctx);
    const used = new Set(state.safeToRaw.keys());
    const out = { ...body };
    if (Array.isArray(body.tools)) out.tools = body.tools.map((tool) => normalizeTool(tool, state, used));
    if (Array.isArray(body.messages)) out.messages = normalizeMessages(body.messages, state, used);
    if (body.tool_choice !== undefined) out.tool_choice = normalizeToolChoice(body.tool_choice, state, used);
    return out;
  },
  inbound(payload, ctx) {
    return restorePayload(payload, ctx);
  },
  streamLine(line, ctx) {
    return restoreStreamLine(line, ctx);
  }
};


function toolDefinition(tool) {
  const fn = tool?.function || tool || {};
  const name = String(fn.name || "").trim();
  if (!name) return null;
  const schema = fn.parameters && typeof fn.parameters === "object" ? fn.parameters : {};
  return {
    name,
    properties: new Set(Object.keys(schema.properties || {})),
    required: new Set(Array.isArray(schema.required) ? schema.required.map(String) : [])
  };
}

function rememberTools(body, ctx) {
  if (!Array.isArray(body?.tools)) return;
  const tools = body.tools.map(toolDefinition).filter(Boolean);
  if (tools.length) ctx._switchyardToolDefinitions = tools;
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function inferToolName(argumentsValue, ctx) {
  const args = parseArguments(argumentsValue);
  const tools = ctx._switchyardToolDefinitions || [];
  if (!args || !tools.length) return "";
  const keys = Object.keys(args);
  const candidates = tools.filter((tool) => {
    if ([...tool.required].some((key) => !Object.hasOwn(args, key))) return false;
    return keys.every((key) => tool.properties.has(key));
  });
  if (candidates.length === 1) return candidates[0].name;
  if (!candidates.length) return "";
  const ranked = candidates.map((tool) => ({
    tool,
    score: keys.filter((key) => tool.properties.has(key)).length * 10 + tool.required.size
  })).sort((a, b) => b.score - a.score);
  return ranked.length === 1 || ranked[0].score > ranked[1].score ? ranked[0].tool.name : "";
}

function repairCalls(calls, ctx, { streaming = false } = {}) {
  if (!Array.isArray(calls)) return false;
  if (streaming && !ctx._switchyardMissingToolCalls) ctx._switchyardMissingToolCalls = new Map();
  let changed = false;
  for (let position = 0; position < calls.length; position += 1) {
    const call = calls[position];
    const fn = call?.function || call;
    if (!fn || String(fn.name || "").trim()) continue;
    let argumentsValue = fn.arguments ?? call.arguments;
    if (streaming) {
      const indexKey = `index:${call.index ?? position}`;
      const idKey = call.id || call.call_id ? `id:${call.id || call.call_id}` : "";
      const previous = (idKey && ctx._switchyardMissingToolCalls.get(idKey)) || ctx._switchyardMissingToolCalls.get(indexKey) || "";
      argumentsValue = `${previous}${String(argumentsValue || "")}`;
      ctx._switchyardMissingToolCalls.set(indexKey, argumentsValue);
      if (idKey) ctx._switchyardMissingToolCalls.set(idKey, argumentsValue);
    }
    const name = inferToolName(argumentsValue, ctx);
    if (!name) continue;
    fn.name = name;
    changed = true;
  }
  return changed;
}

function repairMessages(body, ctx) {
  if (!Array.isArray(body?.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!Array.isArray(message?.tool_calls)) return message;
    const toolCalls = structuredClone(message.tool_calls);
    if (!repairCalls(toolCalls, ctx)) return message;
    changed = true;
    return { ...message, tool_calls: toolCalls };
  });
  return changed ? { ...body, messages } : body;
}

function repairPayload(payload, ctx) {
  if (!Array.isArray(payload?.choices)) return payload;
  const next = structuredClone(payload);
  let changed = false;
  for (const choice of next.choices) {
    changed = repairCalls(choice?.message?.tool_calls, ctx) || changed;
    changed = repairCalls(choice?.delta?.tool_calls, ctx, { streaming: true }) || changed;
  }
  return changed ? next : payload;
}

function repairStreamLine(line, ctx) {
  const prefix = line.startsWith("data: ") ? "data: " : "";
  const data = prefix ? line.slice(prefix.length) : line;
  if (!data || data === "[DONE]") return line;
  try {
    const parsed = JSON.parse(data);
    const repaired = repairPayload(parsed, ctx);
    return repaired === parsed ? line : `${prefix}${JSON.stringify(repaired)}`;
  } catch {
    return line;
  }
}

export const missingToolNameRecoverPatch = {
  id: "missing-tool-name-recover",
  label: "缺失工具名恢复",
  description: "当 OpenAI-compatible 上游返回空工具名时，根据本次请求的工具 schema 与参数恢复名称。",
  trigger: "Grok Build 使用 OpenAI Chat 兼容模型时自动启用。",
  changes: ["保存本轮工具定义", "恢复流式和非流式响应中的空工具名", "修复下一轮历史里的空 assistant tool_calls"],
  risk: "只有参数能够唯一匹配一个工具 schema 时才恢复；歧义时保持原响应。",
  tests: ["missing-tool-name-recover · restores blank parallel Grok tool names from arguments"],
  match({ clientId }) { return String(clientId || "").toLowerCase() === "grok"; },
  outbound(body, ctx) {
    rememberTools(body, ctx);
    return repairMessages(body, ctx);
  },
  inbound(payload, ctx) {
    return repairPayload(payload, ctx);
  },
  streamLine(line, ctx) {
    return repairStreamLine(line, ctx);
  }
};

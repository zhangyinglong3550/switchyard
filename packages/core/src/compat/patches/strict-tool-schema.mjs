const TARGET_RE = /kimi|moonshot|opencode|openrouter|dashscope|bailian|aliyun|qwen|together|fireworks|groq|minimax|stepfun|qianfan|baidu/i;

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

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "$id" || key === "examples" || key === "deprecated") continue;
    if (key === "default" && value == null) continue;
    if ((key === "anyOf" || key === "oneOf") && Array.isArray(value) && value.length === 1) {
      Object.assign(out, sanitizeSchema(value[0]));
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      const withoutNull = value.filter((item) => item !== "null");
      out.type = withoutNull.length === 1 ? withoutNull[0] : withoutNull;
      continue;
    }
    if (key === "additionalProperties" && value && typeof value === "object") {
      out.additionalProperties = false;
      continue;
    }
    out[key] = sanitizeSchema(value);
  }
  if (!out.type && (out.properties || out.required)) out.type = "object";
  return out;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") return tool;
  const fn = tool.function || {};
  const name = fn.name || tool.name || "tool";
  const parameters = sanitizeSchema(fn.parameters || tool.parameters || { type: "object", properties: {} });
  return {
    ...tool,
    type: "function",
    function: {
      name,
      description: fn.description || tool.description || "",
      ...fn,
      parameters
    }
  };
}

export const strictToolSchemaPatch = {
  id: "strict-tool-schema",
  label: "严格工具 Schema 清理",
  description: "清理常见 OpenAI-compatible 上游拒绝的 JSON Schema 元字段，并补齐 function tool 最小形态。",
  trigger: "provider/model/baseUrl 命中 Kimi、OpenCode、OpenRouter、DashScope、Qwen、MiniMax 等严格工具上游，或手动启用。",
  changes: [
    "补齐 tools[].type = function 和 tools[].function",
    "移除 $schema、$id、examples、deprecated 和 null default",
    "展开单分支 anyOf/oneOf，移除 type 数组中的 null",
    "把对象型 additionalProperties 收敛为 false"
  ],
  risk: "可能降低复杂工具 schema 表达力；只在目标 provider/model 请求前改写。",
  tests: [
    "strict-tool-schema · normalizes loose function tool shape",
    "strict-tool-schema · removes nullable and unsupported schema keywords"
  ],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.tools)) return body;
    return { ...body, tools: body.tools.map(normalizeTool) };
  }
};


// Kimi (Moonshot) tool-schema sanitizer.
// Kimi rejects JSON Schema fragments that include $schema, examples, or anyOf
// with single-branch wrappers around primitive types; this strips those without
// touching anyone else's payload.
//
// Scope: provider.id === "kimi" || provider.id === "moonshot"
//        OR upstreamModel/aliases includes /kimi/i

const PROVIDER_IDS = new Set(["kimi", "moonshot"]);
const NAME_RE = /kimi|moonshot/i;

function targeted({ provider, model }) {
  if (!provider) return false;
  if (PROVIDER_IDS.has(provider.id)) return true;
  if (model?.providerId && PROVIDER_IDS.has(model.providerId)) return true;
  const id = model?.id || "";
  return NAME_RE.test(id);
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "$schema") continue;
    if (k === "$id") continue;
    if (k === "examples") continue;
    if (k === "default" && v == null) continue;
    if (k === "anyOf" && Array.isArray(v) && v.length === 1) {
      const inner = sanitizeSchema(v[0]);
      Object.assign(out, inner);
      continue;
    }
    if (k === "additionalProperties" && typeof v === "object") {
      out.additionalProperties = false;
      continue;
    }
    out[k] = sanitizeSchema(v);
  }
  return out;
}

export const kimiToolSchemaPatch = {
  id: "kimi-tool-schema",
  label: "Kimi 工具 Schema 清理",
  description: "Moonshot/Kimi 对工具 JSON Schema 更严格，会拒绝部分通用 schema 字段。",
  trigger: "provider/model 名称命中 Kimi 或 Moonshot，或手动启用 kimi 兼容规则。",
  changes: [
    "移除 $schema、$id、examples 和 null default",
    "展开单分支 anyOf",
    "把对象型 additionalProperties 收敛为 false"
  ],
  risk: "可能降低工具 schema 表达力；只在发送给目标供应商前改写。",
  tests: ["kimi-tool-schema · strips $schema, examples, anyOf wrappers from Kimi function parameters"],
  match(ctx) { return targeted(ctx); },
  outbound(body) {
    if (!body || !Array.isArray(body.tools)) return body;
    const tools = body.tools.map((t) => {
      if (!t || t.type !== "function" || !t.function) return t;
      const fn = t.function;
      const params = fn.parameters ? sanitizeSchema(fn.parameters) : fn.parameters;
      return { ...t, function: { ...fn, parameters: params } };
    });
    return { ...body, tools };
  }
};

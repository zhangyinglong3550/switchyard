export const UNSUPPORTED_IMAGE_MARKER = "[Unsupported Image]";

const THINKING_SIGNATURE_HINTS = [
  /invalid.*signature.*thinking.*block/i,
  /thought signature.*(?:not valid|invalid)/i,
  /must start with a thinking block/i,
  /signature.*field required/i,
  /signature.*extra inputs are not permitted/i,
  /(?:thinking|redacted_thinking).*cannot be modified/i
];

const UNSUPPORTED_IMAGE_HINTS = [
  /unsupported/i,
  /not supported/i,
  /does not support/i,
  /doesn't support/i,
  /do not support/i,
  /don't support/i,
  /only supports text/i,
  /text[- ]only/i,
  /invalid content type/i,
  /invalid message content/i,
  /unknown (?:variant|content type)/i,
  /unrecognized content type/i,
  /cannot (?:process|handle)/i,
  /can't (?:process|handle)/i,
  /unable to process/i
];

export function errorText(payload) {
  if (!payload) return "";
  if (typeof payload === "string") return payload;
  const candidates = [
    payload.error?.message,
    payload.error?.type,
    payload.error,
    payload.message,
    payload.detail,
    payload.details
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function classifyCompatibilityError(payload, status = 0) {
  const text = errorText(payload);
  const lower = text.toLowerCase();
  if ([400, 415, 422, 501].includes(Number(status)) &&
    /(image|vision|multimodal|multi-modal|modality|modalities|media|attachment)/i.test(text) &&
    UNSUPPORTED_IMAGE_HINTS.some((hint) => hint.test(text))) {
    return "vision.unsupported-image";
  }
  if (THINKING_SIGNATURE_HINTS.some((hint) => hint.test(text))) return "thinking.signature-invalid";
  if (/thinking.*budget_tokens|budget_tokens.*thinking|thinking budget|max_tokens.*thinking|thinking.*max_tokens/i.test(text)) {
    return "thinking.budget-too-small";
  }
  if (/content\[\]\.thinking|thinking mode.*passed back|thinking.*must be passed back|reasoning_content.*missing/i.test(lower)) {
    return "thinking.passback-required";
  }
  if (/tool use concurrency|tool_use.*tool_result|tool result.*tool call|tool_call_id|messages with role ['"]?tool/i.test(text)) {
    return "tool.history-invalid";
  }
  if (/json schema|schema.*(?:invalid|unsupported)|function.*parameters|tool.*schema|invalid.*tools/i.test(text)) {
    return "tool.schema-invalid";
  }
  return "";
}

export function rectifyUpstreamRequest({ apiFormat = "openai_chat", body, payload, status, ctx } = {}) {
  const errorClass = classifyCompatibilityError(payload, status);
  // OpenCode Go's DeepSeek route has occasionally returned an internal 500
  // (`Cannot read properties of undefined (reading 'text')`) for a valid but
  // rich Codex tool manifest. It is not a client-visible schema validation
  // error, so the generic classifier cannot identify it from the response.
  // Retry once with the same tools expressed through the conservative OpenAI
  // function-schema subset instead of making users choose a compat option.
  if (!errorClass && isOpenCodeGoToolManifestFailure(payload, status, body, ctx)) {
    const retryStage = Number(ctx?.runtimeRectifierAttempt || 0);
    if (retryStage > 0) {
      return actionResult(minimalOpenCodeToolManifest(body), {
        id: "opencode-go-tool-manifest-minimal",
        label: "OpenCode Go minimal tool manifest rectifier",
        errorClass: "opencode-go.tool-manifest-crash",
        changes: [
          "removed all tool and schema descriptions after the compact-manifest retry also failed",
          "preserved every tool name, parameter name, type, required field and enum"
        ]
      });
    }
    return actionResult(compactOpenCodeToolManifest(body), {
      id: "opencode-go-tool-manifest",
      label: "OpenCode Go tool manifest rectifier",
      errorClass: "opencode-go.tool-manifest-crash",
      changes: [
        "compacted function schemas to the OpenAI object/array/primitive subset",
        "removed nullable unions and unsupported composition keywords for retry"
      ]
    });
  }
  if (!errorClass) return { applied: false, errorClass: "" };

  if (errorClass === "vision.unsupported-image") {
    const { value, count } = replaceImages(body);
    if (count > 0) {
      return actionResult(value, {
        id: "media-unsupported-image",
        label: "Unsupported image fallback",
        errorClass,
        changes: [`replaced ${count} image block(s) with ${UNSUPPORTED_IMAGE_MARKER}`]
      });
    }
  }

  if (errorClass === "thinking.signature-invalid") {
    const { value, removedBlocks, removedSignatures } = removeThinkingSignatures(body);
    if (removedBlocks > 0 || removedSignatures > 0 || value.thinking !== body?.thinking) {
      return actionResult(value, {
        id: "thinking-signature",
        label: "Thinking signature rectifier",
        errorClass,
        changes: [
          `removed ${removedBlocks} thinking block(s)`,
          `removed ${removedSignatures} signature field(s)`
        ]
      });
    }
  }

  if (errorClass === "thinking.budget-too-small") {
    const value = expandThinkingBudget(body);
    return actionResult(value, {
      id: "thinking-budget",
      label: "Thinking budget rectifier",
      errorClass,
      changes: ["expanded thinking budget and max_tokens for retry"]
    });
  }

  if (errorClass === "thinking.passback-required") {
    const value = disableThinking(body);
    return actionResult(value, {
      id: "thinking-passback",
      label: "Thinking passback rectifier",
      errorClass,
      changes: ["disabled incomplete thinking state for retry"]
    });
  }

  return { applied: false, errorClass, apiFormat };
}

function actionResult(body, action) {
  return { applied: true, body, errorClass: action.errorClass, action };
}

function replaceImages(value) {
  let count = 0;
  const next = visit(value, (node) => {
    if (isImageBlock(node)) {
      count += 1;
      return { type: textTypeForImageBlock(node), text: UNSUPPORTED_IMAGE_MARKER };
    }
    return node;
  });
  return { value: next, count };
}

function isImageBlock(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  return ["image", "image_url", "input_image"].includes(node.type) ||
    Boolean(node.image_url && typeof node.image_url === "object" && node.image_url.url) ||
    Boolean(node.source?.type === "base64" && node.source?.data);
}

function textTypeForImageBlock(node) {
  return node?.type === "input_image" ? "input_text" : "text";
}

function removeThinkingSignatures(body) {
  let removedBlocks = 0;
  let removedSignatures = 0;
  const value = visit(body, (node) => {
    if (Array.isArray(node)) {
      const filtered = [];
      for (const item of node) {
        if (item?.type === "thinking" || item?.type === "redacted_thinking") {
          removedBlocks += 1;
          continue;
        }
        filtered.push(item);
      }
      return filtered;
    }
    if (node && typeof node === "object" && !Array.isArray(node) && Object.hasOwn(node, "signature")) {
      const { signature: _signature, ...rest } = node;
      removedSignatures += 1;
      return rest;
    }
    return node;
  });
  const next = { ...(value || {}) };
  if (next.thinking?.type === "enabled" && messageHistoryHasToolUseWithoutThinking(next.messages)) {
    delete next.thinking;
  }
  return { value: next, removedBlocks, removedSignatures };
}

function messageHistoryHasToolUseWithoutThinking(messages) {
  if (!Array.isArray(messages)) return false;
  const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
  if (!lastAssistant || !Array.isArray(lastAssistant.content)) return false;
  const firstType = lastAssistant.content[0]?.type;
  const missingThinkingPrefix = firstType !== "thinking" && firstType !== "redacted_thinking";
  return missingThinkingPrefix && lastAssistant.content.some((block) => block?.type === "tool_use");
}

function expandThinkingBudget(body) {
  const next = { ...(body || {}) };
  next.thinking = { ...(next.thinking && typeof next.thinking === "object" ? next.thinking : {}), type: "enabled", budget_tokens: 32000 };
  const maxTokens = Number(next.max_tokens || next.max_output_tokens || 0);
  if (!Number.isFinite(maxTokens) || maxTokens < 64000) next.max_tokens = 64000;
  return next;
}

function disableThinking(body) {
  const next = removeThinkingSignatures(body).value || { ...(body || {}) };
  if (next.thinking && typeof next.thinking === "object") next.thinking = { ...next.thinking, type: "disabled" };
  if (next.enable_thinking !== undefined) next.enable_thinking = false;
  if (next.reasoning_split !== undefined) next.reasoning_split = false;
  if (next.reasoning && typeof next.reasoning === "object") next.reasoning = { ...next.reasoning, effort: "none" };
  return next;
}

function isOpenCodeGoToolManifestFailure(payload, status, body, ctx) {
  if (!Array.isArray(body?.tools) || !body.tools.length) return false;
  if (![400, 500, 502, 503, 504].includes(Number(status))) return false;
  const provider = String(ctx?.provider?.id || "").toLowerCase();
  const model = [
    ctx?.model?.id,
    ctx?.model?.providerId,
    ctx?.model?.upstreamModel
  ].filter(Boolean).join(" ").toLowerCase();
  if (provider !== "opencode-go" && !/\bopencode\b/.test(model)) return false;
  // OpenCode Go has returned both a concrete internal exception and the
  // generic Console Go wrapper error for the same malformed/oversized tool
  // manifest path. Restrict the generic signature to requests that actually
  // carry tools, then retry once with the compact fallback below.
  return /cannot read properties of undefined \(reading ['"]text['"]\)|error from provider \(console go\): upstream request failed|upstream request failed/i
    .test(errorText(payload));
}

function compactOpenCodeToolManifest(body) {
  return {
    ...body,
    tools: body.tools.map((tool) => {
      const fn = tool?.function || tool || {};
      const name = String(fn.name || tool?.name || "tool").trim() || "tool";
      const description = typeof fn.description === "string"
        ? fn.description.slice(0, 480)
        : "";
      return {
        type: "function",
        function: {
          name,
          description,
          parameters: compactOpenCodeSchema(fn.parameters || tool?.parameters)
        }
      };
    })
  };
}

function compactOpenCodeSchema(raw) {
  const schema = isPlainObject(raw) ? raw : {};
  const variant = firstConcreteSchemaVariant(schema);
  const source = variant ? { ...variant, ...schema } : schema;
  const type = concreteSchemaType(source);
  const description = typeof source.description === "string" ? source.description.slice(0, 240) : "";

  if (type === "object" || (!type && isPlainObject(source.properties))) {
    const properties = {};
    for (const [name, property] of Object.entries(source.properties || {})) {
      properties[name] = compactOpenCodeSchema(property);
    }
    const out = { type: "object", properties };
    if (description) out.description = description;
    const required = Array.isArray(source.required)
      ? source.required.filter((name) => typeof name === "string" && Object.hasOwn(properties, name))
      : [];
    if (required.length) out.required = required;
    // A schema-valued additionalProperties is one of the JSON Schema forms
    // that strict proxy implementations commonly mishandle. The fallback is
    // intentionally conservative and only runs after the upstream has failed.
    out.additionalProperties = false;
    return out;
  }

  if (type === "array") {
    const items = Array.isArray(source.items)
      ? source.items.find((item) => isPlainObject(item))
      : source.items;
    const out = {
      type: "array",
      items: compactOpenCodeSchema(items)
    };
    if (description) out.description = description;
    return out;
  }

  const out = { type: type || "string" };
  if (description) out.description = description;
  if (Array.isArray(source.enum)) {
    const values = source.enum.filter((value) => value != null && ["string", "number", "boolean"].includes(typeof value));
    if (values.length) out.enum = values;
  }
  return out;
}

function minimalOpenCodeToolManifest(body) {
  return {
    ...body,
    tools: body.tools.map((tool) => {
      const fn = tool?.function || tool || {};
      const name = String(fn.name || tool?.name || "tool").trim() || "tool";
      return {
        type: "function",
        function: {
          name,
          parameters: minimalOpenCodeSchema(fn.parameters || tool?.parameters)
        }
      };
    })
  };
}

function minimalOpenCodeSchema(raw) {
  const schema = isPlainObject(raw) ? raw : {};
  const variant = firstConcreteSchemaVariant(schema);
  const source = variant ? { ...variant, ...schema } : schema;
  const type = concreteSchemaType(source);

  if (type === "object" || (!type && isPlainObject(source.properties))) {
    const properties = {};
    for (const [name, property] of Object.entries(source.properties || {})) {
      properties[name] = minimalOpenCodeSchema(property);
    }
    const out = { type: "object", properties, additionalProperties: false };
    const required = Array.isArray(source.required)
      ? source.required.filter((name) => typeof name === "string" && Object.hasOwn(properties, name))
      : [];
    if (required.length) out.required = required;
    return out;
  }

  if (type === "array") {
    const items = Array.isArray(source.items)
      ? source.items.find((item) => isPlainObject(item))
      : source.items;
    return { type: "array", items: minimalOpenCodeSchema(items) };
  }

  const out = { type: type || "string" };
  if (Array.isArray(source.enum)) {
    const values = source.enum.filter((value) => value != null && ["string", "number", "boolean"].includes(typeof value));
    if (values.length) out.enum = values;
  }
  return out;
}

function firstConcreteSchemaVariant(schema) {
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (!Array.isArray(schema?.[key])) continue;
    const match = schema[key].find((candidate) => {
      if (!isPlainObject(candidate)) return false;
      const type = concreteSchemaType(candidate);
      return Boolean(type || candidate.properties || candidate.items);
    });
    if (match) return match;
  }
  return null;
}

function concreteSchemaType(schema) {
  const raw = schema?.type;
  if (typeof raw === "string") return raw === "null" ? "" : raw;
  if (Array.isArray(raw)) {
    return raw.find((type) => typeof type === "string" && type !== "null") || "";
  }
  if (isPlainObject(schema?.properties)) return "object";
  if (schema?.items !== undefined) return "array";
  return "";
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function visit(value, visitor) {
  const visited = visitor(value);
  if (visited !== value) return visitChildren(visited, visitor);
  return visitChildren(value, visitor);
}

function visitChildren(value, visitor) {
  if (Array.isArray(value)) return value.map((item) => visit(item, visitor));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = visit(item, visitor);
  return out;
}

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

export function rectifyUpstreamRequest({ apiFormat = "openai_chat", body, payload, status } = {}) {
  const errorClass = classifyCompatibilityError(payload, status);
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

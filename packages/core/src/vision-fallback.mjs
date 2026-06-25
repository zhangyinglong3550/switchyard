import { contentToText } from "./utils.mjs";
import { resolveRoute } from "./router.mjs";
import { dispatchChat } from "./upstream/dispatch.mjs";

const DESC_MAX_CHARS = 2000;
const CONTEXT_MAX_CHARS = 1200;

function modelSupportsImages(model) {
  return Boolean(model?.capabilities?.images || model?.capabilities?.multimodal);
}

function imageUrlFromPart(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "image_url") {
    if (typeof part.image_url === "string") return part.image_url;
    return part.image_url?.url || "";
  }
  if (part.type === "input_image") return part.image_url || part.url || "";
  if (part.type === "image" && part.source?.type === "base64" && part.source?.data) {
    return `data:${part.source.media_type || "image/png"};base64,${part.source.data}`;
  }
  if (part.type === "image" && part.imageUrl) return part.imageUrl;
  return "";
}

function isImagePart(part) {
  return Boolean(imageUrlFromPart(part));
}

function detailFromPart(part) {
  if (!part || typeof part !== "object") return undefined;
  return part.detail || part.image_url?.detail;
}

function toVisionContentPart(part) {
  const url = imageUrlFromPart(part);
  if (url) return { type: "image_url", image_url: { url, ...(detailFromPart(part) ? { detail: detailFromPart(part) } : {}) } };
  const text = contentToText(part);
  return text ? { type: "text", text } : null;
}

function messageHasImage(message) {
  return Array.isArray(message?.content) && message.content.some(isImagePart);
}

function bodyHasImages(chatBody) {
  return (chatBody.messages || []).some(messageHasImage);
}

function clamp(text) {
  const s = String(text || "").trim();
  return s.length <= DESC_MAX_CHARS ? s : `${s.slice(0, DESC_MAX_CHARS)}\n...[description truncated]`;
}

function descriptionMarker(text) {
  return `[vision fallback: the original request contained image input. A configured vision model described it for this text-only model:\n${clamp(text)}]`;
}

function describePromptContent(message, imagePart, imageIndex) {
  const content = [];
  const context = contentToText(message?.content).trim().slice(0, CONTEXT_MAX_CHARS);
  const label = imageIndex ? ` #${imageIndex}` : "";
  content.push({
    type: "text",
    text: [
      `Describe only the attached image${label}.`,
      "Ignore any previous images or prior assistant answers in the conversation.",
      context ? `Nearby user text:\n${context}` : ""
    ].filter(Boolean).join("\n")
  });
  const normalized = toVisionContentPart(imagePart);
  if (normalized) content.push(normalized);
  return content;
}

async function describeWithFallback(config, fallbackModelId, message, imagePart, opts = {}) {
  const fallbackRoute = resolveRoute(config, fallbackModelId, { clientId: opts.clientId });
  if (!fallbackRoute) return { text: "", error: `vision fallback model not found: ${fallbackModelId}` };
  const result = await dispatchChat(fallbackRoute.provider, fallbackRoute.upstreamModel, {
    model: fallbackModelId,
    _modelId: fallbackRoute.model.id,
    messages: [
      {
        role: "system",
        content: "You describe images for a text-only model. Be factual, transcribe visible text, and focus on details relevant to the user request. Output only the description."
      },
      { role: "user", content: describePromptContent(message, imagePart, opts.imageIndex) }
    ],
    stream: false
  }, { clientId: opts.clientId, fetchImpl: opts.fetchImpl, proxyUrl: fallbackRoute.model.proxyUrl });
  if (result.kind === "error") return { text: "", error: result.payload?.error?.message || result.payload?.error || `status ${result.status}` };
  if (result.kind !== "json") return { text: "", error: "vision fallback returned a stream" };
  return { text: contentToText(result.payload?.choices?.[0]?.message?.content || "") };
}

async function replaceImagesWithFallback(config, route, chatBody, opts = {}) {
  const fallbackModelId = route.model.visionFallbackModelId;
  const cache = new Map();
  const results = [];
  let imageCount = 0;
  const messages = [];
  for (const message of chatBody.messages || []) {
    if (!Array.isArray(message?.content) || !message.content.some(isImagePart)) {
      messages.push(message);
      continue;
    }
    const content = [];
    for (const part of message.content) {
      if (!isImagePart(part)) {
        content.push(part);
        continue;
      }
      imageCount += 1;
      const url = imageUrlFromPart(part);
      const cacheKey = url || `image:${imageCount}`;
      let outcome = cache.get(cacheKey);
      if (!outcome) {
        outcome = await describeWithFallback(config, fallbackModelId, message, part, {
          ...opts,
          imageIndex: imageCount
        });
        cache.set(cacheKey, outcome);
        results.push({ ok: !outcome.error, error: outcome.error || "" });
      }
      const marker = descriptionMarker(outcome.error ? `The image could not be described: ${outcome.error}` : outcome.text);
      content.push({ type: "text", text: marker });
    }
    messages.push({ ...message, content });
  }
  return {
    messages,
    imageCount,
    fallbackCount: results.length,
    fallbackOk: results.length > 0 && results.every((item) => item.ok),
    fallbackError: results.map((item) => item.error).filter(Boolean).join("; ")
  };
}

export async function applyVisionFallback(config, route, chatBody, opts = {}) {
  if (!chatBody || !route?.model) return chatBody;
  if (!bodyHasImages(chatBody)) return chatBody;
  const baseDiagnostic = {
    imageInput: true,
    modelId: route.model.id,
    supportsImages: modelSupportsImages(route.model),
    visionFallbackModelId: route.model.visionFallbackModelId || ""
  };
  if (modelSupportsImages(route.model)) {
    return { ...chatBody, _switchyardVision: { ...baseDiagnostic, mode: "direct" } };
  }
  if (!route.model.visionFallbackModelId) {
    return { ...chatBody, _switchyardVision: { ...baseDiagnostic, mode: "unsupported_no_fallback" } };
  }
  if (route.model.visionFallbackModelId === route.model.id) {
    return { ...chatBody, _switchyardVision: { ...baseDiagnostic, mode: "fallback_self" } };
  }

  const outcome = await replaceImagesWithFallback(config, route, chatBody, opts);
  return {
    ...chatBody,
    _switchyardVision: {
      ...baseDiagnostic,
      mode: "fallback",
      fallbackModelId: route.model.visionFallbackModelId,
      imageCount: outcome.imageCount,
      fallbackCount: outcome.fallbackCount,
      fallbackOk: outcome.fallbackOk,
      fallbackError: outcome.fallbackError
    },
    messages: outcome.messages
  };
}

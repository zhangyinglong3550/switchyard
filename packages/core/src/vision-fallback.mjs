import crypto from "node:crypto";
import { contentToText } from "./utils.mjs";
import { resolveRoute } from "./router.mjs";
import { dispatchChat } from "./upstream/dispatch.mjs";
import { applyUsageToRequestRecord } from "./stream-usage.mjs";

const DESC_MAX_CHARS = 6000;
const CONTEXT_MAX_CHARS = 1200;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;
// ponytail: process-local LRU; persist to disk if gateway restarts drop too much
const descCache = new Map();

export function modelNativelySupportsImages(model) {
  return Boolean(model?.capabilities?.images || model?.capabilities?.multimodal);
}

export function visionFallbackModelIds(model) {
  const ids = [];
  const primary = String(model?.visionFallbackModelId || "").trim();
  if (primary) ids.push(primary);
  for (const item of model?.visionFallbackModelIds || []) {
    const id = String(item || "").trim();
    if (id) ids.push(id);
  }
  const self = String(model?.id || "").trim();
  return [...new Set(ids)].filter((id) => id && id !== self);
}

export function hasVisionFallback(model) {
  return visionFallbackModelIds(model).length > 0;
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

function imageCacheKey(url) {
  const raw = String(url || "");
  if (!raw) return "";
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function cacheGet(store, key) {
  if (!key) return null;
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    store.delete(key);
    return null;
  }
  store.delete(key);
  store.set(key, hit);
  return hit.text;
}

function cacheSet(store, key, text) {
  if (!key || !text) return;
  if (store.size >= CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { text, expires: Date.now() + CACHE_TTL_MS });
}

function nearbyUserText(message) {
  return contentToText(message?.content).trim().slice(0, CONTEXT_MAX_CHARS);
}

function describePromptContent(message, imagePart, imageIndex) {
  const content = [];
  const label = imageIndex ? ` #${imageIndex}` : "";
  content.push({
    type: "text",
    text: [
      `Describe only the attached image${label}.`,
      "Be factual. Transcribe visible text. Ignore previous images and prior assistant answers.",
      "Output only the description."
    ].join("\n")
  });
  const normalized = toVisionContentPart(imagePart);
  if (normalized) content.push(normalized);
  return content;
}

function emitVisionEyeLog(config, opts, {
  fallbackModelId,
  fallbackRoute,
  text = "",
  error = "",
  status = 200,
  ms = 0,
  cacheHit = false,
  usage = null
} = {}) {
  if (typeof opts.emit !== "function") return;
  const route = fallbackRoute || resolveRoute(config, fallbackModelId, { clientId: opts.clientId });
  const record = {
    level: "info",
    msg: "request",
    requestLog: true,
    method: "POST",
    path: "/vision-fallback",
    clientId: opts.clientId || null,
    requestedModel: fallbackModelId,
    modelId: route?.model?.id || fallbackModelId,
    providerId: route?.provider?.id || "",
    upstreamModel: route?.upstreamModel || "",
    apiFormat: route?.provider?.apiFormat || "",
    status: error ? (status || 502) : 200,
    ms,
    promptPreview: cacheHit
      ? `[vision fallback cache] ${opts.parentModelId || ""}`
      : `Describe image for ${opts.parentModelId || "text-only model"}`,
    responsePreview: String(text || error || "").slice(0, 600),
    requestSummary: {
      protocol: "vision_fallback",
      parentModelId: opts.parentModelId || "",
      cacheHit: Boolean(cacheHit)
    },
    error: error || null
  };
  if (usage) applyUsageToRequestRecord(record, usage);
  opts.emit(record);
}

async function describeWithOneModel(config, fallbackModelId, message, imagePart, opts = {}) {
  const fallbackRoute = resolveRoute(config, fallbackModelId, { clientId: opts.clientId });
  if (!fallbackRoute) {
    const error = `vision fallback model not found: ${fallbackModelId}`;
    emitVisionEyeLog(config, opts, { fallbackModelId, error, status: 400 });
    return { text: "", error };
  }
  const question = nearbyUserText(message);
  const started = Date.now();
  const result = await dispatchChat(fallbackRoute.provider, fallbackRoute.upstreamModel, {
    model: fallbackModelId,
    _modelId: fallbackRoute.model.id,
    messages: [
      {
        role: "system",
        content: [
          "You describe images for a text-only model.",
          question ? `The user's current question:\n${question}` : ""
        ].filter(Boolean).join("\n")
      },
      { role: "user", content: describePromptContent(message, imagePart, opts.imageIndex) }
    ],
    stream: false
  }, { clientId: opts.clientId, fetchImpl: opts.fetchImpl, proxyUrl: fallbackRoute.model.proxyUrl, retry: { enabled: false } });
  const ms = Date.now() - started;
  if (result.kind === "error") {
    const error = result.payload?.error?.message || result.payload?.error || `status ${result.status}`;
    emitVisionEyeLog(config, opts, { fallbackModelId, fallbackRoute, error, status: result.status || 502, ms, usage: result.payload?.usage });
    return { text: "", error, status: result.status };
  }
  if (result.kind !== "json") {
    const error = "vision fallback returned a stream";
    emitVisionEyeLog(config, opts, { fallbackModelId, fallbackRoute, error, status: 502, ms });
    return { text: "", error };
  }
  const text = contentToText(result.payload?.choices?.[0]?.message?.content || "").trim();
  if (!text) {
    const error = `vision fallback ${fallbackModelId} returned empty description`;
    emitVisionEyeLog(config, opts, { fallbackModelId, fallbackRoute, error, status: 502, ms, usage: result.payload?.usage });
    return { text: "", error };
  }
  emitVisionEyeLog(config, opts, { fallbackModelId, fallbackRoute, text, ms, usage: result.payload?.usage });
  return { text };
}

async function describeWithFallbackChain(config, fallbackIds, message, imagePart, opts = {}) {
  const errors = [];
  for (const fallbackModelId of fallbackIds) {
    const outcome = await describeWithOneModel(config, fallbackModelId, message, imagePart, opts);
    if (outcome.text) return { text: outcome.text, fallbackModelId, tried: [...errors.map((item) => item.modelId), fallbackModelId] };
    errors.push({ modelId: fallbackModelId, error: outcome.error || "unknown error", status: outcome.status });
  }
  return {
    text: "",
    error: errors.map((item) => `${item.modelId}: ${item.error}`).join("; ") || "no vision fallback model",
    tried: errors.map((item) => item.modelId)
  };
}

async function replaceImagesWithFallback(config, route, chatBody, opts = {}) {
  const fallbackIds = visionFallbackModelIds(route.model);
  const requestCache = new Map();
  const store = opts.descCache || descCache;
  const results = [];
  let imageCount = 0;
  let usedFallbackModelId = fallbackIds[0] || "";
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
      const cacheKey = imageCacheKey(url) || `image:${imageCount}`;
      let outcome = requestCache.get(cacheKey);
      if (!outcome) {
        const cachedText = cacheGet(store, cacheKey);
        if (cachedText) {
          outcome = { text: cachedText, fallbackModelId: usedFallbackModelId, cacheHit: true };
          emitVisionEyeLog(config, opts, { fallbackModelId: usedFallbackModelId, text: cachedText, cacheHit: true });
        } else {
          outcome = await describeWithFallbackChain(config, fallbackIds, message, part, {
            ...opts,
            imageIndex: imageCount
          });
          if (outcome.text) cacheSet(store, cacheKey, outcome.text);
        }
        requestCache.set(cacheKey, outcome);
        results.push({
          ok: Boolean(outcome.text),
          error: outcome.error || "",
          fallbackModelId: outcome.fallbackModelId || "",
          cacheHit: Boolean(outcome.cacheHit)
        });
        if (outcome.fallbackModelId) usedFallbackModelId = outcome.fallbackModelId;
      }
      const marker = descriptionMarker(outcome.text || `The image could not be described: ${outcome.error || "unknown error"}`);
      content.push({ type: "text", text: marker });
    }
    messages.push({ ...message, content });
  }
  return {
    messages,
    imageCount,
    fallbackCount: results.length,
    fallbackOk: results.length > 0 && results.every((item) => item.ok),
    fallbackError: results.map((item) => item.error).filter(Boolean).join("; "),
    fallbackModelId: usedFallbackModelId,
    cacheHits: results.filter((item) => item.cacheHit).length
  };
}

export async function applyVisionFallback(config, route, chatBody, opts = {}) {
  if (!chatBody || !route?.model) return chatBody;
  if (!bodyHasImages(chatBody)) return chatBody;
  const fallbackIds = visionFallbackModelIds(route.model);
  const baseDiagnostic = {
    imageInput: true,
    modelId: route.model.id,
    supportsImages: modelNativelySupportsImages(route.model),
    visionFallbackModelId: fallbackIds[0] || ""
  };
  if (modelNativelySupportsImages(route.model)) {
    return { ...chatBody, _switchyardVision: { ...baseDiagnostic, mode: "direct" } };
  }
  if (!fallbackIds.length) {
    const raw = String(route.model.visionFallbackModelId || "").trim();
    if (raw && raw === String(route.model.id || "").trim()) {
      return { ...chatBody, _switchyardVision: { ...baseDiagnostic, mode: "fallback_self" } };
    }
    return { ...chatBody, _switchyardVision: { ...baseDiagnostic, mode: "unsupported_no_fallback" } };
  }

  const outcome = await replaceImagesWithFallback(config, route, chatBody, {
    ...opts,
    parentModelId: route.model.id
  });
  return {
    ...chatBody,
    _switchyardVision: {
      ...baseDiagnostic,
      mode: "fallback",
      fallbackModelId: outcome.fallbackModelId,
      imageCount: outcome.imageCount,
      fallbackCount: outcome.fallbackCount,
      fallbackOk: outcome.fallbackOk,
      fallbackError: outcome.fallbackError,
      cacheHits: outcome.cacheHits
    },
    messages: outcome.messages
  };
}

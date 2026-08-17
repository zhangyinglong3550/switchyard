import { cursorSubscriptionKeychainAccount } from "./auth.mjs";

export const CURSOR_SUBSCRIPTION_API_FORMAT = "cursor_subscription";
export const CURSOR_SUBSCRIPTION_LEGACY_BASE_URL = "https://agent.api5.cursor.sh";
export const CURSOR_SUBSCRIPTION_DEFAULT_BASE_URL = "https://agentn.api5.cursor.sh";
export const CURSOR_SUBSCRIPTION_DEFAULT_UPSTREAM_MODEL = "default";
export const CURSOR_SUBSCRIPTION_DEFAULT_IDLE_TIMEOUT_MS = 90000;
export const CURSOR_SUBSCRIPTION_DEFAULT_CONCURRENCY = 2;
export const CURSOR_SUBSCRIPTION_MAX_CONCURRENCY = 3;

export class CursorSubscriptionRequestError extends Error {
  constructor(message, code = "CURSOR_SUBSCRIPTION_UNSUPPORTED_REQUEST") {
    super(message);
    this.name = "CursorSubscriptionRequestError";
    this.code = code;
  }
}

export function isCursorSubscriptionProvider(provider) {
  return provider?.providerType === "cursor_subscription" || provider?.apiFormat === CURSOR_SUBSCRIPTION_API_FORMAT;
}

function assertSafeBaseUrl(baseUrl) {
  const url = new URL(String(baseUrl || CURSOR_SUBSCRIPTION_DEFAULT_BASE_URL));
  if (url.protocol !== "https:" || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]|::1)$/i.test(url.hostname)) {
    throw new Error("Cursor 订阅桥接上游必须使用 HTTPS Cursor 地址，不支持本地或远程自定义转发地址");
  }
  if (!/(^|\.)cursor\.sh$/i.test(url.hostname)) {
    throw new Error("Cursor 订阅桥接上游仅允许 Cursor 官方域名");
  }
  return url.origin;
}

export function normalizeCursorSubscriptionProvider(provider = {}) {
  const id = String(provider.id || "cursor-subscription").trim() || "cursor-subscription";
  // Cursor's current desktop client uses the non-privacy Agent endpoint.  The
  // former agent.api5 host is kept only as a migration input: it no longer
  // accepts the current desktop client's request contract reliably.
  const requestedBaseUrl = provider.baseUrl === CURSOR_SUBSCRIPTION_LEGACY_BASE_URL
    ? CURSOR_SUBSCRIPTION_DEFAULT_BASE_URL
    : (provider.baseUrl || CURSOR_SUBSCRIPTION_DEFAULT_BASE_URL);
  const baseUrl = assertSafeBaseUrl(requestedBaseUrl);
  // 账号池形态（authMode=account_pool + poolKind=cursor_subscription）保留原样，
  // 只有单账号桥接形态才落到 keychain。
  const isPoolForm = provider?.authMode === "account_pool" || provider?.providerType === "account_pool" || provider?.poolKind === "cursor_subscription";
  const normalized = {
    ...provider,
    id,
    name: provider.name || "Cursor 订阅桥接",
    providerType: "cursor_subscription",
    apiFormat: CURSOR_SUBSCRIPTION_API_FORMAT,
    authMode: isPoolForm ? "account_pool" : "keychain",
    poolKind: isPoolForm ? (provider.poolKind || "cursor_subscription") : provider.poolKind,
    keychainAccount: cursorSubscriptionKeychainAccount({ ...provider, id }),
    baseUrl,
    enabled: isPoolForm ? provider.enabled !== false : provider.enabled === true,
    maxConcurrentRequests: Math.min(
      CURSOR_SUBSCRIPTION_MAX_CONCURRENCY,
      Math.max(1, Math.floor(Number(provider.maxConcurrentRequests) || CURSOR_SUBSCRIPTION_DEFAULT_CONCURRENCY))
    ),
    streamIdleTimeoutMs: Number(provider.streamIdleTimeoutMs) > 0
      ? Number(provider.streamIdleTimeoutMs)
      : CURSOR_SUBSCRIPTION_DEFAULT_IDLE_TIMEOUT_MS
  };
  delete normalized.accessToken;
  delete normalized.machineId;
  delete normalized.apiKey;
  return normalized;
}



export function assertCursorSubscriptionRequest(body = {}) {
  // 仅做结构校验：不支持的内容（图片/非 function 工具等）由编码层降级处理
  // （图片→占位文本、非 function 工具→过滤），不再逐个内容类型拒绝，避免
  // DeepSeek 等客户端带 thinking/图片历史时被误杀。
  if (!body || typeof body !== "object") {
    throw new CursorSubscriptionRequestError("Cursor 订阅请求必须是 JSON 对象");
  }
  if ((body.messages || []).some((m) => !m || typeof m !== "object" || typeof m.role !== "string")) {
    throw new CursorSubscriptionRequestError("Cursor 订阅消息缺少 role");
  }
  return true;
}

export function resolveCursorSubscriptionModel(model) {
  const requested = String(model || "").trim();
  // `auto` is Switchyard's public catalog alias. Cursor's AgentService
  // expects its concrete default model identifier instead.
  return !requested || requested === "auto"
    ? CURSOR_SUBSCRIPTION_DEFAULT_UPSTREAM_MODEL
    : canonicalCursorSubscriptionModelId(requested);
}

// Cursor Agent CLI lists every combination of a model, reasoning setting and
// acceleration as a separate ID (for example
// `cursor-grok-4.5-medium-fast`). They are picker variants, not independent
// models. Switchyard exposes one canonical model and lets the Agent send
// reasoning/speed choices as parameters.
const CURSOR_MODEL_VARIANT_SUFFIX_RE = /-(?:none|minimal|low|medium|high|xhigh|max|extra-high|thinking|fast)$/i;
const CURSOR_DISPLAY_VARIANT_SUFFIX_RE = /\s+(?:none|minimal|low|medium|high|extra high|max|thinking|fast|priority)(?:\s+(?:none|minimal|low|medium|high|extra high|max|thinking|fast|priority))*\s*$/i;

export function canonicalCursorSubscriptionModelId(value) {
  let id = String(value || "").trim();
  if (!id || id === "auto" || id === "default") return id || "auto";
  while (CURSOR_MODEL_VARIANT_SUFFIX_RE.test(id)) {
    id = id.replace(CURSOR_MODEL_VARIANT_SUFFIX_RE, "");
  }
  // The CLI calls this model `cursor-grok-4.5`, while Cursor Desktop's
  // model-picker/API identity is `grok-4.5`.
  if (/^cursor-grok-/i.test(id)) id = id.slice("cursor-".length);
  return id || String(value || "").trim();
}

export function cursorSubscriptionDisplayName(value, fallback = "") {
  const name = String(value || fallback || "").trim();
  const normalized = name.replace(CURSOR_DISPLAY_VARIANT_SUFFIX_RE, "").trim();
  return normalized || name;
}

function mergeCursorCatalogCapabilities(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right || {})) {
    merged[key] = Boolean(merged[key] || value);
  }
  return merged;
}

/**
 * Reduces Cursor's CLI variant matrix to one selectable model per base model.
 * `aliases` retains every legacy raw ID so existing Switchyard configuration
 * continues to resolve after the migration.
 */
export function collapseCursorSubscriptionModelCatalog(models = []) {
  const output = [];
  const byId = new Map();
  for (const item of models || []) {
    const rawId = String(item?.id || item?.upstreamModel || "").trim();
    if (!rawId) continue;
    const id = canonicalCursorSubscriptionModelId(rawId);
    const next = {
      ...item,
      id,
      upstreamModel: id,
      displayName: cursorSubscriptionDisplayName(item?.displayName, id),
      aliases: Array.from(new Set([...(item?.aliases || []), rawId, item?.upstreamModel].filter(Boolean)))
    };
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, next);
      output.push(next);
      continue;
    }
    existing.aliases = Array.from(new Set([...(existing.aliases || []), ...(next.aliases || [])].filter(Boolean)));
    existing.capabilities = mergeCursorCatalogCapabilities(existing.capabilities, next.capabilities);
    if (!existing.contextWindow && next.contextWindow) existing.contextWindow = next.contextWindow;
    if (!existing.maxOutputTokens && next.maxOutputTokens) existing.maxOutputTokens = next.maxOutputTokens;
  }
  return output;
}

// Cursor AgentService does not expose an OpenAI-compatible /models endpoint. These
// are the current Cursor Desktop model identifiers, kept deliberately small so the
// UI never offers historical migration-only IDs that are likely to be rejected.
const CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES = {
  text: true,
  stream: true,
  tools: true,
  reasoning: true,
  images: false,
  multimodal: false
};

export const CURSOR_SUBSCRIPTION_STATIC_MODELS = [
  { id: "auto", displayName: "Auto", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "grok-4.5", displayName: "Cursor Grok 4.5", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "composer-2.5", displayName: "Composer 2.5", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "claude-opus-5", displayName: "Opus 5", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "claude-fable-5", displayName: "Fable 5", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "claude-sonnet-5", displayName: "Sonnet 5", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", capabilities: CURSOR_SUBSCRIPTION_MODEL_CAPABILITIES }
];

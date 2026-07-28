import { cursorSubscriptionKeychainAccount } from "./auth.mjs";

export const CURSOR_SUBSCRIPTION_API_FORMAT = "cursor_subscription";
export const CURSOR_SUBSCRIPTION_DEFAULT_BASE_URL = "https://agent.api5.cursor.sh";
export const CURSOR_SUBSCRIPTION_DEFAULT_IDLE_TIMEOUT_MS = 600000;

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
  const baseUrl = assertSafeBaseUrl(provider.baseUrl || CURSOR_SUBSCRIPTION_DEFAULT_BASE_URL);
  const normalized = {
    ...provider,
    id,
    name: provider.name || "Cursor 订阅桥接（实验性）",
    providerType: "cursor_subscription",
    apiFormat: CURSOR_SUBSCRIPTION_API_FORMAT,
    authMode: "keychain",
    keychainAccount: cursorSubscriptionKeychainAccount({ ...provider, id }),
    baseUrl,
    enabled: provider.enabled === true,
    maxConcurrentRequests: 1,
    streamIdleTimeoutMs: Number(provider.streamIdleTimeoutMs) > 0
      ? Number(provider.streamIdleTimeoutMs)
      : CURSOR_SUBSCRIPTION_DEFAULT_IDLE_TIMEOUT_MS
  };
  delete normalized.accessToken;
  delete normalized.machineId;
  delete normalized.apiKey;
  return normalized;
}

function contentIsText(content) {
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.every((part) => part && part.type === "text" && typeof part.text === "string");
}

export function assertCursorSubscriptionRequest(body = {}) {
  if (Array.isArray(body.tools) && body.tools.length) {
    throw new CursorSubscriptionRequestError("Cursor 订阅桥接第一版不支持工具调用");
  }
  for (const message of body.messages || []) {
    if (!message || !["system", "user", "assistant"].includes(message.role) || !contentIsText(message.content) ||
      (Array.isArray(message.tool_calls) && message.tool_calls.length)) {
      throw new CursorSubscriptionRequestError("Cursor 订阅桥接第一版仅支持纯文本 system/user/assistant 对话");
    }
  }
  return true;
}

export const CURSOR_SUBSCRIPTION_STATIC_MODELS = [
  { id: "auto", displayName: "Cursor Auto", capabilities: { text: true, stream: true, tools: false, images: false, multimodal: false } }
];

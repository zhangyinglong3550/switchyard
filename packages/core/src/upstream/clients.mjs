// Upstream clients keyed by provider.apiFormat. Each function speaks the
// upstream-native wire format, so that callers can stay protocol-agnostic.
import { localEndpoint, safeJsonParse } from "../utils.mjs";

export function resolveApiKey(provider) {
  if (provider?.apiKey) return provider.apiKey;
  if (provider?.apiKeyEnv) return process.env[provider.apiKeyEnv] || "";
  return "";
}

function authHeader(provider, scheme) {
  const key = resolveApiKey(provider);
  if (!key) return {};
  if (scheme === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { Authorization: `Bearer ${key}` };
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

async function postJson(url, body, headers, { signal, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: body && body.stream ? "text/event-stream" : "application/json", ...headers },
    body: JSON.stringify(body),
    signal
  };
  try {
    return await doFetch(url, init);
  } catch (err) {
    if (!localEndpoint(url)) throw err;
    return await doFetch(url, init);
  }
}

export async function callOpenAIChat(provider, body, opts) {
  const url = joinUrl(provider.baseUrl, "/chat/completions");
  return postJson(url, body, authHeader(provider, "bearer"), opts);
}

export async function callOpenAIResponses(provider, body, opts) {
  const url = joinUrl(provider.baseUrl, "/responses");
  return postJson(url, body, authHeader(provider, "bearer"), opts);
}

export async function callAnthropicMessages(provider, body, opts) {
  const url = joinUrl(provider.baseUrl, "/v1/messages");
  return postJson(url, body, authHeader(provider, "anthropic"), opts);
}

export function providerReady(provider) {
  if (!provider?.baseUrl) return false;
  if (provider.apiKey) return true;
  if (!provider.apiKeyEnv) return true;
  return Boolean(process.env[provider.apiKeyEnv]);
}

export async function readJsonResponse(res) {
  const text = await res.text();
  return safeJsonParse(text, { error: text });
}

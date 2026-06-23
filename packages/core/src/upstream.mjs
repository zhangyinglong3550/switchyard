// Outbound request handling. Reads API key from inline value or env var.
import { localEndpoint } from "./utils.mjs";

export function resolveApiKey(provider) {
  if (provider?.apiKey) return provider.apiKey;
  if (provider?.apiKeyEnv) return process.env[provider.apiKeyEnv] || "";
  return "";
}

function authHeader(provider) {
  const key = resolveApiKey(provider);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${suffix}`;
}

export async function fetchChatCompletion(provider, body, { signal, fetchImpl } = {}) {
  const url = joinUrl(provider.baseUrl, "/chat/completions");
  const headers = {
    "Content-Type": "application/json",
    Accept: body && body.stream ? "text/event-stream" : "application/json",
    ...authHeader(provider),
    ...(localEndpoint(url) ? { Connection: "close" } : {})
  };
  const doFetch = fetchImpl || globalThis.fetch;
  try {
    return await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (!localEndpoint(url)) throw err;
    return await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  }
}

export function providerReady(provider) {
  if (!provider?.baseUrl) return false;
  if (provider.apiKey) return true;
  if (!provider.apiKeyEnv) return true;
  return Boolean(process.env[provider.apiKeyEnv]);
}

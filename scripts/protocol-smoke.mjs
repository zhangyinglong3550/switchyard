#!/usr/bin/env node
// Optional live protocol smoke checks. This is intentionally opt-in: it never
// calls a provider unless both a gateway URL and model are supplied explicitly.

import { pathToFileURL } from "node:url";

function trimUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function readProtocolSmokeConfig(env = process.env) {
  const baseUrl = trimUrl(env.SWITCHYARD_PROTOCOL_SMOKE_URL);
  const model = String(env.SWITCHYARD_PROTOCOL_SMOKE_MODEL || "").trim();
  const token = String(env.SWITCHYARD_PROTOCOL_SMOKE_TOKEN || "").trim();
  if (!baseUrl) return { ready: false, reason: "Set SWITCHYARD_PROTOCOL_SMOKE_URL to opt in." };
  if (!model) return { ready: false, reason: "Set SWITCHYARD_PROTOCOL_SMOKE_MODEL to opt in." };
  return { ready: true, baseUrl, model, token };
}

function requestHeaders(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function jsonRequest(config, path, body) {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: requestHeaders(config.token),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 500) }; }
  return { status: response.status, ok: response.ok, payload };
}

async function streamRequest(config, body) {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: requestHeaders(config.token),
    body: JSON.stringify({ ...body, stream: true })
  });
  const text = await response.text();
  return { status: response.status, ok: response.ok, text };
}

function outcome(id, passed, detail = "") {
  return { id, passed: Boolean(passed), detail: String(detail || "") };
}

export async function runProtocolSmoke(config) {
  const cases = [];
  const health = await fetch(`${config.baseUrl}/health`, { headers: config.token ? { Authorization: `Bearer ${config.token}` } : {} });
  cases.push(outcome("health", health.ok, `HTTP ${health.status}`));

  const text = await jsonRequest(config, "/v1/chat/completions", {
    model: config.model,
    messages: [{ role: "user", content: "Reply with exactly: switchyard-smoke" }],
    max_tokens: 32
  });
  cases.push(outcome("text", text.ok && Boolean(text.payload?.choices?.[0]?.message), `HTTP ${text.status}`));

  const tools = await jsonRequest(config, "/v1/chat/completions", {
    model: config.model,
    messages: [{ role: "user", content: "Call the smoke_echo tool once with value switchyard." }],
    tools: [{ type: "function", function: { name: "smoke_echo", description: "Echo a value for protocol smoke testing.", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } } }],
    tool_choice: { type: "function", function: { name: "smoke_echo" } },
    max_tokens: 64
  });
  cases.push(outcome("tools", tools.ok && Array.isArray(tools.payload?.choices?.[0]?.message?.tool_calls), `HTTP ${tools.status}`));

  const reasoning = await jsonRequest(config, "/v1/chat/completions", {
    model: config.model,
    messages: [{ role: "user", content: "Return the word ok." }],
    reasoning: { effort: "low" },
    max_tokens: 32
  });
  cases.push(outcome("reasoning", reasoning.ok, `HTTP ${reasoning.status}`));

  const stream = await streamRequest(config, {
    model: config.model,
    messages: [{ role: "user", content: "Reply with exactly: stream-ok" }],
    max_tokens: 32
  });
  cases.push(outcome("stream", stream.ok && /data:\s*\[DONE\]/.test(stream.text), `HTTP ${stream.status}`));

  const invalid = await jsonRequest(config, "/v1/chat/completions", {
    model: "switchyard-protocol-smoke-missing-model",
    messages: [{ role: "user", content: "This must not reach an upstream." }]
  });
  cases.push(outcome("route-error", invalid.status === 400, `HTTP ${invalid.status}`));

  return { ok: cases.every((entry) => entry.passed), cases };
}

async function main() {
  const config = readProtocolSmokeConfig();
  if (!config.ready) {
    console.log(`SKIP protocol smoke: ${config.reason}`);
    return;
  }
  const result = await runProtocolSmoke(config);
  for (const entry of result.cases) {
    console.log(`${entry.passed ? "PASS" : "FAIL"} ${entry.id} ${entry.detail}`.trim());
  }
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`FAIL protocol smoke: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

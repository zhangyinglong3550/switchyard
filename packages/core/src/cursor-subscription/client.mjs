import http2 from "node:http2";
import crypto from "node:crypto";
import { loadCursorSubscriptionCredentials, redactCursorSubscriptionError } from "./auth.mjs";
import { getKeychainSecret } from "../keychain-store.mjs";
import { assertCursorSubscriptionRequest, isCursorSubscriptionProvider } from "./model-catalog.mjs";
import { createCursorSubscriptionLane } from "./rate-limit.mjs";
import { collectCursorSubscriptionResponse, createCursorSubscriptionStream, textFromCursorMessages } from "./adapter.mjs";

const lanes = new Map();
const runtimeStates = new Map();
const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";

function providerKey(provider) {
  return String(provider?.id || "cursor-subscription");
}

function laneFor(provider) {
  const key = providerKey(provider);
  if (!lanes.has(key)) lanes.set(key, createCursorSubscriptionLane());
  return lanes.get(key);
}

function encodeVarint(value) {
  const bytes = [];
  let number = Number(value);
  while (number > 127) { bytes.push((number & 127) | 128); number = Math.floor(number / 128); }
  bytes.push(number);
  return Buffer.from(bytes);
}
function fieldBytes(field, value) {
  const body = Buffer.from(value || []);
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(body.length), body]);
}
function fieldString(field, value) { return fieldBytes(field, Buffer.from(String(value || ""))); }
function frame(payload) { const length = Buffer.alloc(4); length.writeUInt32BE(payload.length); return Buffer.concat([Buffer.from([0]), length, payload]); }

function buildAgentRun(messages, model) {
  const normalized = textFromCursorMessages(messages);
  const system = normalized.filter((m) => m.role === "system").map((m) => m.content).filter(Boolean).join("\n\n");
  const user = [...normalized].reverse().find((m) => m.role === "user")?.content || "Continue.";
  const userMessage = Buffer.concat([fieldString(1, user), fieldString(2, crypto.randomUUID())]);
  const userAction = fieldBytes(1, userMessage);
  const conversationAction = fieldBytes(1, userAction);
  const requestedModel = Buffer.concat([fieldString(1, model), Buffer.from([0x38, 0x01])]);
  const run = Buffer.concat([fieldBytes(1, Buffer.alloc(0)), fieldBytes(2, conversationAction), ...(system ? [fieldString(8, system)] : []), fieldBytes(9, requestedModel)]);
  return frame(fieldBytes(1, run));
}

function cursorHeaders(credentials, clientVersion = "1.0.0") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  let key = 165;
  const checksum = [];
  for (const char of timestamp) { const code = char.charCodeAt(0); checksum.push(code ^ key); key = (key + code) & 255; }
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    "connect-accept-encoding": "gzip",
    "x-cursor-client-version": clientVersion,
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "x-cursor-client-arch": process.arch === "arm64" ? "aarch64" : process.arch,
    "x-cursor-client-device-type": "desktop",
    "x-cursor-checksum": `${Buffer.from(checksum).toString("base64")},${credentials.machineId}`
  };
}

function decodeVarint(buffer, offset) {
  let value = 0; let shift = 0; let cursor = offset;
  while (cursor < buffer.length) { const byte = buffer[cursor++]; value += (byte & 127) * (2 ** shift); if (!(byte & 128)) return { value, offset: cursor }; shift += 7; }
  return null;
}
function fields(buffer) {
  const result = new Map(); let offset = 0;
  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset); if (!key) break; offset = key.offset;
    const wire = key.value & 7; const field = key.value >> 3;
    if (wire !== 2) { const value = decodeVarint(buffer, offset); if (!value) break; offset = value.offset; continue; }
    const length = decodeVarint(buffer, offset); if (!length || offset + (length.offset - offset) + length.value > buffer.length) break;
    offset = length.offset; const value = buffer.subarray(offset, offset + length.value); offset += length.value;
    if (!result.has(field)) result.set(field, []); result.get(field).push(value);
  }
  return result;
}
function firstText(fieldMap, field) { const value = fieldMap.get(field)?.[0]; return value ? Buffer.from(value).toString("utf8") : ""; }
function requestContextFrame() { return frame(fieldBytes(2, fieldBytes(10, fieldBytes(1, Buffer.alloc(0))))); }

async function* http2AgentEvents({ provider, credentials, messages, model, signal }) {
  const base = String(provider.baseUrl).replace(/\/+$/, "");
  const url = new URL(`${base}${AGENT_RUN_PATH}`);
  const session = http2.connect(url.origin);
  let request;
  try {
    request = session.request({ ":method": "POST", ":path": url.pathname, ":authority": url.host, ...cursorHeaders(credentials, provider.clientVersion) });
    if (signal?.aborted) request.close(http2.constants.NGHTTP2_CANCEL);
    else if (signal) signal.addEventListener("abort", () => request.close(http2.constants.NGHTTP2_CANCEL), { once: true });
    request.write(buildAgentRun(messages, model));
    let status = 0;
    request.on("response", (headers) => { status = Number(headers[":status"] || 0); });
    let pending = Buffer.alloc(0);
    for await (const rawChunk of request) {
      if (status && status !== 200) {
        const error = new Error(`Cursor upstream returned ${status}`); error.status = status; throw error;
      }
      pending = Buffer.concat([pending, Buffer.from(rawChunk)]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const length = pending.readUInt32BE(1); const payload = pending.subarray(5, 5 + length); pending = pending.subarray(5 + length);
        const server = fields(payload);
        if (server.get(1)?.[0]) {
          const update = fields(server.get(1)[0]);
          const interaction = update.get(1)?.[0] ? fields(update.get(1)[0]) : null;
          const text = interaction ? firstText(fields(interaction.get(1)?.[0] || Buffer.alloc(0)), 1) : "";
          if (text) yield { type: "text", text };
          if (update.get(14)?.[0]) yield { type: "terminal" };
        }
        if (server.get(2)?.[0]) request.write(requestContextFrame());
      }
    }
    if (status && status !== 200) {
      const error = new Error(`Cursor upstream returned ${status}`); error.status = status; throw error;
    }
  } finally {
    try { request?.end(); } catch {}
    try { session.close(); } catch {}
  }
}

export function cursorSubscriptionLaneSnapshot(provider) {
  const snapshot = laneFor(provider).snapshot();
  return { ...snapshot, status: runtimeStates.get(providerKey(provider)) || snapshot.state };
}
export function clearCursorSubscriptionRuntime(provider) {
  const key = providerKey(provider);
  lanes.delete(key);
  runtimeStates.delete(key);
}

export async function callCursorSubscription(provider, body, {
  keychain = { get: (account) => getKeychainSecret(account) },
  transport = http2AgentEvents,
  signal
} = {}) {
  if (!isCursorSubscriptionProvider(provider)) throw new Error("Provider is not cursor_subscription");
  if (provider.enabled !== true) return { ok: false, status: 403, payload: { error: { code: "CURSOR_SUBSCRIPTION_DISABLED", message: "Cursor 订阅桥接（实验性）默认关闭，请先在本机启用" } } };
  try { assertCursorSubscriptionRequest(body); } catch (error) { return { ok: false, status: 400, payload: { error: { code: error.code, message: error.message } } }; }
  const credentials = loadCursorSubscriptionCredentials(provider, keychain);
  if (!credentials) return { ok: false, status: 401, payload: { error: { code: "CURSOR_SUBSCRIPTION_UNCONFIGURED", message: "Cursor 订阅桥接尚未连接本机凭据" } } };
  const lane = laneFor(provider);
  try {
    const result = await lane.run(async () => {
      const events = transport({ provider, credentials, messages: body.messages || [], model: body.model || "auto", signal });
      if (body.stream) return { ok: true, status: 200, response: createCursorSubscriptionStream(body.model || "auto", events, { onCancel: () => signal?.abort?.() }) };
      return { ok: true, status: 200, payload: await collectCursorSubscriptionResponse(body.model || "auto", events) };
    });
    runtimeStates.set(providerKey(provider), "connected");
    return result;
  } catch (error) {
    const status = Number(error?.status) || (error?.code === "CURSOR_SUBSCRIPTION_CIRCUIT_OPEN" ? 503 : 502);
    runtimeStates.set(providerKey(provider), status === 401 || status === 403 ? "auth_invalid" : lane.snapshot().state);
    return { ok: false, status, payload: { error: { code: error?.code || "CURSOR_SUBSCRIPTION_UPSTREAM_ERROR", message: redactCursorSubscriptionError(error) } } };
  }
}

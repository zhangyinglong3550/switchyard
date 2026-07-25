// OpenAI Agent Identity credentials used by newer Codex subscription exports.
// The private key is kept only in the local pool file (0600); callers must
// never put it in logs, public account views, or renderer IPC payloads.
import crypto from "node:crypto";
import { ProxyAgent } from "undici";

export const AGENT_IDENTITY_AUTH_BASE_URL = "https://auth.openai.com/api/accounts";

const registrationInFlight = new Map();
const proxyAgents = new Map();

function text(value) {
  return String(value || "").trim();
}

function privateKeyFromBase64(encoded) {
  const value = text(encoded);
  if (!value) throw new Error("agent identity private key is missing");
  let key;
  try {
    key = crypto.createPrivateKey({
      key: Buffer.from(value, "base64"),
      format: "der",
      type: "pkcs8"
    });
  } catch {
    throw new Error("agent identity private key is not a valid PKCS#8 key");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("agent identity private key is not Ed25519");
  }
  return key;
}

export function isAgentIdentityAccount(account) {
  return Boolean(
    account &&
    (account.agentIdentity === true || text(account.authMode).toLowerCase() === "agentidentity") &&
    text(account.agentRuntimeId) &&
    text(account.agentPrivateKey)
  );
}

export function validateAgentIdentityAccount(account) {
  if (!account || !text(account.agentRuntimeId)) {
    throw new Error("agent identity runtime id is missing");
  }
  privateKeyFromBase64(account.agentPrivateKey);
  return true;
}

function timestampNow(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildAgentAssertion(account, { now = new Date() } = {}) {
  validateAgentIdentityAccount(account);
  const taskId = text(account.agentTaskId);
  if (!taskId) throw new Error("agent identity task id is missing");
  const runtimeId = text(account.agentRuntimeId);
  const timestamp = timestampNow(now);
  const signature = crypto.sign(null, Buffer.from(`${runtimeId}:${taskId}:${timestamp}`), privateKeyFromBase64(account.agentPrivateKey));
  const payload = {
    agent_runtime_id: runtimeId,
    task_id: taskId,
    timestamp,
    signature: signature.toString("base64")
  };
  return `AgentAssertion ${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function proxyDispatcher(proxyUrl) {
  const normalized = text(proxyUrl);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
  } catch {
    return null;
  }
  if (!proxyAgents.has(normalized)) proxyAgents.set(normalized, new ProxyAgent(normalized));
  return proxyAgents.get(normalized);
}

/**
 * Register a fresh Agent Identity task when an imported task is absent or no
 * longer accepted upstream. Current Sub2API exports normally contain task_id,
 * so this path is only used for recovery.
 */
export async function registerAgentIdentityTask(account, {
  now = new Date(),
  proxyUrl = "",
  fetchImpl,
  authBaseUrl = AGENT_IDENTITY_AUTH_BASE_URL
} = {}) {
  validateAgentIdentityAccount(account);
  const runtimeId = text(account.agentRuntimeId);
  const timestamp = timestampNow(now);
  const signature = crypto.sign(null, Buffer.from(`${runtimeId}:${timestamp}`), privateKeyFromBase64(account.agentPrivateKey)).toString("base64");
  const url = `${text(authBaseUrl).replace(/\/+$/, "")}/v1/agent/${encodeURIComponent(runtimeId)}/task/register`;
  const doFetch = fetchImpl || globalThis.fetch;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ timestamp, signature })
  };
  const dispatcher = proxyDispatcher(proxyUrl);
  if (dispatcher) init.dispatcher = dispatcher;

  let response;
  try {
    response = await doFetch(url, init);
  } catch {
    throw new Error("agent identity task registration request failed");
  }
  if (!response.ok) throw new Error(`agent identity task registration returned status ${response.status}`);

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("agent identity task registration response is invalid");
  }
  // Sub2API itself accepts both snake_case and camelCase responses. Encrypted
  // task IDs are deliberately rejected rather than attempting a partial,
  // unsafe decryption implementation; the current public endpoint returns
  // task_id directly.
  const taskId = text(result?.task_id || result?.taskId);
  if (!taskId) {
    if (text(result?.encrypted_task_id || result?.encryptedTaskId)) {
      throw new Error("agent identity task registration returned an unsupported encrypted task id");
    }
    throw new Error("agent identity task registration response omitted task id");
  }
  return taskId;
}

export async function ensureAgentIdentityTask(account, {
  force = false,
  ...options
} = {}) {
  validateAgentIdentityAccount(account);
  if (!force && text(account.agentTaskId)) return { account, registered: false };
  const runtimeId = text(account.agentRuntimeId);
  const inFlightKey = `${runtimeId}:${force ? "replace" : "create"}`;
  if (!registrationInFlight.has(inFlightKey)) {
    registrationInFlight.set(inFlightKey, registerAgentIdentityTask(account, options));
  }
  try {
    const agentTaskId = await registrationInFlight.get(inFlightKey);
    return { account: { ...account, agentTaskId }, registered: true };
  } finally {
    registrationInFlight.delete(inFlightKey);
  }
}

export async function isInvalidAgentIdentityTaskResponse(response) {
  if (!response || Number(response.status) !== 401) return false;
  let body = "";
  try {
    body = await response.clone().text();
  } catch {
    return false;
  }
  const lower = body.toLowerCase();
  const compact = lower.replace(/\s/g, "");
  return [
    '"code":"invalid_task_id"',
    '"code":"task_not_found"',
    '"code":"task_expired"',
    '"error":"invalid_task_id"',
    "invalid task_id",
    "invalid task id",
    "task_id is invalid",
    "task id is invalid",
    "task not found",
    "task expired",
    "unknown task_id",
    "unknown task id"
  ].some((marker) => compact.includes(marker.replace(/\s/g, "")) || lower.includes(marker));
}

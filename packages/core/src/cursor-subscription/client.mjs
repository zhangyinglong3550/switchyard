import http2 from "node:http2";
import crypto from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { logDir, nowIso } from "../utils.mjs";
import { loadCursorSubscriptionCredentials, redactCursorSubscriptionError } from "./auth.mjs";
import { getKeychainSecret } from "../keychain-store.mjs";
import { assertCursorSubscriptionRequest, isCursorSubscriptionProvider, resolveCursorSubscriptionModel } from "./model-catalog.mjs";
import { createCursorSubscriptionLane } from "./rate-limit.mjs";
import { collectCursorSubscriptionResponse, createCursorSubscriptionStream } from "./adapter.mjs";
import { applyCursorToolCompatibility, prepareCursorConversation } from "./tool-compat.mjs";
import { readLocalCursorDesktopVersion, readLocalCursorRequestedModel } from "./local-auth.mjs";
import { cursorAgentCliEvents, isCursorAgentCliEligible } from "./agent-cli.mjs";
import { http2CursorBidiEvents } from "./bidi-client.mjs";
import { mapReadArguments, mapShellArguments, selectReadTool, selectShellTool, toolCatalog } from "./tool-capabilities.mjs";
import { applySensitiveGuard, buildSensitiveOutboundPreview } from "../sensitive-guard.mjs";

const lanes = new Map();

function writeCursorDiagnostic(summary) {
  if (!summary?.unsupportedExecution) return;
  try {
    const entry = JSON.stringify({
      ts: nowIso(),
      level: "warn",
      msg: "cursor unsupported execution",
      execution: summary.unsupportedExecution,
      frame: summary.frame,
      execFields: summary.execFields || null
    }) + "\n";
    fs.appendFileSync(path.join(logDir(), "gateway.log"), entry);
  } catch {}
}
function dumpExecFields(payload) {
  try {
    const server = fields(payload);
    const exec = server.get(2)?.[0];
    if (!exec) return null;
    const execWire = wireFields(exec);
    const execLen = fields(exec);
    const result = {};
    // Capture varint fields (like field 1 = execution type indicator)
    for (const [field, entries] of execWire) {
      if (entries.some((e) => e.wire === 0)) {
        result[`field_${field}_varint`] = entries.filter((e) => e.wire === 0).map((e) => e.value);
      }
    }
    // Capture length-delimited fields with decoded content
    for (const [field, values] of execLen) {
      const decoded = values.map((v) => {
        const text = Buffer.from(v).toString("utf8");
        // Check if it looks like printable text
        const printable = text.replace(/[^\x20-\x7E\n\r\t]/g, "").length;
        return printable > text.length * 0.7 ? text : `<${v.length} bytes hex:${Buffer.from(v).toString("hex").slice(0, 100)}>`;
      });
      result[`field_${field}_text`] = decoded;
    }
    return result;
  } catch {
    return null;
  }
}
const runtimeStates = new Map();
const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";

function cursorReasoningEffort(body = {}) {
  if (typeof body.reasoning_effort === "string") return body.reasoning_effort;
  if (typeof body.reasoning === "string") return body.reasoning;
  if (body.reasoning === false || (Object.prototype.hasOwnProperty.call(body, "reasoning") && body.reasoning == null)) return "none";
  if (body.reasoning === true) return "high";
  if (body.reasoning && typeof body.reasoning === "object" && typeof body.reasoning.effort === "string") return body.reasoning.effort;
  return "";
}

function cursorSpeedTier(body = {}) {
  if (typeof body.service_tier === "string") return body.service_tier;
  if (typeof body.speed_tier === "string") return body.speed_tier;
  if (body.fast === true) return "fast";
  if (body.fast === false) return "standard";
  return "";
}

function providerKey(provider) {
  return String(provider?.id || "cursor-subscription");
}

function laneFor(provider) {
  const key = providerKey(provider);
  const requestedConcurrency = Number(provider?.maxConcurrentRequests) || 2;
  const existing = lanes.get(key);
  if (!existing || (existing.maxConcurrentRequests !== requestedConcurrency && existing.snapshot().running === 0 && existing.snapshot().queued === 0)) {
    lanes.set(key, createCursorSubscriptionLane({ maxConcurrentRequests: requestedConcurrency }));
  }
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
function fieldVarint(field, value) { return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]); }
function fieldFixed64(field, value) { const body = Buffer.alloc(8); body.writeDoubleLE(Number(value)); return Buffer.concat([encodeVarint((field << 3) | 1), body]); }

function protobufValue(value) {
  if (value == null) return fieldVarint(1, 0);
  if (typeof value === "number") return fieldFixed64(2, value);
  if (typeof value === "string") return fieldString(3, value);
  if (typeof value === "boolean") return fieldVarint(4, value ? 1 : 0);
  if (Array.isArray(value)) return fieldBytes(6, Buffer.concat(value.map((item) => fieldBytes(1, protobufValue(item)))));
  if (typeof value === "object") return fieldBytes(5, protobufStruct(value));
  return fieldString(3, String(value));
}

function protobufStruct(value = {}) {
  return Buffer.concat(Object.entries(value).map(([key, item]) => fieldBytes(1, Buffer.concat([
    fieldString(1, key),
    fieldBytes(2, protobufValue(item))
  ]))));
}

function nativeCursorMcpTools(tools = []) {
  const definitions = (tools || []).map((tool) => tool?.type === "function" ? tool.function : null).filter((fn) => fn?.name);
  if (!definitions.length) return null;
  return Buffer.concat(definitions.map((fn) => fieldBytes(1, Buffer.concat([
    fieldString(1, fn.name),
    fieldString(4, "switchyard"),
    fieldString(5, fn.name),
    ...(fn.description ? [fieldString(2, fn.description)] : []),
    fieldBytes(3, protobufValue(fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} }))
  ]))));
}
function frame(payload) { const length = Buffer.alloc(4); length.writeUInt32BE(payload.length); return Buffer.concat([Buffer.from([0]), length, payload]); }

function requestedModelPayload(model, requestedModel) {
  const resolved = requestedModel && typeof requestedModel === "object"
    ? requestedModel
    : { modelId: model, maxMode: false, parameters: [], builtInModel: true, isVariantStringRepresentation: false };
  const fields = [
    fieldString(1, resolved.modelId || model)
  ];
  if (resolved.maxMode === true) fields.push(Buffer.from([0x10, 0x01]));
  for (const parameter of resolved.parameters || []) {
    if (!parameter?.id || parameter?.value === undefined) continue;
    fields.push(fieldBytes(3, Buffer.concat([fieldString(1, parameter.id), fieldString(2, parameter.value)])));
  }
  if (resolved.builtInModel !== false) fields.push(Buffer.from([0x38, 0x01]));
  if (resolved.isVariantStringRepresentation === true) fields.push(Buffer.from([0x40, 0x01]));
  return Buffer.concat(fields);
}

export function buildAgentRun(messages, model, { tools = [], requestedModel } = {}) {
  // Tools are sent through AgentRunRequest.mcp_tools. Do not also describe an
  // XML compatibility protocol in the prompt: that makes Cursor bypass its
  // native execution request and leaves Codex with unbound text markup.
  const { system, user } = prepareCursorConversation(messages, []);
  // The Cursor Agent endpoint rejects AgentRunRequest.custom_system_prompt
  // (field 8) as an unsupported option. Preserve system guidance by placing
  // it at the start of the user turn. Capability flags (fields 19, 23) are
  // intentionally omitted: 9router benchmarks show they trigger heavier
  // server-side processing (~28s vs ~3s for a PONG round-trip).
  const prompt = system ? `${system}\n\n${user}` : user;
  const userMessage = Buffer.concat([fieldString(1, prompt), fieldString(2, crypto.randomUUID())]);
  const userAction = Buffer.concat([
    fieldBytes(1, userMessage),
    fieldBytes(2, Buffer.alloc(0))
  ]);
  const conversationAction = fieldBytes(1, userAction);
  const modelSelection = requestedModelPayload(model, requestedModel);
  const mcpTools = nativeCursorMcpTools(tools);
  const run = Buffer.concat([
    fieldBytes(1, Buffer.alloc(0)),
    fieldBytes(2, conversationAction),
    ...(mcpTools ? [fieldBytes(4, mcpTools)] : []),
    fieldString(5, crypto.randomUUID()),
    fieldBytes(9, modelSelection)
  ]);
  return frame(fieldBytes(1, run));
}

export function buildCursorRequestContextResponse() {
  const requestContextSuccess = fieldBytes(1, Buffer.alloc(0));
  const requestContextResult = fieldBytes(1, requestContextSuccess);
  const executionClientMessage = fieldBytes(10, requestContextResult);
  return frame(fieldBytes(2, executionClientMessage));
}

function cursorChecksum(machineId) {
  // Match the current local Cursor desktop client's checksum header shape.
  // This is a compatibility marker, not a credential; the access token is
  // still read only from the local Keychain.
  const timestamp = Math.floor(Date.now() / 1e6);
  const bytes = new Uint8Array([
    (timestamp >> 40) & 255,
    (timestamp >> 32) & 255,
    (timestamp >> 24) & 255,
    (timestamp >> 16) & 255,
    (timestamp >> 8) & 255,
    timestamp & 255
  ]);
  let key = 165;
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (bytes[index] ^ key) + (index % 256);
    key = bytes[index];
  }
  return `${Buffer.from(bytes).toString("base64")}${machineId}`;
}

export function cursorRequestHeaders(credentials, configuredClientVersion = "") {
  const clientVersion = String(configuredClientVersion || readLocalCursorDesktopVersion() || "1.0.0").trim();
  const requestId = crypto.randomUUID();
  const clientKey = crypto.createHash("sha256").update(credentials.accessToken).digest("hex");
  const sessionId = crypto.createHash("sha1").update(credentials.accessToken + "dns").digest("hex").slice(0, 36);
  return {
    authorization: `Bearer ${credentials.accessToken}`,
    "connect-accept-encoding": "gzip",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${requestId}`,
    "x-client-key": clientKey,
    "x-cursor-checksum": cursorChecksum(credentials.machineId),
    "x-cursor-client-version": clientVersion,
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
    "x-cursor-client-arch": process.arch === "arm64" ? "aarch64" : process.arch,
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": crypto.randomUUID(),
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-ghost-mode": "true",
    "x-request-id": requestId,
    "x-session-id": sessionId
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

function wireFields(buffer) {
  const result = new Map(); let offset = 0;
  while (offset < buffer.length) {
    const key = decodeVarint(buffer, offset); if (!key) break; offset = key.offset;
    const wire = key.value & 7; const field = key.value >> 3; let value;
    if (wire === 0) {
      const decoded = decodeVarint(buffer, offset); if (!decoded) break;
      value = decoded.value; offset = decoded.offset;
    } else if (wire === 1) {
      if (offset + 8 > buffer.length) break;
      value = buffer.subarray(offset, offset + 8); offset += 8;
    } else if (wire === 2) {
      const length = decodeVarint(buffer, offset); if (!length) break;
      offset = length.offset; if (offset + length.value > buffer.length) break;
      value = buffer.subarray(offset, offset + length.value); offset += length.value;
    } else if (wire === 5) {
      if (offset + 4 > buffer.length) break;
      value = buffer.subarray(offset, offset + 4); offset += 4;
    } else break;
    if (!result.has(field)) result.set(field, []);
    result.get(field).push({ wire, value });
  }
  return result;
}
function varintValue(buffer, field, fallback = 0) {
  const entry = wireFields(buffer).get(field)?.find((item) => item.wire === 0);
  return entry ? Number(entry.value) : fallback;
}
function decodeProtobufValue(buffer) {
  const map = wireFields(buffer);
  const stringValue = map.get(3)?.find((item) => item.wire === 2)?.value;
  if (stringValue) return Buffer.from(stringValue).toString("utf8");
  const boolValue = map.get(4)?.find((item) => item.wire === 0);
  if (boolValue) return Boolean(boolValue.value);
  const numberValue = map.get(2)?.find((item) => item.wire === 1)?.value;
  if (numberValue) return Buffer.from(numberValue).readDoubleLE(0);
  const structValue = map.get(5)?.find((item) => item.wire === 2)?.value;
  if (structValue) return decodeProtobufStruct(structValue);
  const listValue = map.get(6)?.find((item) => item.wire === 2)?.value;
  if (listValue) return (fields(listValue).get(1) || []).map(decodeProtobufValue);
  if (map.get(1)?.some((item) => item.wire === 0)) return null;
  return null;
}
function decodeProtobufStruct(buffer) {
  const output = {};
  for (const entry of fields(buffer).get(1) || []) {
    const pair = fields(entry); const key = firstText(pair, 1); const value = pair.get(2)?.[0];
    if (key && value) output[key] = decodeProtobufValue(value);
  }
  return output;
}

function fieldShape(fieldMap) {
  return [...fieldMap.entries()].map(([field, values]) => ({
    field,
    lengths: values.map((value) => value.length)
  }));
}
export function summarizeCursorAgentFrame(payload, flags = 0) {
  const server = fields(payload);
  const update = server.get(1)?.[0] ? fields(server.get(1)[0]) : null;
  return {
    flags,
    server: fieldShape(server),
    update: update ? fieldShape(update) : [],
    interaction: server.get(2)?.[0] ? fieldShape(fields(server.get(2)[0])) : []
  };
}
export function parseCursorEndStream(payload) {
  try {
    const body = JSON.parse(Buffer.from(payload).toString("utf8"));
    const error = body?.error;
    return {
      ok: !error,
      errorCode: error ? String(error.code || "unknown") : "",
      errorMessage: error ? String(error.message || "Cursor upstream stream failed") : ""
    };
  } catch {
    return { ok: false, errorCode: "malformed_end_stream", errorMessage: "Cursor upstream returned an invalid stream terminator" };
  }
}
export function decodeCursorConnectFramePayload(payload, flags = 0) {
  const frame = Buffer.from(payload || []);
  if (!(flags & 0x01) || (frame[0] === 0x7b && frame[1] === 0x22)) return frame;
  try {
    return zlib.gunzipSync(frame);
  } catch {
    try {
      return zlib.inflateSync(frame);
    } catch {
      try {
        return zlib.inflateRawSync(frame);
      } catch {
        const error = new Error("Cursor upstream returned an unreadable compressed stream frame");
        error.code = "CURSOR_SUBSCRIPTION_COMPRESSED_FRAME";
        throw error;
      }
    }
  }
}
function cursorEndStreamStatus(code) {
  switch (String(code || "").toLowerCase()) {
    case "unauthenticated": return 401;
    case "permission_denied": return 403;
    case "invalid_argument":
    case "failed_precondition": return 400;
    case "resource_exhausted": return 429;
    case "unavailable":
    case "deadline_exceeded": return 503;
    default: return 502;
  }
}
function firstText(fieldMap, field) { const value = fieldMap.get(field)?.[0]; return value ? Buffer.from(value).toString("utf8") : ""; }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

export function cursorAgentExecutionEvent(payload, tools = []) {
  const server = fields(payload);
  const exec = server.get(2)?.[0];
  if (!exec) return null;
  const execFields = fields(exec);
  const catalog = toolCatalog(tools);
  const allowed = new Set(catalog.keys());
  if (execFields.get(10)?.[0]) return { type: "request_context" };
  const mcp = execFields.get(11)?.[0];
  if (mcp) {
    const args = fields(mcp);
    const requestedName = firstText(args, 5) || firstText(args, 1);
    const name = allowed.has(requestedName) ? requestedName : (allowed.has(firstText(args, 1)) ? firstText(args, 1) : "");
    if (!name) return { type: "unsupported_execution", execution: "mcp", name: requestedName };
    const values = {};
    for (const entry of args.get(2) || []) {
      const pair = fields(entry); const key = firstText(pair, 1); const value = pair.get(2)?.[0];
      if (key && value) values[key] = decodeProtobufValue(value);
    }
    return {
      type: "tool_call",
      id: firstText(args, 3) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
      name,
      arguments: JSON.stringify(values)
    };
  }
  const shell = execFields.get(2)?.[0] || execFields.get(14)?.[0];
  if (shell) {
    const args = fields(shell);
    const command = firstText(args, 1);
    if (!command) return { type: "unsupported_execution", execution: "shell" };
    const target = selectShellTool(tools);
    if (target) {
      return {
        type: "tool_call",
        id: firstText(args, 4) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: target.name,
        arguments: JSON.stringify(mapShellArguments(target, {
          command,
          workdir: firstText(args, 2),
          timeout: varintValue(shell, 3)
        }))
      };
    }
    return { type: "unsupported_execution", execution: "shell" };
  }
  const read = execFields.get(7)?.[0];
  if (read) {
    const args = fields(read);
    const filePath = firstText(args, 1);
    if (!filePath) return { type: "unsupported_execution", execution: "read" };
    const offset = varintValue(read, 4);
    const limit = varintValue(read, 5);
    const target = selectReadTool(tools);
    const nativeArgs = target && mapReadArguments(target, { filePath, offset, limit });
    if (target && nativeArgs) {
      return {
        type: "tool_call",
        id: firstText(args, 2) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: target.name,
        arguments: JSON.stringify(nativeArgs)
      };
    }
    const shellTarget = target?.name === "exec_command" ? target : selectShellTool(tools);
    if (shellTarget) {
      const startLine = offset + 1;
      const command = limit
        ? `sed -n '${startLine},${startLine + limit - 1}p' ${shellQuote(filePath)}`
        : `tail -n +${startLine} -- ${shellQuote(filePath)}`;
      return {
        type: "tool_call",
        id: firstText(args, 2) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: shellTarget.name,
        arguments: JSON.stringify(mapShellArguments(shellTarget, { command }))
      };
    }
    return { type: "unsupported_execution", execution: "read" };
  }
  const grep = execFields.get(5)?.[0];
  if (grep) {
    const args = fields(grep);
    const pattern = firstText(args, 1);
    const filePath = firstText(args, 2);
    if (!pattern) return { type: "unsupported_execution", execution: "grep" };
    const target = selectShellTool(tools);
    if (target) {
      const command = `grep -n ${shellQuote(pattern)} ${shellQuote(filePath || ".")}`;
      return {
        type: "tool_call",
        id: firstText(args, 14) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: target.name,
        arguments: JSON.stringify(mapShellArguments(target, { command }))
      };
    }
    return { type: "unsupported_execution", execution: "grep" };
  }
  // WriteFile (exec field 3): WriteArgs { path=1, file_text=2, tool_call_id=3 }
  const write = execFields.get(3)?.[0];
  if (write) {
    const args = fields(write);
    const filePath = firstText(args, 1);
    const fileText = firstText(args, 2);
    if (!filePath) return { type: "unsupported_execution", execution: "write" };
    const target = selectShellTool(tools);
    if (target) {
      const delim = `SWITCHYARD_${crypto.randomUUID().replace(/-/g, "")}`;
      const command = `cat > ${shellQuote(filePath)} << '${delim}'\n${fileText || ""}\n${delim}`;
      return {
        type: "tool_call",
        id: firstText(args, 3) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: target.name,
        arguments: JSON.stringify(mapShellArguments(target, { command }))
      };
    }
    return { type: "unsupported_execution", execution: "write" };
  }
  // DeleteFile (exec field 4): DeleteArgs { path=1, tool_call_id=2 }
  const del = execFields.get(4)?.[0];
  if (del) {
    const args = fields(del);
    const filePath = firstText(args, 1);
    if (!filePath) return { type: "unsupported_execution", execution: "delete" };
    const target = selectShellTool(tools);
    if (target) {
      const command = `rm -f ${shellQuote(filePath)}`;
      return {
        type: "tool_call",
        id: firstText(args, 2) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: target.name,
        arguments: JSON.stringify(mapShellArguments(target, { command }))
      };
    }
    return { type: "unsupported_execution", execution: "delete" };
  }
  // ListDir (exec field 8): LsArgs { path=1, tool_call_id=3 }
  const ls = execFields.get(8)?.[0];
  if (ls) {
    const args = fields(ls);
    const dirPath = firstText(args, 1);
    const target = selectShellTool(tools);
    if (target) {
      const command = `ls -la ${shellQuote(dirPath || ".")}`;
      return {
        type: "tool_call",
        id: firstText(args, 3) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`,
        name: target.name,
        arguments: JSON.stringify(mapShellArguments(target, { command }))
      };
    }
    return { type: "unsupported_execution", execution: "ls" };
  }
  // pi_* variants (fields 45-51): newer protocol versions of the same tools.
  // Map them to the same handlers as their non-pi counterparts by re-reading
  // from the execFields with the pi_ field number.
  //   45=pi_read, 46=pi_bash, 47=pi_edit, 48=pi_write, 49=pi_grep, 50=pi_find, 51=pi_ls
  const piRead = execFields.get(45)?.[0];
  if (piRead) {
    const args = fields(piRead);
    const filePath = firstText(args, 1);
    if (!filePath) return { type: "unsupported_execution", execution: "pi_read" };
    const offset = varintValue(piRead, 4);
    const limit = varintValue(piRead, 5);
    const target = selectReadTool(tools);
    const nativeArgs = target && mapReadArguments(target, { filePath, offset, limit });
    if (target && nativeArgs) {
      return { type: "tool_call", id: firstText(args, 2) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: target.name, arguments: JSON.stringify(nativeArgs) };
    }
    const shellTarget = target?.name === "exec_command" ? target : selectShellTool(tools);
    if (shellTarget) {
      const startLine = offset + 1;
      const command = limit ? `sed -n '${startLine},${startLine + limit - 1}p' ${shellQuote(filePath)}` : `tail -n +${startLine} -- ${shellQuote(filePath)}`;
      return { type: "tool_call", id: firstText(args, 2) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: shellTarget.name, arguments: JSON.stringify(mapShellArguments(shellTarget, { command })) };
    }
    return { type: "unsupported_execution", execution: "pi_read" };
  }
  const piBash = execFields.get(46)?.[0];
  if (piBash) {
    const args = fields(piBash);
    const command = firstText(args, 1);
    if (!command) return { type: "unsupported_execution", execution: "pi_bash" };
    const target = selectShellTool(tools);
    if (target) {
      return { type: "tool_call", id: firstText(args, 4) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: target.name, arguments: JSON.stringify(mapShellArguments(target, { command, workdir: firstText(args, 2), timeout: varintValue(piBash, 3) })) };
    }
    return { type: "unsupported_execution", execution: "pi_bash" };
  }
  const piWrite = execFields.get(48)?.[0];
  if (piWrite) {
    const args = fields(piWrite);
    const filePath = firstText(args, 1);
    const fileText = firstText(args, 2);
    if (!filePath) return { type: "unsupported_execution", execution: "pi_write" };
    const target = selectShellTool(tools);
    if (target) {
      const delim = `SWITCHYARD_${crypto.randomUUID().replace(/-/g, "")}`;
      const command = `cat > ${shellQuote(filePath)} << '${delim}'\n${fileText || ""}\n${delim}`;
      return { type: "tool_call", id: firstText(args, 3) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: target.name, arguments: JSON.stringify(mapShellArguments(target, { command })) };
    }
    return { type: "unsupported_execution", execution: "pi_write" };
  }
  const piGrep = execFields.get(49)?.[0];
  if (piGrep) {
    const args = fields(piGrep);
    const pattern = firstText(args, 1);
    const filePath = firstText(args, 2);
    if (!pattern) return { type: "unsupported_execution", execution: "pi_grep" };
    const target = selectShellTool(tools);
    if (target) {
      const command = `grep -n ${shellQuote(pattern)} ${shellQuote(filePath || ".")}`;
      return { type: "tool_call", id: firstText(args, 14) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: target.name, arguments: JSON.stringify(mapShellArguments(target, { command })) };
    }
    return { type: "unsupported_execution", execution: "pi_grep" };
  }
  const piFind = execFields.get(50)?.[0];
  if (piFind) {
    const args = fields(piFind);
    const pattern = firstText(args, 1);
    const filePath = firstText(args, 2);
    const target = selectShellTool(tools);
    if (target) {
      const command = pattern ? `find ${shellQuote(filePath || ".")} -name ${shellQuote(pattern)}` : `find ${shellQuote(filePath || ".")}`;
      return { type: "tool_call", id: firstText(args, 3) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: target.name, arguments: JSON.stringify(mapShellArguments(target, { command })) };
    }
    return { type: "unsupported_execution", execution: "pi_find" };
  }
  const piLs = execFields.get(51)?.[0];
  if (piLs) {
    const args = fields(piLs);
    const dirPath = firstText(args, 1);
    const target = selectShellTool(tools);
    if (target) {
      const command = `ls -la ${shellQuote(dirPath || ".")}`;
      return { type: "tool_call", id: firstText(args, 3) || firstText(execFields, 15) || `call_${crypto.randomUUID()}`, name: target.name, arguments: JSON.stringify(mapShellArguments(target, { command })) };
    }
    return { type: "unsupported_execution", execution: "pi_ls" };
  }
  return { type: "unsupported_execution", execution: "cursor_builtin" };
}

export function cursorAgentEventsFromFrame(payload) {
  const server = fields(payload);
  const interaction = server.get(1)?.[0] ? fields(server.get(1)[0]) : null;
  const events = [];
  const text = interaction ? firstText(fields(interaction.get(1)?.[0] || Buffer.alloc(0)), 1) : "";
  if (text) events.push({ type: "text", text });
  if (interaction?.get(14)?.[0]) {
    const turnEnded = interaction.get(14)[0];
    const promptTokens = varintValue(turnEnded, 1);
    const completionTokens = varintValue(turnEnded, 2);
    const cached = varintValue(turnEnded, 3);
    const reasoning = varintValue(turnEnded, 5);
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    };
    if (cached) usage.prompt_tokens_details = { cached_tokens: cached };
    if (reasoning) usage.completion_tokens_details = { reasoning_tokens: reasoning };
    events.push({ type: "usage", usage });
    events.push({ type: "terminal" });
  }
  return events;
}

async function* http2AgentEventsOnce({ provider, credentials, messages, model, requestedModel, tools = [], signal, diagnostics }) {
  const base = String(provider.baseUrl).replace(/\/+$/, "");
  const url = new URL(`${base}${AGENT_RUN_PATH}`);
  const session = http2.connect(url.origin);
  let request;
  let sessionError = null;
  // `ClientHttp2Session` emits `error` independently from the request stream.
  // Without a listener a transient TLS reset can crash the gateway process.
  session.on("error", (error) => { sessionError = error; });
  try {
    request = session.request({ ":method": "POST", ":path": url.pathname, ":authority": url.host, ...cursorRequestHeaders(credentials, provider.clientVersion) });
    if (signal?.aborted) request.close(http2.constants.NGHTTP2_CANCEL);
    else if (signal) signal.addEventListener("abort", () => request.close(http2.constants.NGHTTP2_CANCEL), { once: true });
    request.write(buildAgentRun(messages, model, { tools, requestedModel }));
    let status = 0;
    request.on("response", (headers) => { status = Number(headers[":status"] || 0); });
    let pending = Buffer.alloc(0);
    for await (const rawChunk of request) {
      if (status && status !== 200) {
        const error = new Error(`Cursor upstream returned ${status}`); error.status = status; throw error;
      }
      pending = Buffer.concat([pending, Buffer.from(rawChunk)]);
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const flags = pending[0]; const length = pending.readUInt32BE(1); let payload = pending.subarray(5, 5 + length); pending = pending.subarray(5 + length);
        payload = decodeCursorConnectFramePayload(payload, flags);
        const server = fields(payload);
        diagnostics?.(summarizeCursorAgentFrame(payload, flags));
        const execution = cursorAgentExecutionEvent(payload, tools);
        if (execution?.type === "request_context") {
          request.write(buildCursorRequestContextResponse());
        } else if (execution?.type === "tool_call") {
          yield execution;
          yield { type: "terminal" };
          return;
        } else if (execution?.type === "unsupported_execution") {
          // Cursor 上游有时会下发尚未识别的内置执行类型（如 edit/grep 等）。
          // 直接 throw 会丢弃同一轮已输出的全部文本并触发
          // "stream disconnected before completion"。改为记录诊断、向客户端
          // 输出一条提示，再正常结束本轮，保留已收到的模型输出。
          diagnostics?.({ unsupportedExecution: execution.execution, frame: summarizeCursorAgentFrame(payload, flags), execFields: dumpExecFields(payload) });
          yield { type: "text", text: `

[switchyard] Cursor requested an unsupported built-in execution (${execution.execution}). Ending the turn to preserve output already received.` };
          yield { type: "terminal" };
          return;
        }
        if (flags & 0x02) {
          const end = parseCursorEndStream(payload);
          if (!end.ok) {
            const error = new Error(end.errorMessage);
            error.code = `CURSOR_SUBSCRIPTION_${end.errorCode.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
            error.status = cursorEndStreamStatus(end.errorCode);
            throw error;
          }
          yield { type: "terminal" };
          continue;
        }
        for (const event of cursorAgentEventsFromFrame(payload)) yield event;
      }
    }
    if (sessionError) throw sessionError;
    if (status && status !== 200) {
      const error = new Error(`Cursor upstream returned ${status}`); error.status = status; throw error;
    }
  } finally {
    try { request?.end(); } catch {}
    try { session.close(); } catch {}
  }
}

function retryableCursorTransportError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  return ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE", "ECONNREFUSED", "ETIMEDOUT", "ERR_CRYPTO_HANDSHAKE_FAILED", "ERR_TLS_DH_PRIME_SIZE"].includes(code)
    || /socket disconnected before secure TLS/i.test(message);
}

export async function* http2AgentEvents(options) {
  let emitted = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      for await (const event of http2AgentEventsOnce(options)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      // Retry exactly once only when the connection dies before any upstream
      // event. Replaying a partial turn could duplicate model output/tool work.
      if (attempt === 0 && !emitted && retryableCursorTransportError(error) && !options?.signal?.aborted) continue;
      throw error;
    }
  }
}

export async function* http2BidiEvents({ provider, credentials, messages, model, requestedModel, tools = [], signal }) {
  const wire = buildAgentRun(messages, model, { tools, requestedModel }).subarray(5);
  yield* http2CursorBidiEvents({
    provider, credentials, message: wire, headers: cursorRequestHeaders,
    decodeFrameEvents: cursorAgentEventsFromFrame,
    decodeFramePayload: decodeCursorConnectFramePayload,
    // RunSSE is a read-only projection of the AgentService bidi stream. Any
    // server callback still has to be appended back through BidiAppend. The
    // first callback requested by a normal Cursor turn is RequestContext.
    onFrame(payload) {
      const server = fields(payload);
      const executionRequest = server.get(2)?.[0] ? fields(server.get(2)[0]) : null;
      return executionRequest?.get(10)?.[0]
        ? [buildCursorRequestContextResponse().subarray(5)]
        : [];
    },
    signal
  });
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

function applyCursorSensitiveGuard(body, {
  sensitiveGuard,
  onSensitiveAudit,
  clientId,
  sessionKey,
  model,
  provider
} = {}) {
  if (!sensitiveGuard || sensitiveGuard.enabled === false) return body;
  try {
    const resolvedSession = String(
      sessionKey
      || body?.conversation_id
      || body?.session_id
      || body?.metadata?.session_id
      || ""
    ).trim().slice(0, 200);
    const guarded = applySensitiveGuard(body, sensitiveGuard, {
      clientId: clientId || "",
      sessionKey: resolvedSession
    });
    if (typeof onSensitiveAudit === "function" && guarded.shouldAudit) {
      onSensitiveAudit({
        action: guarded.action,
        hits: guarded.hits,
        total: guarded.total,
        bypass: Boolean(guarded.bypass),
        retainOriginal: sensitiveGuard?.auditRetainOriginal !== false,
        outboundPreview: buildSensitiveOutboundPreview(guarded.body, {
          action: guarded.action,
          hits: guarded.hits
        }),
        sessionKey: resolvedSession,
        clientId: clientId || "",
        modelId: model?.id || body?.model || "",
        providerId: provider?.id || model?.providerId || "cursor-subscription"
      });
    }
    return guarded.body;
  } catch {
    return body;
  }
}

export async function callCursorSubscription(provider, body, {
  keychain = { get: (account) => getKeychainSecret(account) },
  transport = http2AgentEvents,
  readLocalModel = readLocalCursorRequestedModel,
  signal,
  sensitiveGuard,
  onSensitiveAudit,
  clientId,
  sessionKey,
  model
} = {}) {
  if (!isCursorSubscriptionProvider(provider)) throw new Error("Provider is not cursor_subscription");
  if (provider.enabled !== true) return { ok: false, status: 403, payload: { error: { code: "CURSOR_SUBSCRIPTION_DISABLED", message: "Cursor 订阅桥接默认关闭，请先在本机启用" } } };
  try { assertCursorSubscriptionRequest(body); } catch (error) { return { ok: false, status: 400, payload: { error: { code: error.code, message: error.message } } }; }
  body = applyCursorSensitiveGuard(body, {
    sensitiveGuard,
    onSensitiveAudit,
    clientId,
    sessionKey,
    model,
    provider
  });
  const useCursorAgentCli = transport === http2AgentEvents && provider.useCursorAgentCli !== false && isCursorAgentCliEligible(body);
  const credentials = useCursorAgentCli ? null : loadCursorSubscriptionCredentials(provider, keychain);
  if (!useCursorAgentCli && !credentials) return { ok: false, status: 401, payload: { error: { code: "CURSOR_SUBSCRIPTION_UNCONFIGURED", message: "Cursor 订阅桥接尚未连接本机凭据" } } };
  const lane = laneFor(provider);
  try {
    if (body.stream) {
      const lease = await lane.acquire();
      try {
        const requestedModel = body.model || "auto";
        const upstreamModel = resolveCursorSubscriptionModel(requestedModel);
        const localSelection = readLocalModel(upstreamModel, {
          reasoningEffort: cursorReasoningEffort(body),
          speedTier: cursorSpeedTier(body)
        });
        const cursorDiagnostics = writeCursorDiagnostic;
        const events = useCursorAgentCli
          ? cursorAgentCliEvents({ messages: body.messages || [], tools: body.tools || [], model: requestedModel, signal })
          : transport({
            provider, credentials, messages: body.messages || [], tools: body.tools || [], model: upstreamModel,
            requestedModel: localSelection.ok ? localSelection.requestedModel : undefined, signal,
            diagnostics: cursorDiagnostics
          });
        runtimeStates.set(providerKey(provider), "connected");
        return {
          ok: true,
          status: 200,
          response: createCursorSubscriptionStream(requestedModel, events, {
            onCancel: () => signal?.abort?.(),
            onFinish: (error) => lease.release(error),
            // The CLI carries function calls as its textual compatibility
            // envelope. Let dispatch convert it back into SSE tool calls.
            nativeToolCalls: true
          })
        };
      } catch (error) {
        lease.release(error);
        throw error;
      }
    }
    const result = await lane.run(async () => {
      const requestedModel = body.model || "auto";
      const upstreamModel = resolveCursorSubscriptionModel(requestedModel);
      const localSelection = readLocalModel(upstreamModel, {
        reasoningEffort: cursorReasoningEffort(body),
        speedTier: cursorSpeedTier(body)
      });
        const cursorDiagnostics = writeCursorDiagnostic;
      const events = useCursorAgentCli
        ? cursorAgentCliEvents({ messages: body.messages || [], tools: body.tools || [], model: requestedModel, signal })
        : transport({
          provider, credentials, messages: body.messages || [], tools: body.tools || [], model: upstreamModel,
          requestedModel: localSelection.ok ? localSelection.requestedModel : undefined, signal,
          diagnostics: cursorDiagnostics
        });
      const response = await collectCursorSubscriptionResponse(requestedModel, events);
      return { ok: true, status: 200, payload: applyCursorToolCompatibility(response, body.tools || []) };
    });
    runtimeStates.set(providerKey(provider), "connected");
    return result;
  } catch (error) {
    const status = Number(error?.status) || (error?.code === "CURSOR_SUBSCRIPTION_CIRCUIT_OPEN" ? 503 : 502);
    runtimeStates.set(providerKey(provider), status === 401 || status === 403 ? "auth_invalid" : lane.snapshot().state);
    return { ok: false, status, payload: { error: { code: error?.code || "CURSOR_SUBSCRIPTION_UPSTREAM_ERROR", message: redactCursorSubscriptionError(error) } } };
  }
}

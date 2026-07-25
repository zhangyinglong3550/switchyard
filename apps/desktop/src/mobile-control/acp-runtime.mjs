import path from "node:path";
import { mergeTool, toolFrom, toolMessage } from "./message-parts.mjs";

const BASE_CAPABILITIES = Object.freeze({
  sendMessage: true,
  setModel: true,
  setEffort: false,
  cancel: true,
  rename: false,
  archive: false,
  unarchive: false,
  delete: true,
  fork: true,
  compact: false,
  approve: true
});

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("\n");
  if (!content || typeof content !== "object") return "";
  return String(content.text || content.content || "");
}

function updateEvent(frame) {
  const params = frame.params || {};
  const update = params.update || {};
  const kind = String(update.sessionUpdate || "");
  const rawText = textOf(update.content);
  let type = "status";
  let role = null;
  let summary = "";
  if (kind === "user_message_chunk") {
    type = "message";
    role = "user";
    summary = textOf(update.content);
  } else if (kind === "agent_message_chunk") {
    type = "message";
    role = "assistant";
    summary = textOf(update.content);
  } else if (kind === "agent_thought_chunk" || kind === "agent_thought") {
    type = "thinking";
    role = "assistant";
    summary = textOf(update.content);
  } else if (kind === "tool_call" || kind === "tool_call_update") {
    type = "tool";
    role = "tool";
    summary = update.title || update.toolCallId || "工具调用";
  } else if (kind === "session_info_update") {
    // ACP sends metadata churn (title/timestamp) very frequently. It is not a
    // turn-state transition and must not make the mobile chat look like it is
    // continuously reconnecting or refreshing.
    type = "metadata";
    summary = "";
  } else if (kind === "usage_update") {
    type = "usage";
    summary = "";
  } else {
    // Unknown ACP updates (such as available_commands_update) are transport
    // metadata. Do not publish them as chat state updates.
    type = "metadata";
    summary = rawText || "";
  }
  return {
    sessionId: String(params.sessionId || ""),
    type,
    summary,
    role,
    runtimeEvent: kind || frame.method,
    tool: type === "tool" ? toolFrom({
      id: update.toolCallId,
      name: update.toolName || update.kind || update.title || "工具调用",
      title: update.title,
      input: update.rawInput,
      output: update.rawOutput,
      status: update.status || (kind === "tool_call" ? "running" : "completed")
    }, kind === "tool_call" ? "running" : "completed") : null
  };
}

function requestEvent(frame) {
  const params = frame.params || {};
  return {
    sessionId: String(params.sessionId || ""),
    type: frame.method === "session/request_permission" ? "approval" : "status",
    summary: frame.method === "session/request_permission" ? "等待操作审批" : String(frame.method || ""),
    runtimeEvent: frame.method,
    requestId: frame.id,
    request: params
  };
}

function availableCommands(update = {}) {
  const rows = update.availableCommands || update.commands || update.content?.commands || [];
  return (Array.isArray(rows) ? rows : []).map((item) => typeof item === "string"
    ? { name: item.replace(/^\//, ""), description: "Agent 命令" }
    : { name: String(item?.name || item?.command || "").replace(/^\//, ""), description: item?.description || item?.title || "Agent 命令" })
    .filter((item) => item.name);
}

function normalizeSession(row, capabilities) {
  const cwd = String(row.cwd || "");
  return {
    id: String(row.sessionId || row.id || ""),
    agentId: "",
    name: row.title || row.sessionId || row.id || "Agent 任务",
    state: "completed",
    updatedAt: row.updatedAt || null,
    model: row.modelId || row.model || "",
    directory: cwd,
    project: cwd ? path.basename(cwd) : "",
    archived: false,
    capabilities: { ...capabilities }
  };
}

export function createAcpRuntime({
  id,
  label,
  client,
  overlay,
  capabilityModes = {},
  listSessionsImpl
} = {}) {
  if (!id || !client?.connect || !client?.request || !client?.subscribe) {
    throw new Error("ACP runtime 参数不完整");
  }
  const capabilities = {
    ...BASE_CAPABILITIES,
    rename: Boolean(overlay?.rename),
    archive: Boolean(overlay?.archive),
    unarchive: Boolean(overlay?.unarchive)
  };
  const subscribers = new Set();
  const sessions = new Map();
  const messages = new Map();
  const pendingPrompts = new Map();
  const loadedSessions = new Set();
  let dynamicCommands = [];

  client.subscribe((frame) => {
    if (frame.kind === "notification" && frame.method === "session/update") {
      const update = frame.params?.update || {};
      if (String(update.sessionUpdate || "") === "available_commands_update") {
        dynamicCommands = availableCommands(update);
        return;
      }
      const event = updateEvent(frame);
      if (["message", "thinking"].includes(event.type) && event.summary) {
        const rows = messages.get(event.sessionId) || [];
        const previous = rows.at(-1);
        if (previous && previous.role === event.role && previous.kind === event.runtimeEvent) previous.text += event.summary;
        else rows.push({ role: event.role, text: event.summary, kind: event.type === "thinking" ? "thinking" : event.runtimeEvent });
        messages.set(event.sessionId, rows.slice(-500));
      } else if (event.type === "tool" && event.tool) {
        const rows = messages.get(event.sessionId) || [];
        const previous = event.tool.id ? rows.findLast((row) => row.kind === "tool" && row.tool?.id === event.tool.id) : null;
        if (previous) previous.tool = mergeTool(previous.tool, event.tool);
        else rows.push(toolMessage(event.tool, event.summary));
        messages.set(event.sessionId, rows.slice(-500));
      }
      if (event.type === "metadata" || event.type === "usage") return;
      for (const listener of subscribers) {
        try { listener(event, frame); } catch {}
      }
      return;
    }
    if (frame.kind === "request") {
      const event = requestEvent(frame);
      for (const listener of subscribers) {
        try { listener(event, frame); } catch {}
      }
    }
  });

  const ensureConnected = () => client.connect();

  const listSessions = async ({ cursor, cwd } = {}) => {
    await ensureConnected();
    const result = listSessionsImpl
      ? await listSessionsImpl({ cursor, cwd, client })
      : await client.request("session/list", {
        ...(cursor ? { cursor } : {}),
        ...(cwd ? { cwd } : {})
      });
    const rows = result?.sessions || [];
    return rows.map((row) => {
      const normalized = normalizeSession(row, capabilities);
      normalized.agentId = id;
      sessions.set(normalized.id, normalized);
      return normalized;
    });
  };

  const sessionCwd = async (sessionId) => {
    if (sessions.has(sessionId)) return sessions.get(sessionId).directory;
    const found = (await listSessions()).find((row) => row.id === sessionId);
    return found?.directory || process.cwd();
  };

  const loadSession = async (sessionId) => {
    await ensureConnected();
    const sid = String(sessionId);
    const cwd = await sessionCwd(sid);
    const result = await client.request("session/load", {
      sessionId: sid,
      cwd,
      mcpServers: []
    }, 60_000);
    loadedSessions.add(sid);
    return { result, cwd };
  };

  const readSession = async (sessionId) => {
    const sid = String(sessionId);
    messages.set(sid, []);
    const { result, cwd } = await loadSession(sid);
    const row = sessions.get(sid) || {
      id: sid,
      agentId: id,
      name: sid,
      state: "completed",
      updatedAt: null,
      model: result?.models?.currentModelId || "",
      directory: cwd,
      project: path.basename(cwd),
      archived: false,
      capabilities: { ...capabilities }
    };
    return {
      ...row,
      model: result?.models?.currentModelId || row.model || "",
      messages: (messages.get(sid) || []).map((message) => ({ ...message }))
    };
  };

  const createSession = async ({ cwd, model } = {}) => {
    await ensureConnected();
    const result = await client.request("session/new", {
      cwd: String(cwd || process.cwd()),
      mcpServers: []
    }, 60_000);
    const sessionId = String(result?.sessionId || "");
    if (!sessionId) throw new Error(`${label || id} 未返回 session id`);
    loadedSessions.add(sessionId);
    sessions.set(sessionId, {
      id: sessionId,
      agentId: id,
      name: sessionId,
      state: "completed",
      updatedAt: null,
      model: result?.models?.currentModelId || "",
      directory: String(cwd || process.cwd()),
      project: path.basename(String(cwd || process.cwd())),
      archived: false,
      capabilities: { ...capabilities }
    });
    if (model) await client.request("session/set_model", { sessionId, modelId: String(model) });
    return { sessionId };
  };

  const sendMessage = async (sessionId, { text, messageId, attachments = [] } = {}) => {
    await ensureConnected();
    const sid = String(sessionId);
    // ACP agents keep resume state in their process. A mobile request can arrive
    // after the service restarted, so reload the shared CLI session before prompt.
    if (!loadedSessions.has(sid)) await loadSession(sid);
    const prompt = client.request("session/prompt", {
      sessionId: sid,
      ...(messageId ? { messageId: String(messageId) } : {}),
      prompt: [
        ...(() => {
          const files = attachments.filter((attachment) => attachment.kind !== "image")
            .map((attachment) => `\n\n<attachment name="${attachment.name}">\n${attachment.text || `本地文件路径：${attachment.path || "不可用"}`}\n</attachment>`).join("");
          const promptText = `${String(text || "")}${files}`;
          return promptText ? [{ type: "text", text: promptText }] : [];
        })(),
        ...attachments.filter((attachment) => attachment.kind === "image").map((attachment) => ({ type: "image", data: attachment.data, mimeType: attachment.mimeType }))
      ]
    }, 24 * 60 * 60 * 1000);
    pendingPrompts.set(sid, prompt);
    prompt.then((result) => {
      pendingPrompts.delete(sid);
      const event = {
        sessionId: sid,
        type: "status",
        summary: String(result?.stopReason || "completed"),
        runtimeEvent: "session/prompt:completed"
      };
      for (const listener of subscribers) {
        try { listener(event); } catch {}
      }
    }).catch((error) => {
      pendingPrompts.delete(sid);
      const event = {
        sessionId: sid,
        type: "error",
        summary: error?.message || String(error),
        runtimeEvent: "session/prompt:failed"
      };
      for (const listener of subscribers) {
        try { listener(event); } catch {}
      }
    });
    await Promise.resolve();
    return { accepted: true };
  };

  const setModel = async (sessionId, modelId) => {
    await ensureConnected();
    if (!loadedSessions.has(String(sessionId))) await loadSession(sessionId);
    await client.request("session/set_model", {
      sessionId: String(sessionId),
      modelId: String(modelId)
    });
  };

  const cancel = async (sessionId) => {
    await ensureConnected();
    client.notify("session/cancel", { sessionId: String(sessionId) });
  };

  const fork = async (sessionId) => {
    await ensureConnected();
    const sid = String(sessionId);
    const result = await client.request("session/fork", {
      sessionId: sid,
      cwd: await sessionCwd(sid),
      mcpServers: []
    });
    const nextId = String(result?.sessionId || "");
    if (nextId) loadedSessions.add(nextId);
    return { sessionId: nextId };
  };

  const remove = async (sessionId) => {
    await ensureConnected();
    await client.request("session/delete", { sessionId: String(sessionId) });
    loadedSessions.delete(String(sessionId));
  };

  return {
    id,
    label: label || id,
    client,
    capabilities,
    capabilityModes: {
      rename: overlay?.rename ? "overlay" : "unsupported",
      archive: overlay?.archive ? "overlay" : "unsupported",
      unarchive: overlay?.unarchive ? "overlay" : "unsupported",
      setModel: "native",
      fork: "native",
      delete: "native",
      ...capabilityModes
    },
    listSessions,
    readSession,
    createSession,
    sendMessage,
    setModel,
    cancel,
    rename: overlay?.rename
      ? (sessionId, title) => overlay.rename(String(sessionId), String(title || "").trim().slice(0, 200))
      : undefined,
    archive: overlay?.archive
      ? (sessionId) => overlay.archive(String(sessionId))
      : undefined,
    unarchive: overlay?.unarchive
      ? (sessionId) => overlay.unarchive(String(sessionId))
      : undefined,
    fork,
    delete: remove,
    listCommands() { return dynamicCommands.map((item) => ({ ...item })); },
    respond(requestId, result, error) {
      client.respond(requestId, result, error);
    },
    subscribe(handler) {
      if (typeof handler !== "function") throw new TypeError("subscriber 必须是函数");
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
    close() {
      client.close?.();
    }
  };
}

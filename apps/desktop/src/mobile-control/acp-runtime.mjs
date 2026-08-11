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

/** ACP 完成态常回 end_turn；手机 UI 只认 completed 等标准状态。 */
function normalizeStopReason(value) {
  const reason = String(value || "completed").trim().toLowerCase();
  if (!reason || ["end_turn", "stop", "max_tokens", "length", "completed", "end"].includes(reason)) {
    return "completed";
  }
  return String(value || "completed");
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
  const streamedDuringPrompt = new Set();
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
      // 发送中的 user 回声：live 已有锚点、手机账本也已投影，跳过。
      // session/load 回放不在 pendingPrompts 内，仍需写入 live 供 readSession。
      if (event.runtimeEvent === "user_message_chunk") {
        if (!pendingPrompts.has(event.sessionId) && event.summary) {
          const rows = messages.get(event.sessionId) || [];
          const previous = rows.at(-1);
          if (previous && previous.role === "user" && previous.kind === "text") previous.text += event.summary;
          else rows.push({ role: "user", text: event.summary, kind: "text" });
          messages.set(event.sessionId, rows.slice(-500));
        }
        return;
      }
      if (["message", "thinking"].includes(event.type) && event.summary) {
        const rows = messages.get(event.sessionId) || [];
        const previous = rows.at(-1);
        // 存盘 kind 用 thinking/text 语义；比较必须与写入一致，否则每个 thought chunk 都会新建一行。
        const nextKind = event.type === "thinking"
          ? "thinking"
          : event.role === "assistant" ? "text" : (event.runtimeEvent || "text");
        if (previous && previous.role === event.role && previous.kind === nextKind) previous.text += event.summary;
        else rows.push({ role: event.role, text: event.summary, kind: nextKind });
        messages.set(event.sessionId, rows.slice(-500));
        if (event.type === "message" && event.role === "assistant" && pendingPrompts.has(event.sessionId)) {
          streamedDuringPrompt.add(event.sessionId);
        }
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
    const params = { sessionId: sid, cwd, mcpServers: [] };
    // Grok ACP 只实现 session/resume（sessionCapabilities.resume），没有 session/load；
    // 其他 ACP agent 用 session/load。先试 load，-32601 时降级 resume，避免续聊落到错误会话。
    let result;
    try {
      result = await client.request("session/load", params, 60_000);
    } catch (error) {
      const code = Number(error?.code);
      if (code === -32601 || /method\s+not\s+found/i.test(String(error?.message || ""))) {
        console.error(`[acp:${id}] session/load 不可用，降级 session/resume sid=${String(sid).slice(0, 8)}`);
        result = await client.request("session/resume", params, 60_000);
      } else {
        throw error;
      }
    }
    console.error(`[acp:${id}] loadSession OK sid=${String(sid).slice(0, 8)} cwd=${cwd}`);
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
    let result;
    try {
      result = await client.request("session/new", {
        cwd: String(cwd || process.cwd()),
        mcpServers: []
      }, 60_000);
    } catch (error) {
      console.error(`[acp:${id}] session/new 失败 cwd=${cwd || process.cwd()}: ${error?.message || JSON.stringify(error)}`);
      throw error;
    }
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
    if (model) {
      // 模型切换是可选增强：set_model 失败不应阻塞会话创建（模型下轮生效可再设）。
      try {
        await client.request("session/set_model", { sessionId, modelId: String(model) });
      } catch (error) {
        console.error(`[acp:${id}] set_model 失败（忽略）: ${error?.message || error}`);
      }
    }
    return { sessionId };
  };

  const sendMessage = async (sessionId, { text, messageId, attachments = [] } = {}) => {
    console.error(`[acp:${id}] sendMessage 进入 sid=${String(sessionId).slice(0, 8)}`);
    await ensureConnected();
    console.error(`[acp:${id}] sendMessage ensureConnected 完成`);
    const sid = String(sessionId);
    // ACP agents keep resume state in their process. A mobile request can arrive
    // after the service restarted, so reload the shared CLI session before prompt.
    // Grok 的 active 会话是进程级状态：任何 readSession/resume 都会切换它，
    // 因此发送前必须无条件 resume，否则 prompt 会落到当前 active 会话（错误会话）。
    await loadSession(sid);
    // messageId 只用于 Switchyard 端幂等；不要传给 session/prompt。
    // Grok 对未知字段会在流式结束后回 -32603 Internal error，导致手机先看到回答再报错。
    void messageId;
    // 发送时写入 user 锚点，供 mergeGrokLiveTail / liveMessages 截取「本轮」；
    // Agent 回声的 user_message_chunk 仍不向手机账本转发。
    const promptText = String(text || "").trim();
    if (promptText) {
      const rows = messages.get(sid) || [];
      rows.push({ role: "user", text: promptText, kind: "text" });
      messages.set(sid, rows.slice(-500));
    }
    const prompt = client.request("session/prompt", {
      sessionId: sid,
      prompt: [
        ...(() => {
          const files = attachments.filter((attachment) => attachment.kind !== "image")
            .map((attachment) => `\n\n<attachment name="${attachment.name}">\n${attachment.text || `本地文件路径：${attachment.path || "不可用"}`}\n</attachment>`).join("");
          const body = `${String(text || "")}${files}`;
          return body ? [{ type: "text", text: body }] : [];
        })(),
        ...attachments.filter((attachment) => attachment.kind === "image").map((attachment) => ({ type: "image", data: attachment.data, mimeType: attachment.mimeType }))
      ]
    }, 24 * 60 * 60 * 1000);
    console.error(`[acp:${id}] sendMessage prompt sid=${String(sid).slice(0, 8)} text=${String(text || "").slice(0, 40)}`);
    pendingPrompts.set(sid, prompt);
    streamedDuringPrompt.delete(sid);
    prompt.then((result) => {
      pendingPrompts.delete(sid);
      streamedDuringPrompt.delete(sid);
      const event = {
        sessionId: sid,
        type: "status",
        summary: normalizeStopReason(result?.stopReason),
        runtimeEvent: "session/prompt:completed"
      };
      for (const listener of subscribers) {
        try { listener(event); } catch {}
      }
    }).catch((error) => {
      pendingPrompts.delete(sid);
      const hadStream = streamedDuringPrompt.delete(sid);
      // Grok 常见：正文已通过 agent_message_chunk 推完，收尾 RPC 仍回 -32603 /
      // Internal error。若已有流式内容，按完成处理，避免手机刷盘把回答冲掉。
      const errorCode = Number(error?.code);
      const errorMessage = String(error?.message || error || "");
      const softComplete = hadStream && (errorCode === -32603 || /internal\s*error/i.test(errorMessage));
      if (softComplete) {
        const event = {
          sessionId: sid,
          type: "status",
          summary: "completed",
          runtimeEvent: "session/prompt:soft-completed"
        };
        for (const listener of subscribers) {
          try { listener(event); } catch {}
        }
        return;
      }
      const detail = error?.data && typeof error.data === "object"
        ? JSON.stringify(error.data).slice(0, 400)
        : "";
      const codeLabel = Number.isFinite(Number(error?.code)) ? `（${error.code}）` : "";
      const summary = `${error?.message || String(error)}${codeLabel}${detail ? ` ${detail}` : ""}`.trim();
      const failed = {
        sessionId: sid,
        type: "error",
        summary,
        runtimeEvent: "session/prompt:failed"
      };
      const status = {
        sessionId: sid,
        type: "status",
        summary: "failed",
        runtimeEvent: "session/prompt:failed-status"
      };
      for (const listener of subscribers) {
        try { listener(failed); } catch {}
        try { listener(status); } catch {}
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
    liveMessages(sessionId) {
      return (messages.get(String(sessionId)) || []).map((message) => ({ ...message, ...(message.tool ? { tool: { ...message.tool } } : {}) }));
    },
    isBusy(sessionId) {
      return pendingPrompts.has(String(sessionId));
    },
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

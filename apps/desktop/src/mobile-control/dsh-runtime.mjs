import path from "node:path";
import { createDshHostClient } from "./dsh-host-client.mjs";
import { toolFrom, toolMessage, mergeTool } from "./message-parts.mjs";

/**
 * DeepSeek Harness (DSH) mobile runtime。
 *
 * 通过 dsh-host-client 连接 DSH host（优先附着 DSH Desktop，其次自托管
 * `dsh web`），用其 HTTP API 完成会话列表 / 历史 / 发送 / 停止 / 重命名，
 * 并把 events.mux 事件流折算成 Switchyard 的移动端运行时事件。
 *
 * 附着模式下手机与桌面共享同一个 host：手机发的消息桌面实时可见，
 * 桌面正在跑的任务手机也能实时看到 chunk 级流式输出。
 */

const CAPABILITIES = Object.freeze({
  sendMessage: true,
  setModel: true,
  setEffort: true,
  cancel: true,
  rename: true,
  archive: true,
  unarchive: true,
  delete: false,
  fork: true,
  compact: false,
  approve: true
});

function blockText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
}

function isRealUserMessage(event) {
  const data = event?.data || {};
  const source = data.source || data.message?.source || {};
  return source.kind === "user";
}

/**
 * 把 DSH 会话事件（session.history 返回的 event 列表）投影为移动端消息行。
 * 规则：
 *  - user/message 只保留 source.kind === "user" 的真人输入（插件注入的
 *    runtime context / system reminder 全部跳过）。
 *  - assistant/message 的 text 块是回答；thinking/reasoning 块是思考过程。
 *  - tool/call 与 tool/result 按 callId 合并成一张工具卡。
 */
export function projectDshHistoryEvents(events = []) {
  const rows = [];
  const toolById = new Map();
  for (const entry of events) {
    const event = entry?.event || entry;
    if (!event || typeof event !== "object") continue;
    const type = String(event.type || "");
    const data = event.data || {};
    if (type === "user/message" && isRealUserMessage(event)) {
      const text = blockText(data.content);
      if (text) rows.push({ role: "user", text, kind: "text", timestamp: event.time || null, turnId: data.turn });
      continue;
    }
    if (type === "assistant/message") {
      const message = data.message || {};
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type === "text" && String(block.text || "").trim()) {
          rows.push({ role: "assistant", text: String(block.text), kind: "text", timestamp: event.time || null, turnId: data.turn });
        } else if ((block?.type === "thinking" || block?.type === "reasoning") && String(block.text || "").trim()) {
          rows.push({ role: "assistant", text: String(block.text), kind: "thinking", timestamp: event.time || null, turnId: data.turn });
        }
      }
      continue;
    }
    if (type === "todo/write") {
      // DSH 的任务清单：整表重写（content/status），手机端每轮取最后一次渲染成步骤卡。
      const todos = Array.isArray(data.todos) ? data.todos : [];
      if (!todos.length) continue;
      rows.push(toolMessage(toolFrom({
        id: `todos-${event.seq}`,
        name: "todo_write",
        input: JSON.stringify({ todos }),
        status: "completed"
      }, "completed"), "更新任务清单"));
      continue;
    }
    if (type === "tool/call") {
      const tool = toolFrom({
        id: data.callId,
        name: data.name,
        input: data.arguments,
        status: "running"
      }, "running");
      const message = toolMessage(tool, tool.title || tool.name);
      rows.push(message);
      if (tool.id) toolById.set(tool.id, message);
      continue;
    }
    if (type === "tool/result") {
      const resultMessage = data.message || {};
      const callId = String(resultMessage.source?.callId || data.callId || "");
      const inner = Array.isArray(resultMessage.content) ? resultMessage.content : [];
      let output = "";
      let failed = false;
      for (const part of inner) {
        const nested = Array.isArray(part?.content) ? part.content : [];
        for (const piece of nested) {
          if (typeof piece?.text === "string") output += piece.text;
        }
        if (part?.isError) failed = true;
      }
      const existing = toolById.get(callId);
      const patch = toolFrom({
        id: callId,
        name: existing?.tool?.name || "工具调用",
        output: output || undefined,
        status: failed ? "failed" : "completed"
      }, failed ? "failed" : "completed");
      if (existing) existing.tool = mergeTool(existing.tool, patch);
      else rows.push(toolMessage(patch, output.slice(0, 200) || "工具结果"));
      continue;
    }
  }
  return rows.slice(-500);
}

function historyEventsOrdered(events = []) {
  const rows = events.filter((entry) => entry?.event || entry);
  const seqOf = (row) => Number(row.event?.seq ?? row.seq ?? 0);
  // session.history 按新到旧分页（beforeSeq 回溯）；投影前统一转成旧到新。
  if (rows.length > 1 && seqOf(rows[0]) > seqOf(rows.at(-1))) {
    return rows.slice().reverse();
  }
  return rows;
}

function titleOf(item = {}) {
  const values = item.projections?.values || {};
  return String(values.title || "").trim();
}

function isoTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

/** DSH 原生 goal（goal/change + 投影）→ 手机端目标面板结构。 */
export function dshGoalFromProjection(value) {
  const goal = value?.goal && typeof value.goal === "object" ? value.goal : value;
  if (!goal || typeof goal !== "object") return null;
  const objective = String(goal.objective || "").trim();
  if (!objective) return null;
  const phase = String(goal.phase || goal.status || "active").toLowerCase();
  return {
    objective: objective.slice(0, 500),
    status: phase === "complete" || phase === "completed" || phase === "done" ? "complete" : phase === "blocked" ? "blocked" : "in_progress",
    createdAt: goal.createdAt || null,
    updatedAt: goal.updatedAt || null,
    completedAt: phase.includes("complete") ? goal.updatedAt || null : null,
    blockedReason: null,
    tokenBudget: null,
    tokenUsage: null,
    plan: []
  };
}

export function createDeepSeekRuntime({
  command,
  env,
  hostClient,
  overlay,
  log = () => {}
} = {}) {
  const client = hostClient || createDshHostClient({ command, env, log });
  const subscribers = new Set();
  const sessionRows = new Map();
  const selectedModels = new Map();
  // 本轮是否已经见过流式 delta；决定 assistant/message 到达时是否还需要整段补发。
  const streamedTurns = new Set();
  const approvalByRequestId = new Map();

  const emit = (event) => {
    for (const handler of subscribers) {
      try { handler(event); } catch {}
    }
  };

  const rememberRow = (item) => {
    const cwd = String(item.cwd || "");
    const row = {
      id: String(item.sessionId),
      agentId: "deepseek-harness",
      name: titleOf(item) || String(item.sessionId),
      state: item.running ? "running" : "completed",
      updatedAt: isoTime(item.updatedAt),
      model: "",
      directory: cwd,
      project: cwd ? path.basename(cwd) : "",
      archived: false,
      capabilities: { ...CAPABILITIES }
    };
    sessionRows.set(row.id, row);
    return row;
  };

  const listSessions = async () => {
    const value = await client.rpc("session.list", {});
    const items = Array.isArray(value?.items) ? value.items : [];
    const rows = [];
    for (const item of items) {
      if (item.origin === "subagent" || item.parentSessionId) continue;
      if (item.blank) continue;
      rows.push(rememberRow(item));
    }
    return rows;
  };

  const readSession = async (sessionId, { messageLimit = 500 } = {}) => {
    const sid = String(sessionId);
    let base = sessionRows.get(sid);
    if (!base) {
      const value = await client.rpc("session.list", {});
      base = (value?.items || []).find((item) => String(item.sessionId) === sid);
      if (base) base = rememberRow(base);
    }
    const history = await client.rpc("session.history", { sessionId: sid, maxMessages: Math.min(500, Math.max(1, messageLimit)) });
    const events = historyEventsOrdered(Array.isArray(history?.events) ? history.events : []);
    const messages = projectDshHistoryEvents(events);
    const values = history?.projections?.values || {};
    // DSH 原生 goal 优先；没有时 registry 会从 todo_write 工具流推导。
    const nativeGoal = dshGoalFromProjection(values.goal);
    return {
      id: sid,
      agentId: "deepseek-harness",
      nativeId: sid,
      name: String(values.title || base?.name || sid),
      title: String(values.title || base?.name || sid),
      state: base?.state || "completed",
      updatedAt: base?.updatedAt || null,
      model: selectedModels.get(sid) || "",
      directory: base?.directory || "",
      cwd: base?.directory || "",
      project: base?.project || "",
      archived: false,
      capabilities: { ...CAPABILITIES },
      ...(nativeGoal ? { goal: nativeGoal } : {}),
      messages
    };
  };

  const createSession = async ({ cwd, model, title } = {}) => {
    const value = await client.rpc("session.create", { cwd: String(cwd || process.cwd()) });
    const sid = String(value?.sessionId || "");
    if (!sid) throw new Error("DSH 未返回会话 ID");
    if (title) {
      try { await client.rpc("session.rename", { sessionId: sid, title: String(title).slice(0, 120) }); } catch {}
    }
    if (model) selectedModels.set(sid, String(model));
    sessionRows.set(sid, {
      id: sid,
      agentId: "deepseek-harness",
      name: String(title || sid),
      state: "completed",
      updatedAt: new Date().toISOString(),
      model: model || "",
      directory: String(cwd || process.cwd()),
      project: path.basename(String(cwd || process.cwd())),
      archived: false,
      capabilities: { ...CAPABILITIES }
    });
    return { sessionId: sid };
  };

  const sendMessage = async (sessionId, { text = "", attachments = [] } = {}) => {
    const sid = String(sessionId);
    const images = attachments.filter((item) => item.kind === "image");
    const textAttachments = attachments.filter((item) => item.kind !== "image");
    const attachmentContext = textAttachments
      .map((item) => `\n\n<attachment name="${item.name}">\n${String(item.text || "").slice(0, 200_000)}\n</attachment>`)
      .join("");
    const content = [];
    const body = `${String(text || "")}${attachmentContext}`;
    if (body.trim()) content.push({ type: "text", text: body });
    for (const image of images) {
      content.push({
        type: "image",
        mediaType: image.mimeType,
        data: image.data,
        ...(image.name ? { name: image.name } : {})
      });
    }
    if (!content.length) throw new Error("消息内容为空");
    await client.rpc("session.prompt", { sessionId: sid, mode: "queue", content });
    return { accepted: true };
  };

  const modelCatalogCache = new Map();
  const modelCatalog = async (sessionId) => {
    const cached = modelCatalogCache.get(String(sessionId));
    if (cached && Date.now() - cached.at < 60_000) return cached.value;
    const value = await client.rpc("session.models", { sessionId: String(sessionId) });
    modelCatalogCache.set(String(sessionId), { at: Date.now(), value });
    return value;
  };

  const resolveModelTarget = async (sessionId, modelId) => {
    const catalog = await modelCatalog(sessionId).catch(() => null);
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
    for (const group of groups) {
      for (const model of Array.isArray(group.models) ? group.models : []) {
        if (String(model.id) === String(modelId) || String(model.name) === String(modelId)) {
          return { provider: String(group.id), model: String(model.id) };
        }
      }
    }
    // Switchyard 网关模型统一挂在 switchyard provider 下，模型 id 原样传递。
    return { provider: "switchyard", model: String(modelId) };
  };

  const setModel = async (sessionId, modelId, effort) => {
    const sid = String(sessionId);
    const target = await resolveModelTarget(sid, String(modelId));
    const args = { sessionId: sid, ...target };
    if (effort && effort !== "off") args.reasoningEffort = String(effort);
    await client.rpc("session.selectModel", args);
    selectedModels.set(sid, String(modelId));
    selectedEfforts.set(sid, effort || "");
    return { ok: true };
  };

  // DSH 思考等级：跟随当前模型声明的 reasoningEfforts；默认按常见档位展示。
  const selectedEfforts = new Map();
  const effortOptionsFor = async (sessionId) => {
    try {
      const catalog = await modelCatalog(sessionId);
      const current = catalog?.current;
      for (const group of Array.isArray(catalog?.groups) ? catalog.groups : []) {
        for (const model of Array.isArray(group.models) ? group.models : []) {
          if (current && String(model.id) === String(current.model)) {
            const efforts = model.reasoning?.efforts;
            if (Array.isArray(efforts) && efforts.length) return efforts.map((item) => String(item.id)).filter(Boolean);
          }
        }
      }
    } catch {}
    return ["off", "low", "high", "max"];
  };
  const setSettings = async (sessionId, { effort, permissionMode } = {}) => {
    const sid = String(sessionId);
    if (effort) selectedEfforts.set(sid, String(effort));
    // 思考档位挂在当前模型上：没有显式选过模型时，用会话当前模型。
    let modelId = selectedModels.get(sid) || "";
    if (!modelId) {
      try {
        const catalog = await modelCatalog(sid);
        modelId = catalog?.current?.model || "";
      } catch {}
    }
    if (!modelId) throw new Error("当前会话没有可用模型");
    const target = await resolveModelTarget(sid, String(modelId));
    const args = { sessionId: sid, ...target };
    const effortValue = selectedEfforts.get(sid) || effort || "";
    if (effortValue && effortValue !== "off") args.reasoningEffort = String(effortValue);
    await client.rpc("session.selectModel", args);
    return { ok: true };
  };

  // 思考等级跟随当前模型声明（与桌面端一致）：读 session.models 的
  // reasoning.efforts，读不到时回退常见档位。
  const getSettings = async (sessionId) => {
    const sid = String(sessionId);
    const effortOptions = await effortOptionsFor(sid);
    const current = selectedEfforts.get(sid) || "";
    return { effort: current || null, effortOptions };
  };

  const cancel = async (sessionId) => {
    await client.rpc("session.cancel", { sessionId: String(sessionId) });
  };

  // DSH host 原生 skill.list：手机端输入 / 时展示真实可用的 Skills。
  let dshSkillsCache = { at: 0, rows: [] };
  const listCommands = async () => {
    if (Date.now() - dshSkillsCache.at < 60_000) return dshSkillsCache.rows;
    try {
      const value = await client.rpc("skill.list", {});
      const skills = Array.isArray(value?.skills) ? value.skills : [];
      dshSkillsCache = { at: Date.now(), rows: skills
        .filter((item) => String(item?.name || "").trim())
        .map((item) => ({
          name: String(item.name).trim().replace(/^\/+/, ""),
          description: String(item.description || "").trim() || "DSH Skill",
          kind: "skill",
          insertText: `/${String(item.name).trim().replace(/^\/+/, "")} `
        })) };
    } catch {
      dshSkillsCache = { at: Date.now(), rows: [] };
    }
    return dshSkillsCache.rows;
  };

  const rename = async (sessionId, title) => {
    await client.rpc("session.rename", { sessionId: String(sessionId), title: String(title || "").slice(0, 200) });
  };

  const fork = async (sessionId) => {
    const value = await client.rpc("session.fork", { sessionId: String(sessionId) });
    return { sessionId: String(value?.sessionId || "") };
  };

  /** 手机端审批回复：optionId 由本 runtime 自己定义（allow / reject）。 */
  const respond = async (requestId, payload = {}) => {
    const approval = approvalByRequestId.get(String(requestId));
    if (!approval) throw new Error("审批请求不存在或已过期");
    const optionId = String(payload?.outcome?.optionId || "");
    const outcome = optionId === "allow" ? "allowed-once" : optionId === "reject" ? "rejected" : "";
    if (!outcome) throw new Error("审批决定无效");
    approvalByRequestId.delete(String(requestId));
    await client.respond(String(requestId), {
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      outcome
    });
    return { ok: true };
  };

  // ---- events.mux → runtime 事件 ----
  const handleSessionEvent = (sessionId, event) => {
    const type = String(event?.type || "");
    const data = event?.data || {};
    if (type === "turn/start") {
      streamedTurns.delete(`${sessionId}:${data.turn}`);
      emit({ sessionId, type: "status", summary: "running", runtimeEvent: "dsh/turn-start" });
      return;
    }
    if (type === "assistant/chunk") {
      const chunk = data.chunk || {};
      if (chunk.type === "text-delta" && chunk.text) {
        streamedTurns.add(`${sessionId}:${data.turn}`);
        emit({ sessionId, type: "message", role: "assistant", summary: String(chunk.text), runtimeEvent: "dsh/text-delta" });
      } else if (chunk.type === "block-start" && (chunk.blockType === "thinking" || chunk.blockType === "reasoning")) {
        streamedTurns.add(`${sessionId}:thinking:${data.turn}`);
      } else if (chunk.type === "thinking-delta" && chunk.text) {
        streamedTurns.add(`${sessionId}:${data.turn}`);
        emit({ sessionId, type: "thinking", role: "assistant", summary: String(chunk.text), runtimeEvent: "dsh/thinking-delta" });
      }
      return;
    }
    if (type === "assistant/message") {
      // 已经流式输出的轮次不再整段补发，否则手机端会出现重复气泡。
      if (streamedTurns.has(`${sessionId}:${data.turn}`)) return;
      const message = data.message || {};
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "text" && String(block.text || "").trim()) {
          emit({ sessionId, type: "message", role: "assistant", summary: String(block.text), runtimeEvent: "dsh/assistant-message" });
        } else if ((block?.type === "thinking" || block?.type === "reasoning") && String(block.text || "").trim()) {
          emit({ sessionId, type: "thinking", role: "assistant", summary: String(block.text), runtimeEvent: "dsh/assistant-thinking" });
        }
      }
      return;
    }
    if (type === "tool/call") {
      const tool = toolFrom({ id: data.callId, name: data.name, input: data.arguments, status: "running" }, "running");
      emit({ sessionId, type: "tool", role: "tool", summary: tool.title || tool.name, tool, runtimeEvent: "dsh/tool-call" });
      return;
    }
    if (type === "tool/result") {
      const resultMessage = data.message || {};
      const callId = String(resultMessage.source?.callId || data.callId || "");
      const inner = Array.isArray(resultMessage.content) ? resultMessage.content : [];
      let output = "";
      let failed = false;
      for (const part of inner) {
        for (const piece of Array.isArray(part?.content) ? part.content : []) {
          if (typeof piece?.text === "string") output += piece.text;
        }
        if (part?.isError) failed = true;
      }
      const tool = toolFrom({ id: callId, output: output || undefined, status: failed ? "failed" : "completed" }, failed ? "failed" : "completed");
      emit({ sessionId, type: "tool", role: "tool", summary: tool.title || tool.name, tool, runtimeEvent: "dsh/tool-result" });
      return;
    }
    if (type === "todo/write") {
      const todos = Array.isArray(data.todos) ? data.todos : [];
      if (!todos.length) return;
      // 固定 id：手机端按 data-tool-id 命中同一张卡，原地刷新步骤进度。
      const tool = toolFrom({
        id: "dsh-todos",
        name: "todo_write",
        input: JSON.stringify({ todos }),
        status: "completed"
      }, "completed");
      emit({ sessionId, type: "tool", role: "tool", summary: tool.title || "更新任务清单", tool, runtimeEvent: "dsh/todo-write" });
      return;
    }
    if (type === "goal/change") {
      const goal = dshGoalFromProjection(data.goal ? { goal: data.goal, createdAt: data.createdAt, updatedAt: data.updatedAt } : null);
      if (goal) emit({ sessionId, type: "status", summary: "running", goal, runtimeEvent: "dsh/goal-change" });
      return;
    }
    if (type === "turn/end") {
      const reason = String(data.reason?.kind || "completed");
      const summary = reason === "error" ? "failed" : reason === "cancelled" || reason === "canceled" ? "cancelled" : "completed";
      emit({ sessionId, type: "status", summary, runtimeEvent: "dsh/turn-end" });
      return;
    }
    if (type === "approval/asked") {
      emit({ sessionId, type: "status", summary: "waiting_for_approval", runtimeEvent: "dsh/approval-asked" });
      return;
    }
    if (type === "approval/decided") {
      emit({ sessionId, type: "status", summary: "running", runtimeEvent: "dsh/approval-decided" });
      return;
    }
    if (type === "session/title") {
      const row = sessionRows.get(sessionId);
      if (row) row.name = String(data.title || row.name);
      return;
    }
  };

  client.subscribe((envelope) => {
    const payload = envelope?.payload || {};
    const frameType = String(payload.type || "");
    if (frameType === "session/event") {
      handleSessionEvent(String(payload.sessionId), payload.event);
      return;
    }
    if (frameType === "approval/requested") {
      const requestId = String(envelope.rpcId || "");
      const approvalId = String(payload.approvalId || "");
      approvalByRequestId.set(requestId, { sessionId: String(payload.sessionId), approvalId });
      emit({
        sessionId: String(payload.sessionId),
        type: "approval",
        requestId,
        runtimeEvent: "dsh/approval",
        request: {
          method: "dsh/approval",
          reason: String(payload.reason || ""),
          toolName: String(payload.toolName || ""),
          options: [
            { kind: "allow_once", optionId: "allow" },
            { kind: "reject_once", optionId: "reject" }
          ]
        }
      });
      return;
    }
    if (frameType === "approval/resolved") {
      const outcome = String(payload.outcome || "");
      approvalByRequestId.delete(String(envelope.rpcId || ""));
      emit({ sessionId: String(payload.sessionId), type: "approval_resolved", summary: outcome, runtimeEvent: "dsh/approval-resolved" });
      emit({ sessionId: String(payload.sessionId), type: "status", summary: "running", runtimeEvent: "dsh/approval-resolved-status" });
      return;
    }
    if (frameType === "host/session-status") {
      emit({
        sessionId: String(payload.sessionId),
        type: "status",
        summary: payload.running ? "running" : "completed",
        runtimeEvent: "dsh/host-status"
      });
      return;
    }
    if (frameType === "session/queue") {
      const queued = Array.isArray(payload.items) ? payload.items.filter((item) => item.placement === "queued") : [];
      if (queued.length) emit({ sessionId: String(payload.sessionId), type: "status", summary: `queued`, runtimeEvent: "dsh/queue" });
      return;
    }
  });

  return {
    id: "deepseek-harness",
    label: "DeepSeek",
    capabilities: { ...CAPABILITIES },
    capabilityModes: {
      setModel: "next_turn",
      setEffort: "next_turn",
      rename: "native",
      archive: overlay?.archive ? "overlay" : "unsupported",
      unarchive: overlay?.unarchive ? "overlay" : "unsupported",
      fork: "native"
    },
    settings: {
      effortOptions: ["off", "low", "high", "max"],
      permissionOptions: []
    },
    listSessions,
    readSession,
    createSession,
    sendMessage,
    setModel,
    setSettings,
    getSettings,
    cancel,
    rename: (id, title) => rename(id, title),
    archive: overlay?.archive ? (id) => overlay.archive(String(id)) : undefined,
    unarchive: overlay?.unarchive ? (id) => overlay.unarchive(String(id)) : undefined,
    fork,
    respond,
    listCommands,
    subscribe(handler) { subscribers.add(handler); return () => subscribers.delete(handler); },
    close() { client.close(); }
  };
}

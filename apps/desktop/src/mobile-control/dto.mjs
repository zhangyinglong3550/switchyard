import path from "node:path";

const SESSION_STATES = new Set([
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "waiting_for_desktop_approval",
  "completed",
  "failed",
  "cancelled",
  "incomplete"
]);

const SESSION_CAPABILITIES = [
  "sendMessage",
  "setModel",
  "setEffort",
  "cancel",
  "rename",
  "archive",
  "unarchive",
  "delete",
  "fork",
  "compact",
  "approve"
];

const EVENT_TYPES = new Set([
  "status",
  "message",
  "thinking",
  "tool",
  "approval",
  "model",
  "diff",
  "usage",
  "error",
  "file_delivery"
]);

export function cleanMobileText(value, maxLength = 4000) {
  return String(value || "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/g, "[LOCAL_PATH]")
    .slice(0, maxLength);
}

function projectName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return cleanMobileText(path.basename(text), 120);
}

function projectCapabilities(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(
    SESSION_CAPABILITIES
      .filter((key) => source[key] === true)
      .map((key) => [key, true])
  );
}

function projectAsset(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanMobileText(value.id || "", 240);
  if (!id) return null;
  return {
    id,
    name: cleanMobileText(value.name || "文件", 160),
    mimeType: cleanMobileText(value.mimeType || "application/octet-stream", 160),
    kind: ["image", "text", "file", "workspace_file"].includes(value.kind) ? value.kind : "file",
    byteLength: Math.max(0, Number(value.byteLength || 0) || 0),
    source: ["upload", "tool", "delivery"].includes(value.source) ? value.source : "tool",
    createdAt: value.createdAt ? String(value.createdAt) : null,
    updatedAt: value.updatedAt ? String(value.updatedAt) : (value.createdAt ? String(value.createdAt) : null),
    ...(value.deliveryAt ? { deliveryAt: String(value.deliveryAt) } : {}),
    ...(value.expiresAt ? { expiresAt: String(value.expiresAt) } : {}),
    ...(value.activity ? {
      activity: ["read", "search", "edit", "command", "other"].includes(value.activity) ? value.activity : "other"
    } : {})
  };
}

function projectTool(value) {
  if (!value || typeof value !== "object") return null;
  const status = ["pending", "running", "waiting_for_approval", "completed", "failed", "cancelled"].includes(value.status)
    ? value.status
    : "completed";
  return {
    id: cleanMobileText(value.id || "", 240),
    name: cleanMobileText(value.name || "工具调用", 160),
    title: cleanMobileText(value.title || "", 500),
    activity: ["read", "search", "edit", "command", "other"].includes(value.activity) ? value.activity : "other",
    command: cleanMobileText(value.command || "", 8_000),
    arguments: cleanMobileText(value.arguments || "", 12_000),
    status,
    output: cleanMobileText(value.output || "", 20_000),
    error: cleanMobileText(value.error || "", 8_000),
    ...(Number.isFinite(Number(value.durationMs)) ? { durationMs: Math.max(0, Number(value.durationMs)) } : {}),
    ...(Number.isFinite(Number(value.exitCode)) ? { exitCode: Number(value.exitCode) } : {}),
    ...(Array.isArray(value.files) ? { files: value.files.map(projectAsset).filter(Boolean) } : {})
  };
}

export function projectMobileSession(row = {}, overlay = {}) {
  const state = SESSION_STATES.has(row.state) ? row.state : "completed";
  const updatedAt = row.updatedAt || row.mtime || null;
  const directory = String(row.directory || row.cwd || "").trim().slice(0, 500);
  const nativeId = String(row.nativeId || "").trim().slice(0, 240);
  return {
    id: String(row.id || ""),
    agent: String(row.agent || row.agentId || ""),
    title: cleanMobileText(overlay.title || row.title || row.name || row.id || "未命名任务", 200),
    state,
    updatedAt: updatedAt ? String(updatedAt) : null,
    model: cleanMobileText(overlay.model || row.model || "", 160),
    project: projectName(row.project || row.directory || row.cwd || ""),
    // 工作区绝对路径与原生会话 ID 供手机端复制/排障；不做路径脱敏。
    ...(directory ? { directory } : {}),
    ...(nativeId ? { nativeId } : {}),
    pinned: Boolean(overlay.pinned),
    archived: Boolean(overlay.archived ?? row.archived),
    autoApproveSession: Boolean(overlay.autoApproveSession),
    capabilities: projectCapabilities(row.capabilities)
  };
}

function projectRoute(value) {
  if (!value || typeof value !== "object") return null;
  const terminal = value.streamTerminal || value.stream_terminal || {};
  const route = {
    requestedModel: cleanMobileText(value.requestedModel || value.requested_model || "", 160),
    modelId: cleanMobileText(value.modelId || value.model_id || "", 160),
    providerId: cleanMobileText(value.providerId || value.provider_id || "", 160),
    upstreamModel: cleanMobileText(value.upstreamModel || value.upstream_model || "", 160),
    apiFormat: cleanMobileText(value.apiFormat || value.api_format || "", 80),
    account: cleanMobileText(value.account || value.accountEmail || value.account_email || value.accountId || value.account_id || "", 160),
    terminalState: cleanMobileText(terminal.state || terminal.terminalState || value.terminalState || "", 80),
    terminalReason: cleanMobileText(terminal.reason || terminal.terminalReason || value.terminalReason || "", 120)
  };
  return Object.values(route).some(Boolean) ? route : null;
}

function projectGoal(value) {
  if (!value || typeof value !== "object") return null;
  const plan = Array.isArray(value.plan) ? value.plan.map((item) => ({
    step: cleanMobileText(item?.step || "", 500),
    status: ["pending", "in_progress", "running", "doing", "completed", "complete", "done"].includes(String(item?.status || "").toLowerCase()) ? String(item.status).toLowerCase() : "pending"
  })).filter((item) => item.step) : [];
  const objective = cleanMobileText(value.objective || "", 500);
  if (!objective && !plan.length) return null;
  return {
    objective: objective || "执行计划",
    status: ["in_progress", "complete", "blocked"].includes(String(value.status)) ? String(value.status) : "in_progress",
    createdAt: value.createdAt ? String(value.createdAt) : null,
    updatedAt: value.updatedAt ? String(value.updatedAt) : null,
    completedAt: value.completedAt ? String(value.completedAt) : null,
    blockedReason: cleanMobileText(value.blockedReason || "", 1000) || null,
    tokenBudget: Number.isFinite(Number(value.tokenBudget)) ? Number(value.tokenBudget) : null,
    tokenUsage: Number.isFinite(Number(value.tokenUsage)) ? Number(value.tokenUsage) : null,
    plan
  };
}

export function projectMobileEvent(event = {}) {
  return {
    id: Number(event.id) || 0,
    sessionId: String(event.sessionId || ""),
    type: EVENT_TYPES.has(event.type) ? event.type : "status",
    role: ["user", "assistant", "tool", "system"].includes(event.role) ? event.role : null,
    createdAt: event.createdAt ? String(event.createdAt) : null,
    summary: cleanMobileText(event.summary || "", 4000),
    // 客户端乐观渲染用的 messageId；与 ledger 数字 id 分离，便于 SSE 去重。
    ...(event.messageId ? { messageId: cleanMobileText(event.messageId, 240) } : {}),
    ...(event.approval && typeof event.approval === "object" ? {
      approval: {
        id: cleanMobileText(event.approval.id || "", 240),
        requiresDesktop: Boolean(event.approval.requiresDesktop),
        summary: cleanMobileText(event.approval.summary || "", 1000)
      }
    } : {}),
    ...(Array.isArray(event.attachments) ? { attachments: event.attachments.map(projectAsset).filter(Boolean) } : {}),
    ...(event.delivery ? { delivery: projectAsset(event.delivery) } : {}),
    ...(event.tool ? { tool: projectTool(event.tool) } : {}),
    ...(projectRoute(event.route) ? { route: projectRoute(event.route) } : {}),
    ...(projectGoal(event.goal) ? { goal: projectGoal(event.goal) } : {})
  };
}

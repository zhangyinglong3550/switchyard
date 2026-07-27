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
  "error"
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
    ...(Array.isArray(value.files) ? { files: value.files.map(projectAsset).filter(Boolean) } : {})
  };
}

export function projectMobileSession(row = {}, overlay = {}) {
  const state = SESSION_STATES.has(row.state) ? row.state : "completed";
  const updatedAt = row.updatedAt || row.mtime || null;
  return {
    id: String(row.id || ""),
    agent: String(row.agent || row.agentId || ""),
    title: cleanMobileText(overlay.title || row.title || row.name || row.id || "未命名任务", 200),
    state,
    updatedAt: updatedAt ? String(updatedAt) : null,
    model: cleanMobileText(overlay.model || row.model || "", 160),
    project: projectName(row.project || row.directory || row.cwd || ""),
    pinned: Boolean(overlay.pinned),
    archived: Boolean(overlay.archived ?? row.archived),
    capabilities: projectCapabilities(row.capabilities)
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
    ...(event.approval && typeof event.approval === "object" ? {
      approval: {
        id: cleanMobileText(event.approval.id || "", 240),
        requiresDesktop: Boolean(event.approval.requiresDesktop),
        summary: cleanMobileText(event.approval.summary || "", 1000)
      }
    } : {}),
    ...(Array.isArray(event.attachments) ? { attachments: event.attachments.map(projectAsset).filter(Boolean) } : {}),
    ...(event.tool ? { tool: projectTool(event.tool) } : {})
  };
}

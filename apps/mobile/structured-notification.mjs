const TAGGED_JSON_RE = /^\s*<([a-z][a-z0-9_.-]*)>\s*([\s\S]+?)\s*$/i;
const STATUS_ORDER = ["failed", "cancelled", "canceled", "waiting_for_approval", "running", "pending", "completed", "complete", "done"];

function cleanLabel(value) {
  return String(value || "通知")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function statusPayload(value) {
  if (typeof value === "string") return { state: "", text: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "", text: "" };
  const entries = Object.entries(value);
  const preferred = STATUS_ORDER.map((key) => entries.find(([name]) => String(name).toLowerCase() === key)).find(Boolean) || entries[0];
  if (!preferred) return { state: "", text: "" };
  const [state, content] = preferred;
  if (typeof content === "string") return { state: String(state).toLowerCase(), text: content };
  if (content && typeof content === "object") {
    return {
      state: String(state).toLowerCase(),
      text: String(content.message || content.summary || content.content || content.output || content.result || "")
    };
  }
  return { state: String(state).toLowerCase(), text: "" };
}

function textFromPayload(payload) {
  const direct = [payload.message, payload.summary, payload.content, payload.output, payload.result, payload.text]
    .find((value) => typeof value === "string" && value.trim());
  if (direct) return { state: "", text: direct };
  return statusPayload(payload.status);
}

export function notificationLabel(tag) {
  const normalized = String(tag || "").toLowerCase();
  if (normalized === "subagent_notification") return "子任务通知";
  if (normalized === "agent_notification") return "Agent 通知";
  return cleanLabel(tag);
}

export function parseStructuredNotification(value) {
  const source = String(value || "");
  const match = source.match(TAGGED_JSON_RE);
  if (!match) return null;
  let payload;
  try { payload = JSON.parse(match[2]); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const extracted = textFromPayload(payload);
  if (!extracted.text.trim()) return null;
  return {
    tag: match[1],
    label: notificationLabel(match[1]),
    state: extracted.state,
    text: extracted.text.trim()
  };
}

export function notificationStateLabel(state) {
  const value = String(state || "").toLowerCase();
  if (["completed", "complete", "done"].includes(value)) return "已完成";
  if (["failed", "error"].includes(value)) return "失败";
  if (["cancelled", "canceled"].includes(value)) return "已取消";
  if (["waiting_for_approval"].includes(value)) return "等待审批";
  if (["running", "pending"].includes(value)) return "进行中";
  return "通知";
}

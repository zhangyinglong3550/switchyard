const TAGGED_JSON_RE = /^\s*<([a-z][a-z0-9_.-]*)>\s*([\s\S]+?)\s*$/i;
const STATUS_ORDER = ["failed", "cancelled", "canceled", "waiting_for_approval", "running", "pending", "completed", "complete", "done"];
// 扫描开标签：通知多为小写 snake；系统注入常为全大写信封（INSTRUCTIONS 等）。
const INLINE_TAG_RE = /<([A-Za-z][A-Za-z0-9_.-]*)>/g;
const INSTRUCTION_HEADER_RE = /(?:^|\n)(#\s+\S+\.md\s+instructions\s+for\s+[^\n]+)\s*$/i;
// 常见 HTML/Markdown 标签，避免把正文里的标记误当成系统信封。
const COMMON_MARKUP_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "code", "del", "details", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "s", "samp", "small", "span", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "th", "thead", "tr", "u", "ul", "var"
]);

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

function notificationFromPayload(tag, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const extracted = textFromPayload(payload);
  if (!extracted.text.trim()) return null;
  return {
    tag,
    label: notificationLabel(tag),
    state: extracted.state,
    text: extracted.text.trim(),
    ...(typeof payload.agent_path === "string" && payload.agent_path.trim()
      ? { agentPath: String(payload.agent_path).trim().slice(0, 240) }
      : {})
  };
}

export function parseStructuredNotification(value) {
  const source = String(value || "");
  const match = source.match(TAGGED_JSON_RE);
  if (!match) return null;
  // 部分运行时会补一个 </tag> 收尾，先把闭合标签剥掉再解析 JSON。
  const inner = match[2].replace(new RegExp(`</${match[1]}>\\s*$`, "i"), "").trim();
  let payload;
  try { payload = JSON.parse(inner); } catch { return null; }
  return notificationFromPayload(match[1], payload);
}

// 从 start（"{" 位置）做括号平衡扫描，容忍字符串内的括号与转义。
function extractJsonObject(source, start) {
  let depth = 0; let inString = false; let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") { depth -= 1; if (depth === 0) return source.slice(start, index + 1); }
  }
  return "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 按形态识别系统/注入信封，不维护完整标签名单。 */
export function isAgentContextTag(name) {
  const tag = String(name || "");
  if (!tag) return false;
  const lower = tag.toLowerCase();
  if (lower === "thinking") return false;
  if (COMMON_MARKUP_TAGS.has(lower)) return false;
  if (/(?:instructions|reminder|context)$/i.test(tag)) return true;
  // 全大写 / 大写蛇形：INSTRUCTIONS、SYSTEM_REMINDER、APP_CONTEXT …
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(tag)) return true;
  return false;
}

function contextLabel(tag) {
  const lower = String(tag || "").toLowerCase();
  if (lower.endsWith("reminder")) return "系统提醒";
  if (lower.endsWith("context")) return "运行上下文";
  if (lower.endsWith("instructions") || lower === "instructions") return "系统指令";
  return "系统上下文";
}

/** 若开标签前紧邻 `# *.md instructions for …` 头，一并收进上下文块。 */
function contextBlockStart(source, tagStart) {
  const before = source.slice(0, tagStart);
  const match = before.match(INSTRUCTION_HEADER_RE);
  if (!match) return tagStart;
  const header = match[1];
  const headerAt = before.lastIndexOf(header);
  if (headerAt < 0) return tagStart;
  const between = before.slice(headerAt + header.length);
  if (!/^\s*$/.test(between)) return tagStart;
  return headerAt;
}

function extractTaggedEnvelope(source, tagStart, openLength, tagName) {
  const innerStart = tagStart + openLength;
  const closer = new RegExp(`</${escapeRegExp(tagName)}>`, "i");
  const rest = source.slice(innerStart);
  const close = closer.exec(rest);
  if (!close) {
    return {
      end: source.length,
      inner: rest,
      raw: source.slice(tagStart)
    };
  }
  const end = innerStart + close.index + close[0].length;
  return {
    end,
    inner: rest.slice(0, close.index),
    raw: source.slice(tagStart, end)
  };
}

function tryParseNotificationAt(source, match) {
  const gapEnd = match.index + match[0].length;
  const braceIndex = source.indexOf("{", gapEnd);
  if (braceIndex === -1 || !/^\s*$/.test(source.slice(gapEnd, braceIndex))) return null;
  const jsonText = extractJsonObject(source, braceIndex);
  if (!jsonText) return null;
  let payload;
  try { payload = JSON.parse(jsonText); } catch { return null; }
  const notification = notificationFromPayload(match[1], payload);
  if (!notification) return null;
  let end = braceIndex + jsonText.length;
  const closingMatch = source.slice(end).match(new RegExp(`^\\s*</${escapeRegExp(match[1])}>`, "i"));
  if (closingMatch) end += closingMatch[0].length;
  return { end, notification };
}

function pushTextSegment(segments, text) {
  if (text && text.trim()) segments.push({ type: "text", text });
}

// 整条消息不再要求必须是 <tag>{json}：
// 1) 标签后紧跟 JSON → 结构化通知卡
// 2) 形态像系统信封（全大写 / *instructions|*reminder|*context）→ 系统上下文折叠
// 3) 其余文本保持原样
export function splitStructuredContent(value) {
  const source = String(value || "");
  const segments = [];
  let cursor = 0;
  INLINE_TAG_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_TAG_RE.exec(source))) {
    const tagName = match[1];
    const parsed = tryParseNotificationAt(source, match);
    if (parsed) {
      pushTextSegment(segments, source.slice(cursor, match.index));
      segments.push({ type: "notification", ...parsed.notification });
      cursor = parsed.end;
      INLINE_TAG_RE.lastIndex = parsed.end;
      continue;
    }
    if (!isAgentContextTag(tagName)) continue;
    const envelope = extractTaggedEnvelope(source, match.index, match[0].length, tagName);
    if (!String(envelope.inner || "").trim()) continue;
    const blockStart = contextBlockStart(source, match.index);
    const raw = source.slice(blockStart, envelope.end).trim();
    if (!raw) continue;
    pushTextSegment(segments, source.slice(cursor, blockStart));
    segments.push({
      type: "context",
      tag: tagName,
      label: contextLabel(tagName),
      text: raw
    });
    cursor = envelope.end;
    INLINE_TAG_RE.lastIndex = envelope.end;
  }
  pushTextSegment(segments, source.slice(cursor));
  return segments.length ? segments : [{ type: "text", text: source }];
}

/** 去掉系统上下文信封，保留正文（供历史清洗）。 */
export function stripAgentContext(value) {
  const source = String(value || "");
  if (!source.trim()) return "";
  return splitStructuredContent(source)
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isMostlyAgentContext(value) {
  const source = String(value || "");
  if (!source.trim()) return false;
  const segments = splitStructuredContent(source);
  const context = segments.filter((segment) => segment.type === "context");
  if (!context.length) return false;
  const prose = segments.filter((segment) => segment.type === "text").map((segment) => segment.text).join("").trim();
  return prose.length < 48;
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

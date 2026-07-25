const TOOL_STATUS = new Map([
  ["pending", "pending"], ["queued", "pending"], ["running", "running"], ["in_progress", "running"],
  ["completed", "completed"], ["success", "completed"], ["succeeded", "completed"],
  ["failed", "failed"], ["error", "failed"], ["cancelled", "cancelled"], ["canceled", "cancelled"],
  ["waiting_for_approval", "waiting_for_approval"], ["approval", "waiting_for_approval"]
]);

export function toolStatus(value, fallback = "completed") {
  const raw = String(value?.status || value?.type || value || "").toLowerCase();
  return TOOL_STATUS.get(raw) || (raw.includes("fail") || raw.includes("error") ? "failed" : fallback);
}

export function textValue(value, maxLength = 20_000) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, maxLength);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textValue(item, maxLength)).filter(Boolean).join("\n").slice(0, maxLength);
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.slice(0, maxLength);
    if (typeof value.output_text === "string") return value.output_text.slice(0, maxLength);
    if (typeof value.content === "string") return value.content.slice(0, maxLength);
    try { return JSON.stringify(value, null, 2).slice(0, maxLength); } catch { return String(value).slice(0, maxLength); }
  }
  return String(value).slice(0, maxLength);
}

function parseArguments(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function toolFiles(value, activity) {
  const rows = [];
  const seen = new Set();
  const visit = (input, key = "") => {
    if (!input || rows.length >= 20) return;
    if (Array.isArray(input)) {
      for (const item of input) visit(item, key);
      return;
    }
    if (typeof input !== "object") {
      if (!/(?:^|_)(?:file_?)?path$/i.test(key) && !/^path$/i.test(key)) return;
      const filePath = String(input || "").trim();
      if (!filePath || /^[a-z][a-z0-9+.-]*:\/\//i.test(filePath) || seen.has(filePath)) return;
      seen.add(filePath);
      rows.push({ path: filePath, activity });
      return;
    }
    for (const [name, item] of Object.entries(input)) visit(item, name);
  };
  const state = value.state && typeof value.state === "object" ? value.state : {};
  visit(value.input ?? value.arguments ?? value.args ?? value.rawInput ?? state.input ?? value.action ?? null);
  visit(value.changes);
  visit(value.fileChanges);
  return rows;
}

export function toolActivity(value = {}) {
  const state = value.state && typeof value.state === "object" ? value.state : {};
  const input = value.input ?? value.arguments ?? value.args ?? value.rawInput ?? state.input ?? value.action ?? "";
  const text = [value.activity, value.name, value.tool, value.toolName, value.kind?.tool_type, value.type, value.title, value.command, textValue(input, 8_000)]
    .filter(Boolean).join(" ").toLowerCase();
  if (/\b(read|read_file|readfile|cat|head|tail|sed)\b|读取|查看文件/.test(text)) return "read";
  if (/\b(grep|rg|glob|find|search|websearch|web_search|web-search)\b|搜索|检索|查找/.test(text)) return "search";
  if (/\b(edit|write|apply_patch|file_change|filechange|notebookedit|str_replace|create_file)\b|编辑|写入|修改文件/.test(text)) return "edit";
  if (/\b(bash|shell|terminal|exec|run_command|execute|command_execution|commandexecution)\b|执行命令|运行命令/.test(text)) return "command";
  return "other";
}

export function toolFrom(value = {}, fallbackStatus = "completed") {
  const state = value.state && typeof value.state === "object" ? value.state : {};
  const input = value.input ?? value.arguments ?? value.args ?? value.rawInput ?? state.input ?? value.action ?? null;
  const parsed = parseArguments(input);
  const commandValue = value.command ?? parsed?.command ?? parsed?.cmd ?? "";
  const command = Array.isArray(commandValue) ? commandValue.join(" ") : commandValue;
  const output = value.output ?? value.result ?? value.aggregated_output ?? value.rawOutput ?? state.output ?? state.metadata?.output ?? "";
  const error = value.error ?? state.error ?? "";
  const name = value.name || value.tool || value.toolName || value.kind?.tool_type || value.type || "工具调用";
  const title = value.title || state.title || state.input?.title || state.metadata?.description || "";
  const activity = toolActivity(value);
  return {
    id: String(value.callId || value.call_id || value.callID || value.toolCallId || value.tool_call_id || value.id || ""),
    name: String(name || "工具调用"),
    title: String(title || ""),
    activity,
    command: textValue(command, 8_000),
    arguments: textValue(parsed, 12_000),
    status: toolStatus(state.status || value.status, error ? "failed" : fallbackStatus),
    output: textValue(output, 20_000),
    error: textValue(error, 8_000),
    files: toolFiles(value, activity)
  };
}

export function toolMessage(tool, text = "") {
  const normalized = toolFrom(tool);
  return {
    role: "tool",
    kind: "tool",
    text: String(text || normalized.title || normalized.name || "工具调用"),
    tool: normalized
  };
}

export function mergeTool(target, next) {
  const merged = { ...(target || {}) };
  for (const [key, value] of Object.entries(next || {})) {
    if (value !== "" && value !== null && value !== undefined) merged[key] = value;
  }
  return merged;
}

function functionTool(tool) {
  if (typeof tool === "string") {
    return { name: tool, description: "", properties: new Set(), raw: { type: "function", function: { name: tool, parameters: { type: "object", properties: {} } } } };
  }
  const fn = tool?.type === "function" ? tool.function : tool?.function || tool;
  const name = String(fn?.name || "").trim();
  if (!name) return null;
  const properties = fn?.parameters?.properties && typeof fn.parameters.properties === "object"
    ? Object.keys(fn.parameters.properties)
    : [];
  return {
    name,
    description: String(fn?.description || "").toLowerCase(),
    properties: new Set(properties),
    raw: tool?.type === "function" ? tool : { type: "function", function: fn }
  };
}

export function toolCatalog(tools = []) {
  const result = new Map();
  for (const tool of tools || []) {
    const normalized = functionTool(tool);
    if (normalized) result.set(normalized.name, normalized);
  }
  return result;
}

function hasAny(set, values) {
  return values.some((value) => set.has(value));
}

function findByShape(catalog, { names = [], properties = [], description = [] } = {}) {
  for (const name of names) {
    if (catalog.has(name)) return catalog.get(name);
  }
  return [...catalog.values()].find((tool) =>
    (properties.length && hasAny(tool.properties, properties))
    || (description.length && description.some((word) => tool.description.includes(word)))
  ) || null;
}

/** Codex / OpenCode 编码核心工具：桥接时优先暴露。 */
const CORE_TOOL_NAMES = new Set([
  "exec_command",
  "apply_patch",
  "write_stdin",
  "bash",
  "shell",
  "run_command",
  "read",
  "read_file",
  "read_text_file",
  "write",
  "write_file",
  "edit",
  "str_replace",
  "grep",
  "grep_files",
  "list_dir",
  "glob",
  "glob_file_search"
]);

/** 在 Cursor 桥接里容易导致空转、且对落地改代码帮助很小的工具。 */
const BRIDGE_DROP_TOOL_NAMES = new Set([
  "update_plan",
  "view_image",
  "image_gen.imagegen",
  "imagegen"
]);

function isCoreCodingTool(tool) {
  if (CORE_TOOL_NAMES.has(tool.name)) return true;
  if (hasAny(tool.properties, ["cmd", "command", "filePath", "file_path", "path", "patch"])) return true;
  if (/(exec|shell|bash|patch|read file|write file|edit file)/i.test(tool.description)) return true;
  return false;
}

/**
 * 裁剪发给 Cursor Agent/MCP 的工具面：保留编码核心，丢掉易空转工具，限制总量。
 * 目的：让 Grok 等模型在 Codex 里更倾向 exec_command/apply_patch，而不是刷 update_plan。
 */
export function selectCursorBridgeTools(tools = [], { maxTools = 48 } = {}) {
  const catalog = [];
  for (const tool of tools || []) {
    const normalized = functionTool(tool);
    if (!normalized) continue;
    if (BRIDGE_DROP_TOOL_NAMES.has(normalized.name)) continue;
    if (normalized.name.endsWith(".imagegen") || normalized.name.startsWith("image_gen.")) continue;
    catalog.push(normalized);
  }
  const core = [];
  const rest = [];
  for (const tool of catalog) {
    if (isCoreCodingTool(tool)) core.push(tool.raw);
    else rest.push(tool.raw);
  }
  return [...core, ...rest].slice(0, Math.max(1, Number(maxTools) || 48));
}

export function selectReadTool(tools = []) {
  return findByShape(toolCatalog(tools), {
    names: ["read", "read_file", "read_text_file", "exec_command"],
    properties: ["filePath", "path"],
    description: ["read a file", "read file"]
  });
}

export function selectShellTool(tools = []) {
  return findByShape(toolCatalog(tools), {
    names: ["exec_command", "bash", "shell", "run_command"],
    properties: ["cmd", "command"],
    description: ["execute a command", "run a command", "shell command", "bash command"]
  });
}

export function selectWriteTool(tools = []) {
  return findByShape(toolCatalog(tools), {
    names: ["apply_patch", "write_file", "write", "edit", "str_replace", "exec_command"],
    properties: ["path", "filePath", "file_path", "patch", "contents", "content"],
    description: ["apply a patch", "write a file", "edit a file"]
  });
}

export function mapReadArguments(tool, { filePath, offset = 0, limit = 0 } = {}) {
  const properties = tool?.properties || new Set();
  if (tool?.name === "exec_command" || properties.has("cmd") || properties.has("command")) return null;
  const output = {};
  output[properties.has("file_path") ? "file_path" : properties.has("path") && !properties.has("filePath") ? "path" : "filePath"] = filePath;
  if (offset && properties.has("offset")) output.offset = offset;
  if (limit && properties.has("limit")) output.limit = limit;
  return output;
}

export function mapShellArguments(tool, { command, workdir, timeout } = {}) {
  const properties = tool?.properties || new Set();
  const output = {};
  output[properties.has("cmd") || tool?.name === "exec_command" ? "cmd" : "command"] = command;
  if (workdir) {
    if (properties.has("workdir") || tool?.name === "exec_command" || tool?.name === "bash") output.workdir = workdir;
    else if (properties.has("cwd")) output.cwd = workdir;
  }
  if (timeout) {
    if (properties.has("yield_time_ms") || tool?.name === "exec_command") output.yield_time_ms = timeout;
    else if (properties.has("timeout") || tool?.name === "bash") output.timeout = timeout;
    else if (properties.has("timeout_ms")) output.timeout_ms = timeout;
  }
  return output;
}

/**
 * 把 Cursor 写/改文件意图映射到客户端工具参数。
 * apply_patch 语义特殊，默认仍落到 shell heredoc，避免伪造错误 patch。
 */
export function mapWriteArguments(tool, { filePath, fileText = "" } = {}) {
  if (!tool?.name) return null;
  const properties = tool.properties || new Set();
  if (tool.name === "apply_patch") return null;
  if (properties.has("cmd") || properties.has("command") || tool.name === "exec_command") return null;
  const output = {};
  if (properties.has("file_path")) output.file_path = filePath;
  else if (properties.has("filePath")) output.filePath = filePath;
  else if (properties.has("path")) output.path = filePath;
  else return null;
  if (properties.has("contents")) output.contents = fileText;
  else if (properties.has("content")) output.content = fileText;
  else if (properties.has("file_text")) output.file_text = fileText;
  else if (properties.has("text")) output.text = fileText;
  else return null;
  return output;
}

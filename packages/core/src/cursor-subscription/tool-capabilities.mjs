function functionTool(tool) {
  if (typeof tool === "string") {
    return { name: tool, description: "", properties: new Set() };
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
    properties: new Set(properties)
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

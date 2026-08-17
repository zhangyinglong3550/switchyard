import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_ENTRIES = 500;
const AGENTS = Object.freeze({
  codex: {
    skillRoots: [".codex/skills", ".agents/skills"], skillPrefix: "$",
    commands: [
      ["compact", "压缩当前会话上下文"], ["review", "审查当前工作区变更"],
      ["model", "查看或切换模型"], ["status", "查看当前会话状态"],
      ["permissions", "调整执行权限"], ["new", "开始新会话"]
    ]
  },
  "claude-code": {
    skillRoots: [".claude/skills"], commandRoots: [".claude/commands"], skillPrefix: "/",
    commands: [
      ["compact", "压缩当前会话上下文"], ["clear", "清空当前会话"],
      ["context", "查看上下文使用情况"], ["cost", "查看本次会话用量"],
      ["doctor", "检查 Claude Code 环境"], ["help", "查看 Claude Code 帮助"],
      ["model", "查看或切换模型"], ["permissions", "调整执行权限"],
      ["review", "审查当前工作区变更"], ["status", "查看当前会话状态"]
    ]
  },
  opencode: {
    skillRoots: [".config/opencode/skills", ".config/opencode/skill"], skillPrefix: "/",
    commands: [
      ["compact", "压缩当前会话上下文"], ["help", "查看 OpenCode 帮助"],
      ["models", "查看可用模型"], ["new", "开始新会话"],
      ["share", "共享当前会话"], ["undo", "撤销上一步"], ["redo", "重做上一步"]
    ]
  },
  grok: {
    skillRoots: [".grok/skills"], skillPrefix: "/",
    commands: [
      ["compact", "压缩当前会话上下文"], ["clear", "清空当前会话"],
      ["help", "查看 Grok 帮助"], ["model", "查看或切换模型"],
      ["new", "开始新会话"], ["status", "查看当前会话状态"]
    ]
  },
  "deepseek-harness": {
    skillRoots: [".dsh/skills"], skillPrefix: "/",
    commands: [
      ["goal", "进入/管理目标模式"], ["compact", "压缩当前会话上下文"],
      ["clear", "清空当前会话"], ["model", "查看或切换模型"],
      ["help", "查看 DSH 帮助"], ["status", "查看当前会话状态"]
    ]
  }
});

function safeName(value) {
  return String(value || "").trim().replace(/^[/\$@]+/, "").replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 140);
}

function frontMatter(file) {
  let text = "";
  try { text = fs.readFileSync(file, "utf8").slice(0, 16_384); } catch { return {}; }
  const match = text.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^\s*(name|description)\s*:\s*(.*?)\s*$/i);
    if (!field) continue;
    result[field[1].toLowerCase()] = field[2].replace(/^['"]|['"]$/g, "").trim();
  }
  return result;
}

function skillRow(file, fallbackName, prefix, source, namespace = "") {
  const meta = frontMatter(file);
  const bareName = safeName(meta.name || fallbackName);
  if (!bareName) return null;
  const name = namespace ? `${safeName(namespace)}:${bareName}` : bareName;
  return {
    id: `skill:${name}`, kind: "skill", name,
    description: String(meta.description || "已安装 Skill").slice(0, 300),
    insertText: `${prefix}${name} `, source
  };
}

function directSkillRows(root, prefix, source = "installed") {
  const rows = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return rows; }
  for (const entry of entries) {
    if (rows.length >= MAX_ENTRIES) break;
    // Hidden system roots (notably ~/.codex/skills/.system) contain real Skills.
    // Ignore hidden files, but recurse one level into hidden directories.
    if (entry.name.startsWith(".") && !entry.isDirectory()) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name, "SKILL.md");
    try {
      if (fs.statSync(candidate).isFile()) {
        const row = skillRow(candidate, entry.name, prefix, source);
        if (row) rows.push(row);
        continue;
      }
    } catch {}
    if (!entry.name.startsWith(".")) continue;
    let nested = [];
    try { nested = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true }); } catch { continue; }
    for (const child of nested) {
      if (rows.length >= MAX_ENTRIES) break;
      if (!child.isDirectory() && !child.isSymbolicLink()) continue;
      const file = path.join(root, entry.name, child.name, "SKILL.md");
      try { if (!fs.statSync(file).isFile()) continue; } catch { continue; }
      const row = skillRow(file, child.name, prefix, source);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function walkNamedFiles(root, targetName, limit = MAX_ENTRIES) {
  const files = [];
  const visit = (directory, depth) => {
    if (files.length >= limit || depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= limit) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (entry.isFile() && entry.name === targetName) files.push(file);
    }
  };
  visit(root, 0);
  return files;
}

function pluginSkillRows(root, prefix, namespace, source) {
  return walkNamedFiles(path.join(root, "skills"), "SKILL.md").map((file) => skillRow(file, path.basename(path.dirname(file)), prefix, source, namespace)).filter(Boolean);
}

function commandFileRows(root, namespace = "", source = "custom") {
  const rows = [];
  let files = [];
  try { files = fs.readdirSync(root, { withFileTypes: true }); } catch { return rows; }
  for (const file of files) {
    if (rows.length >= MAX_ENTRIES || !file.isFile() || !file.name.endsWith(".md")) continue;
    const bareName = safeName(path.basename(file.name, ".md"));
    const name = namespace ? `${safeName(namespace)}:${bareName}` : bareName;
    const meta = frontMatter(path.join(root, file.name));
    if (name) rows.push({ id: `command:${name}`, kind: "command", name, description: String(meta.description || "自定义命令").slice(0, 300), insertText: `/${name} `, source });
  }
  return rows;
}

function claudePluginRows(home) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(path.join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")); } catch { return []; }
  const rows = [];
  for (const [pluginId, installs] of Object.entries(data.plugins || {})) {
    const namespace = pluginId.split("@")[0];
    for (const install of Array.isArray(installs) ? installs : []) {
      // Project-scoped plugins are only active in their project. They are
      // intentionally supplied by ACP dynamically when that session starts.
      if (install?.scope === "project") continue;
      const root = String(install?.installPath || "");
      if (!root) continue;
      rows.push(...commandFileRows(path.join(root, "commands"), namespace, "plugin"));
      rows.push(...pluginSkillRows(root, "/", namespace, "plugin"));
    }
  }
  return rows;
}

function codexPluginRows() {
  const result = spawnSync("codex", ["plugin", "list", "--json"], { encoding: "utf8", timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) return [];
  let data = {};
  try { data = JSON.parse(result.stdout); } catch { return []; }
  const rows = [];
  for (const plugin of data.installed || []) {
    if (!plugin?.installed || plugin?.enabled === false) continue;
    const root = String(plugin?.source?.path || "");
    const namespace = String(plugin?.name || plugin?.pluginId || "").split("@")[0];
    if (root && namespace) rows.push(...pluginSkillRows(root, "$", namespace, "plugin"));
  }
  return rows;
}

function skillRows(home, definition) {
  return (definition.skillRoots || []).flatMap((relative) => directSkillRows(path.join(home, relative), definition.skillPrefix));
}

function customCommandRows(home, definition) {
  return (definition.commandRoots || []).flatMap((relative) => commandFileRows(path.join(home, relative)));
}

function mentionRows(rows = []) {
  return rows.map((row) => {
    const name = safeName(row?.name || row?.id);
    if (!name) return null;
    return {
      id: `mention:${name}`, kind: "mention", name,
      description: String(row?.description || "Codex 插件").slice(0, 300),
      insertText: `@${name} `, source: "agent"
    };
  }).filter(Boolean);
}

function normalizeDynamic(row) {
  const name = safeName(row?.name || row?.command || row?.id);
  if (!name) return null;
  return { id: `command:${name}`, kind: "command", name, description: String(row?.description || row?.title || "Agent 命令").slice(0, 300), insertText: `/${name} `, source: "agent" };
}

export function createMobileCommandCatalog({ home = os.homedir() } = {}) {
  const pluginCache = new Map();
  const pluginsFor = (agentId) => {
    const cached = pluginCache.get(agentId);
    if (cached && Date.now() - cached.at < 60_000) return cached.rows;
    const rows = agentId === "codex" && path.resolve(home) === path.resolve(os.homedir()) ? codexPluginRows() : agentId === "claude-code" ? claudePluginRows(home) : [];
    pluginCache.set(agentId, { at: Date.now(), rows });
    return rows;
  };
  return {
    list(agentId, dynamicCommands = [], { mentions = [] } = {}) {
      const key = String(agentId || "");
      const definition = AGENTS[key];
      if (!definition) return [];
      const builtins = definition.commands.map(([name, description]) => ({ id: `command:${name}`, kind: "command", name, description, insertText: `/${name} `, source: "builtin" }));
      const rows = [...builtins, ...customCommandRows(home, definition), ...dynamicCommands.map(normalizeDynamic).filter(Boolean), ...skillRows(home, definition), ...pluginsFor(key), ...(key === "codex" ? mentionRows(mentions) : [])];
      const seen = new Set();
      return rows.filter((row) => { const unique = `${row.kind}:${row.name}`; if (seen.has(unique)) return false; seen.add(unique); return true; })
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    }
  };
}

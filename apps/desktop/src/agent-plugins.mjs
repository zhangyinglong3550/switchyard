import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_HOME, ensureDir, safeJsonParse } from "../../../packages/core/src/utils.mjs";

const MAX_PLUGIN_MANIFESTS = 500;

function homeDir() {
  return process.env.SWITCHYARD_AGENT_HOME || os.homedir();
}

function expandHome(value) {
  return path.resolve(String(value || "").replace(/^~(?=$|\/|\\)/, homeDir()));
}

function safeStat(file) {
  try { return fs.statSync(file); } catch { return null; }
}

function readJsonFile(file, fallback = null) {
  try {
    return safeJsonParse(fs.readFileSync(file, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

function pluginSourcesFile() {
  return process.env.SWITCHYARD_PLUGIN_SOURCES_FILE || path.join(DEFAULT_HOME, "plugin-sources.json");
}

function readSwitchyardSources() {
  const file = pluginSourcesFile();
  const parsed = readJsonFile(file, { sources: [] });
  return Array.isArray(parsed?.sources) ? parsed.sources : [];
}

function saveSwitchyardSources(sources) {
  const file = pluginSourcesFile();
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ sources }, null, 2), "utf8");
}

function claudeRoot() {
  return expandHome("~/.claude");
}

function marketplaceRoot() {
  return path.join(claudeRoot(), "plugins", "marketplaces");
}

function walkFiles(root, { maxDepth = 4, include } = {}) {
  const rows = [];
  const resolved = path.resolve(root);
  if (!safeStat(resolved)?.isDirectory()) return rows;
  const visit = (dir, depth) => {
    if (rows.length >= MAX_PLUGIN_MANIFESTS || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (!include || include(target, entry)) rows.push(target);
    }
  };
  visit(resolved, 0);
  return rows;
}

function sourceId(source) {
  return Buffer.from(JSON.stringify(source)).toString("base64url").slice(0, 80);
}

function normalizeSource(source, origin = "switchyard") {
  const raw = typeof source === "string" ? { url: source } : { ...(source || {}) };
  const type = raw.type || (raw.path ? "path" : "url");
  const name = String(raw.name || raw.label || raw.id || raw.path || raw.url || "插件源").trim();
  const normalized = {
    id: raw.id || sourceId({ name, type, path: raw.path || "", url: raw.url || "" }),
    name,
    type,
    path: raw.path || "",
    url: raw.url || "",
    origin
  };
  if (raw.source) normalized.source = raw.source;
  return normalized;
}

function readClaudeSettingsSources() {
  const settings = readJsonFile(path.join(claudeRoot(), "settings.json"), {});
  const rows = [];
  const extra = settings?.extraKnownMarketplaces || {};
  for (const [name, value] of Object.entries(extra)) {
    const source = value?.source || value || {};
    rows.push(normalizeSource({
      id: `claude-settings:${name}`,
      name,
      type: source.repo || source.url ? "remote" : "settings",
      url: source.url || (source.repo ? `https://github.com/${source.repo}` : ""),
      source
    }, "claude-settings"));
  }
  return rows;
}

function localMarketplaceSources() {
  const root = marketplaceRoot();
  if (!safeStat(root)?.isDirectory()) return [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      return normalizeSource({
        id: `local:${entry.name}`,
        name: entry.name,
        type: "path",
        path: dir
      }, "local");
    });
}

function marketplaceManifestPathsForSource(source) {
  if (source.type !== "path" || !source.path) return [];
  const base = expandHome(source.path);
  const candidates = [
    base,
    path.join(base, ".claude-plugin"),
    path.join(base, "marketplace"),
  ];
  const files = [];
  for (const dir of candidates) {
    const file = path.join(dir, "marketplace.json");
    if (safeStat(file)?.isFile()) files.push(file);
  }
  return Array.from(new Set(files));
}

async function readMarketplaceFromSource(source) {
  if (source.type === "path") {
    const files = marketplaceManifestPathsForSource(source);
    return files.map((file) => ({ file, manifest: readJsonFile(file, null) })).filter((item) => item.manifest);
  }
  if (source.type === "url" && source.url && /\.json($|\?)/i.test(source.url)) {
    const resp = await fetch(source.url, { headers: { Accept: "application/json", "User-Agent": "Switchyard/0.2" } });
    if (!resp.ok) throw new Error(`${source.url} -> ${resp.status}`);
    return [{ url: source.url, manifest: await resp.json() }];
  }
  return [];
}

function pluginFeatures(pluginRoot, manifest) {
  const checks = [
    ["commands", path.join(pluginRoot, "commands")],
    ["agents", path.join(pluginRoot, "agents")],
    ["skills", path.join(pluginRoot, "skills")],
    ["hooks", path.join(pluginRoot, "hooks")],
    ["mcp", path.join(pluginRoot, ".mcp.json")]
  ];
  const features = [];
  for (const [label, target] of checks) {
    if (safeStat(target)) features.push(label);
    else if (Array.isArray(manifest?.[label]) && manifest[label].length) features.push(label);
  }
  return features;
}

function summarizeInstalledPlugin(file) {
  const manifest = readJsonFile(file, null);
  if (!manifest) return null;
  const root = path.dirname(path.dirname(file));
  const stat = safeStat(file);
  return {
    name: manifest.name || path.basename(root),
    version: manifest.version || "",
    description: manifest.description || "",
    author: manifest.author?.name || manifest.author || "",
    homepage: manifest.homepage || manifest.repository || "",
    path: root,
    manifestPath: file,
    features: pluginFeatures(root, manifest),
    mtime: stat?.mtime?.toISOString?.() || null
  };
}

function listInstalledClaudePlugins() {
  const root = marketplaceRoot();
  const files = walkFiles(root, {
    maxDepth: 6,
    include: (file) => path.basename(file) === "plugin.json" && path.basename(path.dirname(file)) === ".claude-plugin"
  });
  return files.map(summarizeInstalledPlugin).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function summarizeMarketplace(source, item) {
  const manifest = item.manifest || {};
  const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
  return {
    sourceId: source.id,
    sourceName: source.name,
    origin: source.origin,
    name: manifest.name || source.name,
    description: manifest.description || manifest.metadata?.description || "",
    version: manifest.version || manifest.metadata?.version || "",
    owner: manifest.owner?.name || "",
    path: item.file || "",
    url: item.url || source.url || "",
    pluginCount: plugins.length,
    plugins: plugins.map((plugin) => ({
      name: plugin.name || "",
      version: plugin.version || "",
      description: plugin.description || "",
      category: plugin.category || "",
      author: plugin.author?.name || plugin.author || "",
      homepage: plugin.homepage || "",
      source: typeof plugin.source === "string" ? plugin.source : (plugin.source?.url || plugin.source?.repo || plugin.source?.source || "")
    })).filter((plugin) => plugin.name)
  };
}

export async function listAgentPlugins({ agentId = "claude-code" } = {}) {
  if (agentId && agentId !== "claude-code") {
    return { agentId, sources: [], marketplaces: [], installed: [], available: [], unsupported: true };
  }
  const sources = [
    ...localMarketplaceSources(),
    ...readClaudeSettingsSources(),
    ...readSwitchyardSources().map((source) => normalizeSource(source, "switchyard"))
  ];
  const dedupedSources = [];
  const seenSources = new Set();
  for (const source of sources) {
    const key = `${source.origin}:${source.name}:${source.path}:${source.url}`;
    if (seenSources.has(key)) continue;
    seenSources.add(key);
    dedupedSources.push(source);
  }
  const marketplaces = [];
  for (const source of dedupedSources) {
    try {
      const manifests = await readMarketplaceFromSource(source);
      for (const item of manifests) marketplaces.push(summarizeMarketplace(source, item));
    } catch (err) {
      marketplaces.push({
        sourceId: source.id,
        sourceName: source.name,
        origin: source.origin,
        name: source.name,
        error: err?.message || String(err),
        pluginCount: 0,
        plugins: []
      });
    }
  }
  const available = marketplaces.flatMap((marketplace) =>
    (marketplace.plugins || []).map((plugin) => ({ ...plugin, marketplace: marketplace.name, sourceId: marketplace.sourceId }))
  );
  return {
    agentId: "claude-code",
    sources: dedupedSources,
    marketplaces,
    installed: listInstalledClaudePlugins(),
    available
  };
}

export function addPluginSource({ agentId = "claude-code", name, url, path: sourcePath } = {}) {
  if (agentId !== "claude-code") throw new Error("当前仅支持 Claude Code 插件源");
  const source = normalizeSource({
    name: String(name || sourcePath || url || "").trim(),
    type: sourcePath ? "path" : "url",
    path: sourcePath ? expandHome(sourcePath) : "",
    url: String(url || "").trim()
  }, "switchyard");
  if (!source.name) throw new Error("缺少插件源名称");
  if (!source.path && !source.url) throw new Error("缺少插件源路径或 URL");
  if (source.path && !safeStat(source.path)) throw new Error(`插件源路径不存在：${source.path}`);
  const sources = readSwitchyardSources().map((item) => normalizeSource(item, "switchyard"));
  if (sources.some((item) => item.path === source.path && item.url === source.url)) return { ok: true, source, alreadyExists: true };
  sources.push(source);
  saveSwitchyardSources(sources);
  return { ok: true, source };
}

export function removePluginSource({ id } = {}) {
  const sources = readSwitchyardSources().map((item) => normalizeSource(item, "switchyard"));
  const next = sources.filter((source) => source.id !== id);
  saveSwitchyardSources(next);
  return { ok: true, removed: sources.length - next.length };
}

function safePluginName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes(String.fromCharCode(92)))
    throw new Error("插件名称无效");
  return name;
}

export function installPlugin({ agentId = "claude-code", sourcePath, pluginName } = {}) {
  if (agentId !== "claude-code") throw new Error("当前仅支持 Claude Code 插件安装");
  const source = expandHome(String(sourcePath || ""));
  if (!source || !safeStat(path.join(source, ".claude-plugin", "plugin.json")))
    throw new Error("插件源路径无效或缺少 .claude-plugin/plugin.json");
  const name = safePluginName(pluginName || path.basename(source));
  const dest = path.join(marketplaceRoot(), name);
  if (safeStat(dest)) throw new Error("目标已存在：" + name + "，请先卸载");
  ensureDir(marketplaceRoot());
  fs.cpSync(source, dest, { recursive: true, dereference: true });
  return { ok: true, name, path: dest };
}

export function uninstallPlugin({ agentId = "claude-code", pluginName } = {}) {
  if (agentId !== "claude-code") throw new Error("当前仅支持 Claude Code 插件卸载");
  const name = safePluginName(pluginName);
  const dest = path.join(marketplaceRoot(), name);
  if (!safeStat(dest)) throw new Error("插件不存在：" + name);
  fs.rmSync(dest, { recursive: true, force: true });
  return { ok: true, removed: name };
}

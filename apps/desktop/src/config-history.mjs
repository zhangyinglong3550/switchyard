import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDir, atomicWriteFileSync } from "../../../packages/core/src/utils.mjs";
const LIMIT = 30;
export function configHistoryDir(home = process.env.SWITCHYARD_HOME || path.join(os.homedir(), ".switchyard")) { return path.join(home, "backups", "config-history"); }
function safeReason(reason = "save") { return String(reason).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "save"; }
export function snapshotConfig(config, { reason = "save", home } = {}) {
  const dir = configHistoryDir(home); ensureDir(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${safeReason(reason)}.json`);
  atomicWriteFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), reason, config }, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort().reverse();
  for (const name of files.slice(LIMIT)) { try { fs.rmSync(path.join(dir, name)); } catch {} }
  return file;
}
export function listConfigHistory({ home } = {}) { const dir=configHistoryDir(home); try { return fs.readdirSync(dir).filter(n=>n.endsWith('.json')).sort().reverse().map((name)=>{ const file=path.join(dir,name); try { const value=JSON.parse(fs.readFileSync(file,'utf8')); return { id:name, savedAt:value.savedAt||'', reason:value.reason||'', providers:value.config?.providers?.length||0, models:value.config?.models?.length||0 }; } catch { return null; }}).filter(Boolean); } catch { return []; } }
export function readConfigHistory(id, { home } = {}) { const name=path.basename(String(id||'')); if (!name.endsWith('.json')) throw new Error('无效的配置历史记录'); const file=path.join(configHistoryDir(home),name); const value=JSON.parse(fs.readFileSync(file,'utf8')); if (!value?.config) throw new Error('配置历史无效'); return value.config; }

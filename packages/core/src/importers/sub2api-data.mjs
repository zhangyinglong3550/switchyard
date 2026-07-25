const SUPPORTED_TYPES = new Set(["", "sub2api-data", "sub2api-bundle"]);
const SUPPORTED_VERSION = 1;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseFile(file, index) {
  const name = String(file?.name || `Sub2API 备份 #${index + 1}`).trim() || `Sub2API 备份 #${index + 1}`;
  let payload;
  try {
    payload = JSON.parse(String(file?.text || ""));
  } catch {
    return { ok: false, error: `文件 ${name} 不是有效 JSON` };
  }
  if (!isObject(payload)) return { ok: false, error: `文件 ${name} 不是有效的 Sub2API 备份对象` };
  const type = typeof payload.type === "string" ? payload.type.trim() : "";
  const version = payload.version == null ? 0 : Number(payload.version);
  if (!SUPPORTED_TYPES.has(type)) return { ok: false, error: `文件 ${name} 不是受支持的 Sub2API 数据备份` };
  if (!Number.isFinite(version) || (version !== 0 && version !== SUPPORTED_VERSION)) {
    return { ok: false, error: `文件 ${name} 的 Sub2API 备份版本不受支持` };
  }
  if (!Array.isArray(payload.accounts) || !Array.isArray(payload.proxies)) {
    return { ok: false, error: `文件 ${name} 缺少 Sub2API accounts 或 proxies 数组` };
  }
  return {
    ok: true,
    name,
    accounts: payload.accounts,
    proxies: payload.proxies
  };
}

/**
 * Merge exported Sub2API account-backup files for the target Sub2API admin API.
 * Credentials remain only in this result's data payload; use the public helper
 * for renderer-facing summaries.
 */
export function parseSub2ApiDataFiles(files, { exportedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(files) || !files.length) return { ok: false, error: "请选择至少一个 Sub2API 数据备份 JSON 文件" };
  const accounts = [];
  const proxies = [];
  const summaries = [];
  for (let index = 0; index < files.length; index += 1) {
    const parsed = parseFile(files[index], index);
    if (!parsed.ok) return parsed;
    accounts.push(...parsed.accounts);
    proxies.push(...parsed.proxies);
    summaries.push({ name: parsed.name, accounts: parsed.accounts.length, proxies: parsed.proxies.length });
  }
  return {
    ok: true,
    data: {
      type: "sub2api-data",
      version: SUPPORTED_VERSION,
      exported_at: exportedAt,
      proxies,
      accounts
    },
    files: summaries
  };
}

export function publicSub2ApiDataImport(result) {
  if (!result?.ok) return { ok: false, error: result?.error || "Sub2API 数据备份解析失败" };
  const files = (result.files || []).map((item) => ({
    name: item.name,
    accounts: Number(item.accounts) || 0,
    proxies: Number(item.proxies) || 0
  }));
  return {
    ok: true,
    files,
    totals: {
      files: files.length,
      accounts: files.reduce((sum, item) => sum + item.accounts, 0),
      proxies: files.reduce((sum, item) => sum + item.proxies, 0)
    }
  };
}

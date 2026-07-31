/**
 * Switchyard 配置包：按供应商导出 / 导入。
 * 默认脱敏；可选带密钥（由调用方注入 secretsResolver）。
 */

export const CONFIG_BUNDLE_KIND = "switchyard-config-bundle";
export const CONFIG_BUNDLE_VERSION = 1;

const SENSITIVE_PROVIDER_KEYS = new Set([
  "apiKey",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "token",
  "secret",
  "password",
  "authorization"
]);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "••••";
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

export function stripProviderSecrets(provider = {}) {
  const next = cloneJson(provider) || {};
  for (const key of SENSITIVE_PROVIDER_KEYS) delete next[key];
  if (next.usage_check && typeof next.usage_check === "object") {
    const usage = { ...next.usage_check };
    for (const key of SENSITIVE_PROVIDER_KEYS) delete usage[key];
    next.usage_check = usage;
  }
  return next;
}

export function stripModelSecrets(model = {}) {
  const next = cloneJson(model) || {};
  for (const key of SENSITIVE_PROVIDER_KEYS) delete next[key];
  return next;
}

function selectedProviderIds(config, providerIds) {
  const all = (config?.providers || []).map((row) => row.id).filter(Boolean);
  if (!Array.isArray(providerIds) || !providerIds.length) return all;
  const wanted = new Set(providerIds.map(String));
  return all.filter((id) => wanted.has(id));
}

function secretStatusForProvider(provider, { includeSecrets, resolved } = {}) {
  const authMode = String(provider?.authMode || provider?.providerType || "api_key");
  const base = {
    providerId: provider.id,
    authMode,
    keychainAccount: provider.keychainAccount || null,
    poolKind: provider.poolKind || null,
    hadInlineKey: Boolean(provider.apiKey),
    mask: provider.apiKey ? maskSecret(provider.apiKey) : ""
  };
  if (!includeSecrets) {
    return {
      ...base,
      status: "omitted",
      reason: "默认不导出密钥；勾选「包含凭证」后才会写入"
    };
  }
  if (resolved?.status === "included") {
    return {
      ...base,
      status: "included",
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.pool ? { pool: resolved.pool } : {}),
      reason: resolved.reason || ""
    };
  }
  return {
    ...base,
    status: resolved?.status || "unavailable",
    reason: resolved?.reason || "本机未找到可导出的凭证"
  };
}

/**
 * @param {object} config 当前 Switchyard 配置
 * @param {object} [options]
 * @param {string[]} [options.providerIds] 要导出的供应商 id；空=全部
 * @param {boolean} [options.includeSecrets=false]
 * @param {(provider: object) => ({status:string, apiKey?:string, pool?:object, reason?:string}|null|undefined)} [options.secretsResolver]
 */
export function buildConfigBundle(config, {
  providerIds,
  includeSecrets = false,
  secretsResolver,
  now = () => new Date().toISOString()
} = {}) {
  const ids = selectedProviderIds(config, providerIds);
  const idSet = new Set(ids);
  const providers = (config?.providers || [])
    .filter((row) => idSet.has(row.id))
    .map((row) => stripProviderSecrets(row));
  const models = (config?.models || [])
    .filter((row) => idSet.has(row.providerId))
    .map((row) => stripModelSecrets(row));

  const byProvider = {};
  for (const raw of (config?.providers || []).filter((row) => idSet.has(row.id))) {
    let resolved = null;
    if (includeSecrets && typeof secretsResolver === "function") {
      try { resolved = secretsResolver(raw) || null; } catch (error) {
        resolved = { status: "unavailable", reason: error?.message || String(error) };
      }
    }
    byProvider[raw.id] = secretStatusForProvider(raw, { includeSecrets, resolved });
  }

  const includedCount = Object.values(byProvider).filter((row) => row.status === "included").length;
  return {
    kind: CONFIG_BUNDLE_KIND,
    version: CONFIG_BUNDLE_VERSION,
    exportedAt: now(),
    includeSecrets: Boolean(includeSecrets),
    providers,
    models,
    secrets: {
      status: includeSecrets ? (includedCount ? "included" : "empty") : "omitted",
      includedCount,
      byProvider
    }
  };
}

export function parseConfigBundle(raw) {
  const bundle = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!bundle || typeof bundle !== "object") throw new Error("配置包无效");
  if (bundle.kind !== CONFIG_BUNDLE_KIND) throw new Error(`不是 Switchyard 配置包（kind=${bundle.kind || "?"}）`);
  const version = Number(bundle.version);
  if (!Number.isFinite(version) || version < 1 || version > CONFIG_BUNDLE_VERSION) {
    throw new Error(`不支持的配置包版本：${bundle.version}`);
  }
  if (!Array.isArray(bundle.providers) || !Array.isArray(bundle.models)) {
    throw new Error("配置包缺少 providers / models");
  }
  return {
    ...bundle,
    version,
    providers: bundle.providers.map((row) => stripProviderSecrets(row)).filter((row) => row?.id),
    models: bundle.models.map((row) => stripModelSecrets(row)).filter((row) => row?.id && row?.providerId),
    secrets: bundle.secrets && typeof bundle.secrets === "object"
      ? bundle.secrets
      : { status: "omitted", includedCount: 0, byProvider: {} }
  };
}

export function previewConfigBundleMerge(existing, bundleInput) {
  const bundle = parseConfigBundle(bundleInput);
  const existingProviderIds = new Set((existing?.providers || []).map((row) => row.id));
  const existingModelIds = new Set((existing?.models || []).map((row) => row.id));
  const addProviders = bundle.providers.filter((row) => !existingProviderIds.has(row.id));
  const skipProviders = bundle.providers.filter((row) => existingProviderIds.has(row.id));
  const addModels = bundle.models.filter((row) => !existingModelIds.has(row.id));
  const skipModels = bundle.models.filter((row) => existingModelIds.has(row.id));
  const secretEntries = Object.values(bundle.secrets?.byProvider || {})
    .filter((row) => row?.status === "included");
  return {
    ok: true,
    bundle,
    addProviders,
    skipProviders,
    addModels,
    skipModels,
    secretEntries,
    includeSecrets: Boolean(bundle.includeSecrets)
  };
}

/**
 * 合并配置包：同 id 跳过，只追加。
 * secretsApplier 可选：对新增供应商应用凭证。
 */
export function mergeConfigBundle(existing, bundleInput, {
  secretsApplier
} = {}) {
  const preview = previewConfigBundleMerge(existing, bundleInput);
  const next = {
    ...existing,
    providers: [...(existing?.providers || []), ...preview.addProviders.map((row) => cloneJson(row))],
    models: [...(existing?.models || []), ...preview.addModels.map((row) => cloneJson(row))]
  };

  const appliedSecrets = [];
  const skippedSecrets = [];
  if (typeof secretsApplier === "function" && preview.secretEntries.length) {
    const addedIds = new Set(preview.addProviders.map((row) => row.id));
    for (const entry of preview.secretEntries) {
      if (!addedIds.has(entry.providerId)) {
        skippedSecrets.push({ providerId: entry.providerId, reason: "供应商已存在，跳过凭证写入" });
        continue;
      }
      const provider = next.providers.find((row) => row.id === entry.providerId);
      if (!provider) {
        skippedSecrets.push({ providerId: entry.providerId, reason: "未找到供应商" });
        continue;
      }
      try {
        const result = secretsApplier(provider, entry) || { ok: true };
        if (result.ok === false) skippedSecrets.push({ providerId: entry.providerId, reason: result.error || "写入失败" });
        else appliedSecrets.push({ providerId: entry.providerId, ...(result.mode ? { mode: result.mode } : {}) });
      } catch (error) {
        skippedSecrets.push({ providerId: entry.providerId, reason: error?.message || String(error) });
      }
    }
  }

  return {
    ...preview,
    config: next,
    appliedSecrets,
    skippedSecrets
  };
}

export function summarizeBundleSecrets(bundle) {
  const rows = Object.values(bundle?.secrets?.byProvider || {});
  return {
    omitted: rows.filter((row) => row.status === "omitted").length,
    included: rows.filter((row) => row.status === "included").length,
    unavailable: rows.filter((row) => row.status === "unavailable").length
  };
}

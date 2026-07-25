// Pure compatibility registry matching helpers shared by the runtime
// dispatcher and the desktop diagnostics/recommendation API.

export function normalizeCompatRegistry(input = {}) {
  const version = Number.isFinite(input.version) ? input.version : 1;
  const rules = Array.isArray(input.rules) ? input.rules : [];
  return {
    version,
    rules: rules.map(normalizeRule).filter(Boolean)
  };
}

export function normalizeRule(rule) {
  if (!rule || typeof rule !== "object" || rule.enabled === false) return null;
  const id = cleanString(rule.id);
  if (!id) return null;
  const match = rule.match && typeof rule.match === "object" ? rule.match : {};
  const recommendedCompatPacks = cleanStringList(rule.recommendedCompatPacks || rule.compatPacks || rule.packs);
  if (!recommendedCompatPacks.length) return null;
  return {
    id,
    providerIdPattern: cleanString(rule.providerIdPattern || match.providerIdPattern || match.providerId),
    providerNamePattern: cleanString(rule.providerNamePattern || match.providerNamePattern || match.providerName),
    providerHostPattern: cleanString(rule.providerHostPattern || match.providerHostPattern || match.providerHost),
    providerPattern: cleanString(rule.providerPattern || match.providerPattern || match.provider),
    modelPattern: cleanString(rule.modelPattern || match.modelPattern || match.model),
    apiFormat: normalizeMatchList(rule.apiFormat || match.apiFormat),
    clientIdPattern: cleanString(rule.clientIdPattern || match.clientIdPattern || match.clientId),
    recommendedCompatPacks,
    reason: cleanString(rule.reason),
    impact: cleanString(rule.impact || rule.scope),
    risk: cleanString(rule.risk),
    fixtures: cleanStringList(rule.fixtures),
    source: cleanString(rule.source) || "builtin"
  };
}

export function ruleMatches(rule, ctx = {}) {
  const provider = ctx.provider || {};
  const model = ctx.model || null;
  if (rule.apiFormat.length && !rule.apiFormat.includes(String(provider.apiFormat || ""))) return false;
  if (!providerSelectorMatches(rule, provider)) return false;
  if (rule.modelPattern && !model) return false;
  if (!matchesPattern(modelText(model), rule.modelPattern)) return false;
  if (!matchesPattern(ctx.clientId, rule.clientIdPattern)) return false;
  return true;
}

export function recommendedCompatPackIds({ provider = null, model = null, clientId = "", registry = null } = {}) {
  const normalizedRegistry = registry ? normalizeCompatRegistry(registry) : { version: 1, rules: [] };
  const ids = [];
  const seen = new Set();
  for (const rule of normalizedRegistry.rules) {
    if (!ruleMatches(rule, { provider, model, clientId })) continue;
    for (const packId of rule.recommendedCompatPacks) {
      if (seen.has(packId)) continue;
      seen.add(packId);
      ids.push(packId);
    }
  }
  return ids;
}

function providerSelectorMatches(rule, provider) {
  const selectors = [
    [provider.id, rule.providerIdPattern],
    [[provider.name, provider.displayName].filter(Boolean).join(" "), rule.providerNamePattern],
    [providerHostText(provider), rule.providerHostPattern],
    [providerText(provider), rule.providerPattern]
  ].filter(([_value, pattern]) => pattern);
  if (!selectors.length) return true;
  return selectors.some(([value, pattern]) => matchesPattern(value, pattern));
}

function providerHostText(provider = {}) {
  const baseUrl = String(provider.baseUrl || provider.url || "");
  let host = "";
  try {
    host = new URL(baseUrl).host;
  } catch {
    host = baseUrl;
  }
  return [host, baseUrl].filter(Boolean).join(" ");
}

function providerText(provider = {}) {
  return [
    provider.id,
    provider.name,
    provider.displayName,
    provider.baseUrl,
    provider.url
  ].filter(Boolean).join(" ");
}

function modelText(model = {}) {
  return [
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(Array.isArray(model?.aliases) ? model.aliases : [])
  ].filter(Boolean).join(" ");
}

function matchesPattern(value, pattern) {
  if (!pattern) return true;
  const text = String(value || "");
  if (!text) return false;
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(String(pattern).toLowerCase());
  }
}

function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 1000);
}

function cleanStringList(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
  return Array.from(new Set(list.map((item) => cleanString(String(item || ""))).filter(Boolean)));
}

function normalizeMatchList(value) {
  if (!value) return [];
  return cleanStringList(value);
}

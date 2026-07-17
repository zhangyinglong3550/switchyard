const AUTH_MODES_WITHOUT_INLINE_KEY = new Set([
  "none",
  "keychain",
  "codex_oauth",
  "anthropic_oauth",
  "account_pool"
]);

export function providerCredentialState(provider = {}, health) {
  const configured = Boolean(
    provider.apiKey ||
    provider.apiKeyEnv ||
    provider.keychainAccount ||
    AUTH_MODES_WITHOUT_INLINE_KEY.has(provider.authMode)
  );
  if (!configured) return "missing";
  if (health?.status === "healthy") return "verified";
  if (health?.status === "unhealthy") return "failed";
  return "configured";
}

export function buildSetupProgress(config = {}, status = {}, providerHealth = {}) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const models = Array.isArray(config.models) ? config.models : [];
  const credentialsDone = providers.length > 0 && providers.every((provider) => (
    providerCredentialState(provider, providerHealth[provider.id]) !== "missing"
  ));
  const checks = [
    { id: "provider", label: "供应商", done: providers.length > 0 },
    { id: "credential", label: "访问凭证", done: credentialsDone },
    { id: "model", label: "模型", done: models.length > 0 },
    { id: "gateway", label: "网关", done: Boolean(status.running) }
  ];
  return {
    checks,
    completed: checks.filter((item) => item.done).length,
    next: checks.find((item) => !item.done) || null
  };
}

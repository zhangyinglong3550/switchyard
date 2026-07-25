// Import a Sub2API account-backup payload directly into Switchyard's native
// Codex pool. This deliberately does not talk to a running Sub2API instance.
import { normalizeAccount, upsertAccounts } from "./store.mjs";
import { accountFromCodexAuthJson } from "./import-multi.mjs";
import { validateAgentIdentityAccount } from "./agent-identity.mjs";

function text(value) {
  return String(value || "").trim();
}

function isOpenAIOAuthAccount(item) {
  return text(item?.platform).toLowerCase() === "openai" &&
    text(item?.type).toLowerCase() === "oauth" &&
    item?.credentials &&
    typeof item.credentials === "object";
}

export function accountFromSub2ApiEntry(item = {}) {
  if (!isOpenAIOAuthAccount(item)) return null;
  const credentials = item.credentials || {};
  const extra = item.extra && typeof item.extra === "object" ? item.extra : {};
  const authMode = text(credentials.auth_mode || credentials.authMode);
  const email = text(credentials.email || extra.email);
  const accountId = text(credentials.account_id || credentials.accountId || credentials.chatgpt_account_id || extra.account_id);

  if (authMode.toLowerCase() === "agentidentity") {
    const account = normalizeAccount({
      email,
      name: text(item.name) || email || accountId || "codex-agent",
      accountId,
      planType: credentials.plan_type || credentials.planType || "",
      enabled: item.auto_pause_on_expired === true ? true : item.enabled !== false,
      weight: item.rate_multiplier || item.concurrency || 1,
      source: "sub2api-data",
      notes: "Imported from Sub2API backup",
      agentIdentity: true,
      authMode: "agentIdentity",
      agentRuntimeId: credentials.agent_runtime_id || credentials.agentRuntimeId,
      agentPrivateKey: credentials.agent_private_key || credentials.agentPrivateKey,
      agentTaskId: credentials.task_id || credentials.taskId || credentials.agent_task_id || credentials.agentTaskId
    });
    validateAgentIdentityAccount(account);
    return account;
  }

  const oauth = accountFromCodexAuthJson({
    ...credentials,
    email,
    name: text(item.name) || credentials.name || email,
    account_id: accountId,
    plan_type: credentials.plan_type || credentials.planType || ""
  }, "sub2api-data");
  if (!oauth.accessToken && !oauth.refreshToken && !oauth.sessionToken) return null;
  return oauth;
}

export function importSub2ApiDataToCodexPool(providerId, data, {
  skipDuplicates = true,
  home
} = {}) {
  const accounts = [];
  const errors = [];
  let unsupported = 0;
  for (const item of data?.accounts || []) {
    try {
      const account = accountFromSub2ApiEntry(item);
      if (!account) {
        unsupported += 1;
        continue;
      }
      accounts.push(account);
    } catch (err) {
      errors.push({
        name: text(item?.name) || "unnamed",
        error: err?.message || "invalid credential"
      });
    }
  }
  if (!accounts.length) {
    return {
      ok: false,
      error: "备份中没有可导入的 OpenAI OAuth / Agent Identity 账号",
      scanned: Array.isArray(data?.accounts) ? data.accounts.length : 0,
      unsupported,
      errors,
      added: 0,
      skipped: 0,
      updated: 0
    };
  }
  const result = upsertAccounts(providerId, accounts, {
    poolKind: "codex_oauth",
    skipDuplicates,
    home
  });
  return {
    ...result,
    scanned: Array.isArray(data?.accounts) ? data.accounts.length : 0,
    imported: accounts.length,
    unsupported,
    errors,
    agentIdentity: accounts.filter((account) => account.agentIdentity).length
  };
}

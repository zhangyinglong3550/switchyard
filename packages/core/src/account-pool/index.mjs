import {
  POOL_KINDS,
  POOL_STRATEGIES,
  poolsRoot,
  poolFilePath,
  createEmptyPool,
  normalizeAccount,
  normalizePool,
  loadPool,
  savePool,
  listPoolAccountsPublic as listPoolAccountsPublicStored,
  publicAccountView,
  isAccessExpired,
  upsertAccounts,
  patchAccounts,
  deleteAccounts,
  updateAccountRuntime
} from "./store.mjs";
import { applyAntigravityLiveAccess } from "./import-multi.mjs";

export {
  POOL_KINDS,
  POOL_STRATEGIES,
  poolsRoot,
  poolFilePath,
  createEmptyPool,
  normalizeAccount,
  normalizePool,
  loadPool,
  savePool,
  publicAccountView,
  isAccessExpired,
  upsertAccounts,
  patchAccounts,
  deleteAccounts,
  updateAccountRuntime
};

export function listPoolAccountsPublic(providerId, opts = {}) {
  const pool = listPoolAccountsPublicStored(providerId, opts);
  if (pool.poolKind !== "antigravity_oauth") return pool;
  return {
    ...pool,
    accounts: loadPool(providerId, opts).accounts.map((account) =>
      publicAccountView(applyAntigravityLiveAccess(account, opts))
    )
  };
}

export {
  parseXaiImportPayload,
  importXaiAccountsFromText,
  importXaiAccountsFromTextSync,
  importXaiAccountsFromCpaDirs,
  scanCpaXaiFiles
} from "./import-xai.mjs";

export {
  importAntigravityFromCpaDirs,
  importCodexFromPaths,
  importCodexAccountsFromText,
  parseCodexImportPayload,
  syncAntigravityPoolToCliproxyDir,
  accountFromAntigravityJson,
  accountFromCodexAuthJson,
  looksLikeCodexAuthJson,
  parseAntigravityCliSecret,
  readAntigravityCliCredential,
  applyAntigravityLiveAccess
} from "./import-multi.mjs";

export {
  accountFromSub2ApiEntry,
  importSub2ApiDataToCodexPool
} from "./import-sub2api.mjs";

export {
  AGENT_IDENTITY_AUTH_BASE_URL,
  isAgentIdentityAccount,
  validateAgentIdentityAccount,
  buildAgentAssertion,
  registerAgentIdentityTask,
  ensureAgentIdentityTask,
  isInvalidAgentIdentityTaskResponse
} from "./agent-identity.mjs";

export {
  XAI_OAUTH_CLIENT_ID,
  XAI_TOKEN_ENDPOINT,
  XAI_API_BASE_URL,
  refreshXaiTokens
} from "./oauth-xai.mjs";

export {
  refreshGoogleTokens,
  ANTIGRAVITY_CLIENT_ID,
  GOOGLE_TOKEN_ENDPOINT
} from "./oauth-google.mjs";

export {
  refreshCodexTokens,
  refreshCodexViaSessionToken,
  refreshCodexAccountTokens,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_TOKEN_URL,
  CODEX_API_BASE_URL,
  CHATGPT_SESSION_URL
} from "./oauth-codex.mjs";

export {
  convertSsoCookie,
  convertSsoCookiesBatch,
  normalizeSso,
  isWebSsoJwt,
  looksLikeJwt
} from "./sso-convert.mjs";

export {
  isAccountPoolProvider,
  poolKindOf,
  poolStrategyOf,
  accountAffinityId,
  bindAccountAffinity,
  clearAccountAffinity,
  listEligibleAccounts,
  pickAccount,
  ensureFreshAccount,
  pickAndRefreshAccount,
  bindProviderToAccount,
  markAccountSuccess,
  markAccountFailure,
  accountPoolReady,
  resetRoundRobinCursors,
  setPoolStrategy,
  recoverExpiredAccountCooldowns,
  POOL_KIND_META
} from "./picker.mjs";

export {
  fetchAccountQuota,
  fetchCodexAccountQuota,
  fetchXaiAccountQuota,
  parseCodexUsagePayload,
  refreshAccountQuota,
  refreshPoolQuotas
} from "./quota.mjs";

export { healthLabelOf, formatQuotaLabel } from "./store.mjs";

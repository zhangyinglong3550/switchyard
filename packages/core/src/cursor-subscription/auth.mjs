const MIN_ACCESS_TOKEN_LENGTH = 32;
const MACHINE_ID_PATTERN = /^[A-Za-z0-9-]{24,}$/;

export function cursorSubscriptionKeychainAccount(provider = {}) {
  return String(provider?.keychainAccount || provider?.id || "cursor-subscription").trim();
}

function validCredentials(value) {
  if (!value || typeof value !== "object") return false;
  return String(value.accessToken || "").trim().length >= MIN_ACCESS_TOKEN_LENGTH &&
    MACHINE_ID_PATTERN.test(String(value.machineId || "").trim());
}

export function serializeCursorSubscriptionCredentials(credentials) {
  if (!validCredentials(credentials)) throw new Error("Cursor 凭据无效：需要访问凭据和本机标识");
  return JSON.stringify({
    accessToken: String(credentials.accessToken).trim(),
    machineId: String(credentials.machineId).trim()
  });
}

export function parseCursorSubscriptionCredentials(secret) {
  try {
    const parsed = JSON.parse(String(secret || ""));
    if (!validCredentials(parsed)) return null;
    return { accessToken: String(parsed.accessToken).trim(), machineId: String(parsed.machineId).trim() };
  } catch {
    return null;
  }
}

export function saveCursorSubscriptionCredentials(provider, credentials, keychain) {
  if (!keychain?.set) throw new Error("Cursor 凭据安全存储不可用");
  return keychain.set(cursorSubscriptionKeychainAccount(provider), serializeCursorSubscriptionCredentials(credentials));
}

export function loadCursorSubscriptionCredentials(provider, keychain) {
  if (!keychain?.get) return null;
  return parseCursorSubscriptionCredentials(keychain.get(cursorSubscriptionKeychainAccount(provider)));
}

export function clearCursorSubscriptionCredentials(provider, keychain) {
  if (!keychain?.delete) throw new Error("Cursor 凭据安全存储不可用");
  return keychain.delete(cursorSubscriptionKeychainAccount(provider));
}

export function redactCursorSubscriptionError(error) {
  return String(error?.message || error || "Cursor 订阅通道请求失败")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(access[_-]?token|token|cookie|authorization)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500);
}

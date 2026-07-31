/**
 * 会话级敏感信息守卫放行（内存，进程内有效）。
 */

const bypassMap = new Map();

function keyOf(clientId, sessionKey) {
  return `${String(clientId || "").trim() || "*"}::${String(sessionKey || "").trim()}`;
}

export function allowSensitiveBypass({
  clientId = "",
  sessionKey = "",
  minutes = 30
} = {}) {
  const session = String(sessionKey || "").trim();
  if (!session) {
    throw new Error("sessionKey 不能为空");
  }
  const ttl = Math.max(1, Math.min(24 * 60, Number(minutes) || 30));
  const key = keyOf(clientId, session);
  const expiresAt = Date.now() + ttl * 60_000;
  bypassMap.set(key, {
    key,
    clientId: String(clientId || "").trim() || "*",
    sessionKey: session,
    expiresAt,
    createdAt: Date.now()
  });
  return { ...bypassMap.get(key) };
}

export function isSensitiveBypassActive(clientId, sessionKey) {
  const session = String(sessionKey || "").trim();
  if (!session) return false;
  const candidates = [
    keyOf(clientId, session),
    keyOf("*", session),
    keyOf("", session)
  ];
  const now = Date.now();
  for (const key of candidates) {
    const row = bypassMap.get(key);
    if (!row) continue;
    if (row.expiresAt <= now) {
      bypassMap.delete(key);
      continue;
    }
    return true;
  }
  return false;
}

export function listSensitiveBypasses() {
  const now = Date.now();
  const out = [];
  for (const [key, row] of bypassMap.entries()) {
    if (!row || row.expiresAt <= now) {
      bypassMap.delete(key);
      continue;
    }
    out.push({ ...row, remainingMs: row.expiresAt - now });
  }
  return out.sort((a, b) => a.expiresAt - b.expiresAt);
}

export function clearSensitiveBypass(key) {
  if (!key) {
    bypassMap.clear();
    return { cleared: true, all: true };
  }
  return { cleared: bypassMap.delete(String(key)), all: false };
}

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

const STORE_VERSION = 1;
const MAX_REMEMBERED_MESSAGES = 2000;

function iso(now) {
  return new Date(now).toISOString();
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function emptyState() {
  return {
    version: STORE_VERSION,
    challenges: {},
    devices: {},
    overlays: {},
    leases: {},
    messages: {}
  };
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      ...emptyState(),
      ...parsed,
      version: STORE_VERSION,
      challenges: parsed.challenges && typeof parsed.challenges === "object" ? parsed.challenges : {},
      devices: parsed.devices && typeof parsed.devices === "object" ? parsed.devices : {},
      overlays: parsed.overlays && typeof parsed.overlays === "object" ? parsed.overlays : {},
      leases: parsed.leases && typeof parsed.leases === "object" ? parsed.leases : {},
      messages: parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {}
    };
  } catch {
    return emptyState();
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ""), "hex");
  const b = Buffer.from(String(right || ""), "hex");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function publicDevice(device) {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    revokedAt: device.revokedAt || null
  };
}

function pruneMessages(state) {
  const entries = Object.entries(state.messages || {});
  if (entries.length <= MAX_REMEMBERED_MESSAGES) return;
  entries.sort((a, b) => String(a[1]?.acceptedAt || "").localeCompare(String(b[1]?.acceptedAt || "")));
  state.messages = Object.fromEntries(entries.slice(-MAX_REMEMBERED_MESSAGES));
}

export function createMobileControlStore({
  root,
  now = () => Date.now(),
  randomBytes = cryptoRandomBytes
} = {}) {
  if (!root) throw new Error("mobile control store root 不能为空");
  const file = path.join(path.resolve(root), "state.json");
  let state = loadState(file);

  const save = () => {
    pruneMessages(state);
    atomicWriteJson(file, state);
  };

  const createChallenge = ({ ttlMs = 10 * 60 * 1000 } = {}) => {
    const createdAtMs = now();
    const secret = `syc_${randomBytes(24).toString("base64url")}`;
    const secretHash = sha256(secret);
    const id = `challenge_${secretHash.slice(0, 20)}`;
    state.challenges[id] = {
      id,
      secretHash,
      createdAt: iso(createdAtMs),
      expiresAt: iso(createdAtMs + Math.max(1000, Number(ttlMs) || 0)),
      usedAt: null
    };
    save();
    return {
      id,
      secret,
      createdAt: state.challenges[id].createdAt,
      expiresAt: state.challenges[id].expiresAt
    };
  };

  const completePairing = ({ challenge, name = "移动设备" } = {}) => {
    const challengeHash = sha256(challenge);
    const entry = Object.values(state.challenges).find((item) => safeEqualHex(item.secretHash, challengeHash));
    if (!entry) throw new Error("配对码无效");
    if (entry.usedAt) throw new Error("配对码已使用");
    const nowMs = now();
    if (Date.parse(entry.expiresAt) < nowMs) throw new Error("配对码已过期");

    const token = `sym_${randomBytes(32).toString("base64url")}`;
    const tokenHash = sha256(token);
    const id = `device_${tokenHash.slice(0, 20)}`;
    const createdAt = iso(nowMs);
    entry.usedAt = createdAt;
    state.devices[id] = {
      id,
      name: String(name || "移动设备").trim().slice(0, 80) || "移动设备",
      tokenHash,
      createdAt,
      lastSeenAt: null,
      revokedAt: null
    };
    save();
    return { ...publicDevice(state.devices[id]), token };
  };

  const authenticate = (token) => {
    const tokenHash = sha256(token);
    const device = Object.values(state.devices).find((item) => safeEqualHex(item.tokenHash, tokenHash));
    if (!device) throw new Error("设备 token 无效");
    if (device.revokedAt) throw new Error("设备已撤销");
    device.lastSeenAt = iso(now());
    save();
    return publicDevice(device);
  };

  const listDevices = () => Object.values(state.devices)
    .map(publicDevice)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const revokeDevice = (deviceId) => {
    const device = state.devices[String(deviceId || "")];
    if (!device) throw new Error("设备不存在");
    if (!device.revokedAt) device.revokedAt = iso(now());
    save();
    return publicDevice(device);
  };

  const getOverlay = (sessionId) => {
    const overlay = state.overlays[String(sessionId || "")];
    return overlay ? { ...overlay } : {};
  };

  const patchOverlay = (sessionId, patch = {}) => {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("session id 不能为空");
    const previous = state.overlays[id] || {};
    const next = { ...previous };
    if (Object.hasOwn(patch, "title")) {
      const title = String(patch.title || "").trim().slice(0, 200);
      if (title) next.title = title;
      else delete next.title;
    }
    if (Object.hasOwn(patch, "archived")) next.archived = Boolean(patch.archived);
    if (Object.hasOwn(patch, "pinned")) next.pinned = Boolean(patch.pinned);
    if (Object.hasOwn(patch, "model")) {
      const model = String(patch.model || "").trim().slice(0, 200);
      if (model) next.model = model;
      else delete next.model;
    }
    // hidden is a local tombstone used when an Agent cannot physically delete
    // its native history (for example Codex desktop rollouts). Keep it in the
    // persisted overlay so the next discovery cannot resurrect the session.
    if (Object.hasOwn(patch, "hidden")) next.hidden = Boolean(patch.hidden);
    next.updatedAt = iso(now());
    state.overlays[id] = next;
    save();
    return { ...next };
  };

  const acquireLease = ({ sessionId, ownerId, ttlMs = 30_000 } = {}) => {
    const id = String(sessionId || "").trim();
    const owner = String(ownerId || "").trim();
    if (!id || !owner) throw new Error("sessionId 和 ownerId 不能为空");
    const nowMs = now();
    const active = state.leases[id];
    if (active && Date.parse(active.expiresAt) > nowMs && active.ownerId !== owner) {
      const error = new Error("该会话正在被其他设备写入");
      error.code = "SESSION_WRITE_CONFLICT";
      error.ownerId = active.ownerId;
      error.expiresAt = active.expiresAt;
      throw error;
    }
    const lease = {
      sessionId: id,
      ownerId: owner,
      acquiredAt: active?.ownerId === owner ? active.acquiredAt : iso(nowMs),
      expiresAt: iso(nowMs + Math.max(1000, Number(ttlMs) || 0))
    };
    state.leases[id] = lease;
    save();
    return { ...lease };
  };

  const releaseLease = ({ sessionId, ownerId } = {}) => {
    const id = String(sessionId || "").trim();
    const owner = String(ownerId || "").trim();
    const active = state.leases[id];
    if (!active || active.ownerId !== owner) return { released: false };
    delete state.leases[id];
    save();
    return { released: true };
  };

  const rememberMessage = ({ sessionId, messageId } = {}) => {
    const session = String(sessionId || "").trim();
    const message = String(messageId || "").trim();
    if (!session || !message) throw new Error("sessionId 和 messageId 不能为空");
    const key = sha256(`${session}\u0000${message}`);
    if (state.messages[key]) return { duplicate: true, acceptedAt: state.messages[key].acceptedAt };
    const acceptedAt = iso(now());
    state.messages[key] = { sessionId: session, messageIdHash: sha256(message), acceptedAt };
    save();
    return { duplicate: false, acceptedAt };
  };

  return {
    file,
    createChallenge,
    completePairing,
    authenticate,
    listDevices,
    revokeDevice,
    getOverlay,
    patchOverlay,
    acquireLease,
    releaseLease,
    rememberMessage
  };
}

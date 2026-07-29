import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

const STORE_VERSION = 5;
const MAX_REMEMBERED_MESSAGES = 2000;
const MAX_MOBILE_MESSAGES_PER_SESSION = 200;
const DEFAULT_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PRIVATE_ASSET_BYTES = 64 * 1024 * 1024;

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
    messages: {},
    assets: {},
    mobileMessages: {},
    queues: {},
    queuePauses: {}
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
      messages: parsed.messages && typeof parsed.messages === "object" ? parsed.messages : {},
      assets: parsed.assets && typeof parsed.assets === "object" ? parsed.assets : {},
      mobileMessages: parsed.mobileMessages && typeof parsed.mobileMessages === "object" ? parsed.mobileMessages : {},
      queues: parsed.queues && typeof parsed.queues === "object" ? parsed.queues : {},
      queuePauses: parsed.queuePauses && typeof parsed.queuePauses === "object" ? parsed.queuePauses : {}
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

function publicAsset(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    name: asset.name,
    mimeType: asset.mimeType,
    kind: asset.kind,
    byteLength: Number(asset.byteLength || 0),
    source: ["upload", "tool", "delivery"].includes(asset.source) ? asset.source : (asset.storage === "upload" ? "upload" : "tool"),
    createdAt: asset.createdAt || null,
    updatedAt: asset.updatedAt || asset.createdAt || null,
    ...(asset.deliveryAt ? { deliveryAt: asset.deliveryAt } : {}),
    ...(asset.expiresAt ? { expiresAt: asset.expiresAt } : {}),
    ...(asset.activity ? { activity: asset.activity } : {})
  };
}

function safeName(value) {
  return String(value || "附件").replace(/[\\/\0]/g, "_").slice(0, 160) || "附件";
}

function mimeTypeForFile(file) {
  const extension = path.extname(file).toLowerCase();
  return ({
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
    ".js": "text/javascript",
    ".jsx": "text/javascript",
    ".mjs": "text/javascript",
    ".cjs": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".html": "text/html",
    ".css": "text/css",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp"
  })[extension] || "application/octet-stream";
}

function realPath(value) {
  try { return fs.realpathSync.native(path.resolve(value)); } catch { return ""; }
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function referencedAssetIds(state) {
  const ids = new Set();
  for (const rows of Object.values(state.mobileMessages || {})) {
    for (const row of Array.isArray(rows) ? rows : []) for (const asset of row?.attachments || []) if (asset?.id) ids.add(asset.id);
  }
  for (const rows of Object.values(state.queues || {})) {
    for (const row of Array.isArray(rows) ? rows : []) for (const asset of row?.attachments || []) if (asset?.id) ids.add(asset.id);
  }
  return ids;
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

  const pruneAssets = () => {
    const referenced = referencedAssetIds(state);
    const nowMs = now();
    let removed = 0;
    let bytes = 0;
    const privateUploads = Object.values(state.assets).filter((asset) => asset?.storage === "upload");
    const removable = privateUploads.filter((asset) => !referenced.has(asset.id));
    const expired = removable.filter((asset) => asset.expiresAt && Date.parse(asset.expiresAt) <= nowMs);
    const privateBytes = privateUploads.reduce((total, asset) => total + Number(asset.byteLength || 0), 0);
    const overflow = privateBytes > MAX_PRIVATE_ASSET_BYTES
      ? removable.filter((asset) => !expired.includes(asset)).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
      : [];
    for (const asset of [...expired, ...overflow]) {
      if (!state.assets[asset.id]) continue;
      if (!expired.includes(asset) && privateBytes - bytes <= MAX_PRIVATE_ASSET_BYTES) break;
      try { fs.unlinkSync(asset.path); } catch {}
      delete state.assets[asset.id];
      removed += 1;
      bytes += Number(asset.byteLength || 0);
    }
    if (removed) atomicWriteJson(file, state);
    return { removed, bytes };
  };

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
      revokedAt: null,
      conversationSendMode: "ask"
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

  // Revocation is retained in the private store so a leaked device token can
  // never become valid again, but revoked devices are no longer active pairings
  // and should not clutter the desktop's "已配对设备" list.
  const listDevices = ({ includeRevoked = false } = {}) => Object.values(state.devices)
    .filter((device) => includeRevoked || !device.revokedAt)
    .map(publicDevice)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const revokeDevice = (deviceId) => {
    const device = state.devices[String(deviceId || "")];
    if (!device) throw new Error("设备不存在");
    if (!device.revokedAt) device.revokedAt = iso(now());
    save();
    return publicDevice(device);
  };

  const getDevicePreferences = (deviceId) => {
    const device = state.devices[String(deviceId || "")];
    if (!device) throw new Error("设备不存在");
    const conversationSendMode = ["ask", "guide", "queue"].includes(device.conversationSendMode)
      ? device.conversationSendMode
      : "ask";
    return { conversationSendMode };
  };

  const updateDevicePreferences = (deviceId, patch = {}) => {
    const device = state.devices[String(deviceId || "")];
    if (!device) throw new Error("设备不存在");
    if (Object.hasOwn(patch, "conversationSendMode")) {
      const mode = String(patch.conversationSendMode || "").trim();
      if (!["ask", "guide", "queue"].includes(mode)) throw new Error("对话发送方式无效");
      device.conversationSendMode = mode;
    }
    save();
    return getDevicePreferences(deviceId);
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

  const putAttachment = ({
    sessionId,
    messageId,
    index = 0,
    name,
    mimeType = "application/octet-stream",
    kind = "file",
    data,
    ttlMs = DEFAULT_UPLOAD_TTL_MS
  } = {}) => {
    const session = String(sessionId || "").trim();
    const message = String(messageId || "").trim();
    const encoded = String(data || "");
    if (!session || !message || !encoded) throw new Error("附件参数不完整");
    const bytes = Buffer.from(encoded, "base64");
    const id = `asset_${sha256(`${session}\0${message}\0${index}\0${name}`).slice(0, 32)}`;
    pruneAssets();
    const previousBytes = state.assets[id]?.storage === "upload" ? Number(state.assets[id].byteLength || 0) : 0;
    const privateBytes = Object.values(state.assets)
      .filter((asset) => asset?.storage === "upload")
      .reduce((total, asset) => total + Number(asset.byteLength || 0), 0);
    if (privateBytes - previousBytes + bytes.length > MAX_PRIVATE_ASSET_BYTES) {
      throw new Error("附件存储空间不足，请删除或等待过期附件清理");
    }
    const directory = path.join(path.dirname(file), "attachments");
    const target = path.join(directory, `${id}.bin`);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch {}
    state.assets[id] = {
      id,
      sessionId: session,
      name: safeName(name),
      mimeType: String(mimeType || "application/octet-stream").slice(0, 160),
      kind: ["image", "text", "file"].includes(kind) ? kind : "file",
      byteLength: bytes.length,
      storage: "upload",
      source: "upload",
      path: target,
      createdAt: iso(now()),
      updatedAt: iso(now()),
      expiresAt: iso(now() + Math.max(1000, Number(ttlMs) || DEFAULT_UPLOAD_TTL_MS))
    };
    save();
    return publicAsset(state.assets[id]);
  };

  const rememberMobileMessage = ({ sessionId, messageId, text = "", attachments = [] } = {}) => {
    const session = String(sessionId || "").trim();
    const message = String(messageId || "").trim();
    if (!session || !message) throw new Error("sessionId 和 messageId 不能为空");
    const rows = Array.isArray(state.mobileMessages[session]) ? state.mobileMessages[session] : [];
    const entry = {
      messageId: message,
      text: String(text || "").slice(0, 20_000),
      createdAt: iso(now()),
      attachments: attachments.map((asset) => publicAsset(asset)).filter(Boolean)
    };
    const previous = rows.findIndex((row) => row.messageId === message);
    const duplicate = previous >= 0;
    if (previous >= 0) rows.splice(previous, 1);
    rows.push(entry);
    state.mobileMessages[session] = rows.slice(-MAX_MOBILE_MESSAGES_PER_SESSION);
    save();
    return {
      ...entry,
      duplicate,
      attachments: entry.attachments.map((asset) => ({ ...asset }))
    };
  };

  const listMobileMessages = (sessionId) => {
    const rows = state.mobileMessages[String(sessionId || "")] || [];
    return rows.map((row) => ({
      messageId: String(row.messageId || ""),
      text: String(row.text || ""),
      createdAt: String(row.createdAt || ""),
      attachments: (row.attachments || []).map((asset) => ({ ...asset }))
    }));
  };

  const listQueue = (sessionId) => (state.queues[String(sessionId || "")] || []).map((item) => ({
    id: String(item.id || ""),
    messageId: String(item.messageId || ""),
    text: String(item.text || ""),
    createdAt: String(item.createdAt || ""),
    attachments: (item.attachments || []).map((asset) => ({ ...asset }))
  }));

  const queueRows = (sessionId) => {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("sessionId 不能为空");
    if (!Array.isArray(state.queues[id])) state.queues[id] = [];
    return state.queues[id];
  };

  const queueItem = ({ id, messageId, text = "", attachments = [], createdAt } = {}) => {
    const itemId = String(id || "").trim();
    const message = String(messageId || "").trim();
    if (!itemId || !message) throw new Error("队列项参数不完整");
    return { id: itemId, messageId: message, text: String(text || "").slice(0, 20_000), createdAt: String(createdAt || iso(now())), attachments: attachments.map(publicAsset).filter(Boolean) };
  };

  const addQueueItem = ({ sessionId, position = "end", ...value } = {}) => {
    const rows = queueRows(sessionId); const item = queueItem(value);
    if (rows.some((row) => row.id === item.id || row.messageId === item.messageId)) throw new Error("队列指令已存在");
    if (position === "start") rows.unshift(item); else rows.push(item);
    save(); return { ...item, attachments: item.attachments.map((asset) => ({ ...asset })) };
  };

  const enqueueQueueItem = (value = {}) => addQueueItem({ ...value, position: "end" });
  const prependQueueItem = (value = {}) => addQueueItem({ ...value, position: "start" });

  const updateQueueItem = ({ sessionId, itemId, text, attachments } = {}) => {
    const item = queueRows(sessionId).find((row) => row.id === String(itemId || ""));
    if (!item) throw new Error("排队指令不存在");
    if (text !== undefined) item.text = String(text || "").slice(0, 20_000);
    if (attachments !== undefined) item.attachments = attachments.map(publicAsset).filter(Boolean);
    if (!item.text && !item.attachments.length) throw new Error("消息或附件不能为空");
    save(); return { ...item, attachments: item.attachments.map((asset) => ({ ...asset })) };
  };

  const removeQueueItem = ({ sessionId, itemId } = {}) => {
    const rows = queueRows(sessionId); const index = rows.findIndex((row) => row.id === String(itemId || ""));
    if (index < 0) throw new Error("排队指令不存在");
    const [item] = rows.splice(index, 1); if (!rows.length) delete state.queues[String(sessionId)]; save(); return { ...item, attachments: item.attachments.map((asset) => ({ ...asset })) };
  };

  const shiftQueueItem = (sessionId) => {
    const rows = queueRows(sessionId); const item = rows.shift() || null; if (!rows.length) delete state.queues[String(sessionId)]; save();
    return item ? { ...item, attachments: item.attachments.map((asset) => ({ ...asset })) } : null;
  };

  const clearQueue = (sessionId) => {
    const id = String(sessionId || ""); const count = (state.queues[id] || []).length; delete state.queues[id]; save(); return { cleared: count };
  };

  const isQueuePaused = (sessionId) => Boolean(state.queuePauses[String(sessionId || "")]);

  const setQueuePaused = (sessionId, paused) => {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("sessionId 不能为空");
    if (paused) state.queuePauses[id] = true;
    else delete state.queuePauses[id];
    save();
    return Boolean(paused);
  };

  const registerWorkspaceFile = ({
    sessionId,
    workspaceRoot,
    filePath,
    activity = "other",
    source = "tool",
    deliveryAt = null
  } = {}) => {
    const requestedPath = path.resolve(String(filePath || ""));
    const rootPath = realPath(String(workspaceRoot || ""));
    const target = realPath(requestedPath);
    if (!rootPath || !target || !within(target, rootPath)) throw new Error("文件不在当前工作目录内");
    if (!fs.statSync(target).isFile()) throw new Error("文件不存在或不可读取");
    const stat = fs.statSync(target);
    const id = `asset_${sha256(`${sessionId}\0${target}`).slice(0, 32)}`;
    state.assets[id] = {
      id,
      sessionId: String(sessionId || ""),
      name: safeName(path.basename(target)),
      mimeType: mimeTypeForFile(target),
      kind: "workspace_file",
      byteLength: stat.size,
      activity: ["read", "search", "edit", "command", "other"].includes(activity) ? activity : "other",
      storage: "workspace",
      workspaceRoot: rootPath,
      source: source === "delivery" ? "delivery" : "tool",
      path: requestedPath,
      createdAt: iso(now()),
      updatedAt: iso(now()),
      ...(deliveryAt ? { deliveryAt: String(deliveryAt) } : {})
    };
    save();
    return publicAsset(state.assets[id]);
  };

  const resolveAsset = (assetId) => {
    const asset = state.assets[String(assetId || "")];
    const target = realPath(asset?.path || "");
    if (!target || !fs.statSync(target).isFile()) return null;
    if (asset.storage === "workspace") {
      const workspaceRoot = realPath(asset.workspaceRoot || "");
      if (!workspaceRoot || !within(target, workspaceRoot)) return null;
    }
    return { ...publicAsset(asset), path: asset.path };
  };

  return {
    file,
    createChallenge,
    completePairing,
    authenticate,
    listDevices,
    revokeDevice,
    getDevicePreferences,
    updateDevicePreferences,
    getOverlay,
    patchOverlay,
    acquireLease,
    releaseLease,
    rememberMessage,
    putAttachment,
    rememberMobileMessage,
    listMobileMessages,
    listQueue,
    enqueueQueueItem,
    prependQueueItem,
    updateQueueItem,
    removeQueueItem,
    shiftQueueItem,
    clearQueue,
    isQueuePaused,
    setQueuePaused,
    registerWorkspaceFile,
    resolveAsset,
    pruneAssets
  };
}

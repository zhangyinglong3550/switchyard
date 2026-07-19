import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteFileSync, ensureDir, nowIso } from "../../../packages/core/src/utils.mjs";

const STORE_VERSION = 1;

export function sessionTitlesPath() {
  if (process.env.SWITCHYARD_SESSION_TITLES_PATH) {
    return process.env.SWITCHYARD_SESSION_TITLES_PATH;
  }
  const home = process.env.SWITCHYARD_HOME || path.join(os.homedir(), ".switchyard");
  return path.join(home, "session-titles.json");
}

function emptyStore() {
  return { version: STORE_VERSION, titles: {} };
}

export function loadSessionTitles() {
  const file = sessionTitlesPath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    const titles = raw.titles && typeof raw.titles === "object" ? raw.titles : {};
    return { version: STORE_VERSION, titles: { ...titles } };
  } catch {
    return emptyStore();
  }
}

export function saveSessionTitles(store) {
  const file = sessionTitlesPath();
  ensureDir(path.dirname(file));
  const payload = {
    version: STORE_VERSION,
    titles: store?.titles && typeof store.titles === "object" ? store.titles : {}
  };
  atomicWriteFileSync(file, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return payload;
}

export function getSessionTitle(id, store = loadSessionTitles()) {
  const key = String(id || "").trim();
  if (!key) return null;
  const entry = store.titles?.[key];
  if (!entry || typeof entry !== "object") return null;
  const title = String(entry.title || "").trim();
  return title || null;
}

/**
 * 合并显示名：自定义标题 > 原生 name > fallback
 */
export function resolveSessionDisplayName(row, store = loadSessionTitles()) {
  if (!row) return "";
  const custom = getSessionTitle(row.id, store);
  const native = String(row.nativeName || row.name || "").trim();
  if (custom) {
    return {
      name: custom,
      nativeName: native || custom,
      hasCustomTitle: true
    };
  }
  return {
    name: native || String(row.id || ""),
    nativeName: native || "",
    hasCustomTitle: false
  };
}

export function applySessionTitleOverlays(rows = [], store = loadSessionTitles()) {
  return (rows || []).map((row) => {
    const resolved = resolveSessionDisplayName(row, store);
    return {
      ...row,
      nativeName: resolved.nativeName || row.name || "",
      name: resolved.name,
      hasCustomTitle: resolved.hasCustomTitle
    };
  });
}

/**
 * 设置或清除自定义标题。title 为空字符串则删除 overlay。
 * @returns {{ id, title, cleared, entry }}
 */
export function setSessionTitle(id, title, { agentId = "", nativeSynced = false } = {}) {
  const key = String(id || "").trim();
  if (!key) throw new Error("session id 不能为空");
  const store = loadSessionTitles();
  const trimmed = String(title ?? "").trim();
  if (!trimmed) {
    const existed = store.titles[key] || null;
    delete store.titles[key];
    saveSessionTitles(store);
    return { id: key, title: null, cleared: true, entry: existed };
  }
  const entry = {
    title: trimmed.slice(0, 200),
    updatedAt: nowIso(),
    agentId: agentId || store.titles[key]?.agentId || "",
    nativeSynced: Boolean(nativeSynced)
  };
  store.titles[key] = entry;
  saveSessionTitles(store);
  return { id: key, title: entry.title, cleared: false, entry };
}

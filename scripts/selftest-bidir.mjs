#!/usr/bin/env node
// 双向续聊端到端自测（P1 验证）
// 验证：4 类 agent 会话列表可见 → POST 续聊 → 读回可见 → SQLite 镜像同步
// 用法：SWITCHYARD_PORT=17890 node scripts/selftest-bidir.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.SWITCHYARD_PORT) || 17890;
const BASE = `http://127.0.0.1:${PORT}`;
const STORE_ROOT = process.env.SWITCHYARD_STORE_ROOT || path.join(os.homedir(), ".switchyard", "mobile-control");

function log(msg) {
  console.log(`[selftest] ${msg}`);
}

async function probeStatus() {
  const res = await fetch(`${BASE}/mobile/v1/status`, { signal: AbortSignal.timeout(3000) });
  return res.ok ? res.json() : null;
}

async function pairDevice() {
  // 优先复用已有 token（同一设备 → 同一 ownerId，lease 可续期不冲突）
  const reused = process.env.SWITCHYARD_TOKEN;
  if (reused) return reused;
  // 纯 HTTP 配对：POST /mobile/pair/begin 创建 challenge（daemon 进程内），
  // 再 POST /mobile/pair/complete 用 secret 换 token。token 立即生效。
  const begin = await fetch(`${BASE}/mobile/pair/begin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ttlMs: 600000 }),
    signal: AbortSignal.timeout(5000)
  });
  if (!begin.ok) throw new Error(`pair/begin HTTP ${begin.status}`);
  const ch = await begin.json();
  const complete = await fetch(`${BASE}/mobile/pair/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: ch.secret, name: "selftest-bidir" }),
    signal: AbortSignal.timeout(5000)
  });  if (!complete.ok) throw new Error(`pair/complete HTTP ${complete.status}`);
  const paired = await complete.json();
  return paired.token;
}

async function main() {
  const mark = `SELFTEST_${Date.now()}`;
  const results = [];
  const check = (name, ok, extra = "") => {
    results.push({ name, ok });
    log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  };

  // 1. daemon 健康
  const status = await probeStatus();
  check("daemon status", Boolean(status?.ok), JSON.stringify({ port: PORT, agents: (status?.agents || []).map((a) => a.id) }));
  if (!status?.ok) { log("daemon 不可用，终止"); process.exit(1); }
  const agents = (status.agents || []).map((a) => a.id);
  for (const want of ["grok", "codex", "claude-code", "opencode"]) {
    check(`agent 可见: ${want}`, agents.includes(want));
  }

  // 2. 配对
  let token = null;
  try {
    token = await pairDevice();
    check("设备配对", Boolean(token));
  } catch (e) {
    check("设备配对", false, e.message);
    process.exit(1);
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 3. 会话列表（4 类）
  for (const agent of agents) {
    const res = await fetch(`${BASE}/mobile/v1/sessions?agent=${agent}`, { headers, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    check(`会话列表: ${agent}`, Array.isArray(data) && data.length > 0, `${data?.length || 0} 个`);
  }

  // 4. 续聊闭环（grok 目标会话）
  const grokSessions = await (await fetch(`${BASE}/mobile/v1/sessions?agent=grok`, { headers, signal: AbortSignal.timeout(10000) })).json();
  const target = grokSessions.find((s) => String(s.title || "").includes("灵析")) || grokSessions[0];
  check("找到 grok 目标会话", Boolean(target), target?.title?.slice(0, 30));
  if (!target) { process.exit(1); }

  const sendRes = await fetch(`${BASE}/mobile/v1/sessions/${target.id}/messages`, {
    method: "POST", headers, body: JSON.stringify({ text: `${mark} 双向续聊自测，请只回复OK` }),
    signal: AbortSignal.timeout(15000)
  });
  const sendData = await sendRes.json();
  check("POST 续聊 accepted", Boolean(sendData?.accepted), JSON.stringify(sendData));

  // 5. 读回可见
  await new Promise((r) => setTimeout(r, 8000));
  const readRes = await fetch(`${BASE}/mobile/v1/sessions/${target.id}?messages=40`, { headers, signal: AbortSignal.timeout(20000) });
  const readData = await readRes.json();
  const msgs = readData?.messages || [];
  const found = msgs.filter((m) => String(m.text || "").includes(mark));
  check("读回看到自己发的消息", found.length > 0, `命中 ${found.length} 条`);

  // 6. SQLite 镜像同步：主动触发一次 Native Mirror 扫描后校验
  const { createSqliteMirror } = await import("../apps/desktop/src/mobile-control/sqlite-store.mjs");
  const { createNativeMirror } = await import("../apps/desktop/src/mobile-control/native-mirror.mjs");
  const mirror = createSqliteMirror({ file: process.env.SESSION_CORE_MIRROR_DB || path.join(STORE_ROOT, "mirror.sqlite") });
  const nativeMirror = createNativeMirror({ mirror, intervalMs: 60_000 });
  await nativeMirror.scanOnce();
  const nativeId = String(readData?.nativeId || target.nativeId || "");
  const mirrored = nativeId ? mirror.readMessages("grok", nativeId, {}) : [];
  const mirroredFound = mirrored.filter((m) => String(m.text || "").includes(mark));
  check("SQLite 镜像同步", mirroredFound.length > 0, `命中 ${mirroredFound.length} 条`);
  nativeMirror.stop();
  mirror.close();

  const passed = results.filter((r) => r.ok).length;
  log(`\n===== 结果: ${passed}/${results.length} 通过 =====`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});

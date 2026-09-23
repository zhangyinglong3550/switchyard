#!/usr/bin/env node
// WorkBuddy / CodeBuddy 账号登录并写入 Switchyard 账号池。
//
// 用法：
//   node scripts/workbuddy-login.mjs                 # 生成授权链接 → 打开浏览器 → 轮询 → 写池
//   node scripts/workbuddy-login.mjs --url-only      # 只打印授权链接（手动打开）
//   node scripts/workbuddy-login.mjs --realm=global  # 指定域（默认 global=WorkBuddy；cn=CodeBuddy）
//   node scripts/workbuddy-login.mjs --count=5       # 连续收集 5 个账号（每个账号各需一次人工授权）
//   node scripts/workbuddy-login.mjs --provider=workbuddy-pool --timeout=600
//
// 凭证只写入 ~/.switchyard/pools/workbuddy_oauth/<provider>.json（0600），不打印 token。
import { execFileSync } from "node:child_process";
import {
  createWorkBuddyAuthState,
  pollWorkBuddyLogin,
  upsertAccounts,
  loadPool,
  workBuddyRealmConfig
} from "../packages/core/src/account-pool/index.mjs";

function argValue(name, fallback = "") {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const providerId = argValue("provider", "workbuddy-pool");
const timeoutSeconds = Number(argValue("timeout", "600")) || 600;
const urlOnly = process.argv.includes("--url-only");
// 双域：global → www.workbuddy.ai（WorkBuddy）；cn → copilot.tencent.com + codebuddy.cn（CodeBuddy）。
const realm = argValue("realm", "global").toLowerCase();
const count = Math.max(1, Math.floor(Number(argValue("count", "1")) || 1));
if (realm !== "global" && realm !== "cn") {
  console.error(`--realm 仅支持 global 或 cn（收到 ${realm}）`);
  process.exit(2);
}

const realmLabel = realm === "cn" ? "CodeBuddy（codebuddy.cn）" : "WorkBuddy（workbuddy.ai）";
const realmCfg = workBuddyRealmConfig(realm);

/** 单轮收号：取 state → 打开授权页 → 轮询。超时返回 null。 */
async function collectOne(prefix) {
  const { state, authUrl } = await createWorkBuddyAuthState({ realm });
  console.log(`${prefix}请在浏览器中完成 ${realmLabel} 账号登录：`);
  console.log("");
  console.log(`  ${authUrl}`);
  console.log("");
  if (urlOnly) {
    console.log("（--url-only：不自动打开浏览器，请手动打开上面的链接；本进程会继续在下方轮询。）");
  } else {
    try {
      execFileSync("open", [authUrl], { stdio: "ignore" });
      console.log("已尝试在默认浏览器打开登录页。");
    } catch {
      console.log("（未能自动打开浏览器，请手动复制上面的链接。）");
    }
  }

  console.log("等待登录完成…（最多 %d 秒，每 3 秒轮询一次）", timeoutSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      // realm 必须透传：state 取自哪个域，token 就只能在该域兑换；漏传会回落 global 导致跨域失败。
      const result = await pollWorkBuddyLogin(state, { realm });
      if (result?.accessToken) return result;
    } catch {
      // 未完成时上游返回业务错误码（登录进行中），继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

if (count > 1) {
  console.log(`将连续收集 ${count} 个账号：每个账号各需在浏览器点一次 GitHub（或其他 IdP）授权。`);
  console.log("每轮开始前请确认浏览器当前登录的是本轮目标账号——复用同一个 GitHub 会话会收到同一个");
  console.log("WorkBuddy 账号，脚本会提示「已在池中」且不会重复入库。换号建议用无痕窗口。");
  console.log("");
}

const collected = [];
for (let index = 1; index <= count; index += 1) {
  const prefix = count > 1 ? `[${index}/${count}] ` : "";
  if (index > 1) {
    console.log("");
    console.log(`── 第 ${index}/${count} 个 ── 请先切换到目标 GitHub 账号（已收 ${collected.length} 个）`);
    console.log("");
  }

  const account = await collectOne(prefix);
  if (!account) {
    console.error(`${prefix}登录超时，跳过本轮（重新运行本命令会生成新的授权链接）。`);
    continue;
  }

  const saved = upsertAccounts(providerId, [{
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    expiresAt: account.expiresAt,
    domain: account.domain || realmCfg.domain,
    realm,
    accountId: account.uid || "",
    enterpriseId: account.enterpriseId || "",
    name: account.nickname || "",
    source: "workbuddy-login"
  }], { poolKind: "workbuddy_oauth", skipDuplicates: false });

  const uid = String(account.uid || "");
  collected.push({ uid, nickname: account.nickname || "", updated: saved.updated > 0 });
  console.log(`${prefix}已写入账号池 ${providerId}（新增 ${saved.added}、更新 ${saved.updated}）`);
  console.log(`${prefix}uid: ${uid.slice(0, 8)}…  昵称: ${account.nickname || "-"}${saved.updated > 0 ? "  ← 该账号已在池中，已更新 token" : ""}`);
}

if (!collected.length) {
  console.error("本次未收集到任何账号。");
  process.exit(1);
}

if (count > 1) {
  console.log("");
  console.log(`本次共收集 ${collected.length}/${count} 个账号：`);
  collected.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item.uid.slice(0, 8)}…  ${item.nickname || "-"}  ${item.updated ? "（更新已有）" : "（新增）"}`);
  });
}
console.log(`账号池 ${providerId} 现共 ${loadPool(providerId, { poolKind: "workbuddy_oauth" }).accounts.length} 个账号。`);
console.log("在 Switchyard 供应商页点「重载配置」或重启网关后生效。");
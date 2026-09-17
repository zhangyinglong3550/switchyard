#!/usr/bin/env node
// WorkBuddy / CodeBuddy 账号登录并写入 Switchyard 账号池。
//
// 用法：
//   node scripts/workbuddy-login.mjs                 # 生成授权链接 → 打开浏览器 → 轮询 → 写池
//   node scripts/workbuddy-login.mjs --url-only      # 只打印授权链接（手动打开）
//   node scripts/workbuddy-login.mjs --provider=workbuddy-pool --timeout=600
//
// 凭证只写入 ~/.switchyard/pools/workbuddy_oauth/<provider>.json（0600），不打印 token。
import { execFileSync } from "node:child_process";
import { createWorkBuddyAuthState, pollWorkBuddyLogin, upsertAccounts } from "../packages/core/src/account-pool/index.mjs";

function argValue(name, fallback = "") {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const providerId = argValue("provider", "workbuddy-pool");
const timeoutSeconds = Number(argValue("timeout", "600")) || 600;
const urlOnly = process.argv.includes("--url-only");
// 双域：global → www.workbuddy.ai（WorkBuddy）；cn → copilot.tencent.com + codebuddy.cn（CodeBuddy）。
const realm = argValue("realm", "global").toLowerCase();
if (realm !== "global" && realm !== "cn") {
  console.error(`--realm 仅支持 global 或 cn（收到 ${realm}）`);
  process.exit(2);
}

const { state, authUrl } = await createWorkBuddyAuthState({ realm });
console.log(`请在浏览器中完成 ${realm === "cn" ? "CodeBuddy（codebuddy.cn）" : "WorkBuddy（workbuddy.ai）"} 账号登录：`);
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
let account = null;
while (Date.now() < deadline) {
  try {
    const result = await pollWorkBuddyLogin(state);
    if (result?.accessToken) {
      account = result;
      break;
    }
  } catch {
    // 未完成时上游返回业务错误码（登录进行中），继续轮询。
  }
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

if (!account) {
  console.error("登录超时：请重新运行本命令（每次运行会生成新的授权链接）。");
  process.exit(1);
}

const row = {
  accessToken: account.accessToken,
  refreshToken: account.refreshToken,
  expiresAt: account.expiresAt,
  domain: account.domain || "www.workbuddy.ai",
  realm,
  accountId: account.uid || "",
  enterpriseId: account.enterpriseId || "",
  name: account.nickname || "",
  source: "workbuddy-login"
};
const saved = upsertAccounts(providerId, [row], { poolKind: "workbuddy_oauth", skipDuplicates: false });
console.log(`已写入账号池 ${providerId}（新增 ${saved.added}、更新 ${saved.skipped}）`);
console.log(`uid: ${(account.uid || "").slice(0, 8)}…  昵称: ${account.nickname || "-"}`);
console.log("在 Switchyard 供应商页点「重载配置」或重启网关后生效。");

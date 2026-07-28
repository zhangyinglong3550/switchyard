import { isAccountPoolProvider, poolKindOf, listEligibleAccounts } from "../../../packages/core/src/account-pool/picker.mjs";
import { loadPool } from "../../../packages/core/src/account-pool/store.mjs";
import { requestLogStats } from "./request-log-store.mjs";
export function buildHealthReport({ config = {}, gateway = {}, providerHealth = {}, mobile = {} } = {}) {
  const checks = []; const add=(id,status,title,detail,action="")=>checks.push({id,status,title,detail,action});
  add("gateway", gateway.running ? "ok" : "warning", "网关", gateway.running ? `运行在 ${gateway.url || "本机"}` : "网关未运行", gateway.running ? "" : "启动网关");
  const providers=config.providers||[]; const unhealthy=providers.filter(p=>providerHealth[p.id]?.status === "unhealthy");
  add("providers", unhealthy.length ? "error" : "ok", "供应商健康", unhealthy.length ? `${unhealthy.length} 个供应商连接异常：${unhealthy.map(p=>p.id).join(", ")}` : `${providers.length} 个供应商状态正常`, "刷新供应商健康");
  const stale=providers.filter(p=>!p.modelsDiscoveredAt || Date.now()-Date.parse(p.modelsDiscoveredAt)>30*864e5);
  if (stale.length) add("catalog", "warning", "模型目录", `${stale.length} 个供应商从未同步或超过 30 天未更新`, "同步模型目录");
  for (const provider of providers.filter(isAccountPoolProvider)) { const pool=loadPool(provider.id,{poolKind:poolKindOf(provider)}); const enabled=pool.accounts.filter(a=>a.enabled!==false&&a.health!=="disabled"); const eligible=listEligibleAccounts(pool); add(`pool:${provider.id}`, enabled.length&&!eligible.length?"warning":"ok", `账号池 · ${provider.id}`, enabled.length ? (eligible.length?`${eligible.length}/${enabled.length} 个账号可调度`:`${enabled.length} 个账号暂不可调度`) : "账号池为空", "查看账号池"); }
  add("mobile", mobile.running?"ok":"warning", "手机控制", mobile.running?`运行在 ${mobile.url || "本机"}`:"手机控制未启用", mobile.running?"":"启用手机控制");
  const stats=requestLogStats({since:new Date(Date.now()-864e5).toISOString()}); const rate=stats.total?Math.round(stats.errors/stats.total*100):0;
  add("requests", rate>=30?"error":rate>=10?"warning":"ok", "近 24 小时请求", `${stats.total} 次请求，${stats.errors} 次失败（${rate}%）；日志 ${Math.round(stats.bytes/1024/1024)} / ${Math.round(stats.maxBytes/1024/1024)} MB`, "查看请求日志");
  const overall=checks.some(c=>c.status==="error")?"critical":checks.some(c=>c.status==="warning")?"warning":"healthy";
  return {generatedAt:new Date().toISOString(),overall,checks};
}

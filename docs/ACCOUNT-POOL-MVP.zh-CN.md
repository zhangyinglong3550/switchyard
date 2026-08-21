# 账号池（Account Pool）· 2.0

> 状态：已开源落地（Switchyard 2.0）  
> 目标：在本机统一管理多账号 OAuth，无需 Sub2API；Grok/Codex 可只开 Switchyard。

## 架构

```
客户端 → Switchyard :17888
            ├─ xai_oauth 池 ──→ api.x.ai
            ├─ codex_oauth 池 → chatgpt.com/backend-api/codex
            └─ antigravity 池 → daily-cloudcode-pa.googleapis.com
```

凭证路径：`~/.switchyard/pools/{poolKind}/{providerId}.json`（权限 600，不进 Git / config.json）。

## 能力矩阵

| 能力 | Grok (`xai_oauth`) | Codex (`codex_oauth`) |
|------|--------------------|------------------------|
| 粘贴导入 | SSO / RT / JSON | CPA `type:codex` JSON / RT |
| 多选文件 / 文件夹 | 支持 | **主路径** |
| Token 刷新 | OAuth refresh | RT 或 `session_token` |
| 额度 | 无稳定公开 API | `wham/usage` 5h+周剩余 |
| 调度 | 加权轮询等 | 同左 |
| 失败换号 | 401/403/429/5xx | 同左 |

## 预设

- `xai-account-pool` → providerId 建议 `grok`
- `codex-account-pool` → `codex-pool`
- `antigravity-account-pool` → 实验性

## 使用（Codex 批量号）

1. 供应商 → 新增/编辑 **Codex 订阅池**
2. **选择 JSON 文件…** 多选本地 `type:codex` 文件，或 **选择文件夹…**
3. **刷新额度** 查看 5h / 周剩余
4. 客户端模型指向池上的 `gpt-5.4` / `gpt-5.5` 等

CLI 批量：

```bash
node /path/to/import-helper.mjs --dir ./codex-jsons
```

（可选：`file/grok/import-codex-pool.mjs` 为本地辅助脚本，仓库内以 UI/IPC 为准。）

## 开发入口

| 模块 | 路径 |
|------|------|
| 持久化 | `packages/core/src/account-pool/store.mjs` |
| 选号/刷新 | `packages/core/src/account-pool/picker.mjs` |
| 导入 | `import-xai.mjs` / `import-multi.mjs` |
| 额度 | `quota.mjs` |
| 调度接入 | `packages/core/src/upstream/dispatch.mjs` |
| UI / IPC | `apps/desktop/renderer/*` · `apps/desktop/src/main.mjs` |
| 测试 | `packages/core/test/account-pool.test.mjs` |

## Antigravity 刷新

请求前会依次尝试：本机尚未过期的 agy / CPA Access，再用 Refresh 换新票。
默认使用已公开的 Antigravity 桌面端 OAuth client（与 CLIProxyAPI / agy 相同）。
可用环境变量覆盖：

```bash
export SWITCHYARD_ANTIGRAVITY_CLIENT_ID="..."
export SWITCHYARD_ANTIGRAVITY_CLIENT_SECRET="..."
```

Grok / Codex 池不依赖上述变量。

## 安全

- 禁止把 pools 目录、token、session 写入 README / issue / 截图说明
- 公共 list API 只返回脱敏字段
- 不做自动注册 / 买号
- Google OAuth client 凭据不进仓库

## 验证

```bash
cd switchyard
node --test packages/core/test/account-pool.test.mjs
npm test
```

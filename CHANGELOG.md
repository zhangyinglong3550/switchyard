# Changelog

## 2.1.4 — 2026-07-15

### Features

- **用量统计 · 按模型成功率**：用量页展示每个模型的调用次数、成功/失败、成功率、Token、平均时延；失败含 `status=0`（网络失败）与 `status>=400`。

### 含 2.1.3

- 双供应商同名模型（如 `beike/gpt-5.6` 与 `codex/gpt-5.6`）路由不再串号。

## 2.1.3 — 2026-07-15

### Fix

- **双供应商同名模型串路由**：如 `beike/gpt-5.6` 与 `codex/gpt-5.6` 同时存在时，不再因共享上游名 `gpt-5.6` 而 first-wins 打到一家。
  - 路由：短名（upstream/alias）仅在全局唯一时生效；冲突时只认完整 model id。
  - Codex catalog：上游名冲突时两边都用完整 slug（`beike/gpt-5.6` / `codex/gpt-5.6`），避免官方 Codex 被压成裸 `gpt-5.6` 后与另一家混淆。

### 说明

- 请重载配置并重新同步 Codex profile，刷新 model catalog。
- 在 Codex 中选择带完整 id / 供应商后缀的项；旧会话若锁了裸 `gpt-5.6` 请新开会话。

## 2.1.2 — 2026-07-14

### Fix

- **侧栏矮屏适配**：Mac 笔记本内建屏上左下角版本号被裁切。导航区可滚动，服务卡片 + 版本条固定底部；矮窗口收紧间距。
- **Responses → Chat 适配**：`responsesToChatResponse` 不再把 OpenAI Responses 的 `text` 配置对象（format/verbosity）误当成 assistant 正文，避免 tool-only 轮次出现垃圾 JSON 文本。
- **Anthropic 官方认证对齐 CC Switch**（含 2.1.1）：复用 Claude Code 登录态（Keychain / `.credentials.json`）；浏览器 OAuth 为高级选项。

### 含 2.1.0 能力

- 应用内自动更新（下载安装并重开）
- Anthropic 官方 OAuth 供应商

## 2.1.1 — 2026-07-14

### Fix

- **Anthropic 官方认证对齐 CC Switch**：主路径改为复用本机 Claude Code 登录（Keychain / `.credentials.json` 的 `claudeAiOauth`），浏览器 OAuth 降为高级选项；不再要求用户必须走自建登录。

## 2.1.0 — 2026-07-14

### Highlights

- **应用内自动更新**：启动时与每 4 小时检查 GitHub Release；发现新版本后顶栏显示更新按钮，点击后**下载安装包并安装，然后重新打开**（macOS DMG / Windows Setup）。
- **Anthropic 官方认证（对齐 CC Switch）**：新增供应商模板「Anthropic Claude（官方 / Claude Code 登录）」。
  - **主路径**：复用本机 Claude Code 登录态（macOS Keychain `Claude Code-credentials` / `~/.claude/.credentials.json` 的 `claudeAiOauth`）。
  - **辅路径**：浏览器 PKCE / 粘贴 `refresh_token`（写入 `~/.switchyard/oauth/`，不覆盖 Claude Code 原凭证）。
  - 请求头：`Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`。

### Auto Update

- 保留定期检测；比较 semver，当前版本 < 最新 Release 时提示。
- 按平台选择资源：`Switchyard-{ver}-arm64.dmg` / `Switchyard-{ver}.dmg` / `Switchyard Setup {ver}.exe`。
- macOS：挂载 DMG → 安装到 `/Applications` → `app.relaunch`。
- Windows：拉起 NSIS 安装器后退出当前进程。
- 无匹配安装包时回退打开发布页。

### Anthropic OAuth

- 认证方式 `anthropic_oauth`：PKCE + `claude.ai/oauth/authorize`，回调 `http://localhost:54545/callback`。
- 请求头使用 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`（非 x-api-key）。
- 支持浏览器登录、状态刷新、退出登录、粘贴 `refresh_token` 导入。
- 发请求前自动刷新即将过期的 access token。

### Docs / Notes

- 小版本升级；配置兼容 2.0.0。
- OAuth 与账号池 token 仅本机，请勿提交 `~/.switchyard/`。

## 2.0.0 — 2026-07-14

### Highlights

- **账号池（Account Pool）一等公民能力**：本机多账号 OAuth 轮询 / 失败换号，凭证存 `~/.switchyard/pools/`，不进 `config.json`。
- **Grok / xAI 池**：粘贴 SSO/RT、CLIProxyAPI `xai-*.json`、加权轮询。
- **Codex 订阅池**：批量导入 CPA `type:codex` JSON / 多选文件 / 文件夹；`session_token` 可续 access；**单号额度查询**（5h / 周剩余）。
- **UI 2.0**：Claude Paper Light（C2）全浅奶油主题。
- 本版本为 **大版本**：新增账号池与额度能力，建议从 1.x 备份后升级。

### Account Pool

| poolKind | 上游 | 导入方式 |
|----------|------|----------|
| `xai_oauth` | `api.x.ai` 直连 | 粘贴 SSO/RT、CPA json |
| `codex_oauth` | ChatGPT Codex Responses 直连 | 多选 json / 文件夹 / 粘贴 / `~/.codex/auth.json` |
| `antigravity_oauth` | 实验性（可选 CPA 8317） | 文件夹 / 默认 auth-dir |

调度策略：加权轮询 / 最久未用 / 最低错误率。失败状态 `401/403/429/5xx` 自动换号（最多 3 次）。

### UI

- Theme **C2 Paper Light**：暖奶油底、蜜陶土强调、浅色侧栏。
- 账号池表：中文状态、额度列、Access 令牌过期说明、刷新额度。

### Docs / Release

- 新增 `docs/ACCOUNT-POOL-MVP.zh-CN.md`
- README 增加账号池说明；截图区标注 2.0 UI 刷新说明

### Breaking / 注意

- 账号池 token 仅本机；请勿提交 `~/.switchyard/pools/`。
- Codex 额度依赖 ChatGPT 会话/token 有效与网络代理。
- Grok 官方无稳定「剩余额度」公开 API，额度列仅展示团队/说明信息。

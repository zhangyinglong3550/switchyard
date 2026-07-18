# Changelog

## 2.2.13 — 2026-07-19

### Feat

- **Codex OAuth 有效登录检测与页内登录**：新增/编辑 `codex_oauth` 供应商时检测本机 `~/.codex/auth.json` 是否为**有效登录**（access 未过期，或可 refresh 续期），而不是只看文件是否存在。无效时可在供应商页点「登录 Codex」（调起 `codex login`）、刷新状态、尝试续期，或高级粘贴 `refresh_token` 回写 auth.json。请求前会尽量自动续期 access。

## 2.2.12 — 2026-07-19

### Fix

- **Codex 配置备份串台**：`~/.codex/config.toml` 与 `~/.grok/config.toml` 曾共用 `config.toml.*.bak` 文件名，恢复 Codex 时可能捞到 Grok 的 `[cli]`/marketplace 配置。新备份改为 `codex.config.toml.*` / `grok.config.toml.*`；旧备份仍兼容，但会按内容排除明显串台项。
- **Codex 切「官方直连」残留三方配置**：从手切供应商直连（`provider_direct`）切官方时，未清掉 `switchyard-provider-direct` 的 custom provider / 顶层路由键。现会完整剥离，只保留用户自有块（如 `[mcp]`）。
- **手切三方代理 `requires_openai_auth`**：`provider_direct` 写入由 `false` 改为 `true`，与常见 CC Switch 手配一致。

## 2.2.10 — 2026-07-16

### Fix

- **OpenCode 配置无效 `Missing key …limit.output`**：写入 `provider.switchyard.models` 时，若模型未配置 `maxOutputTokens` 只会写 `limit.context` 或完全不写 limit。OpenCode 要求 `limit.context` 与 `limit.output` 成对。现始终补齐二者（有 maxOutput 用配置值，否则按 context 的约 1/4 推算，默认 context=128k / output 夹在 8k–128k）。

## 2.2.9 — 2026-07-16

### Fix

- **Grok + GPT（Responses 上游）流式报 `missing field id`**：Grok/OpenCode 等 chat 客户端 `stream=true` 时，上游 `openai_responses`（Codex 池 / aigo-gpt 等）的 Responses SSE 被原样透传，客户端按 `chat.completion.chunk` 解析失败。现对 `translate=responses` 做 **Responses SSE → Chat Completions SSE** 实时翻译（含文本 delta、tool_calls、usage）。

## 2.2.8 — 2026-07-16

### Fix

- **Grok 自定义模型 404 / 走官方代理**：`config.toml` 里含点号的模型 id（如 `GLM-5.2`）若写成裸表头 `[model.sy-ke--GLM-5.2]`，TOML 会解析成嵌套表，Grok 只看到截断名 `sy-ke--GLM-5` 且丢失 `base_url`，请求落到 `cli-chat-proxy.grok.com` 报 404。现改为始终写 `[model."sy-…"]` 引号表头；在客户端页重新「一键写入」后重启 Grok 即可。

### UX

- **偏好设置**：去掉 Grok Build 冗余状态卡（写入/诊断仍在「客户端」「诊断」页）。

## 2.2.7 — 2026-07-16

### Fix

- **应用内更新下载损坏**：macOS 自动更新偶发 `hdiutil: 映像数据已损坏`。
  - 优先用系统 `curl` 下载安装包，失败再回退 undici。
  - 下载后校验体积；DMG 再跑 `hdiutil verify`，失败自动重试一次。
  - 仍失败时打开浏览器下载链接，避免半截安装。
  - 进度用 Transform 统计，避免 `data` 监听 + pipeline 竞态。

## 2.2.6 — 2026-07-16

### Features

- **OpenCode 客户端**：网关入口 `/opencode/v1`（OpenAI 兼容）；一键写入 `~/.config/opencode/opencode.json` 的 `provider.switchyard`（模型清单 + baseURL）。
  - 首次在「客户端」页一键写入后，**新增 / 修改 / 启用模型会自动刷新** OpenCode 的 models 列表（仅托管已标记的 switchyard 段，不覆盖用户其它 provider）。
  - 诊断中心可检测 OpenCode 是否指向 Switchyard。
- **OpenCode Skills / 会话 / 可视化**：
  - Skills：读取 `~/.config/opencode/skills` 与 `skill`（兼容旧路径）；支持编辑、禁用、跨 Agent 复制、SkillHub 安装。
  - 会话：读取 `~/.local/share/opencode/storage/session`（JSON 元数据 + message/part），可在「会话」页浏览与删除（移入废纸篓）。
  - 调用可视化：筛选 OpenCode 时展示会话时间线（用户/助手正文、工具调用）；网关请求日志仍按 `client_id=opencode` 归类。
  - 核心文件：可编辑 `opencode.json` / `AGENTS.md`。
- **Grok Build 客户端**（三方模型）：
  - 网关入口 `/grok/v1`（OpenAI Chat Completions）。
  - 一键写入 `~/.grok/config.toml` 托管块：`[model."sy-*"]`（`model`=Switchyard 模型 id，`base_url` 指向网关，`api_key=switchyard-local`；含点号 id 必须引号表头）。
  - 保留用户原有 `[model.*]` / `[cli]` 等配置；仅当默认已是 `sy-*` 时才改 `[models].default`。
  - 首次写入后，增/改/启模型自动刷新托管块。
  - Skills：`~/.grok/skills`；会话：`~/.grok/sessions/**/summary.json` + `updates.jsonl` 时间线；诊断可检测是否指向 Switchyard。

## 2.2.5 — 2026-07-16

### Fix

- **KE 预制模型能力**：Claude / GPT 全部勾选文本、工具、推理、图片、流式、多模态；DeepSeek / GLM 仍按目录能力。

## 2.2.4 — 2026-07-15

### Features

- **KE 供应商模板**：OpenAI 兼容内网网关 `https://openapi-ait.ke.com/v1`；无 `/models` 时用预制列表。
  - 预制模型（13）：Claude Sonnet 5 / 4.6 Sonnet / Opus 4.8 / Opus 4.6；GPT-5.5 / 5.4 / 5.6 sol·luna·terra；DeepSeek V4 Pro·Flash；GLM-5.2 / 5.1。
  - 选中模板后自动带出模型；API Key 本机自填。

## 2.2.3 — 2026-07-15

### Build

- **安装包体积优化**（约 -20%）：
  - 只保留 en / 中文 Electron 语言包（去掉约 40MB 多语言）
  - 剔除 better-sqlite3 编译源码 `deps/src`（仅保留 `.node` 运行时）
  - 更紧的 asar 文件过滤；`compression: maximum`
  - arm64 DMG：约 **99MB → 80MB**；App 解压约 **250MB → 200MB**

## 2.2.2 — 2026-07-15

### UX

- **自动更新检测**：间隔由 4 小时改为 **5 分钟**。
- **界面简化开关**：侧栏品牌旁开关；关闭=简化版（仅总览 / 供应商 / 模型 / 客户端），打开=详细版（全部 Tab）。偏好写入本机 `localStorage`。

## 2.2.1 — 2026-07-15

### Features

- **供应商级网关重试配置**：供应商编辑页可设置「网关重试」。失败时先在网关重试可恢复错误，**成功后再回给 Agent**（对客户端透明）；模型级设置可覆盖。

### 含 2.2.0

- 默认最多 3 次；状态 `0`/`429`/`5xx`；流式仅在未写出内容前重试。

## 2.2.0 — 2026-07-15

### Features

- **网关自动重试（可恢复失败）**：上游瞬时失败时同模型自动重试，默认最多 3 次。
  - 状态：`0`（网络失败）、`429`、`500`/`502`/`503`/`504`；**不重试** 400/401/403 等客户端/鉴权错误。
  - 退避：`500ms → 1500ms → 3000ms`。
  - **流式**：仅在尚未向客户端写出内容前重试（失败响应/未建立成功流）；成功开流后不再整请求重试，避免重复输出。
  - 可配置：模型表单「网关重试」或 `model.retry` / `provider.retry`（`enabled`、`maxAttempts` 1–10、`onStatus`、`backoffMs`）。
  - 与账号池换号互补：外层同策略重试，内层仍可换账号。
  - 请求日志：`retryCount` / `requestSummary.dispatchRetryAttempts`。

### Docs

- 模型编辑页增加最小重试配置说明。

## 2.1.5 — 2026-07-15

### Fix

- **自动更新提示不出现**：启动检查若早于页面 IPC 订阅会丢事件；现改为页面加载后检查 + 渲染进程主动 `app:check-update` + `did-finish-load` 重推。
- **GitHub API 限流/失败**：API 失败时回退到 `releases/latest` 重定向解析版本；失败写入 gateway 日志（不再静默吞掉）。

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

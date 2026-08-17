# Changelog

## 2.3.4 — 2026-08-17

### Feat

- **Cursor 订阅账号池**：新增 `cursor_subscription` 池类型与「Cursor 订阅账号池」预设，支持粘贴导入 `email----…----userId::JWT` / JSON / NDJSON，多号加权轮询、失败换号和逐号连接测试；导入账号统一复用本机 Cursor machine id，凭证仅保存到 `~/.switchyard/pools/cursor_subscription/`，不写入 `config.json`。

### Fix

- **Cursor 账号池去重**：Cursor 池按 access token 优先去重，避免同一订阅号因邮箱字段变化或缺失被重复写入。
- **DSH 思考等级与桌面端对齐**：思考档位不再硬编码，改为从 DSH host `session.models` 的当前模型 `reasoning.efforts` 动态读取——手机端显示的档位与桌面端完全一致（不同模型/供应商档位不同，如官方 DeepSeek 为 off/high/max，Switchyard 网关模型为 off/low/high/max）。`getSettings` 支持 async，registry 兼容 Promise 解包。
- **Grok/Codex 分叉隐藏补全**：会话列表行与详情的 capabilities 统一关闭 fork（此前仅 agents 级生效）。

## 2.3.3 — 2026-08-17

### Fix

- **Grok 分叉彻底隐藏**：此前只关了 agents 级，会话列表行/详情的 capabilities 仍来自 ACP runtime（fork:true）导致手机端菜单仍显示「分叉会话」。现统一在 Grok 的 listSessions/readSession 层关闭 fork。
- **Codex 分叉隐藏**（桌面属主会话不能分叉）。
- **DeepSeek 思考等级**：手机端「对话设置」思考程度下拉恢复（off/low/high/max），保存后下一轮生效（`session.selectModel` 带 `reasoningEffort`）。

## 2.3.2 — 2026-08-17

### Fix

- **DeepSeek 思考等级恢复**：DSH runtime 补上 `settings.effortOptions`（off/low/high/max）与 `setSettings`（此前遗留 `setSettings: undefined` 导致手机端无法选择思考等级）；保存时若未显式选过模型则回退会话当前模型，`session.selectModel` 带 `reasoningEffort` 下一轮生效。
- **分叉入口按可用性收敛**：Codex（桌面属主会话不能分叉）与 Grok（ACP 单实例锁无原生 fork）隐藏手机端「分叉会话」；DeepSeek 分叉实测可用保留。

## 2.3.1 — 2026-08-17

### Feat

- **底部可收起任务卡（全 Agent）**：对话页底部（文档流内、输入栏上方）新增实时任务卡，展示当前会话的计划步骤与进度（`3/7 完成 · 43%`），可一键收起/展开，折叠状态按会话记忆。Codex `update_plan`、Claude `TodoWrite`、OpenCode/DSH `todo_write` 统一汇入；DSH 原生 goal 与 todo 也同步。
- **DSH 斜杠命令与 Skills**：`/` 补全新增 DeepSeek 支持——内置命令（goal/compact/clear/model/help/status）+ 从 DSH host `skill.list` 实时拉取原生 Skills；registry 兼容 async runtime 命令列表。
- **对话内容展示打磨**：任务卡改为随内容滚动（不再悬浮盖消息），输入栏与面板间距、正文排版节奏进一步优化。

### Fix

- **DSH 自托管端口冲突**：默认端口 17890 改为 17891（17888 网关 / 17889 mobile-control / 17890 会话核心网关均被占用）；自托管前先探测占用端口是否为 DSH host 并复用。
- **任务卡无法收起**：`<summary>` 原生 toggle 与手动 toggleAttribute 双重翻转导致"收不起来"，改为自管理 class。
- **DSH `/` 命令报错**：`dynamicCommands.map is not a function`（async runtime 返回 Promise），registry 统一 `await Promise.resolve` 解包。

## 2.3.0 — 2026-08-17

### Feat

- **手机端 DeepSeek（DeepSeek Harness）全链路接入**：新增 `dsh-host-client` + `deepseek-harness` runtime。优先附着运行中的 DSH Desktop 服务器（手机与桌面实时双向同步），找不到时用 `dsh web` 自托管固定端口（17890）。支持会话列表/历史（含 thinking、工具卡、图片描述）、续聊发送（含图片与文本附件）、停止、重命名、分支、模型与推理档位切换、原生审批。
- **DSH 事件流**：`/api/events.mux` WebSocket 订阅 chunk 级流式输出（text-delta 逐字上屏）、tool/call→tool/result 合并、turn/host 状态与 `approval/requested`/`approval/resolved`。该通道为纯下行（上行帧会被服务端以 1008 拒绝），客户端不再发送应用层心跳。
- **审批体验修复**：待审批卡片不再永久卡死——会话终止自动清理、DSH 桌面端处理的审批会向手机推送 `approval_resolved` 并即时撤卡、超过 30 分钟的遗留审批不再展示。
- **任务步骤卡对齐所有 Agent**：Codex `update_plan`、Claude Code `TodoWrite`、OpenCode `todo_write`、DSH `todo/write` 统一渲染为可勾选步骤卡（每轮取最后一次写入）；目标模式（goal）面板扩展至全部 Agent——Codex 原生 goal、DSH `goal/change` + 投影原生 goal，Claude/OpenCode 由 todo 流推导，registry 层统一累积并在会话终止时清理。
- **Agent 抽屉式筛选**：会话列表的 Agent 并排 pill 改为底部抽屉选择器（含彩色头像与各 Agent 会话数），适应持续增加的 Agent 数量。
- **对话体验打磨**：AI 回复新增身份行（Agent 彩点 + 名称 + 模型）；每轮轻量时间提示；流式思考默认展开（终态自动折叠）；工具行按 read/search/edit/command 分类着色；终端卡红绿灯头；composer 聚焦光晕与发送键渐变；Markdown 标题/列表节奏优化；暗色主题同步覆盖。
- **视觉刷新（v86）**：会话卡片去边框改柔和投影、输入框改填充式、顶/底栏去分割线、圆角统一；五种主题与暗色同步覆盖。
- **空状态升级**：无会话时展示图标 + 引导文案 +「开始新任务」CTA。
- **Android 触觉反馈**：审批到达与任务完成时轻震动（`SwitchyardNative.vibrate`）。

### Fix

- **安卓壳支持回环联调**：配对与网络策略允许 `http://127.0.0.1` / `localhost`（生产 Tailscale HTTPS 路径不变），配合 `adb reverse` 可在模拟器直连本机 Session-Core。
- **lsof 发现 DSH Desktop**：按 COMMAND 列解析（空格转义为 `\x20`），修复端口发现失败导致误自托管的问题。
- **移动端资产缓存**：Service Worker 缓存键与版本号统一，避免同版本号下旧 JS/新 HTML 混用导致功能失效。

## 2.2.20 — 2026-07-22

### Feat

- **Claude Code → Codex 会话复制接力**：Sessions 页可预览并将 Claude Code 用户/助手正文复制到独立 Codex thread；Claude 原会话保持不变且仍可继续使用，两边后续不自动同步。
- **接力安全与恢复机制**：完整读取源 JSONL（默认 16 MB 上限）、fingerprint/checkpoint 防重复、每批最多 200 条注入；Codex rollout 修改前备份并原子替换，失败时恢复并归档新建 thread。
- **Codex app-server 接入**：通过 `thread/start`、`thread/inject_items`、`thread/name/set`、`thread/read` 创建可继续对话的新会话，并补齐 Codex Desktop 对话生命周期投影。

## 2.2.19 — 2026-07-21

### Fix

- **删除模型后清理陈旧默认路由**：`saveConfig` 会剔除已不存在的全局/客户端 `defaultModel` 与 Claude `modelMapping` 条目。
- **Codex `model =` 自动回退**：`applyCodex` / `syncCodexModelArtifacts` 不再把已删除的 id（如 `codex-pool/gpt-5.6-luna`）写回 `~/.codex/config.toml`；无匹配时回退到当前目录中第一个可用模型，避免 Agent Desk / Codex CLI 报 `No route for model …`。

## 2.2.18 — 2026-07-20

### Fix

- **配置预览 = 合并后全文**：Codex / Claude Code 等与「一键写入」同一套 merge，预览不再只显示补丁片段。
- **Claude Code 关闭 Foundry 旁路**：写入时清除 `CLAUDE_CODE_USE_FOUNDRY`、`ANTHROPIC_FOUNDRY_*` 以及裸模型旁路（`ANTHROPIC_SMALL_FAST_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL`），避免企业 Foundry 配置残留导致仍走 `openapi-ait` 而本地 Switchyard 看似已写入却不可用。

## 2.2.17 — 2026-07-19

### Feat

- **用量「发现探测」分类**：客户端协议探测（列模型、Ollama tags/show、props、version 等无 model 请求）聚合为 `(发现探测)`，不再显示成「未知」；历史日志同步按路径归类。

### Fix

- **会话命名对话框**：Electron 渲染进程不支持 `window.prompt`，改为应用内「会话命名」弹窗（保存 / 清除 / Enter / Esc）。

## 2.2.16 — 2026-07-19

### Feat

- **会话命名**：Sessions 页可为本机会话自定义名称。标题写入 `~/.switchyard/session-titles.json` 覆盖层；Hermes / OpenCode / Grok 尽量同步写回原生 title（Claude / Codex 等仅覆盖显示名）。留空可清除自定义名。
- **按模型缓存统计**（对齐 CC Switch 核心口径，不做缓存计价）：
  - 从上游 usage 提取 `cache_read` / `cache_creation`（含 Anthropic `cache_*_input_tokens`、OpenAI `prompt_tokens_details` 等别名）。
  - 请求日志落库并按 Agent×模型聚合：缓存命中量、缓存写入量、命中率（`cache_read ÷ prompt`，cap 100%）。
  - 用量页表格与汇总展示缓存列。

## 2.2.15 — 2026-07-19

### Fix

- **Claude ↔ 思考档位双向映射**（对齐 CC Switch `resolve_reasoning_effort`）：
  - `anthropicToChat`：`output_config.effort` / `thinking.budget_tokens` / `thinking.type=adaptive` → Chat `reasoning.effort`（`max`→`xhigh`；未知值不注入）。
  - `chatToAnthropicMessages`：Chat `reasoning` / `reasoning_effort` → Anthropic `thinking` + `output_config`；写入 budget 时同步抬高 `max_tokens`，避免 `budget > max_tokens` 400。
  - Claude → Codex Responses 链路：档位经 Chat 中转后由 2.2.14 的 `chatToResponses` 继续透传。
- **tool_call reasoning 占位**：`reasoning-state` 在 thinking 已启用且 assistant 带 `tool_calls` 却无任何 reasoning 时补非空占位，避免 Kimi/DeepSeek 等上游 `reasoning_content is missing` 400。

## 2.2.14 — 2026-07-19

### Fix

- **Chat → Responses 透传思考档位**：`chatToResponses` 现会把客户端的 `reasoning` / `reasoning_effort` 写成 Responses 原生 `reasoning` 对象（对齐 CC Switch / Codex++）。修复 Hermes / OpenCode 等 Chat 客户端走 Codex Responses 上游时思考等级丢失。
- **请求日志记录 reasoning 参数**：`request_summary.params` 增加 `reasoning` / `reasoningEffort` / `thinking` 等字段，便于对照日志验证是否传到网关。

## 2.2.13 — 2026-07-19

### Feat

- **Codex OAuth 有效登录检测与页内登录**：新增/编辑 `codex_oauth` 供应商时检测本机 `~/.codex/auth.json` 是否为**有效登录**（access 未过期，或可 refresh 续期），而不是只看文件是否存在。无效时可在供应商页点「登录 Codex」（调起 `codex login`）、刷新状态、尝试续期，或高级粘贴 `refresh_token` 回写 auth.json。请求前会尽量自动续期 access。

### Fix

- **Codex 三方代理 `requires_openai_auth = true`**：切到 Switchyard 三方代理时写入 `true`（不再写 `false`），与常见 CC Switch / 手配一致；仍用 `experimental_bearer_token = "dummy"` 走本地网关。

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

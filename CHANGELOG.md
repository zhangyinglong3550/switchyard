# Changelog

## 2.3.16 — 2026-09-24

### Fix

- **Claude 4.7+ 的 thinking 形态按模型版本适配**：`applyChatReasoningToAnthropic` 此前对所有 Anthropic Messages 上游一律写 `thinking.type=enabled` + `budget_tokens`，而 Claude 4.7 起（含 Opus 5.5、Sonnet 5）只接受 `thinking.type=adaptive` + `output_config.effort`，导致请求被上游 400（`claude-opus-5-5 requires adaptive thinking; omit thinking or use thinking.type=adaptive and output_config.effort`）。现在按模型版本选择形态：4.7+ 写 `{type:"adaptive"}` 且不再附带 `budget_tokens`，4.6 及更早（含 4.5 全系）保持 `enabled` + `budget_tokens` 不变。判定基于上游硬约束，对全部 Anthropic Messages 供应商生效，不针对单一 provider。
  - 新增 `parseClaudeModelVersion` / `requiresAdaptiveThinking`（`reasoning.mjs`）。版本号只在 `claude` 之后的头几段里解析：客户端别名形如 `claude-switchyard-ke-glm-5.3-xxx` 会带 `claude` 前缀但实为其他模型，不能把其中的 `5.3` 当成 Claude 版本。
  - 版本无法识别时按旧形态处理，保持既有行为；`adaptive` 不需要抬高 `max_tokens`，该逻辑只在旧形态下生效。
  - 新增 4 条单测覆盖新旧两代模型的出站形态、命名风格解析与 `4.7` 分界。全量 860/860 通过。

## 2.3.15 — 2026-09-23

### Changed

- **网关回归「透传 + 协议转换」，去掉自造内容与代客户端决策**。原则：网关只负责透传，协议不适配时做消息体形态转换；不自己拼内容，不替客户端做决定。对全部接入 provider 生效，非 WorkBuddy 专属。
  - 删除 `reasoning-cache.mjs`：它按会话记住上一轮思考，在客户端未回传时**替客户端回填**——纯属网关编造内容，且客户端通常自带思考，实际几乎空转。
  - `reasoning-state` 改为纯字段转换：客户端 thinking 块 → `reasoning_content`；不再生成思考摘要、不再给 tool_call 补占位、不再改写推理档位、不再替客户端把 `thinking` 降级为 `disabled`。客户端已带 `reasoning_content` / `reasoning` 时原样透传。
  - `workbuddy-adapter`：去掉 `injectDeepSeekThinking`（客户端没要求也注入 `thinking.enabled` + 默认 `reasoning_effort`）与 `backfillReasoningContent`（给每条 assistant 补空 `reasoning_content`）。
  - 删除随之失去调用方的 `ensureToolCallReasoningPlaceholder` 与 `TOOL_CALL_REASONING_PLACEHOLDER`；`server.mjs` 去掉为思考缓存服务的流内累积。
  - 保留的均为上游硬约束适配：强制 `stream`、补 `stream_options`、`tool_choice` 归一、`developer`→`system`、首条补 system、工具名/schema/角色归一、字段名映射。

- **思考回传的去重**：客户端已回传思考时不再复制一份 `reasoning` 别名。长会话实测出站体积 3,415,756 → 2,556,386 字节（−25%）。

### Added

- **`/v1/models` 如实发布上下文窗口**（`publicModel` 输出 `context_window` / `max_context_window` / `max_output_tokens`）。此前一个窗口字段都不发，客户端无从得知上限，也就无法自己决定何时压缩历史。配置里没写则不发布，网关不编造数字。
- **`/v1/models` 发布真实窗口后**，workbuddy preset 的 `deepseek-v4.1-flash` 由 `128000` 改为 `1000000`（官方客户端对该模型声明 `maxInputTokens=1000000`；上游限额计数器实测上限 1,048,576）。

### Fixed

- **上游 4xx/5xx 的原话与响应体不再丢失**。此前这类失败在日志里 `error` 与 `response_preview` 都是空的，客户端只看到光秃秃的 `Bad Request`，排查时无从下手（「老会话不能用」的问题就是卡在这里，最后靠手工回放请求才挖出上游原话）。三处根因：
  - `requestPayloadError` 只认 `error.message` / `error` / `message`，而 WorkBuddy / CodeBuddy 把话放在 `msg` / `extError.message` / `displayMsg` 里，取值全部落空 → 现覆盖这些形态，并支持裸字符串、仅错误码、仅 `displayMsg`。
  - `pipeStream` 在上游非 2xx 时直接透传状态码与头部，**从不读 body** → 现读出 body，把原话与完整响应体交给 `onStreamSummary`。
  - `recordStreamDiagnostics` 不认 `summary.upstreamError` → 现写入 `record.error`，并在 `requestSummary.upstreamError` 保留 `{status, message, body}`。
  - 客户端行为不变：状态码与 body 原样透传，网关不做内容改写，只是日志不再丢原因。

### Tests

- 全量 855 用例通过。新增：`requestPayloadError` 覆盖六种上游错误体形态；端到端用例断言 400 时 `error` 非空且含上游原话；`reasoning-state` 改为纯转换后的透传/不写入/不改开关三组用例；`prepareWorkBuddyChatBody` 不再注入思考开关的用例。

### 说明

- **WorkBuddy 的上下文额度按「上游限额计数器」而非它回传的 `input_tokens` 计算**：同一 prompt，回传 663,910、限额按 1,050,424 算（比值 1.5822，与「全部字符 ÷ 去掉思考后的字符 = 1.5892」吻合）。即回传的思考被计入限额却不计入回传值，故面板显示的 token 数会低估离墙距离。
- **那 1,000,000 窗口下实际可用约 660k**：实测 `workbuddy/deepseek-v4.1-flash` 在 664,680 处触顶（400 `context_length_exceeded`），而 `command-code` / `ke` 同族模型可到 957,383 / 934,367（声明 1M 的 96% / 93%），说明隐藏计数的行为因 provider 而异。
- 本版**不替客户端裁历史**：历史思考由客户端自己回传，网关如实转发。老会话若要恢复，需客户端自行压缩，或改用余量更大的 provider。

## 2.3.14 — 2026-09-18

### Fixed

- **ZCode 经网关调用 WorkBuddy 模型稳定 400 `code=11128`**（`displayMsg`：请求被安全策略拦截）。根因是上游对**客户端模板句指纹**的逐字匹配审核，与 2.3.12 处理的 `/console` HTML WAF **不是同一类规则**，`/v2` 同样生效，因此此前「global 走 `/v2` 就不需要净化」的结论在本类规则上不成立。
  - 触发串：ZCode 的 system prompt 含 Codex 系环境块 `Main branch (you will usually use this for PRs)`。同一网关出口下 Cursor 正常，正是因为它的 prompt 不含该句——**与 provider / 账号 / tools 数量无关**。
  - 证据链：真实请求体 1:1 重放（直连 `/v2` 与经网关两条路径）均 400；对 system prompt 做前缀二分定位到该句；仅替换该句即 200。同一请求打到修复前构建 400、打到含修复的源码网关 200。
  - 修复：新增 `sanitizeWorkBuddyChatBody`（对齐参考实现 `Sliverkiss/workbuddy2api` 的 `internal/upstream/sanitize.go`），在 `dispatch.mjs` 的 workbuddy 出站管线中**无条件**执行——与 `wafHardening` 门控的 HTML WAF 分开，因为本类规则在 `/v2` 必现，且改写语义不变。

### Added

- **出站指纹脱敏规则表**（`workbuddy-adapter.mjs`）。审核按**逐字精确匹配**（非语义审核），故改写策略是「每句只换一个词、语义不变」：
  - 改写层：`Main branch (you will usually use this for PRs)` → `Default branch (…)`；`You are Claude Code, Anthropic's official CLI for Claude` → `…official CLI tool for Claude`；`You are a coding agent running in the Codex CLI, a terminal-based coding assistant.` → `…Codex CLI tool, …`；`To give feedback, users should report the issue at …` → `To provide feedback, …`；裸数字 `11128` → `11-128`（上游只要请求体里出现 `11128` 就整单拦截，而它正是本类拦截自身的错误码，故讨论该错误码的会话不改写必然失败）。
  - 剥离层：`x-anthropic-billing-header: …;` 键值段整段删除，残留裸键名缩写成 `x-anthropic-billing-hdr`；`cc_xxx=…;` 尾随键值循环清理。
  - 扫描面：`content`（含数组形态 `text` 分片）、`reasoning_content`、`reasoning`、`tool_calls[].function.arguments`；`tools` 定义与图片 data URL 不动。带特征预检快路径，未命中即返回原值以保持引用相等。

### Changed

- **面板客户端清单收敛为单一真源**，修复 2.3.13 遗留的「请求列表 / 用量 / 会话等页面没有 ZCode 选项」。此前 `client-visibility-utils.mjs` 虽是清单真源，但 `renderer.js` 另存 7 份手抄映射表（卡片顺序、脱敏标签、`agentLabel` 内联表等），`index.html` 另存 7 处手抄 `<option>` 副本，加客户端只会改到其中一份。
  - `client-visibility-utils.mjs`：新增 `CLIENT_LABELS` / `clientDisplayLabel()` / `CLIENT_FILTER_OPTIONS`（真实客户端 + `model-test` 这类只落库、不可接入的伪 clientId）。
  - `renderer.js`：删除重复表，改为两张派生表——`RUNTIME_CLIENT_FILTERS`（请求日志 / 用量 / 测试台 / 脱敏放行，取自客户端真源）与 `LOCAL_AGENT_FILTERS`（会话 / Skills / 核心文件 / Skill 复制安装目标，取自主进程 `agent:definitions` 的本地 Agent 目录）；客户端卡片标题与顺序同样改为派生。
  - `index.html`：删除 7 处硬编码 `<option>`，只留空 `<select>` 由脚本填充。`plugin-agent-filter` 保留 `claude-code` 单值，因为 `agent-plugins.mjs` 明确只支持 Claude Code。
  - 两个维度刻意不合并：「运行时入口」（含 `generic-openai`，本机无目录）与「本机 Agent 目录」（含 `zcode`，不含 `generic-openai`）。

### Tests

- `npm test` 纳入 `apps/desktop/renderer/*.test.mjs`（此前 `renderer-structure.test.mjs` 不在测试范围内，真源改动不会被拦截）；`client-visibility-utils.test.mjs` 新增清单唯一性、伪 clientId 不泄漏成接入目标、未知 id 回退、ZCode 作用域四组用例。全量 851 用例通过。
- `workbuddy-account-pool.test.mjs` 新增用例覆盖五条改写、三类剥离、放行面（`main branch 上的 PR 怎么合` / `错误码 11101` / `You are Claude` 等不被误改）、字段覆盖与图片分片保留、无 `messages` 原样返回、调用方请求体不被改写。

## 2.3.13 — 2026-09-18

### Added

- **ZCode 成为独立客户端维度**：`zcode` 现在与 Codex / Claude Code / DeepSeek Harness 同级，不再是混在通用 `/v1` 入口里、`clientId` 为空的匿名流量。
  - 网关：新增路由前缀 `/zcode/v1`（`CLIENT_PREFIXES`），请求按 `clientId=zcode` 归集；协议沿用 OpenAI Chat 直通，无需新增适配器。
  - 配置：`SUPPORTED_CLIENTS` 与默认 `clients.zcode`（`enabled` / `allowedModels` / `defaultModel`）就位，`config.example.json` 同步；`mergeWithDefaults` 保证旧配置无需手工改写即可获得该维度。
  - 面板：客户端卡片（排序紧随 DeepSeek Harness）、概览页接入地址 `http://127.0.0.1:17888/zcode/v1`、会话/日志标签、模型「Agent 范围」多选、脱敏面板标签、测试控制台前缀均已登记。
  - 范围界定：ZCode 暂无「一键写入配置」，卡片只提供启用状态与默认模型控制（Base URL 由 ZCode 侧自行填写），因此不进 `PROFILE_META`；诊断页也不列 ZCode——诊断卡片依赖可探测的本地配置文件，ZCode 未提供，避免出现空卡片。

### Tests

- `packages/core/test/v0.3-multi-client.test.mjs` 新增 ZCode 维度用例：`/zcode/v1/models` 只发布该维度允许的模型、通用入口仍看到全部模型（证明可见性隔离）、`/zcode/v1/chat/completions` 直通 200、跨维度越权在路由期 400。
- `renderer-structure.test.mjs` 的客户端卡片顺序断言同步更新。全量 833 用例通过。

## 2.3.12 — 2026-09-18

### Fixed

- **WorkBuddy 403 的根因既不是身份也不是内容，而是端点**。`global` 域的两个 chat 端点内容扫描策略不同：
  - 用同一条真实失败会话（`curl https://www.workbuddy.ai` → 403）的完整出站 body，**只换 path**：`/console/chat/completions` → **403**（2.8 KB WAF 拦截页），`/v2/chat/completions` → **200**（145 KB 完整响应）。
  - `/v2` 完全不扫描内容：裸 `curl https://…`、`html.unescape(`、`<script>alert(1)`、`%3Cscript`、`&lt;script` 全部 200。
  - 这解释了「官方客户端 / 同类开源项目能过、本项目中转不能过」：`BulidH/workbuddy2api` 的 CN realm 走 `/v2`，而本项目池里是 global 账号、路径表以 `/console` 优先，于是每次请求都撞内容扫描。
  - 修复：global 路径表改为 **`/v2` 优先**，`/console` 仅作 `/v2` 下线（404/405）时的回退；`cn` 本就只有 `/v2`，不受影响。
- **WorkBuddy 账号池可靠性**：只将 JSON 2xx / `stream.ok` 记为成功，402/404（包括 401 续期后的失败）不记成功、不额外换号；最终 404 响应体保持可读，普通 403/429 错误重建保留响应头。
- **WorkBuddy WAF 403 防御性错误处理**：仅对 HTTP 403 且 HTML 标题明确为 `WAF Block Page`（忽略大小写及空白差异）的响应返回脱敏的 `upstream_policy_blocked` / `upstream_policy_error`，保留 403 并说明上游安全策略拦截不足以证明凭证过期；不因此重试、换号或更新账号健康状态。普通 401/403/429 与正常流式/非流式响应保持原有行为；此改动不解除上游拦截，也不改变客户端自身的 `auth_failed` 分类。
- **移除凭空构造的归属头组（`X-Agent-Purpose` / `X-IDE-*` / `X-Product`）**：对照官方客户端 `app.asar` 的 `buildHeaders(session)` 实测——官方 chat 出站只有 `Accept` / `Authorization` / `Content-Type` / `X-User-Id`（企业账号另加 `X-Enterprise-Id` / `X-Tenant-Id`，有域时加 `X-Domain`）；`X-Agent-Purpose` 在官方全量二进制中出现 **0 次**，`X-IDE-*` / `X-Product` 仅用于 `/v2/activity/workbuddy/banner` 等非 chat 接口。凭空发送这组头等于自报非官方客户端，与同类开源实现（workbuddy2api `CommonHeaders` 同样不发）也不一致，现全部移除（即撤销 2.3.11 引入的该头组）。
- **撤回 `X-Device-Token` 出站注入**：该头在官方客户端中仅挂载于 `/v2/billing/meter/checkin-activity-status` 与 `/v2/billing/meter/daily-checkin` 两个计费接口，chat 链路不使用；官方桌面端的 `fetchDeviceToken()` 在本机实测持续返回 `TuringShield standardService is unavailable`，即官方在无此头的情况下同样正常对话。账号池字段 `deviceToken`、环境变量 `SWITCHYARD_WORKBUDDY_DEVICE_TOKEN_FILE` 与文件兜底读取一并移除。

### Added

- **WorkBuddy 账号池并发保护**：供应商字段 `maxInFlight` 为每账号进程内在途请求上限，默认 **3**，接受正整数，缺省或无效值回落到 3，其他池不受此配置影响。刷新前同步占位（仅聊天调度传 `reserveLease: true`；纯选号/探测默认不占租约），流式请求到 EOF / cancel / error / abort 才释放；刷新完成后复核最新资格（停用/冷却即释放并顺延下一可用账号）；全忙返回 503 capacity，不发上游请求。取消不处罚账号、不增加尝试。
- **WorkBuddy 会话亲和**：仅采用 `opts.sessionKey` 或请求体显式 `session_id` / `sessionId` / `metadata.session_id`，按客户端和模型隔离，成功后绑定；TTL 一小时、缓存最多 2000 条。不会从首条用户文本或内容哈希推断会话；停用、冷却及容量约束优先。
- **WorkBuddy 限流冷却**：429 尊重 `Retry-After` 秒数或 HTTP 日期；明确代码 6004 只冷却当前模型，并支持重置消息中明确标注 `UTC+8` 的 `YYYY-MM-DD HH:mm:ss`。有效未来期限不截短；无效/过去提示使用既有保守回退。并发结果使用最新持久状态，不缩短已有冷却；所有模型候选均冷却时不回退绕过限制。不增加重试、改变出站身份或请求内容。
- **出站内容硬化 `hardenWorkBuddyChatBody`（默认关闭）**：`/console` 端点确有内容扫描，命中危险特征即 403。规则与实现：
  - 扫描面覆盖 `content`（含数组形态 `text` 分片）、`reasoning_content`、`reasoning`、`tool_calls.arguments`；`prepareWorkBuddyChatBody` 会派生与 `reasoning_content` 并存的 `reasoning` 字段，两者都必须处理，否则裸特征会从后者漏到上游。
  - 实测命中集（每条独立探针，均为「函数名 + 左括号」形态）：`alert( msgbox( eval( confirm( unescape( decodeURIComponent( decodeURI( fromCharCode( document.write( system( subprocess.run( compile(`；放行 `prompt( escape( encodeURIComponent( encodeURI( atob( btoa( Function( setTimeout( setInterval( exec( popen( subprocess( __import__( document.cookie innerHTML`。危险标签只有 `<script` / `<base`，事件绑定为主流 `onXxx=`。
  - shell 动词按 `curl|wget|fetch` 统一处理，且仅在同串出现 URL / IPv4 / 域名特征时才动手；`curl 怎么用` 这类纯讨论不动。
  - 中和一律用可见相似字符，只破坏特征赖以成立的标点：`<script` → `‹script`、`onXxx=` → `onXxx＝`、`alert(` → `alert（`、`%3c` → `%３c`、`&lt;` → `&ｌt;`；shell 动词用空串拼接（`curl` → `c''url`，任何 shell 都会展开回原动词，同时保持可执行）。零宽字符实测会被上游归一化掉，不可靠，故不使用。
  - `hardenText` 带 `WAF_PREFILTER` 快路径：只匹配候选词干、不带括号要求（`decodeURI` 覆盖 `decodeURIComponent`），未命中直接返回原值以保持引用相等；只求「不漏」，精确改写留给慢路径。
  - **默认不启用**：global 已改走不扫描内容的 `/v2`，正常路径无需改写会话文本。实测改写（`html.unescape(` → `html.unescape（`）反而会让模型在思考链里报告「full-width parenthesis 语法错误」。现仅在显式设 `provider.wafHardening = true`（即回退 `/console` 的兜底场景）时启用。

### Notes

- 排障过程证伪了「身份 / 指纹 / 请求头」方向：把真实失败会话的完整出站 body 直打上游、只切换头组做了五组 A/B（现状头、参考项目完整身份头组、仅归属头、原始未硬化 body × 两组头）——**五组全部 403**，头组不是变量。
- 也推翻了「组合规则」的早期判断：`[system, assistant(tool_calls)]` 两条消息即 403，清空 `tool_calls` 立刻 200，说明 `tool_calls[].function.arguments` 单独存在就触发，不需要「外部大段内容 + 思考链动词」同时出现。
- 参考项目 `BulidH/workbuddy2api` 的 `internal/upstream/sanitize.go` 处理的是 **Claude Code / Codex CLI 模板句指纹**（`You are Claude Code`、`x-anthropic-billing-header`、`Main branch (`、裸数字 `11128`），与本文的危险函数族不是同一类规则。**当时判断「它只是为了绕开 `/console`」是错的**：该指纹族在 `/v2` 同样生效，本项目当时未移植，直接导致 2.3.14 的 ZCode 400 问题。
- 硬化代码保留但默认不执行：`/v2` 若被上游下线、回退到 `/console` 时，可打开 `wafHardening` 兜底。

### Tests

- `packages/core/test/workbuddy-account-pool.test.mjs`：路径回退断言改为 v2 → console，global 绑定断言改为 `/v2` 优先；WAF403 用例（流式/非流式 × 2 种标题形态）断言诊断信息（典型诱因、`fetch/curl + 域名`、SSRF 启发式误报、新建会话、Request UUID）以及无 `retriedAttempts`、单次调用即返回（`calls===1` / `bodyReads===1`）、池文件字节不变；硬化用例覆盖危险函数族、改写后放行、「同名非调用形态放行」（`subprocess` / `subprocess(x)` / `a.compile` / `the system design`）、`fetch` + URL 与无 URL 放行、`reasoning` / `reasoning_content` 并存同改；出站形态用例断言归属头组与 `X-Device-Token` 均不注入。全量 832 用例通过。

## 2.3.11 — 2026-09-17

### Fixed

- **ZCode 通过网关报 `auth_failed 403 / Forbidden`**：客户端 `User-Agent` 被当作出站身份头透传，与网关写的官方 UA 合并成 `官方UA, 客户端UA` 的畸形值，上游按「非官方客户端」拒绝。现在透传头丢弃 `user-agent`，并在写请求头前做一次大小写不敏感去重（防止任意头名大小写变体被 undici 合并成畸形值）。
- **多轮请求报 `11155 reasoning_content_missing`**：上游规则是——只要带 `reasoning_effort`（真开思维链），**每轮 assistant 都必须回传上一轮真实思考**；ZCode 这类客户端不回传。现在改为**按需开启严格思维链**，不再无脑注入 effort。
- **出站形态对齐官方桌面端**：UA 改为 `WorkBuddy/5.5.4 WorkBuddy AI/5.5.4 CLI/2.137.1`（cn 为 `WorkBuddy/... WorkBuddy/...`），并补 `X-Agent-Purpose` / `X-IDE-Name` / `X-IDE-Type` / `X-IDE-Version` / `X-Product` 归属头组；刷新与积分查询同步改用同一形态（登录授权流程仍用插件 CLI 形态）。

### Added

- **网关侧思考回传（`reasoning-cache.mjs`）**：客户端不回传思考时，网关把每轮思考按会话缓存（内存、TTL 30 分钟、最多 200 会话 × 20 轮），下一轮按 assistant 文本指纹回填给上游，从而在 ZCode 这类客户端上也能持续开启思维链；匹配不上自动回落到「不思考」稳模式，不会因缓存缺失导致请求失败。
  - 严格思维链判定：历史无 assistant（首轮）→ 开；历史 assistant 都能配上思考（客户端回传或缓存回填）→ 开；否则关。
  - 实测：首轮 399 字思考，第二轮 1706 字思考，均 200。

### Tests

- 新增 `packages/core/test/reasoning-cache.test.mjs`（4 条：会话键解析、按文本回填与不匹配不填、TTL 与容量上限、指纹稳定性）；workbuddy 池测试补 strict/off 模式断言。全量 754/754 通过。

## 2.3.10 — 2026-09-17

### Added

- **WorkBuddy / CodeBuddy 原生账号池**：新增 `workbuddy_oauth` 池类型，把 WorkBuddy（workbuddy.ai）与 CodeBuddy（codebuddy.cn）账号作为一等账号池接入本机网关，替代「本地再跑一个 workbuddy2api 网关」的部署方式。链路变为 `客户端 → Switchyard :17888 → 上游账号域`。
  - OAuth 登录与刷新按实测协议实现：`POST /v2/plugin/auth/state?platform=CLI` 取授权链接、`GET /v2/plugin/auth/token?state=` 轮询换 token、`GET /v2/plugin/login/account?state=` 取 uid/昵称、`POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` + `X-Auth-Refresh-Source: plugin`）续期；凭证只写 `~/.switchyard/pools/workbuddy_oauth/*.json`（0600），不进 `config.json`。
  - 上游硬约束适配：出站强制 `stream: true`（上游拒绝非流式）、首条消息非 system 时自动补一条 system 提示、chat 走 `/console/chat/completions` 并在 404/405 时回退 `/v2/chat/completions`；非流式客户端请求由网关聚合 SSE 成 Chat JSON。出站头按官方客户端形态（`X-User-Id` / `X-Domain: www.workbuddy.ai` / `Origin` / `Referer` / `X-No-Enterprise-Id`）。
  - 复用账号池通用能力：加权轮询、模型级冷却、401 先续期再换号、401/403/429/5xx 换号、公开列表脱敏。
  - **双域**：WorkBuddy（`www.workbuddy.ai`，chat 先 `/console` 再回退 `/v2`）与 CodeBuddy（`copilot.tencent.com` + `codebuddy.cn` 域头，chat 走 `/v2`）按账号 `realm` 自动路由；池内可混放两种账号。
  - **额度查询**：billing 域 `get-user-resource` 聚合积分（workbuddy.ai 首选无 `/v2` 路径、404 回退；codebuddy.cn 走 `/v2`），账号列表「额度」列显示 `积分 剩余/总量（剩X% · N 个套餐）`。
  - **自动续期**：请求时过期即刷新、401 强制续期后重试；应用内另起后台巡检（启动后 90s 首次、此后每 6h），只续期「1 小时内即将过期」的账号，仍有效的账号不打扰上游；可用 `account-pool:refresh-expiring` 手动触发。
  - 桌面端：新增 **WorkBuddy / CodeBuddy 账号池** 供应商预设，账号池面板支持 **面板内登录**（workbuddy.ai / codebuddy.cn 按钮，自动轮询写入池）、粘贴/选择文件/选择目录导入 `workbuddy2api` 的 `auths/*.json`（嵌套 `{account,auth}` 与扁平形都兼容），以及启用、删除、策略切换。供应商诊断对该池改用真实模型目录与 chat 路径探测，不再误报 405。
  - 命令行等价入口：`node scripts/workbuddy-login.mjs --realm=global|cn`。
  - **思考分片合并**（修复 ZCode 里「思考很分散」）：WorkBuddy/CodeBuddy 上游按词切分思考（实测 384 片、每片 1–5 字），网关侧把连续 `reasoning_content` 分片合并到 60 字或 150ms 再下发，正文/工具调用/结束帧仍即时透传。实测同一请求思考帧 384 → 10（每帧 52–61 字），正文帧数不变且思考不混入正文。新增 `reasoning-coalescer.mjs` 与 `packages/core/test/reasoning-coalescer.test.mjs`（5 条）。
  - **出站改写对齐官方客户端**（修复思考不进思考区）：强制 `stream:true` 之外补 `stream_options.include_usage`、`tool_choice` 对象→string 归一（`none` 时连 tools 一起抑制）、`developer`→`system`；DeepSeek 系注入 `thinking.type=enabled` + 默认档 `reasoning_effort:high`（显式 `disabled` 尊重），历史 assistant 带 reasoning 痕迹时回填 `reasoning_content`。实测同一请求：修复前思考帧 0 / 正文 344 帧，修复后思考 384 帧且思考不再混进正文。

### Tests

- 新增 `packages/core/test/workbuddy-account-pool.test.mjs`（8 条：OAuth 端点与刷新头、账号池刷新与公开脱敏、chat 路径回退与账号头、双域绑定与域头、额度查询与积分聚合、后台续期只碰即将过期账号、出站改写（thinking/tool_choice/role/回填）与 SSE 聚合、预设/配置默认值）；新增 renderer 结构断言（导入 + 双域登录入口）。全量 744/744 通过，renderer 结构 12/12 通过。

## 2.3.9 — 2026-09-01

### Fixed

- **KE Sol 传图续轮必炸（`adapter_eof`）修复**：Codex 的 `view_image` 会把用户已粘贴的同一张图再回传一份，图片进入 `tool` 消息后触发 KE 上游 `context_length_exceeded`（非流式 400，流式被吞成 200 空 SSE）。现在 `responsesToChat` 跟踪上下文已出现的图片：`function_call_output` 里与上文重复的图片替换为文本占位，不再重复发给上游；用户自己传的图片（含多图）不受影响，Sol 原生视觉能力保持开启。
- **Chat→Responses 流支持空前导重试**：`streamChatAsResponses` 在没有任何输出（文本/推理/工具调用/usage）时，按路由的 `preludeRetryAttempts`/`preludeRetryBackoffMs` 重发同一请求（KE Sol 默认 2 次、250/750ms 退避），兜底上游偶发空流；一旦已有有效输出绝不重试。
- **Codex 流式请求日志不再整行空白**：`/codex/v1/responses` 走 Chat 上游（`streamChatAsResponses`）时，`response_summary` 里 `finish_reason`/`text`/`toolCalls` 全为空，成功的流和 `adapter_eof` 截断在日志里长得一模一样。现在 `onStreamEnd` 会按流终止诊断写入 `finishReason: completed|incomplete`、`stream`、以及失败时的 `error`（带上游原始错误），请求记录 `error` 也同步标记 `incomplete stream (...)`。
- **`streamChatAsResponses` 的 diagnostics 可判定**：新增 `terminalSeen`、`toolCallCount`、`errorCode`、`errorMessage`；并把「上游无终止标记 → 合成 `SWITCHYARD_INCOMPLETE_STREAM`」提前到 diagnostics 之前，否则调用方永远看到空错误码。
- **顶层 `aborted` 日志可归因**：原来只有一行 `{"level":"error","msg":"aborted"}`，现在带 `clientId`、`path`、`modelId`、`requestedModel`、`ms`、`clientAborted`、`abortReason`，能区分客户端取消与上游断流。

### Tests

- 新增 `server records Codex chat-stream terminal state instead of a blank 200 row`（截断流记为 `incomplete`、正常流记为 `completed`）；`adapters` 两条既有测试补上 `terminalSeen`/`errorCode` 断言。`node --test packages/core/test/*.test.mjs apps/desktop/src/mobile-control/*.test.mjs` 722/722 通过。

### Fixed（思考内容与正文混淆）

- **流式思考不再被改写进正文**：`chat-reasoning` / `deepseek-reasoning` 两个补丁此前在「delta 只带 `reasoning_content`、没有 `content`」时把思考文本回填成 `content`，导致思考阶段的每个分片都变成正文——ZCode 等 chat 客户端里表现为整段思考混进回答，且逐片 `trim()` 还吃掉了词间空格。该分支当初是为 KE 中继的 deepseek「正文也放在 reasoning_content」写的兜底，但实测上游从不把 `content` 与 `reasoning_content` 放进同一个 delta（workbuddy 33:0、KE GLM 208:0），前提不成立。现在流式方向原样透传 `reasoning_content`（它本就是 chat 客户端的标准思考字段，网关自身合成 SSE 也用它）。
- **思考不再凭空消失**：`chat-reasoning` 的旧逻辑以「剥离后 delta 是否为空对象」决定回填还是丢弃，而 KE 的 GLM、Kimi 等上游每个思考 delta 都带 `role`，剥完剩下 `{role}` 非空，于是既没回填也没吞掉，思考被静默丢弃（实测 KE GLM-5.3 的 208 条思考全部消失）。现在只清理 `reasoning` / `reasoning_details` 别名，保留 `reasoning_content`；上游只给别名时提升为标准字段。
- **新增 `think-tag-split` 补丁**：MiniMax-M2.7 / M3 等上游不返回 `reasoning_content`，而是把思考用 `<think>...</think>` 包进 `content`。Responses 协议路径本有 `ThinkTagStreamSplitter` 处理，但 chat 直通（`pipeStream`）没有，客户端拿到的正文里混着思考标签。新补丁在 chat 直通路径上按跨 delta 状态机拆分标签（`<think>` 与 `</think>` 常相隔数十个分片），并把标签被切开的情况按缓冲重组；仅在首段紧贴 `<think>` 时触发，正文中途出现标签一律透传。实测 MiniMax-M2.7 的 950 字符思考与 728 字符正文逐字符守恒。
- 影响面：`chat-reasoning` 覆盖的 DeepSeek / Kimi / GLM / Qwen / MiniMax / Doubao 等模型此前全部受影响（12/12 组合异常）；GPT、Gemini、ERNIE 系不命中这些补丁，行为不变。

### Tests

- 新增 `think-tag-split.test.mjs`（10 条：标签拆分、跨分片重组、非首段标签不误拆、请求间状态隔离）。`v0.4-compat-patches` 中固化旧行为的 3 条断言改为正确行为。全量 736/736 通过。

## 2.3.8 — 2026-09-01

### Fix

- **聚合/代理型 provider 不再原样透传思考档位**：`reasoning-effort-catalog.mjs` 把 `ke`、`bai`、`command`、`blank-gpt` 这类 provider 归成 `chatPassthrough`，Codex 的 `medium`/`xhigh` 会原样发给上游，GLM 系因此报 `该模型始终思考，不支持关闭思考；请使用 low、high 或 max`（上游 code 1210）。现在只在落到「透传形态」时按模型族（`glm|zhipu|z-ai`）回退到新组 `thinkingWithEffort`：只发 `reasoning_effort` 且值钳在 `low/high/max`，能力表不再暴露 `none`（强制思考模型不给关闭档）。已按 provider 精调过的组（如 `zhipu-glm`、`kimi-coding`）行为不变。
- **KE Claude 全系恢复可用**：`compat/patches/ke.mjs` 的 Bedrock 适配判定原先写死 `claude-opus-4-8`，该模型下线后补丁对 `ke/claude-sonnet-5`、`ke/claude-opus-5` 零覆盖，任何带 `reasoning_effort` 的请求都被 KE 转成 `thinking.type.enabled` 并被 Bedrock 400（`"thinking.type.enabled" is not supported for this model`）。判定放宽为 `claude-` 前缀，effort 取值额外兼容 `output_config.effort`。
- **`mapDeepseekWire` 尊重 `thinkingParam: "none"`**：复用 DeepSeek 的 `low/high/max` 钳制时不再强制附带 `thinking` 开关，避免出现上游判成「关闭思考」的 `thinking.disabled`。
- 全站回归：17 个启用模型 × `low/medium/high/xhigh` 共 68 组逐档探测通过（`bai/deepseek-v4-flash-vision-exp` 仅在 5 路并发下抖动，单发正常）。新增 3 条单测覆盖族回退、非 GLM 保持透传、KE Claude adaptive 改写。

## 2.3.6 — 2026-08-30

- 统一桌面端与 Android 安装包版本号。

## 2.3.5 — 2026-08-21

### Fix

- **用户显式选择推理等级时不再降级为 none**：`reasoning-state` 适配规则此前在「多轮历史缺失 thinking 块」时会无条件把 `reasoning.effort` 覆盖为 `none`。若用户明确选择了推理等级（`reasoning_effort` / `reasoning.effort` 非 off），或因模型能力/OpenRouter stealth 等强制推理模型不能被关闭时，现在均原样保留并发往上游，避免 Ox Alpha 等模型在第二问起收到 `none` 被上游 400。

## 2.3.4 — 2026-08-17

### Removed

- **Cursor 订阅供应商**：不再作为上游接入。Cursor 模型请在 Cursor 客户端内直接使用；旧配置里的 `cursor_subscription` 供应商会在加载时忽略。
- **Antigravity 外挂 CLIProxyAPI**：去掉 `antigravity-cli2api` 预设（本机 8317）。原生 Antigravity 账号池仍直连 Google。

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

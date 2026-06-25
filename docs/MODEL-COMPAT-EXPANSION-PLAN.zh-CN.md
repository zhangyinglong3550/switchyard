# Switchyard 对标 CC Switch 的 Agent 模型适配计划

更新时间：2026-06-24

## 目标

对标 GitHub 开源项目 `farion1231/cc-switch`，梳理它在 Claude Code、Claude Desktop、Codex 等 Agent 客户端接入不同厂商模型时的真实适配方式，并把可复用能力补进 Switchyard。

当前执行目标不是再证明“模型协议大类只有 OpenAI / Anthropic”，而是研究并落地 Agent 客户端和上游厂商之间的字段契约适配：模型发现、默认模型槽位、工具调用字段、tool result 邻接、thinking/reasoning 回传、视觉输入、SSE 事件、Codex session/catalog、错误重试和健康/failover 证据链。后续每个兼容结论都必须能落到 provider/model 元数据、预防性修正、运行时 rectifier、请求日志解释或 fixture 回归中的至少一项。

本计划修正一个重要前提：这里的 CC Switch 指 GitHub 开源项目 `https://github.com/farion1231/cc-switch`，不是本机旧的 `codex-ccswitch-gateway` 项目。本机调研快照为：

- 参考仓库：`/Users/zhangyinglong/file/codex/cc-switch-open-source`
- remote：`https://github.com/farion1231/cc-switch.git`
- 快照提交：`6fd4e6f feat(proxy): 添加本地代理请求覆盖功能，支持自定义请求头和请求体 (#4589)`

本文只记录协议、字段、路由、运行时兼容和测试计划，不记录 API Key、OAuth token、Cookie、原始请求正文或附件内容。

## 核心判断

“理论上只有 OpenAI / Anthropic 两类协议”不足以解释 Agent 场景的问题。Claude Code、Claude Desktop、Codex 这类客户端会叠加自己的模型发现、工具调用、thinking、session、流式事件和本地配置约定；不同厂商即使都标称 OpenAI-compatible，实际也会在字段级行为上明显不同。

高频差异包括：

- 角色：`developer`、`system`、Claude-safe model slot、本地 `[1M]` 标记是否被上游接受。
- 内容块：字符串、typed content、image block、tool result、Responses input item 的形态不同。
- 工具：tool name 字符集、JSON Schema 严格度、tool_use/tool_result 邻接、并发工具调用约束不同。
- thinking/reasoning：有的要 `thinking`，有的要 `enable_thinking`，有的要 `reasoning_effort`，OpenRouter 又是 `reasoning: { effort }`，历史回传字段也不同。
- 视觉：模型配置或导入信息常把文本模型误标成支持图片，导致图片直发上游后识别错误或 400。
- 流式：OpenAI Chat SSE、OpenAI Responses SSE、Anthropic SSE 的 delta、done、error 和 EOF 行为不同。
- 错误恢复：部分问题不能靠预设补丁提前穷举，只能在上游返回具体错误后做一次受控整流重试。

因此 Switchyard 后续不能只做“兼容补丁开关”，还要做 CC Switch 风格的运行时适配链路：先按 provider/model 元数据预防性修正，再按上游错误分类做同 provider 一次整流重试，最后才进入 failover 或把可解释错误交给客户端。

## CC Switch 关键实现观察

### 1. Provider 元数据不是展示字段，而是路由契约

`src/types.ts` 中的 `ProviderMeta` 把供应商真实差异显式建模：

- `apiFormat`: `anthropic`、`openai_chat`、`openai_responses`、`gemini_native`。
- `codexChatReasoning`: 描述 Responses 到 Chat 时应使用的 reasoning 参数和回传字段。
- `localProxyRequestOverrides`: 允许 provider 级覆盖请求头和请求体。
- Claude Desktop / Claude Code 模型槽位、用量、健康检测、失败队列等也挂在 provider 元数据上。

Switchyard 应继续保留自身 provider/model 配置，但要把“兼容能力”从纯 UI 开关提升成路由层可执行契约。

### 2. Codex 接入重点是 custom provider、catalog 和官方登录态

`src-tauri/src/codex_config.rs` 中 CC Switch 固定使用 `model_provider = "custom"`，同时处理：

- `model_catalog_json` 和 `models_cache.json`。
- 保留 Codex 官方认证。
- 统一 Codex session bucket，避免切 provider 后会话不可见。
- 从 model spec 生成 Codex 可识别的 catalog，并写入 speed tiers 等字段。

这与 Switchyard 当前口径一致：不能改成 `switchyard` provider，否则 Codex App 会话会按 provider 分组丢失；三方模型能否出现在下拉，核心在 catalog/cache，而不是 `provider/model` 斜杠本身。

### 3. 转发链路有预防性修正和反应式整流

`src-tauri/src/proxy/forwarder.rs` 的关键路径不是单纯透传：

1. 选择 provider 和 adapter。
2. media 预防性降级。
3. 过滤私有 `_` 字段。
4. Claude slot / model alias 映射。
5. 应用 provider 请求覆盖。
6. 发送上游请求。
7. 根据错误触发 media / thinking signature / thinking budget 整流。
8. 对同一 provider 重试一次。
9. 记录 provider 成功/失败，必要时进入 failover。

Switchyard 现有 compat patch 更像“转换前的静态规则”。后续要补一层 `runtime rectifier`，能读取上游错误、修改请求、重试并把动作写入请求日志。

### 4. thinking 需要按错误类型修，不应只靠开关

CC Switch 至少有两类 thinking 整流器：

- `thinking_rectifier.rs`：识别 invalid signature、thought signature invalid、must start with thinking block、signature required、extra signature not permitted 等错误，删除或调整 thinking / redacted_thinking / signature 后重试。
- `thinking_budget_rectifier.rs`：识别 budget_tokens 约束错误，补齐或扩大 `thinking.type`、`budget_tokens`、`max_tokens` 后重试。

Switchyard 已遇到 DeepSeek `content[].thinking in the thinking mode must be passed back to the API`，说明仅在请求转换阶段“猜参数”不够，需要在错误分类层把 thinking passback、signature、budget、token 吃满分成不同 error class。

### 5. 视觉兜底要同时支持预防和反应

`media_sanitizer.rs` 做两类处理：

- 预防性：根据显式模型能力或已知文本模型名单，把 image block 替换为 `[Unsupported Image]`。
- 反应式：如果上游返回 400/415/422/501 且错误文本包含 image/vision/multimodal 等 unsupported 线索，对同 provider 重试一次。

Switchyard 已有视觉兜底，但要补齐 CC Switch 的两点：配置显式能力优先于启发式名单；上游真实报错后也能重试，而不是只靠导入时能力标注。

### 6. Claude Code 要做模型槽位和 Anthropic 形状适配

`model_mapper.rs` 通过 provider env 把 Claude 的 Haiku/Sonnet/Opus/Fable slot 映射到真实模型：

- `ANTHROPIC_DEFAULT_HAIKU_MODEL`
- `ANTHROPIC_DEFAULT_SONNET_MODEL`
- `ANTHROPIC_DEFAULT_OPUS_MODEL`
- `ANTHROPIC_DEFAULT_FABLE_MODEL`
- `ANTHROPIC_MODEL`

同时会剥离 Claude Code 的本地 `[1M]` 后缀，避免上游不认识。Switchyard 目前已经处理 Claude Code 模型发现形状，但还需要对照补齐 slot 映射、1M 标记、tool_use/tool_result 并发和 thinking block 的完整回归。

### 7. Codex GPT 与 Responses 转换有专门保护

`providers/transform_responses.rs` 对 Codex OAuth Responses 做了特殊处理：

- `store: false`。
- `include` 包含 `reasoning.encrypted_content`，保持无服务端状态下的多轮 reasoning 上下文。
- 默认 tools 和 `parallel_tool_calls`。
- 将 Claude tool_use / tool_result 提升为 Responses input item。
- 清理部分工具输入字段。

这解释了为什么 Claude Code 使用 GPT 时“第一句能回，后面不回”不是单纯模型慢，而可能是 Responses 历史、reasoning encrypted content、function_call 流聚合和 Anthropic SSE 回写不完整。

### 8. SSE 需要完整解析，而不是按字符串拼接

CC Switch 的 `sse.rs` 和 response processor 关注：

- UTF-8 chunk 边界。
- 完整 SSE block。
- 压缩/解压。
- hop-by-hop header。
- 完成事件和错误事件。
- 上游 EOF 与下游合法结束事件。

Switchyard 已修过 Codex GPT 的完成后 EOF，但后续做 OpenAI Chat -> Anthropic SSE、Responses -> Anthropic SSE 时仍要把“空 delta、tool call 参数流、completed output 为空但前面已有 output_item”作为固定 fixture。

## Switchyard 当前基础与差距

### 已有基础

- 多客户端入口：Codex、Claude Code、Hermes、generic OpenAI。
- 协议转换：Anthropic / OpenAI Chat / OpenAI Responses 的双向适配已有基础。
- Codex `custom` provider、catalog/cache、session 连续性口径已明确。
- 兼容规则元数据、手动/自动来源、请求日志 `conversionChain` / `compatRules`、诊断兼容画像已初步实现。
- 视觉兜底、官方 GPT 原生 Responses 路由、完成后 EOF 处理已有实现。

### 主要差距

- 缺少 CC Switch 式运行时 rectifier：错误分类、修改请求、同 provider 一次重试、记录整流动作。
- provider/model reasoning 配置还不够 source-aware：同一个模型在 OpenRouter、SiliconFlow、官方接口上的 reasoning 参数不同。
- request override 和私有 `_` 字段递归过滤还没有形成统一链路。
- Claude Code slot 映射、`[1M]` 后缀、tool 并发/邻接、thinking signature 回归不够系统。
- “兼容补丁”对用户仍偏抽象，需要变成错误类别、触发原因、修复动作和验证 fixture。
- 社区开源场景缺少脱敏 Issue Bundle 和 fixture runner，用户报错后仍要靠手工贴日志。

## P0：先把适配架构转向 runtime rectifier

### 2026-06-24 已落地的首批切片

- 新增 `packages/core/src/compat/runtime-rectifier.mjs`。
- 已支持非流式上游错误分类：`vision.unsupported-image`、`thinking.signature-invalid`、`thinking.budget-too-small`、`thinking.passback-required`、`tool.history-invalid`、`tool.schema-invalid`。
- `dispatchChat()` 已在 `openai_chat` 和 `anthropic_messages` 非流式请求中接入同 provider 一次整流重试。
- 首批 rectifier：
  - `media-unsupported-image`：上游明确不支持图片时，将 image block 替换为 `[Unsupported Image]` 后重试。
  - `thinking-signature`：删除非法 thinking / redacted_thinking / signature 后重试。
  - `thinking-budget`：扩大 thinking budget 与 `max_tokens` 后重试。
  - `thinking-passback`：thinking 历史不完整时关闭 thinking 后重试。
- 请求日志已记录 `requestSummary.rectifiers` 和 `requestSummary.errorClass`，便于后续 UI 展示。
- 收紧 `tool-history-adjacent`：不再对 `apiFormat=anthropic_messages` 的原生上游自动启用，避免破坏合法 Anthropic `tool_result`。
- 对齐 CC Switch 的 `localProxyRequestOverrides`：`dispatch` 已支持 provider/model 级请求覆盖，兼容字段名 `localProxyRequestOverrides` 与 `requestOverrides`，支持 `headers` 和顶层/嵌套 `body` 合并；model 级覆盖 provider 级。
- 请求日志已记录 `requestSummary.requestOverrides`，只包含来源、header 名和 body key；敏感 header 名会脱敏，不记录 header/body 值。
- 桌面端已在诊断中心最近错误、实时结构化日志和调用可视化请求详情中展示 `errorClass`、`rectifiers`、`requestOverrides`，只显示错误类、整流动作、覆盖来源、header 名和 body key，不显示敏感值。
- 已验证：`npm run check` 通过，`npm test` 199/199 通过。

当前限制：

- 反应式 rectifier 暂只覆盖非流式请求；流式 upstream 在返回 body 后中途报协议错误时仍走现有 SSE 错误处理。
- request override 的 UI 编辑、预览、撤销还未做；当前只支持配置文件字段生效和日志可见。
- runtime rectifier 还没有独立 fixture runner；现阶段通过 dispatch/server 测试覆盖首批错误场景。

### P0.1 文档和代码方向校正

- 明确参考源是 `farion1231/cc-switch`。
- 回看已新增的 `role-normalize`、`tool-name-normalize`、`tool-history-adjacent`、`strict-tool-schema`、`reasoning-state` 等 patch。
- 能与 CC Switch 观察一致的保留为预防性 compat patch。
- 需要错误后重试的从静态 patch 迁移或补充为 runtime rectifier。

### P0.2 新增错误分类与整流上下文

建议新增或扩展：

- `packages/core/src/compat/error-classifier.mjs`
- `packages/core/src/compat/runtime-rectifier.mjs`
- 请求日志字段：`rectifiers`、`retryOfRequestId`、`retryReason`、`errorClass`。

首批 error class：

- `thinking.signature-invalid`
- `thinking.passback-required`
- `thinking.budget-too-small`
- `vision.unsupported-image`
- `tool.history-invalid`
- `tool.schema-invalid`
- `stream.eof-before-completion`
- `provider.private-field-rejected`

### P0.3 首批 rectifier

- `media-unsupported-image`: 上游明确不支持图片时，替换 image block 后对同 provider 重试一次。
- `thinking-signature`: Anthropic/Gemini/第三方渠道签名错误时，删除不合法 thinking/signature 字段后重试。
- `thinking-budget`: budget/max_tokens 错误时，按 provider 能力修正 thinking budget 和 max_tokens 后重试。
- `private-field-filter`: 发送前递归删除 `_` 私有字段，但保留 JSON Schema 的 `properties`、`patternProperties`、`definitions`、`$defs` 下字段名。
- `request-overrides`: provider/model 级请求头和请求体覆盖，写入前必须可预览、可撤销。首批服务端链路已实现，后续补 UI 编辑与预览。

### P0.4 验收

必须有 mock upstream 测试覆盖：

- 第一次 400 `unsupported image`，rectifier 重试后成功。
- 第一次 400 `invalid signature in thinking block`，rectifier 重试后成功。
- 第一次 400 `thinking.budget_tokens` 约束错误，rectifier 重试后成功。
- 请求体含 `_internal` 字段时发送上游前被删除，但 schema properties 中 `_field` 不被删除。
- 请求日志能看到 errorClass、rectifier 名称、是否重试、重试结果。

## P1：补齐 Claude/Codex Agent 场景差异

### P1.1 Provider/model reasoning 矩阵

把 CC Switch 的 `codexChatReasoning` 思路落到 Switchyard：

| 平台或模型族 | 请求参数 | effort 形态 | 回传字段 | 备注 |
| --- | --- | --- | --- | --- |
| DeepSeek 官方 | `thinking` / `reasoning_effort` | provider 定义 | `reasoning_content` | 重点处理 passback-required |
| OpenRouter | `reasoning: { effort }` | `xhigh/high/medium/low/minimal/none` | 平台透传 | 不发送顶层 `reasoning_effort` |
| SiliconFlow | `enable_thinking` | 不走顶层 effort | `reasoning_content` | 平台规则优先于模型名 |
| MiniMax / MiMo | 可能为 `reasoning_split` 或 provider 私有字段 | provider 定义 | `reasoning_details` 或 `reasoning_content` | 需要 fixture |
| GLM / Zhipu / 火山 Agent | 需按平台验证 | provider 定义 | 不稳定 | 重点避免空白成功 |
| OpenAI/Codex OAuth | Responses `reasoning` + encrypted content | `low/medium/high/xhigh` 等 | Responses reasoning item | 保持 `include: reasoning.encrypted_content` |

### 2026-06-24 P1.1 已落地切片

- `reasoning-options` 已支持 provider/model 级显式 `codexChatReasoning`，兼容 CC Switch 的字段语义：`supportsThinking`、`supportsEffort`、`thinkingParam`、`effortParam`、`effortValueMode`、`outputFormat`，并兼容 snake_case 字段名。
- 优先级调整为：model 显式配置 > provider 显式配置 > 平台推断 > 模型族推断。
- 平台推断只看 provider id/name/baseUrl，不看模型名；OpenRouter 和 SiliconFlow 会覆盖模型名里的 DeepSeek/MiniMax/Kimi 等厂商信息，避免同模型在聚合平台上误发官方参数。
- OpenRouter 走 `reasoning: { effort }`，`max` 映射为 `xhigh`，不发送 `thinking` 或顶层 `reasoning_effort`。
- SiliconFlow / DashScope 走 `enable_thinking`，不按 MiniMax 官方 `reasoning_split` 或 DeepSeek 官方 `reasoning_effort` 发送。
- DeepSeek 官方保留 `thinking` + `reasoning_effort`；MiniMax 官方保留 `reasoning_split`；GLM/Kimi/MiMo 等走 `thinking`。
- 主流 provider preset 已补 `codexChatReasoning` 元数据：DeepSeek、OpenRouter、SiliconFlow、DashScope、GLM、Kimi、MiniMax。
- 已验证：
  - OpenRouter provider + DeepSeek model 名时仍输出 `reasoning: { effort: "xhigh" }`。
  - SiliconFlow provider + MiniMax model 名时仍输出 `enable_thinking: true`。
  - provider 显式配置可关闭启发式 reasoning。
  - model 显式配置可覆盖 provider 显式配置。
  - `node --test packages/core/test/v0.4-compat-patches.test.mjs packages/core/test/provider-presets.test.mjs` 26/26 通过。
  - `npm run check` 通过，`npm test` 203/203 通过。

### P1.2 Claude Code 专项

#### 2026-06-24 P1.2 已落地切片

- `/claude-code/v1/models` 和 `/claude-code/v1/v1/models` 已保持 Anthropic Models API 形状：顶层 `data`、`has_more`、`first_id`、`last_id`，模型项只暴露 Claude Code 可识别的 `type`、`id`、`display_name`、`created_at`。
- discovery id 已使用 Claude-safe 前缀，例如 `claude-switchyard-deepseek-deepseek-v4-pro-...`；路由层会把 discovery id、真实模型 id、upstream model 和 aliases 都映射回同一模型。
- `ANTHROPIC_DEFAULT_*` slot 映射已可配置，写入 Claude Code profile 时会优先选择非 Codex GPT 作为默认 Sonnet 槽位，避免 Claude Code 默认落到 Codex GPT Responses 转 Anthropic SSE 的高风险链路。
- 写入 Claude Code 本地模型槽位时会剥离 `[1M]` 这类本地标记，避免上游不认识。
- 已补服务端级 fixture：Claude Code 通过 `/claude-code/v1/messages` 发送并发 `tool_use` + 同一 user message 内多个 `tool_result`，经 Anthropic Messages -> OpenAI Chat 转换后，上游必须收到 `assistant.tool_calls` 后紧跟多个 `role: "tool"` 消息，且 `tool_call_id` 与参数保持不变。
- 已修复 `tool-history-adjacent` 的误伤：合法紧跟 assistant tool_calls 的并发 tool result 不再被降级为 user 文本；只有真正孤立或无法匹配的 tool result 才会文本化。
- 已有 thinking block 回归：Codex Responses 与 Anthropic Messages 之间可回传 Anthropic `thinking` / `redacted_thinking`，并在 tool result 前保持顺序。
- 已验证：
  - `node --test packages/core/test/server.test.mjs --test-name-pattern "parallel tool results|server filters"` 32/32 通过。
  - `node --test packages/core/test/v0.4-compat-patches.test.mjs --test-name-pattern "tool-history-adjacent"` 24/24 通过。
  - `npm run check` 通过，`npm test` 205/205 通过。

当前限制：

- Claude Code 主动选择 Codex GPT 时，仍需继续补强 Responses function_call 流聚合、`reasoning.encrypted_content` 保留和 Anthropic SSE 回写；这部分归入 P1.3/P2 fixture。
- 真实 Claude Code 的工具并发错误还需要用安装版 smoke test 复测；当前已先用服务端 fixture 固化协议转换不再破坏字段。

### P1.3 Codex 专项

- 保持 `model_provider = "custom"`、catalog/cache 同步和官方 auth 保留。
- 官方 GPT 走 native Responses，三方 Chat 走 gateway transform。
- Responses -> Chat 时保留 tool call、reasoning_content、function_call 参数流。
- Chat -> Responses 时正确生成 `response.output_text.delta`、tool call item、reasoning item 和 usage。
- speed tiers 只给真实支持的官方 GPT 暴露，不伪造三方模型速度档。

#### 2026-06-24 P1.3 已落地切片

- Claude Code 主动选择 Codex GPT 时，Anthropic `thinking` / `redacted_thinking` 历史现在会先进入 Chat 中间态的 `_switchyardAnthropicThinking`，再由 Chat -> Responses 转成 `type: "reasoning"` item，并保留 `encrypted_content`。
- Chat -> Responses 输出顺序已固定为 reasoning item 先于 function_call item，避免 Claude thinking 历史在下一轮工具结果前丢失或错序。
- Codex OAuth 请求会合并补齐 `include: ["reasoning.encrypted_content"]`；如果用户已有 `include`，会追加而不是覆盖。
- ChatGPT Codex 后端的 assistant 文本历史重写仍只作用于 assistant message，不会把 `reasoning`、`function_call`、`function_call_output` 错改成 `Previous assistant response`。
- native Codex Responses 入口也会补齐 encrypted reasoning include，同时保留用户原始 `reasoning`、`text`、`service_tier`、`input` 等字段。
- 已有 function_call 流聚合回归继续覆盖：即使 `response.completed.response.output` 为空，前面通过 `response.output_item.added` / `response.function_call_arguments.delta/done` / `response.output_item.done` 聚合出的 function_call 也会转成 Anthropic `tool_use`。
- 已验证：
  - `node --test packages/core/test/adapters.test.mjs packages/core/test/dispatch.test.mjs packages/core/test/server.test.mjs --test-name-pattern "thinking history|normalizeChatgpt|Codex OAuth|native Codex Responses|round-trips Anthropic thinking|function_call"` 70/70 通过。
  - `npm run check` 通过，`npm test` 207/207 通过。

当前限制：

- 仍需要用安装版 Claude Code + `codex/gpt-*` 做真实 smoke test，验证长上下文、多轮工具、真实 GPT SSE 延迟和客户端渲染表现。
- P2 需要把这类链路沉淀成 fixture 文件，而不是只散落在 adapter/dispatch/server 单测里。

### P1.4 工具字段兼容

预防性 compat patch 仍然有价值，但要降级为“发送前修正”：

- `tool-name-normalize`: function name 字符集归一和双向映射。
- `strict-tool-schema`: 移除上游拒绝的 schema 元字段，保留核心约束。
- `tool-history-adjacent`: 对无法修复的孤立 tool result 转 user 文本上下文。
- `role-normalize`: `developer` 到 `system` 等 provider 定向角色修正。

这些规则必须显示触发原因、影响字段和验证 fixture，避免用户看到“兼容补丁”但不知道它解决什么。

## P2：Fixture Runner 与社区 Issue Bundle

### 2026-06-24 已落地的首批切片

- 新增 `packages/core/src/compat/fixture-runner.mjs`，用于运行 JSON-only 兼容 fixture。
- 支持白名单 operation：`anthropic_to_chat`、`anthropic_to_responses`、`responses_to_anthropic_messages`、`responses_stream_to_chat`、`compat_outbound`、`runtime_rectifier`、`private_field_filter`。
- 支持 fixture 断言语法：对象子集匹配、`{"$exists": false}`、`{"$match": "regex"}`、`{"$contains": ...}`。
- 新增 `packages/core/test/compat-fixtures.test.mjs`，把 fixture runner 纳入 `npm test`。
- `npm run check` 已把 `packages/core/src/compat/fixture-runner.mjs` 纳入语法检查。

新增 fixture 目录：

- `packages/core/test/compat-fixtures/claude-code-tool-concurrency.json`
- `packages/core/test/compat-fixtures/codex-responses-to-deepseek-thinking.json`
- `packages/core/test/compat-fixtures/openrouter-reasoning-effort.json`
- `packages/core/test/compat-fixtures/siliconflow-enable-thinking.json`
- `packages/core/test/compat-fixtures/unsupported-image-reactive-retry.json`
- `packages/core/test/compat-fixtures/thinking-signature-rectifier.json`
- `packages/core/test/compat-fixtures/private-field-filter-schema.json`
- `packages/core/test/compat-fixtures/responses-function-call-stream.json`

这些 fixture 覆盖了本轮最容易返工的 CC Switch 对标场景：Claude Code 并发工具结果、Anthropic thinking 到 Codex Responses 的保真、OpenRouter/SiliconFlow provider 级 reasoning 参数、unsupported image 反应式整流、thinking signature 整流、私有字段过滤和 Responses function_call 流聚合。

Issue Bundle 应包含：

- client id、path、provider/model、apiFormat。
- conversionChain、compatRules、rectifiers、errorClass。
- 脱敏后的 request/response 摘要。
- 最小复现 fixture 草案。

### 2026-06-25 Issue Bundle 第一片已落地

- 新增 `apps/desktop/src/issue-bundle.mjs`，从请求日志 row 生成脱敏 issue bundle 和 GitHub Issue Markdown。
- 新增 `request:issue-bundle` IPC，桌面端可直接按请求日志生成问题包。
- 诊断中心“最近失败”、用量统计“最近请求”、调用可视化“历史时间线”已增加“问题包 / 复制问题包”入口，点击复制脱敏 Markdown。
- 默认不导出消息正文、响应正文、reasoning 正文、工具参数、图片原文、本地路径、邮箱、API Key、Authorization、Cookie、Bearer token。
- Bundle 保留可诊断字段：client/path/provider/model/apiFormat/status/latency、conversionChain、compatRules、rectifiers、errorClass、requestOverrides、角色计数、工具名、图片数量、usage 和 fixture 草案骨架。
- 已验证：
  - `node --test packages/core/test/issue-bundle.test.mjs`
  - `npm run check`
  - `npm test` 210/210 通过

不得包含：

- Authorization、Cookie、API Key、OAuth token。
- 完整用户正文、图片原文、附件内容。
- 未脱敏的本地路径或账号信息。

当前限制：

- Issue Bundle 已支持复制 Markdown 和导出 Markdown + JSON 文件；仍不做压缩包导出或自动打开 GitHub Issue。
- fixture runner 当前只跑脱敏 JSON fixture，不调用真实上游。
- Registry 第一片已接入 Provider/Model 编辑界面：内置 JSON-only registry 会按 provider id/name/baseUrl、model/upstreamModel、apiFormat 和 client 约束推荐 compat pack，用户点击“应用推荐”后才会写入兼容包选择。
- 真实安装版 Claude Code + Codex GPT 的长上下文、多轮工具 smoke test 仍需继续补。

## P3：开源用户接入新供应商的自助流程

- Provider 导入时根据 host/name/model/apiFormat 推荐 compat pack 和 rectifier。
- 诊断中心显示“为什么推荐”“会改哪些字段”“如何验证”。
- 真实失败后自动归类 errorClass，并给出下一步：启用规则、生成 issue bundle、还是标记模型能力错误。
- Registry 默认只读，不执行远程代码，用户确认前不写配置。
- 新兼容问题必须通过 fixture 进入 CI，避免每次都靠大补丁返工。

## 推荐实施顺序

1. 修正文档和长期记忆，确认参考源为 `farion1231/cc-switch`。
2. 审核刚新增的静态 patch，把不适合静态处理的迁到 runtime rectifier。
3. 先实现 `runtime-rectifier` 框架和三类高频重试：media、thinking signature、thinking budget。
4. 补 `private-field-filter` 和 `request-overrides`，对齐 CC Switch 转发链路。
5. 补 source-aware reasoning 配置，优先覆盖 DeepSeek、OpenRouter、SiliconFlow、GLM/火山。
6. 补 Claude Code slot / `[1M]` / tool concurrency fixture。
7. 补 Codex Responses function_call / reasoning encrypted content fixture。
8. 做 Issue Bundle 和 fixture runner，面向开源用户形成可复用闭环。

## 最小验收命令

```bash
npm run check
npm test
node --test packages/core/test/compat.test.mjs packages/core/test/v0.4-compat-patches.test.mjs
node --test packages/core/test/adapters.test.mjs packages/core/test/dispatch.test.mjs packages/core/test/server.test.mjs
```

运行时 smoke test：

```bash
curl -sS http://127.0.0.1:17888/codex/v1/models
curl -sS http://127.0.0.1:17888/claude-code/v1/models
codex debug models
codex exec --ephemeral -m deepseek/deepseek-v4-pro "只回复 OK"
```

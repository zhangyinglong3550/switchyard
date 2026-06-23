---
title: Switchyard 产品功能规划
status: draft
created: 2026-06-23
updated: 2026-06-23
---

# Switchyard 产品功能规划

> **当前阶段标注**：V0.5 团队可用版已完成（含 DMG、INSTALL 手册、dryrun 全绿，docs/HANDOFF-V0.5.zh-CN.md 已交付）。GitHub Release / 飞书文档保留人工授权后触发。本仓库为 V0.2-V0.5 实现仓库 `switchyard`，与 V0.1 探针仓库 `local-llm-switchboard` 分离，不跨仓库回写。

## 1. 产品定位

Switchyard 是一个运行在本机的多客户端 AI 模型网关和桌面管理台。

它不是只给 Codex 用的单一转发器，而是一个统一的本机模型控制面板：在 Electron 里配置供应商、密钥、端点、模型、能力和路由策略，然后同时给 Codex、Claude Code、Hermes 以及其它 OpenAI-compatible / Anthropic-compatible 工具使用。

核心原则：

- 供应商配置和模型展示打平：配置多少供应商，就能在统一模型目录里看到多少模型，不需要像 ccswitch 那样先启用某个当前供应商。
- 客户端协议隔离、模型目录统一：Codex、Claude Code、Hermes 看到的是适配各自协议的模型列表，但底层来自同一个全局模型表。
- Electron 是正式管理台：所有高频操作都应该在界面完成，不依赖用户手改 JSON / TOML / SQLite。
- 本机优先、安全优先：密钥默认存在本机加密存储或环境变量，不进 GitHub、日志、飞书文档和导出包。
- 兼容优先：优先解决真实工具链里的多轮会话、工具调用、图片、thinking、stream、压缩请求体等兼容问题。

## 2. 参考对象

### 2.1 ccswitch

可借鉴：

- Provider / Model 的配置结构。
- 第三方模型的 thinking、reasoning、思考等级、思考模式等能力配置。
- 多供应商接入经验，包括 DeepSeek、GLM、Kimi、MiniMax、火山、OpenCode Go、CLIProxyAPI / Antigravity。

不直接照搬：

- 不采用“当前启用供应商”作为模型可见性的核心机制。
- 不要求用户通过切换 provider 才能看到对应模型。

### 2.2 OpenCodex

可借鉴：

- 图形化 Dashboard。
- 自动 patch Codex 配置并保留备份。
- 模型增删、显示控制、实时日志、一键重启 Codex、一键还原原生配置。
- Vision Bridge：让纯文本模型通过视觉模型补充图片描述。
- 对 Codex Desktop 的体验型能力，例如 Computer Use 路由、截图压缩、错误诊断。

不直接照搬：

- 不只面向 Codex。
- 不把 Computer Use 做成第一阶段核心，先保证模型网关稳定。

### 2.3 AiMaMi

可借鉴：

- 原生桌面伴侣的产品结构。
- 账号、会话、MCP、Skills、路由、中转配置、系统维护集中管理。
- 对本地配置文件的安全读写、备份、回滚和漂移诊断。

不直接照搬：

- 不把 Codex 账号管理作为第一阶段主线。
- 不直接管理用户的所有 Codex 会话和 Skills，除非后续明确纳入 Codex 专属增强模块。

### 2.4 CLIProxyAPI 及其生态

可借鉴：

- Claude / Gemini / Codex / OpenAI / Antigravity 等多协议兼容。
- OAuth 账号池、模型别名、故障转移、冷却、请求追踪、成本统计、配额监控。
- 管理 API、健康检查、实时日志、结构化配置编辑。
- 面向 Claude Code、Codex、OpenCode、Cursor、RooCode 等工具的一键配置。

不直接照搬：

- 不在第一阶段做复杂账号池调度。
- 不把“无 API Key OAuth 聚合”作为默认目标，先兼容已有 API Key、本机代理和 CLIProxyAPI。

## 3. 核心对象模型

### 3.1 Provider

供应商只代表一个上游来源，不代表当前启用状态。

字段：

- 名称、ID、分组、备注。
- 类型：OpenAI-compatible、Anthropic-compatible、Google Gemini、CLIProxyAPI、ccswitch import、OpenCode Go、本机自定义代理。
- 默认 base URL。
- 默认鉴权方式：API Key、Bearer Token、环境变量、macOS Keychain、无鉴权、本机代理。
- 默认协议能力：chat、responses、messages、embeddings、images、vision、tools、stream。
- 健康检查 URL 和测试模型。

### 3.2 Endpoint

一个 Provider 可以有多个 Endpoint。

字段：

- base URL。
- 协议入口：OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini、Ollama、自定义。
- 网络设置：超时、重试、代理、keep-alive、connection close。
- 压缩支持：gzip、br、deflate、zstd。
- TLS / 证书选项。

### 3.3 Credential

密钥独立于 Provider，方便复用和脱敏导出。

字段：

- 类型：API Key、Bearer Token、环境变量引用、Keychain 引用、OAuth 本机服务引用。
- 脱敏显示。
- 最后验证时间。
- 关联 Provider / Endpoint。
- 是否允许导出。默认不导出明文。

### 3.4 Model

Model 是全局模型目录里的核心资源。

字段：

- 全局模型 ID：例如 `volcengine/glm-5.2`、`moonshot/kimi-k2`、`openai/gpt-5.5`。
- 展示名。
- Provider ID。
- Endpoint ID。
- 上游真实模型名。
- 别名列表：例如给 Claude Code 映射 `claude-3-5-sonnet-20241022`。
- 标签：coding、agent、fast、cheap、vision、reasoning、official、proxy。
- 可见客户端：Codex、Claude Code、Hermes、OpenAI-compatible、Anthropic-compatible。
- 能力矩阵。

### 3.5 Capability

每个模型需要明确能力，避免客户端误用。

基础能力：

- text。
- stream。
- tools。
- vision / image input。
- json mode。
- structured outputs / json schema。
- system prompt。
- function calling。
- parallel tool calls。
- prompt cache。

上下文能力：

- context window。
- max output tokens。
- max input image count。
- max input content items。

思考能力：

- supports reasoning。
- supports thinking。
- reasoning effort：low、medium、high、自定义。
- thinking mode：off、auto、enabled、forced。
- thinking budget tokens。
- 是否要求回传 reasoning_content。
- 是否需要隐藏 reasoning_content。

兼容能力：

- strict tool result ordering。
- strict JSON schema。
- forbids orphan tool messages。
- requires assistant tool calls followed by tool messages。
- supports OpenAI Responses 原生。
- supports Anthropic Messages 原生。
- 是否需要把多模态内容降级为文本描述。

### 3.6 Alias

别名是客户端兼容的关键。

用途：

- Claude Code 请求官方 Claude 模型名时，可以映射到 GLM、Kimi、Gemini 或其它上游。
- Codex App 里展示友好模型名，但上游使用真实模型名。
- 同一个上游模型可以给不同客户端暴露不同别名。

规则：

- alias 可以是全局的，也可以按 Client Profile 生效。
- alias 冲突时优先级：Client Profile alias > Model alias > Provider alias。
- UI 必须提示冲突和最终路由结果。

### 3.7 Route Policy

路由策略决定请求如何选择模型和上游。

第一阶段：

- 固定模型路由。
- alias 路由。
- 不存在模型时报错并给出可选模型建议。

第二阶段：

- fallback 模型。
- 按能力选择：需要 vision 时只路由 vision 模型。
- 按客户端选择：Codex / Claude Code / Hermes 使用不同转换器。
- 按错误类型冷却：限流、余额不足、上下文超限、schema 不兼容。

第三阶段：

- 成本优先、速度优先、稳定优先策略。
- 多账号 / 多 endpoint 轮询。
- 配额感知调度。

### 3.8 Client Profile

Client Profile 是给不同工具生成配置和协议适配的入口。

内置 profile：

- Codex Desktop / Codex CLI。
- Claude Code。
- Hermes。
- OpenAI-compatible 通用工具。
- Anthropic-compatible 通用工具。

每个 profile 包含：

- 入口 URL。
- API key / token 占位。
- 模型可见性规则。
- alias 规则。
- 协议转换器。
- 一键写入配置、备份、恢复。
- 启动 / 重启命令。
- 诊断命令。

## 4. Electron 管理台功能列表

### 4.1 首页总览

- 网关运行状态：运行中、未启动、异常。
- 监听地址和端口。
- OpenAI-compatible 入口。
- Anthropic-compatible 入口。
- 当前模型总数、可见模型数、异常模型数。
- 最近 24 小时请求数、失败数、平均延迟。
- 最近错误摘要。
- 常用操作：启动、停止、重启、刷新模型、打开日志、复制接入配置。

### 4.2 Provider 管理

- 新增 Provider。
- 编辑 Provider。
- 删除 Provider。
- 启用 / 禁用 Provider。禁用只影响路由，不删除配置。
- Provider 分组和标签。
- 复制 Provider。
- 从 ccswitch 导入 Provider。
- 从 CLIProxyAPI Management API 导入 Provider。
- 从 JSON 导入 Provider。
- Provider 健康检查。
- Provider 级别默认能力设置。

### 4.3 Endpoint 管理

- 一个 Provider 下配置多个 base URL。
- 测试连接。
- 测试 `/v1/models`。
- 测试最小 chat。
- 测试 stream。
- 配置超时、重试、代理、Header。
- 对本机代理增加连接策略：keep-alive / connection close。
- 显示最近 endpoint 错误。

### 4.4 Credential 管理

- 添加 API Key / Bearer Token。
- 从环境变量读取。
- 存入 macOS Keychain。
- 脱敏显示。
- 测试密钥有效性。
- 标记过期。
- 替换密钥。
- 安全导出配置时自动剔除明文密钥。

### 4.5 模型目录

- 全局模型列表。
- 搜索、筛选、排序。
- 按 Provider / 标签 / 客户端 / 能力过滤。
- 新增模型。
- 编辑模型。
- 删除模型。
- 批量导入模型。
- 批量刷新模型。
- 批量设置能力。
- 批量设置客户端可见性。
- alias 冲突检测。
- 展示最终路由：客户端模型名 -> 全局模型 -> 上游真实模型。

### 4.6 模型能力编辑

- 文本能力。
- 图片输入能力。
- 工具调用能力。
- JSON Schema 严格程度。
- reasoning / thinking 能力。
- 上下文窗口。
- 最大输出。
- 多轮历史兼容。
- 特殊兼容开关：
  - Kimi strict schema sanitizer。
  - DeepSeek reasoning_content pass-through。
  - GLM missing input.content.text 兼容。
  - OpenCode Go tool history 修复。
  - 官方 GPT Responses content 数组校验修复。

### 4.7 客户端接入配置

Codex：

- 生成 Codex `config.toml` provider。
- 备份现有配置。
- 一键写入。
- 一键恢复。
- 一键重启 Codex。
- 检查 `model_catalog_json` 是否有效。

Claude Code：

- 生成 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 等配置说明。
- 可选写入 shell profile。
- 提供 alias 方案，把 Claude 模型名映射到第三方模型。
- 测试 `/v1/messages`。

Hermes：

- 生成 OpenAI-compatible 或 Anthropic-compatible 配置。
- 按 Hermes 实际支持的协议选择入口。
- 提供测试请求。

通用工具：

- 复制 `OPENAI_BASE_URL`、`OPENAI_API_KEY`。
- 复制 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`。
- 生成 curl 测试命令。

### 4.8 测试台

- 选择客户端协议：Responses、Chat Completions、Anthropic Messages。
- 选择模型。
- 文本测试。
- stream 测试。
- tool call 测试。
- 图片测试。
- thinking / reasoning 测试。
- 多轮会话测试。
- 展示原始请求、转换后请求、上游响应、转换后响应。
- 一键复制脱敏诊断包。

### 4.9 实时日志

- 请求列表。
- 请求详情。
- 上游耗时。
- stream 首 token 延迟。
- token 估算。
- 错误栈。
- 上游错误原文脱敏展示。
- 按模型、provider、客户端过滤。
- 日志级别设置。
- 一键打开日志目录。

### 4.10 兼容诊断

- 配置文件语法检查。
- 模型目录 JSON 校验。
- Codex 配置校验。
- Claude Code 环境变量检查。
- 端口占用检查。
- 本机代理连通性检查。
- zstd / gzip / br 解压能力检查。
- Node 版本检查。
- macOS 未签名应用 quarantine 检查。
- 常见错误解释和修复建议。

### 4.11 服务管理

- 启动 / 停止 / 重启网关。
- 开机启动。
- launchd 安装 / 卸载。
- 端口修改。
- 运行目录修改。
- 日志目录打开。
- 自检。
- 更新检查。
- DMG 安装后首次引导。

### 4.12 配置导入导出

- 导出完整配置，不含明文密钥。
- 导出同事可用模板。
- 导入配置模板。
- 导入 ccswitch 配置。
- 导入旧 Codex CC Switch Gateway 模型目录。
- 导入 OpenAI-compatible provider 列表。
- 配置变更 diff。
- 回滚到上一次配置。

### 4.13 团队分享

- 生成同事安装说明。
- 生成模型配置说明。
- 生成脱敏配置包。
- 显示缺失密钥清单。
- 一键复制飞书文档格式说明。

## 5. 网关协议能力

### 5.1 OpenAI-compatible

必须支持：

- `GET /v1/models`。
- `POST /v1/chat/completions`。
- `POST /v1/responses`。
- stream / non-stream。
- tools / function calling。
- image input。
- JSON mode / structured output 透传或降级。

后续支持：

- embeddings。
- image generation。
- audio transcription。

### 5.2 Anthropic-compatible

必须支持：

- `POST /v1/messages`。
- `POST /v1/messages/count_tokens`。
- stream / non-stream。
- tool_use / tool_result。
- image source。
- thinking 参数。

后续支持：

- prompt caching headers。
- beta headers。
- 更精确 token count。

### 5.3 Gemini / Google-compatible

第一阶段不直接暴露 Gemini 原生协议，但可以作为上游适配。

后续支持：

- Gemini generateContent。
- Gemini streamGenerateContent。
- Gemini tool calls。
- Gemini image content。

### 5.4 转换器

需要有独立转换层：

- Responses -> Chat Completions。
- Chat Completions -> Responses。
- Anthropic Messages -> OpenAI Chat。
- OpenAI Chat -> Anthropic Messages。
- Anthropic stream -> OpenAI SSE。
- OpenAI stream -> Anthropic SSE。
- tool_calls <-> tool_use。
- tool messages <-> tool_result。
- image_url / input_image <-> Anthropic image source。
- reasoning_content / thinking block 的 provider 定向处理。

## 6. Provider 兼容策略

### 6.1 官方 OpenAI / Codex

- 优先透传 Responses。
- 保留官方模型能力。
- 不污染官方请求历史。
- 切换第三方模型后再切回官方时，需要清理不符合 Responses 校验的 content / tool 历史。

### 6.2 DeepSeek

- thinking 模式下需要处理 reasoning_content。
- 避免丢失上游要求回传的 reasoning_content。
- 严格检查 tool role 必须对应前置 tool_calls。

### 6.3 Kimi / Moonshot

- JSON Schema 更严格。
- 针对 conflicting anyOf / items / properties 做定向 sanitizer。
- tool_call_id 必须完整闭合。
- 不做全局 schema 降级，避免影响其它模型。

### 6.4 GLM / 智谱 / 火山 GLM

- 处理 `input.content.text` 缺失类错误。
- 验证多轮 after tool call 的 content 结构。
- 保留支持图片的模型能力。
- 区分 Agent Plan 和 Coding Plan。

### 6.5 MiniMax

- 标注 vision 能力。
- 验证图片输入和 tool call 是否可以同时使用。
- 处理上下文长度和最大输出差异。

### 6.6 火山 / 豆包

- 区分模型 endpoint 和 plan。
- 支持 thinking / reasoning 参数映射。
- 对 endpoint 返回的 provider-specific 错误做可读化。

### 6.7 OpenCode Go

- 修复多轮工具历史。
- Kimi / GLM 定向兼容。
- 避免把上游私有字段传给不支持的模型。

### 6.8 CLIProxyAPI / Antigravity

- 支持本机 base URL。
- 支持 connection close 兼容。
- 支持最小请求健康检查。
- 支持模型 alias。
- 后续通过 Management API 读取账号、模型、配额和健康状态。

## 7. 非功能需求

### 7.1 安全

- 明文 key 不进 Git。
- 明文 key 不进日志。
- 明文 key 不进飞书文档。
- 导出配置默认脱敏。
- 诊断包默认脱敏。
- 本机服务默认只监听 `127.0.0.1`。
- 如果开放局域网访问，UI 必须提示风险并要求显式确认。

### 7.2 稳定性

- 请求超时可配置。
- stream 断连有明确错误。
- 上游失败可选择 fallback。
- 配置热重载。
- 模型刷新不阻塞主服务。
- Electron 卡住时不能影响后台网关继续运行。

### 7.3 可观测性

- 每个请求有 request id。
- 日志记录客户端、模型、provider、endpoint、耗时、状态。
- 错误可以追踪到上游。
- UI 提供可复制的脱敏诊断信息。

### 7.4 可发布

- macOS DMG。
- 未签名应用打开说明。
- launchd 后台服务。
- README 中文优先。
- GitHub Release。
- 同事安装手册。

## 8. 版本分期

### 8.1 V0.1 技术探针

状态：已基本完成。

目标：

- 验证 OpenAI 和 Anthropic 双协议入口可行。
- 验证统一模型目录和 alias 可行。
- 验证 CLIProxyAPI / Antigravity 基础链路可行。

不作为正式产品体验。

### 8.2 V0.2 Electron 管理台骨架

目标：

- Electron 应用壳。
- 首页总览。
- 服务启动 / 停止 / 重启。
- Provider / Model 基础增删改查。
- 配置保存和热重载。
- 模型列表刷新。
- 日志目录打开。
- macOS DMG 构建。

成功标准：

- 不手改 JSON，也能添加 Provider 和模型。
- Codex / Claude Code 至少能通过 UI 复制接入配置。
- 本地自检能判断服务是否正常。

### 8.3 V0.3 客户端接入

目标：

- Codex profile 一键写入、备份、恢复。
- Claude Code profile 生成。
- Hermes profile 生成。
- alias 可视化。
- `/v1/models` 按客户端返回不同可见模型。
- 测试台支持文本、stream、多轮。

成功标准：

- 同一套 Provider / Model 配置可以同时服务 Codex 和 Claude Code。
- 新增模型后 UI 刷新即可在客户端可选模型里出现。

### 8.4 V0.4 兼容矩阵

状态：已完成。

目标：

- Kimi tool schema sanitizer。
- DeepSeek reasoning_content。
- GLM input content 修复。
- OpenCode Go 多轮 tool history。
- 官方 GPT 切回兼容。
- 图片能力标注和图片请求转发。
- zstd / gzip / br 请求体。

成功标准：

- Codex App 中常用模型可以完成多轮工具调用。
- Claude Code 通过 Anthropic-compatible 入口可以稳定跑文本和工具请求。
- 每个兼容补丁都有 provider / model 定向，不影响其它模型。

### 8.5 V0.5 团队可用版

状态：已完成。

目标：

- 脱敏导入导出。
- 同事安装手册。
- 配置模板。
- GitHub Release。
- 飞书使用文档。
- 自动更新或更新提示。
- 常见问题诊断页。

成功标准：

- 同事安装 DMG 后，根据文档填入自己的 key，即可使用已有模板接入 Codex / Claude Code / Hermes。

### 8.6 V1.0 稳定版

目标：

- 请求日志和统计。
- fallback / retry / cooldown。
- provider 健康监控。
- CLIProxyAPI Management API 集成。
- 配额 / 成本统计。
- 更完整的 Gemini 原生适配。
- Vision Bridge 可选模块。

## 9. 第一阶段不做

为了避免项目失控，第一阶段不做：

- 不做复杂多账号 OAuth 池。
- 不做自动购买、注册、绕限制。
- 不做远程公网网关。
- 不做完整 Codex 会话管理。
- 不做 MCP / Skills 管理。
- 不做 Computer Use 自研引擎。
- 不做商业计费系统。

这些能力可以在 V1 之后作为插件或高级模块评估。

## 10. 推荐开发顺序

1. 冻结核心配置 schema：Provider、Endpoint、Credential、Model、Capability、Alias、Client Profile。
2. 把当前技术探针改成可测试的 core gateway 包。
3. 做 Electron 壳和本地服务生命周期管理。
4. 做 Provider / Model UI。
5. 做 Client Profile UI。
6. 做测试台和日志。
7. 做兼容矩阵。
8. 做 DMG、README、同事手册和 GitHub Release。

## 11. 成功判断

这个项目做到可用，不是看能不能转发一次 `pong`，而是看下面几件事：

- 配一个 Provider 后，Codex、Claude Code、Hermes 都能看到或使用对应模型。
- 切模型后，多轮会话、工具调用、图片输入不容易炸。
- 新增模型不需要重写代码，只要配置能力矩阵。
- 出错时，UI 能告诉用户是 key、endpoint、模型、协议、tool history、schema 还是上游限制问题。
- 给同事发一个脱敏配置模板和安装包，对方能按文档跑起来。

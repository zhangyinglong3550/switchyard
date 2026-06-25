# Switchyard 兼容性生命周期路线图

更新时间：2026-06-24

## 背景

Switchyard 接入的是多客户端、多协议、多供应商链路。即使某个供应商标称 OpenAI-compatible，到了 Codex、Claude Code、Hermes、OpenCode 等客户端里，仍可能因为角色、工具结果顺序、thinking 回传、SSE 事件、JSON Schema 严格度、视觉输入等细节出现兼容问题。

因此开源前不能只提供“兼容补丁”开关，还需要形成完整生命周期：

1. 发现问题：探针、健康检查、失败日志分类。
2. 解释问题：展示协议链路、实际命中的自动/手动规则、风险和测试依据。
3. 规避问题：按 provider/model 精准启用兼容规则。
4. 沉淀问题：把新供应商问题变成可复现 fixture 和可发布规则。

具体 provider/model 适配扩展计划见 `docs/MODEL-COMPAT-EXPANSION-PLAN.zh-CN.md`。该文档已修正为对标 GitHub 开源项目 `farion1231/cc-switch`，重点不是复刻旧本地网关，而是学习 CC Switch 在 Claude Code、Claude Desktop、Codex 等 Agent 客户端中处理不同厂商模型真实字段差异的方式：provider 元数据、模型槽位映射、请求覆盖、私有字段过滤、media 兜底、thinking 整流重试、SSE 处理和 failover/health 闭环。

## P0/P1 已纳入实现范围

- 兼容规则元数据：每条内置规则有 `label`、`description`、`trigger`、`changes`、`risk`、`tests`。
- 自动/手动来源：区分 provider/model 自动命中与用户强制启用。
- 实际执行方向：只展示当前方向真的会执行的规则，避免误导。
- 请求日志：记录 `conversionChain` 和 `compatRules`，用于失败诊断、调用可视化和结构化日志。
- 能力探针：基础 text/stream/tools/vision/reasoning，加 developer role 与 schema 严格度轻量探针。
- 兼容画像：根据探针和真实错误生成 flags、recommendations、activeRules。
- UI 可解释化：供应商、模型、诊断中心、探针结果、日志详情展示实际规则与链路。
- Runtime rectifier：根据上游真实错误分类，对同 provider 做一次受控整流重试，并在请求日志中记录 `errorClass` 与 `rectifiers`。
- Agent 字段契约：Claude Code / Codex 这类客户端的模型发现、模型槽位、tool_use/tool_result 邻接、thinking/reasoning 回传、Responses function_call 流聚合，必须用 fixture 或服务端测试固化。

## P2A: Fixture Runner 第一片

目标：先把已知兼容问题变成可重复运行的脱敏 fixture，避免每次都靠人工贴日志和大补丁返工。

### 2026-06-24 已落地

- `packages/core/src/compat/fixture-runner.mjs`
- `packages/core/test/compat-fixtures.test.mjs`
- `packages/core/test/compat-fixtures/*.json`
- `docs/compat-fixture-authoring.zh-CN.md`

首批 fixture 覆盖：

- Claude Code 并发工具结果邻接。
- Anthropic thinking / redacted_thinking 到 Codex Responses reasoning item。
- OpenRouter `reasoning: { effort }` 与 SiliconFlow `enable_thinking`。
- unsupported image 反应式整流。
- thinking signature 整流。
- 私有 `_` 字段过滤，且保留 JSON Schema 字段名。
- Responses function_call 流聚合。

### 已验证

```bash
node --test packages/core/test/compat-fixtures.test.mjs
npm run check
npm test
```

## P2B: Issue Bundle 第一片

目标：开源用户遇到不兼容时，可以从最近失败请求一键复制脱敏问题包，维护者拿到后能判断客户端、协议链路、供应商、模型、命中规则和下一步 fixture 方向。

### 2026-06-25 已落地

- `apps/desktop/src/issue-bundle.mjs`
- `packages/core/test/issue-bundle.test.mjs`
- `request:issue-bundle` IPC
- 诊断中心最近失败、用量统计最近请求、调用可视化历史时间线的“问题包 / 复制问题包”入口

问题包保留：

- client id、path、provider/model、upstreamModel、apiFormat、status、latency。
- conversionChain、compatRules、rectifiers、errorClass、requestOverrides。
- 角色计数、图片数量、工具名、usage、响应文本长度、reasoning 长度。
- 可转成 fixture 的草案骨架。

问题包默认移除：

- 完整消息正文、响应正文、reasoning 正文。
- 工具参数、图片原文和附件内容。
- API Key、Authorization、Cookie、Bearer token、邮箱、本地路径、URL 路径和查询参数。

### 已验证

```bash
node --test packages/core/test/issue-bundle.test.mjs
npm run check
npm test
```

## P2: 社区兼容 Registry

目标：用户接入新供应商时，在报错前就获得推荐规则和风险提示。

### 2026-06-25 Registry 第一片已落地

- 新增 `packages/core/src/compat/compat-registry.json`，随版本发布 JSON-only 内置规则。
- 新增 `packages/core/src/compat/registry.mjs`，支持加载、规范化和匹配 registry 规则。
- Provider 匹配维度支持 `provider id / name / baseUrl host` 任一命中；`modelPattern`、`apiFormat`、`clientIdPattern` 继续作为约束，避免误把模型级规则套到整个供应商。
- 首批规则覆盖 DeepSeek、GLM / 智谱、Kimi / Moonshot、OpenRouter、SiliconFlow、DashScope / Qwen、火山 / 豆包、MiniMax、ModelScope、OpenCode Go / Agnes GLM、官方 GPT / Codex。
- 新增 `compat:registry:recommend` 和 `compat:registry:snapshot` IPC。
- Provider / Model 编辑弹窗已显示“推荐兼容规则”，包括建议兼容包、原因、影响、风险和 fixture；用户点击“应用推荐”后才会勾选兼容包，未确认前不写配置。
- `npm run check` 已纳入 `packages/core/src/compat/registry.mjs`。
- 已验证：
  - `node --test packages/core/test/compat-registry.test.mjs`
  - `node --test packages/core/test/server.test.mjs`
  - `npm run check`

当前限制：

- 远程 registry、忽略某条推荐、自动打开 GitHub Issue 尚未落地。
- UI 目前是直接勾选兼容包，不做推荐规则持久化审计。
- 真实上游仍需通过探针、Issue Bundle 或 fixture 继续验证。

### 功能

- 本地 registry 文件：`compat-registry.json`，可随版本发布。
- 远程 registry：可选开启，从 GitHub release 或固定 URL 拉取，默认只读缓存。
- 匹配维度：
  - provider id / name / baseUrl host
  - model id / upstreamModel pattern
  - apiFormat
  - client id
- 输出：
  - 推荐启用的 compat pack 或 patch id
  - 推荐原因
  - 影响范围
  - 已知风险
  - 最小验证命令或 fixture
- UI：
  - Provider/Model 编辑弹窗显示“推荐兼容规则”
  - 用户手动确认后写入配置
  - 允许对某条远程推荐选择“忽略”

### 数据结构草案

```json
{
  "version": 1,
  "rules": [
    {
      "id": "registry.glm.content-text",
      "providerHostPattern": "bigmodel|zhipu|coding-plan",
      "modelPattern": "glm",
      "apiFormat": "openai_chat",
      "recommendedCompatPacks": ["glm"],
      "reason": "GLM 兼容接口常要求 typed content block。",
      "risk": "如果上游只接受裸字符串，应关闭该规则。",
      "fixtures": ["fixtures/glm-content-text.json"]
    }
  ]
}
```

### 验收标准

- 新建 Provider 时能看到推荐规则。
- 用户未确认前不自动写配置。
- registry 拉取失败不影响本地网关运行。
- 远程 registry 不允许执行代码，只解析 JSON。

## P3: Issue Bundle 与 Fixture Runner

目标：开源用户遇到不兼容时，可以一键生成脱敏复现包，维护者可以用 fixture 重放并补规则。Fixture Runner 第一片已在 P2A 落地，Issue Bundle 复制 Markdown 第一片已在 P2B 落地，P3 剩余重点是文件/压缩包导出、自动打开 GitHub Issue、从 bundle 到 fixture 的维护者流程和更完整的 stream/response summary 断言。

### 2026-06-25 Issue Bundle 文件导出已落地

- `request:issue-bundle:save` IPC 会弹出保存对话框，并同时写入脱敏 Markdown 和同名 JSON。
- Markdown 面向 GitHub Issue / 人工排查，JSON 面向维护者转 fixture 或脚本分析。
- 诊断中心最近失败、用量统计最近请求、调用可视化请求详情均提供“导出”入口。
- 导出仍复用 `apps/desktop/src/issue-bundle.mjs` 的脱敏逻辑，不包含完整消息正文、响应正文、reasoning 正文、工具参数、图片原文、API Key、Authorization、Cookie、Bearer token、本地路径和 URL path/query。
- 已验证：`node --test packages/core/test/issue-bundle.test.mjs`。

当前限制：

- 暂不生成 zip 压缩包。
- 暂不自动打开 GitHub Issue。
- 暂不自动把 bundle 转成可提交 fixture，仍需要维护者把草案改成最小合成提示词。

### 功能

- Issue Bundle：
  - 已支持复制最近失败请求的脱敏 Markdown。
  - 已支持导出脱敏 Markdown + JSON 文件。
  - 已包含 provider/model 元数据、apiFormat、clientId、conversionChain、compatRules、错误分类。
  - 已自动移除 API Key、Authorization、Cookie、完整用户正文和附件。
  - 后续补压缩包和自动打开 GitHub Issue。
- Fixture Runner：
  - 已支持 JSON-only 脱敏 fixture 和转换/整流断言。
  - 后续可选扩展 mock upstream 或真实 upstream。
  - 后续补 response summary、stream events 的更完整断言。
- 维护者流程：
  - 用户上传 issue bundle。
  - 维护者把 bundle 转成 fixture。
  - 新增或调整 compat patch。
  - fixture 进入 CI，防止回归。

### 文件规划

- `packages/core/src/compat/registry.mjs`
- `packages/core/src/compat/fixture-runner.mjs`（已落地第一片）
- `packages/core/test/compat-fixtures/*.json`（已落地第一片）
- `apps/desktop/src/issue-bundle.mjs`
- `docs/compat-fixture-authoring.zh-CN.md`

### 验收标准

- 失败请求可以导出脱敏 bundle。
- bundle 中不包含密钥和完整用户敏感内容。
- fixture runner 能在 CI 中稳定运行。
- 新增供应商兼容问题有标准提交流程。

## 长期原则

- 默认精准匹配，不做全局降级。
- 自动规则必须可解释，手动规则必须可撤销。
- 任何新补丁都要有最小 fixture 或单元测试。
- 兼容规则只做协议与格式修正，不伪造模型真实能力。
- 探针结果是证据之一，不是绝对事实；真实失败日志优先级更高。

# 调用可视化（方案 A）与思考档位对齐

日期：2026-08-02

## 背景与目标

用户需要在桌面「调用可视化」里同时看清：

1. **本次请求传了什么参数**（尤其思考档位 `reasoning.effort`）
2. **交互时间线**（系统 / 用户 / 工具 / 响应）
3. **请求档 → 上游实际档** 是否被钳制或改写

同时，思考档位需要在 **客户端可选全集** 与 **Switchyard 模型/供应商能力表** 两侧对齐；覆盖现有全部供应商预设（用户选择范围 3）。

成功标准：

- 选中一条请求后，不滚动即可看到 effort / 模型 / 路由，以及「请求→上游」映射
- 时间线仍可展开查看消息与工具
- 一键复制 `params` JSON
- OpenAI/Codex 目录支持 GPT-5.6 官方档位全集中的可用子集；其它供应商有明确 wire + map，不再 silently 丢档却不可见
- 有单测覆盖映射与摘要字段

非目标（本规格不做）：

- 不实现完整「上游原始 HTTP body」落库（仍用现有 request_summary + 出站映射摘要）
- 不在本迭代做 `reasoning.mode: pro` 的完整 Codex UI（可预留字段）
- 不把 `ultra` 当作通用 API effort（Codex-only，单独标注）

## 已确认决策

| 项 | 选择 |
|---|---|
| 可视化布局 | **方案 A**：参数条置顶 + 下方时间线 / 原始 JSON |
| 能力覆盖 | **现有供应商预设尽量全覆盖** |
| 控制权 | **客户端 + Switchyard 两者都有**：客户端可选全集；超出上游能力则钳制并提示；可视化显示映射结果 |
| UI mock | `docs/superpowers/brainstorm/call-trace-ui-options.html` |

## 调研摘要（对齐依据）

### OpenAI GPT-5.6 API vs Codex

| 面 | 字段 | 档位 |
|---|---|---|
| Responses API | `reasoning.effort` | `none, low, medium, high, xhigh, max`；另有独立 `reasoning.mode: pro` |
| Chat Completions | `reasoning_effort` | 同上（model-dependent；部分路径 `max` 可能 400） |
| Codex 配置 | `model_reasoning_effort` | 按模型 `supported_reasoning_levels`；出站仍为 `reasoning.effort` |
| 本机 Switchyard models_cache（gpt-5.6-*） | 目录 | 仅 `low, medium, high, xhigh`（缺 `none/max`，也无 `ultra`） |

结论：**重叠档（low/medium/high/xhigh）字段与取值一致**；全集与默认档、以及 Codex `ultra` / API `pro` 不对齐，需按模型能力表处理。

### 其它供应商（出站形态）

| 族 | 字段形态 | 逻辑档映射策略 |
|---|---|---|
| OpenAI / Codex / openai_responses 透传 | `reasoning.effort` | 透传；按模型 supported 钳 |
| OpenRouter | `reasoning.effort` | 接近全集；再按模型 supported_efforts |
| DeepSeek V4 | `thinking` + `reasoning_effort` | 官方 `low/high/max`；medium/xhigh→high（官方兼容）；none→thinking.disabled |
| Anthropic | `output_config.effort` | `low/medium/high/xhigh/max`（按模型）；与现有 chat↔anthropic 对齐 |
| Qwen / DashScope / SiliconFlow（enable_thinking） | `enable_thinking` + 可选 `thinking_budget` | none→关；其它→开；budget 由档近似 |
| Kimi / GLM / MiMo / thinkingObject | `thinking: {type}` | none→disabled；其它→enabled |
| MiniMax | `reasoning_split` 等 | on/off |
| StepFun | `reasoning_effort` low_high | low/minimal→low；其它→high |
| 无思考能力的代理/本地 | 无 | 忽略或剥离，摘要标记 `unsupported` |

## 架构

### 1. 逻辑档位与能力表

新增模块（建议路径）：`packages/core/src/reasoning-effort-catalog.mjs`

对内逻辑枚举（稳定排序，由低到高）：

```text
none < minimal < low < medium < high < xhigh < max
```

`ultra` **不进入**通用枚举；仅在 Codex 模型能力里作为 `codexOnly: true` 可选标签，出站策略：

- 走官方 Codex / ChatGPT backend：按上游目录透传 `ultra`（若模型声明支持）
- 走普通 OpenAI API Key / 非 Codex：钳到 `max` 并在摘要标记 `clampedFrom: ultra`

每个 provider preset（及可覆盖的 model）声明：

```js
{
  supportedEfforts: ["low", "medium", "high", "xhigh"], // 逻辑档
  defaultEffort: "medium",
  wire: {
    // 出站形态；与现有 codexChatReasoning / reasoning-options 对齐并逐步替换启发式
    effortParam: "reasoning.effort" | "reasoning_effort" | "output_config.effort" | "none",
    thinkingParam: "thinking" | "enable_thinking" | "reasoning_split" | "none",
    effortValueMode: "passthrough" | "deepseek" | "openrouter" | "low_high" | "on_off" | "anthropic"
  },
  // 可选：逻辑档 → 上游字面值；缺省用 effortValueMode 默认表
  map: { xhigh: "max", none: "disabled" },
  supportsProMode: false
}
```

解析优先级：

1. `model.codexChatReasoning` / model 级 `reasoningEffort` 覆盖
2. `provider.codexChatReasoning` / provider 级能力表
3. preset 默认表（本规格为每个 `PROVIDER_PRESETS` id 填齐）
4. 启发式回退（保留现有 `reasoning-options.mjs` 行为，直至 preset 全覆盖后降级为 fallback）

钳制算法：请求档不在 `supportedEfforts` 时，取序上最近的支持档；若全无则 `unsupported`（不注入 effort，只记摘要）。

### 2. 请求摘要扩展

在 `summarizeRequest`（`packages/core/src/server.mjs`）的 `params` / 新字段中记录：

```js
reasoningEffortTrace: {
  requested: "high",          // 客户端原始逻辑档
  mapped: "high",             // 出站前映射后
  wireParam: "reasoning.effort",
  wireValue: "high",          // 实际上游字面值
  clamped: false,
  clampedFrom: null,
  providerMode: "passthrough" // 或 deepseek / on_off …
}
```

出站适配（`reasoning-options` 或新 catalog apply）执行后写回同一 trace，保证可视化与问题包一致。

### 3. Codex / 模型目录对齐

更新 `CODEX_MODEL_TEMPLATE.supported_reasoning_levels` 与写入 Codex 的模型目录逻辑：

- GPT-5.6 族（sol/terra/luna）至少包含：`low, medium, high, xhigh, max`
- 若走官方 Codex 且模型元数据含 `ultra`：sol/terra 可附加 `ultra`（标注 Codex-only）
- `none`：仅当模型声明支持时出现在目录（API 支持；Codex UI 不一定展示）
- 默认档：优先模型元数据，否则 `medium`（与 API 文档一致）；不要静默写成与官方不符的全局 low

手机端 `effortOptions` 从「写死四档」改为「按当前模型能力表」；未知模型回退 `low/medium/high/xhigh`。

### 4. 桌面调用可视化（方案 A）

页面：`apps/desktop/renderer` 的「调用可视化」Tab。

布局：

```text
┌────────────┬──────────────────────────────────────────┐
│ 最近对象   │ 参数条（sticky）                          │
│ 请求/会话  │ effort 请求 high → 上游 high · model · … │
│            │ [复制 params] [时间线|原始JSON|问题包]     │
│            │ ──────────────────────────────────────── │
│            │ 时间线事件卡片…                           │
└────────────┴──────────────────────────────────────────┘
```

行为：

- 选中 **请求**：参数条 + 时间线（沿用并精简现有 `renderRequestTrace` 事件）
- 选中 **会话**：参数条显示会话元数据（无 effort 则隐藏映射 chip）；时间线为会话消息
- **去掉**当前右侧「实时调用」与「历史时间线」上下双卡；详情区只有「参数条 + Tab（时间线 | 原始 JSON）」
- 新请求到达时刷新左侧列表并自动选中最新一条（可用 `live` chip 标未读/进行中）；不再单独维护第二套 structured-log 卡片列表
- 映射不一致时（`clamped` 或 on/off 近似）用告警色 chip：`请求 xhigh → 上游 max`
- 「复制 params」复制 `request_summary.params` + `reasoningEffortTrace` 的 JSON
- 参数条渲染抽成单一函数，供「调用可视化」与（若保留）诊断页复用，避免两处文案不一致

### 5. 供应商预设覆盖清单

为 `provider-presets.mjs` 中每个 preset id 挂能力表（可抽到 catalog 再引用）。分组默认：

| 分组 | preset 示例 | wire 默认 |
|---|---|---|
| OpenAI Responses 透传 | `openai`, `codex-oauth`, `codex-account-pool`, `sub2api-codex`, `ke`（若 responses） | passthrough `reasoning.effort` |
| OpenAI Chat 兼容（多数） | `xai`, `groq`, `together`, `mistral`, `opencode-go`, `ollama`, `lm-studio`, `custom-openai`… | 有 reasoning 则 passthrough/`reasoning_effort`；否则 unsupported |
| OpenRouter | `openrouter` | openrouter mode |
| DeepSeek | `deepseek` | deepseek mode |
| Anthropic | `anthropic`, `anthropic-oauth`, `custom-anthropic` | anthropic `output_config.effort` |
| enable_thinking | `alibaba-bailian`, `siliconflow` | on_off + budget 近似 |
| thinkingObject | `zai`, `zhipu-glm`, `kimi-coding`, moonshot/mimo 相关 | on_off thinking |
| MiniMax | `minimax` | reasoning_split on_off |
| StepFun | `stepfun` | low_high |
| Cursor / Antigravity | `cursor-subscription`, `antigravity-*` | 沿用现有 adapter 的 effort 读取；catalog 标注 adapter 专用 |

自定义供应商：允许在 UI/配置里覆盖 `codexChatReasoning` / `reasoningEffort`；无覆盖时按 apiFormat 选择默认分组。

## 数据流

```text
Client (Codex effort)
  → Gateway normalize body
  → resolve catalog(provider, model)
  → clamp + map → outbound body
  → summarizeRequest.reasoningEffortTrace
  → Desktop Trace UI 参数条 + 时间线
```

## 错误与边界

- 上游因非法 effort 返回 400：摘要保留 requested/mapped/wireValue；错误分类可标 `reasoning_effort_unsupported`（若可识别）
- 未显式携带 reasoning：不注入、不钳制；参数条显示「未指定」
- 会话对象无 request_summary：隐藏 effort chip，不报错

## 测试

- 单元：catalog clamp/map（OpenAI / DeepSeek / Qwen on_off / Anthropic / StepFun）
- 单元：`summarizeRequest` 含 `reasoningEffortTrace`
- 渲染级（可选轻量）：参数条在 clamped 时出现告警文案
- 回归：现有 `reasoning-options` / dispatch / compat fixtures 不坏

## 里程碑

1. **M1** 能力表模块 + 摘要 trace + 单测（无 UI）
2. **M2** 桌面调用可视化方案 A
3. **M3** Codex/手机目录档位与 preset 全覆盖挂载
4. **M4** 清理重复启发式、文档/问题包字段说明

## 风险

- 供应商文档变化快：catalog 需可覆盖、可按模型细化，避免写死唯一真相
- `ultra` / `pro` 易被误当成 effort：UI 文案区分「编排/模式」与「思考档」
- 全量 preset 一次改完易漏：M1 先保证解析链路，M3 按分组补齐并列表验收

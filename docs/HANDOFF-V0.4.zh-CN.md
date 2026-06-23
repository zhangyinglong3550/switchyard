---
title: Switchyard V0.4 交付
status: ready-for-review
created: 2026-06-23
---

# Switchyard V0.4 交付 — 兼容矩阵

## 交付范围

V0.4 实现产品文档第 8.4 节要求的 5 个 provider/model 定向兼容补丁。每个补丁严格定向到目标 provider/model，互不干扰，并配套独立单元用例。

> 代码仓库：`/Users/zhangyinglong/code/codex/switchyard`
> 对应产品文档章节：第 8.4 节
> 总单元测试：62 通过 / 0 失败

## 5 个兼容补丁

### 1. Kimi tool-schema sanitizer

- **文件**：`packages/core/src/compat/patches/kimi-tool-schema.mjs`
- **定向**：`provider.id ∈ {kimi, moonshot}` 或 `model.id` 匹配 `/kimi|moonshot/i`
- **方向**：outbound
- **行为**：递归剥离 `$schema` / `$id` / `examples` / 单分支 `anyOf` 包裹；将 `additionalProperties: object` 强制为 `false`
- **用例**：strips $schema/examples/anyOf wrappers from Kimi function parameters；does NOT touch non-Kimi providers

### 2. DeepSeek reasoning_content

- **文件**：`packages/core/src/compat/patches/deepseek-reasoning.mjs`
- **定向**：`provider.id === "deepseek"` 或 `model.id` 匹配 `/deepseek/i`
- **方向**：inbound + streamLine（同时处理非流和 SSE delta）
- **行为**：去掉 message.reasoning_content 字段；流式响应中也对每行 SSE delta 做相同处理
- **用例**：strips reasoning_content from non-stream response；strips reasoning_content from stream delta；does NOT affect non-DeepSeek

### 3. GLM input content.text

- **文件**：`packages/core/src/compat/patches/glm-content-text.mjs`
- **定向**：`provider.id ∈ {glm, zhipu, coding-plan, agentplan}` 或 `model.id` 匹配 `/glm|zhipu/i`
- **方向**：outbound
- **行为**：将 `messages[i].content: string` 包装为 `[{type:"text", text:"..."}]`
- **用例**：wraps bare string content for GLM；does NOT affect non-GLM

### 4. OpenCode Go tool-history

- **文件**：`packages/core/src/compat/patches/opencode-tool-history.mjs`
- **定向**：`provider.id ∈ {opencode-go, opencode}` 或 `model.id` 匹配 `/opencode/i`
- **方向**：outbound
- **行为**：重排 messages，让 `role:tool` 紧跟其触发的 assistant 消息之后
- **用例**：reorders tool_results after assistant messages；preserves message count

### 5. 官方 GPT 切回兼容（official-gpt-fallback）

- **文件**：`packages/core/src/compat/patches/official-gpt-fallback.mjs`
- **定向**：`provider.id ∈ {codex, openai, official-gpt}` 或 `model.id` 匹配 `/gpt/i`
- **方向**：outbound
- **行为**：确保 max_tokens 存在且为正；去掉 GPT 不识别的 top_k / min_p / presence_penalty / repetition_penalty；temperature 越界时归 1
- **用例**：sets default max_tokens；strips GPT-unsupported parameters

## 5 补丁交叉隔离测试

`v0.4-patches · all 5 patches registered simultaneously do not interfere`：

- 同时注册全部 5 个补丁
- Kimi 请求只触发 kimi-tool-schema
- DeepSeek 响应只触发 deepseek-reasoning
- GLM 请求只触发 glm-content-text
- OpenCode 请求只触发 opencode-tool-history
- GPT 请求只触发 official-gpt-fallback
- 一个不属于任何补丁的 provider（id: "other"）保持原样：`top_k`、`max_tokens=0` 都不被改

这是 V0.4 验收的核心：**互不干扰，每个补丁都定向，绝不全局降级。**

## 注册机制

`packages/core/src/compat/index.mjs` 导出 `registerBuiltinPatches()`。
`packages/core/src/server.mjs` 在 import 时即调用一次，自动激活全部 5 个补丁。

```javascript
import { registerBuiltinPatches, applyStreamLine } from "./compat/index.mjs";
registerBuiltinPatches();
```

CLI 入口（`packages/core/bin/gateway.mjs`）通过 import server.mjs 自动获得补丁；Electron desktop 通过 `@switchyard/core/server` 同样自动获得。

## SSE 流式处理改造

为了让 deepseek-reasoning 在 stream 模式下生效，`pipeStream()` 改造为按行解析 SSE：
- 用 TextDecoder 增量解码
- 按 `\r?\n` 分割完整行
- 每行通过 `applyStreamLine(line, ctx)` 走 streamLine 补丁
- 补丁返回 `null` 时丢弃该行；其他保留并补换行

## 单元测试

```
ℹ tests 62
ℹ pass 62
ℹ fail 0
```

新增 `packages/core/test/v0.4-compat-patches.test.mjs`：12 个用例（5 patches × 2-3 用例 + 1 隔离总测）。
其他既有测试无回归。

## 已知约束（按 goal 不做）

- 不做 fallback / retry / cooldown
- 不做 provider 健康监控
- 不做 CLIProxyAPI Management API
- 不做配额成本统计
- 不做 Gemini 原生适配
- 不做 Vision Bridge
- 任何补丁都 provider/model 定向，没有全局 schema 降级

## 下一步（V0.5）

参见 `docs/PRODUCT-SCOPE.zh-CN.md` 第 8.5 节：

- 脱敏导入导出包
- 同事安装手册
- 配置模板
- GitHub Release（用户授权后）
- 飞书使用文档（用户授权后）
- 自动更新或更新提示
- 常见问题诊断页
- 外部干净安装演练

---

*此文档对应 PRODUCT-SCOPE.zh-CN.md 第 8.4 节的 V0.4 成功标准：5 个兼容补丁互不干扰，每个补丁有独立定向单元用例。*

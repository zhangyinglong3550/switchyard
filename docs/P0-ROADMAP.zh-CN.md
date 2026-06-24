# Switchyard P0 Product Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Switchyard 从“能接入模型”推进到“出问题能自诊断、能回放、能校准、能安全保存密钥、能检测客户端配置漂移”的本机团队可用工具。

**Architecture:** P0 不引入自动 fallback、复杂健康监控、成本调度或远程管理 API。实现采用本机只读/低风险检测优先：核心逻辑放在 `apps/desktop/src/*` 与 `packages/core/src/*` 的小模块中，Electron 通过 IPC 暴露给 UI，SQLite 请求日志继续作为回放和可视化来源。

**Tech Stack:** Electron、Node.js ESM、macOS `security` Keychain CLI、SQLite request log、现有 Switchyard gateway/profile writer/test model IPC。

---

## P0 范围

### 1. 一键诊断中心

用户需要回答的问题：

- 为什么某个模型不可用？
- 是 Key、baseUrl、协议、模型名、能力声明、客户端配置还是上游限制的问题？
- 应该点哪里修？

P0 输出：

- Provider 级诊断：baseUrl、认证方式、Key 来源、模型列表接口、协议路径。
- Model 级诊断：provider 是否存在、upstreamModel 是否存在、客户端可见性、能力声明、模型测试结果。
- Client 级诊断：Codex / Claude Code / Hermes 当前配置是否指向 Switchyard。
- 错误分类：`auth`、`network`、`protocol`、`model_not_found`、`schema`、`capability`、`client_config`、`unknown`。
- UI 上提供“运行诊断”和可读修复建议。

### 2. 模型能力自动校准

用户需要回答的问题：

- 这个模型到底支持 stream / tools / vision / reasoning 吗？
- 当前手填能力是否准确？

P0 输出：

- 运行小探针：文本、流式、工具调用、视觉输入、reasoning 响应字段。
- 生成建议能力矩阵，不自动覆盖用户配置。
- 用户确认后写入模型能力。
- 探针结果可被测试台和诊断中心复用。

### 3. 失败请求回放

用户需要回答的问题：

- 刚才 Codex / Claude / Hermes 失败的请求，能不能在测试台复现？

P0 输出：

- 从 SQLite 请求日志读取 `request_summary` / `response_summary`。
- 在调用可视化和用量最近请求里提供“回放到测试台”。
- 回放使用安全摘要，不恢复完整密钥，不直接重放历史大 payload。
- 回放结果展示新状态、耗时、响应预览和错误分类。

### 4. 系统安全密钥存储

用户需要回答的问题：

- 同事本机使用时，Key 能不能不明文写配置文件？
- macOS 和 Windows 是否都能走各自平台安全存储，而不是硬编码 macOS Keychain？

P0 输出：

- 新增系统安全存储模块，service 使用 `switchyard`，account 使用 provider id。
- macOS 使用系统 Keychain；Windows 使用当前用户 DPAPI 加密文件存储；其他平台明确提示不支持安全存储。
- Provider 支持 `authMode: "keychain"` 或 `keychainAccount`。
- UI 新增“保存到系统安全存储”选项和 Key 状态展示。
- 日志、规划文档、测试输出均不打印真实 Key。

### 5. 客户端配置漂移检测

用户需要回答的问题：

- Codex / Claude Code / Hermes 现在是不是还接在 Switchyard？
- 如果被别的工具改坏了，能否一键重写？

P0 输出：

- 检测 Codex `~/.codex/config.toml` 的 `model_provider = "custom"` 与 `base_url = http://127.0.0.1:17888/codex/v1`。
- 检测 Claude Code settings 中 Switchyard 模型槽位/环境变量。
- 检测 Hermes config 中 Switchyard baseUrl。
- UI 显示 `ok / drifted / missing / unreadable` 和修复按钮。

## 非目标

- 不做自动 fallback / retry / cooldown。
- 不做 provider 持续健康监控后台任务。
- 不做 CLIProxyAPI Management API。
- 不做成本/配额调度。
- 不做 Gemini 原生适配。
- 不做远程公网服务。
- 不做语音助手。

## 文件规划

- Create `apps/desktop/src/keychain-store.mjs`：封装系统安全存储，macOS 走 Keychain CLI，Windows 走 DPAPI，可测试注入 runner。
- Create `apps/desktop/src/diagnostics.mjs`：一键诊断、错误分类、能力探针编排、客户端漂移检测。
- Modify `packages/core/src/upstream/clients.mjs`：Provider 认证头支持 Keychain 解析。
- Modify `apps/desktop/src/main.mjs`：新增 IPC：`diagnostics:run`、`capabilities:probe`、`capabilities:apply`、`request:replay`、`client-config:doctor`、`keychain:*`。
- Modify `apps/desktop/renderer/index.html`：新增“诊断中心”页面与回放按钮入口。
- Modify `apps/desktop/renderer/renderer.js`：接入诊断、能力校准、回放到测试台、漂移检测 UI。
- Modify `apps/desktop/renderer/styles.css`：诊断结果、错误分类、建议能力矩阵样式。
- Test `packages/core/test/keychain-store.test.mjs`：Keychain 命令构造和不泄露密钥。
- Test `packages/core/test/diagnostics.test.mjs`：错误分类、能力建议、客户端漂移状态。
- Test `packages/core/test/request-replay.test.mjs`：从请求日志生成可回放测试草稿。

## 执行任务

### Task 1: 系统安全密钥存储

- [x] 写失败测试：保存、读取、删除 Keychain key 时 runner 收到正确 `security` 参数。
- [x] 写失败测试：Windows 分支使用 DPAPI 加密文件存储，命令参数不携带明文 key。
- [x] 实现 `keychain-store.mjs`，按 `process.platform` 差异化。
- [x] 在 provider auth 里支持 `authMode: "keychain"`。
- [x] 验证不把明文 key 写到日志。

### Task 2: 诊断和错误分类

- [x] 写失败测试：把典型错误映射到 `auth/network/protocol/model_not_found/schema/capability/client_config/unknown`。
- [x] 实现 `classifyGatewayError()`。
- [x] 实现 provider/model/client 诊断汇总。
- [x] UI 展示分类和修复建议。

### Task 3: 模型能力探针

- [x] 写失败测试：模拟 text/stream/tools/vision/reasoning 探针结果生成建议能力。
- [x] 实现 `probeModelCapabilities()`。
- [x] 新增“应用建议能力”逻辑。
- [x] UI 显示探针结果，不自动覆盖配置。

### Task 4: 请求回放

- [x] 写失败测试：从 SQLite 行的摘要生成测试台草稿。
- [x] 实现 `buildReplayDraft()`。
- [x] 在调用可视化/最近请求提供“回放到测试台”。
- [x] 回放结果进入测试台，不重放密钥。

### Task 5: 客户端配置漂移检测

- [x] 写失败测试：Codex/Claude/Hermes 配置匹配、缺失、漂移。
- [x] 实现 `doctorClientConfigs()`。
- [x] UI 显示状态并复用现有 profile 写入修复。

### Task 6: 总体验证

- [x] `npm test`
- [x] `npm run check`
- [x] `npm run desktop:dmg`
- [x] 覆盖安装 `/Applications/Switchyard.app`
- [x] 本机健康检查 `http://127.0.0.1:17888/health`

## 执行结果

- `npm test`：119/119 通过。
- `npm run check`：通过，已覆盖新增 `keychain-store.mjs` 与 `diagnostics.mjs`。
- `npm run desktop:dmg`：通过，产物 `dist/Switchyard-0.2.0-arm64.dmg`。
- 本机覆盖安装：已安装 `/Applications/Switchyard.app`。
- 健康检查：`http://127.0.0.1:17888/health` 返回 `ok: true`，客户端包含 Codex、Claude Code、Hermes、通用 OpenAI。
- 飞书备份：新版备份链接见最终交付记录。

## Review 修复记录

- 安全审查修复：删除 `keychain:get` IPC，renderer 不再能从系统安全存储读取明文 Key。
- 安全审查修复：macOS Keychain 写入改为 `security ... -w` prompt 模式，通过 stdin 输入，明文 Key 不再出现在命令参数 argv。
- 安全审查修复：移除 Codex OAuth 隐式请求重试，P0 阶段保持单次请求，符合“不做 fallback / retry / cooldown”边界。
- 交互审查修复：诊断中心、探针结果、请求回放统一标注为“启发式建议 / 草稿回放”，避免误导为确定诊断或完整原始请求复现。

## 成功标准

- 用户能在诊断中心看懂一个模型为什么不可用，并得到下一步修复建议。
- 用户能对任意模型运行能力探针，并把建议能力写回模型配置。
- 用户能把失败请求回放到测试台复现。
- 用户能选择系统安全存储保存 Provider key，配置文件不再需要保存明文 key。
- 用户能看到 Codex / Claude Code / Hermes 是否仍指向 Switchyard，并能一键修复。
- 全量测试与打包安装通过。

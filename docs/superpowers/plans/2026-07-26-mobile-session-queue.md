# 移动端会话排队与引导指令 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为移动端会话提供持久化的 FIFO 后续指令队列、停止策略和可编辑队列 UI。

**Architecture:** `store.mjs` 保存仅包含公开附件引用的队列项；`session-registry.mjs` 是唯一调度器，负责启动、结束调度和停止策略；HTTP/SSE 只投影队列状态；移动端根据会话详情渲染队列与操作。

**Tech Stack:** Node.js ES modules、现有 mobile-control JSON 状态库、HTTP/SSE、原生 PWA。

## Global Constraints

- 队列按会话 FIFO，不支持跨会话移动或重排。
- 停止默认清空队列；保留队列时必须手动恢复。
- 仅在当前运行成功完成时自动调度下一项；失败、取消、等待审批不自动继续。
- 附件复用现有安全资产存储，不在队列状态中保存 base64 内容。

---

### Task 1: 持久化队列状态

**Files:**
- Modify: `apps/desktop/src/mobile-control/store.mjs`
- Test: `packages/core/test/mobile-control-store.test.mjs`

- [ ] 增加 `queues` 状态段及 `listQueue`、`enqueueQueueItem`、`updateQueueItem`、`removeQueueItem`、`shiftQueueItem`、`clearQueue` API。
- [ ] 将队列项限定为 `{ id, messageId, text, attachments, createdAt }`，附件使用 `publicAsset`。
- [ ] 测试重启状态库后队列、编辑、删除与 FIFO 仍一致。

### Task 2: 会话调度和停止策略

**Files:**
- Modify: `apps/desktop/src/mobile-control/session-registry.mjs`
- Test: `packages/core/test/mobile-session-registry.test.mjs`

- [ ] 用单一 `startMessage` 负责记录消息、配置模型、调用 runtime 与错误处理。
- [ ] `sendMessage` 根据 session active 状态立即运行或入队。
- [ ] 监听 runtime 终态：仅 completed 自动 shift 并启动下一项；failed/cancelled 暂停。
- [ ] 实现 `updateQueueItem`、`removeQueueItem`、`resumeQueue` 和带 `clearQueue` 的 cancel。
- [ ] 将队列投影进 `readSession`，并通过 ledger 发送状态事件。

### Task 3: HTTP API

**Files:**
- Modify: `apps/desktop/src/mobile-control/server.mjs`
- Test: `packages/core/test/mobile-control-server.test.mjs`

- [ ] 增加队列编辑、删除、恢复路由，并把 cancel body 的 `clearQueue` 交给 registry。
- [ ] 为错误操作返回现有 JSON 错误格式。

### Task 4: 移动端队列 UI

**Files:**
- Modify: `apps/mobile/index.html`
- Modify: `apps/mobile/app.js`
- Modify: `apps/mobile/styles.css`
- Test: `packages/core/test/mobile-pwa-structure.test.mjs`

- [ ] 在会话详情加入可折叠“排队指令（N）”面板，支持编辑和取消。
- [ ] 正在执行时发送按钮与提示显示“排队发送”。
- [ ] 停止会话弹窗提供“停止并清空”和“仅停止、保留队列”。
- [ ] SSE 或详情刷新后重新渲染队列。

### Task 5: 验证

- [ ] 运行 `npm run check`。
- [ ] 运行队列相关单测和已有移动端回归测试。
- [ ] 运行 `git diff --check`。

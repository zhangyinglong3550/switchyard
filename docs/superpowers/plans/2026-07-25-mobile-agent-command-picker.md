# Mobile Agent Command Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为手机端四个 Agent 增加 `/` 命令与 Skill 选择器，并为 Codex 增加 `$` Skill 触发器。

**Architecture:** 新建独立的移动命令目录模块，规范化本地 Skill、静态 Agent 命令与 ACP 动态命令；session registry 暴露安全 DTO，server 提供认证接口。手机端使用一个可复用的 token 解析和弹层控制器服务已有会话与新会话输入框。

**Tech Stack:** Node.js ESM、原生 HTTP、原生浏览器 JavaScript/CSS、Node test、Playwright。

## Global Constraints

- 覆盖 Codex、Claude Code、OpenCode、Grok。
- Codex Skill 使用 `$name`；其余 Agent Skill 使用 `/name`。
- 选择条目不自动发送。
- 不暴露 Skill 正文、本机路径或凭据。
- 不新增依赖，不重启桌面 App。

---

### Task 1: 命令目录

**Files:**
- Create: `apps/desktop/src/mobile-control/command-catalog.mjs`
- Modify: `apps/desktop/src/mobile-control/session-registry.mjs`
- Test: `packages/core/test/mobile-command-catalog.test.mjs`

**Interfaces:**
- Produces: `createMobileCommandCatalog().list(agentId)`，返回安全的 command/skill 条目数组。

- [ ] 写失败测试，覆盖四 Agent Skill 根、禁用文件、front matter 描述、语法和去重。
- [ ] 实现 Skill 扫描、Agent 静态命令与 Claude command 文件扫描。
- [ ] 在 registry 增加 `listCommands(agentId)` 和短时缓存。
- [ ] 运行 `node --test packages/core/test/mobile-command-catalog.test.mjs`。

### Task 2: API 与动态命令

**Files:**
- Modify: `apps/desktop/src/mobile-control/server.mjs`
- Modify: `apps/desktop/src/mobile-control/acp-runtime.mjs`
- Modify: `apps/desktop/src/mobile-control/opencode-runtime.mjs`
- Test: `packages/core/test/mobile-control-server.test.mjs`
- Test: `packages/core/test/mobile-agent-runtimes.test.mjs`

**Interfaces:**
- Consumes: `registry.listCommands(agentId)`。
- Produces: `GET /mobile/v1/commands?agent=<id>`。

- [ ] 写认证接口和 `available_commands_update` 规范化测试。
- [ ] 捕获 ACP 动态命令并通过 runtime `listCommands()` 暴露。
- [ ] 合并动态命令并确保 DTO 不含路径和正文。
- [ ] 运行 server/runtime 专项测试。

### Task 3: 手机选择器

**Files:**
- Modify: `apps/mobile/index.html`
- Modify: `apps/mobile/app.js`
- Modify: `apps/mobile/styles.css`
- Modify: `apps/mobile/sw.js`
- Test: `packages/core/test/mobile-pwa-structure.test.mjs`

**Interfaces:**
- Consumes: `/mobile/v1/commands?agent=<id>`。

- [ ] 写结构断言，覆盖 `/`、Codex `$`、键盘和选择后不发送。
- [ ] 实现命令缓存、token 解析、分组筛选、触摸与键盘控制。
- [ ] 同时绑定 `#message` 和 `#prompt`，切换 Agent 时刷新目录。
- [ ] 升级 PWA 缓存版本并运行结构测试。

### Task 4: 集成验证与部署

**Files:**
- Verify only.

- [ ] 运行手机端、runtime、server 和项目检查。
- [ ] 用 393px Chrome 视口验证 `/`、`$`、长列表和无横向溢出。
- [ ] 只重启手机 LaunchAgent，等待端口恢复并验证 HTTP 200。

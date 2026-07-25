# Switchyard 移动控制 P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不暴露模型数据面、Provider 凭据和任意 Shell 的前提下，为 Codex、Claude Code、Grok Build、OpenCode 提供可通过 Tailscale 使用的移动 PWA，支持继续/新建任务、下一轮切换模型、停止、低风险审批以及改名、归档、删除。

**Architecture:** Electron main process启动独立的 `MobileControlServer`，只绑定 `127.0.0.1:17889`，通过设备配对 token 提供固定 DTO REST API 和 SSE 事件补拉。会话控制通过统一 `AgentRuntime` 接口转发到 Codex app-server 或 ACP/本机 Server API；显示名、非原生归档、置顶和写入租约保存在 `~/.switchyard/mobile-control/`，不修改 Claude JSONL 等原始会话文件。

**Tech Stack:** Node.js 20 ESM、Electron 33、Node `http`、JSON/JSONL 持久化、Server-Sent Events、原生 HTML/CSS/JavaScript PWA、Node test runner。

## Global Constraints

- 移动控制服务默认关闭且只绑定 `127.0.0.1:17889`；不自动启用 Tailscale Funnel 或公网 Tunnel。
- `:17888` 继续只承担模型数据面；mobile token 不得用于任何 Provider、OAuth 或模型网关认证。
- 手机不展示或修改 API Key、OAuth token、兼容包、协议转换规则、原始请求日志、任意 Shell 或任意文件路径。
- 模型切换只影响目标会话后续 turn；运行中的 turn 不热切换。
- 同一 session 同时只能有一个写入租约持有者；桌面与手机可以同时只读。
- 原生支持的动作写回 Agent；缺少原生 rename/archive 时仅写 Switchyard overlay；不伪造底层能力。
- 新增行为先写失败测试并确认 RED，再写最小实现并确认 GREEN。
- 保留仓库现有未提交改动，不 reset、不 checkout、不批量格式化无关文件。

---

### Task 1: 移动控制持久化、脱敏 DTO 和事件账本

**Files:**
- Create: `apps/desktop/src/mobile-control/store.mjs`
- Create: `apps/desktop/src/mobile-control/dto.mjs`
- Create: `apps/desktop/src/mobile-control/event-ledger.mjs`
- Test: `packages/core/test/mobile-control-foundation.test.mjs`

**Interfaces:**
- Produces: `createMobileControlStore({ root, now, randomBytes })`
- Produces: `projectMobileSession(row, overlay)`
- Produces: `projectMobileEvent(event)`
- Produces: `createEventLedger({ file, maxEvents })`

- [ ] **Step 1: Write the failing foundation tests**

```js
test("mobile store consumes pairing challenge once and revocation is immediate", () => {
  const store = createMobileControlStore({ root, now: () => NOW });
  const challenge = store.createChallenge({ ttlMs: 600000 });
  const device = store.completePairing({ challenge: challenge.secret, name: "iPhone" });
  assert.throws(() => store.completePairing({ challenge: challenge.secret, name: "Replay" }), /已使用/);
  assert.equal(store.authenticate(device.token).id, device.id);
  store.revokeDevice(device.id);
  assert.throws(() => store.authenticate(device.token), /已撤销/);
});

test("mobile DTO removes paths, prompts, tokens and raw tool input", () => {
  const dto = projectMobileSession({
    id: "s1", agentId: "codex", name: "任务", path: "/Users/a/secret",
    apiKey: "sk-secret", conversation: { messages: [{ role: "user", text: "private prompt" }] }
  });
  assert.deepEqual(dto, {
    id: "s1", agent: "codex", title: "任务", state: "completed",
    updatedAt: null, model: "", project: "", pinned: false, archived: false,
    capabilities: {}
  });
});

test("event ledger replays strictly after cursor without duplicates", () => {
  const ledger = createEventLedger({ file });
  const one = ledger.append({ sessionId: "s1", type: "status", summary: "running" });
  const two = ledger.append({ sessionId: "s1", type: "status", summary: "completed" });
  assert.deepEqual(ledger.list({ after: one.id }).map((event) => event.id), [two.id]);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test packages/core/test/mobile-control-foundation.test.mjs`

Expected: FAIL because the three mobile-control modules do not exist.

- [ ] **Step 3: Implement atomic JSON persistence, hashed tokens, overlays and JSONL events**

`store.mjs` must persist only token hashes and expose:

```js
{
  createChallenge({ ttlMs }),
  completePairing({ challenge, name }),
  authenticate(token),
  listDevices(),
  revokeDevice(deviceId),
  getOverlay(sessionId),
  patchOverlay(sessionId, patch),
  acquireLease({ sessionId, ownerId, ttlMs }),
  releaseLease({ sessionId, ownerId }),
  rememberMessage({ sessionId, messageId })
}
```

`dto.mjs` must build allowlisted objects only; it must never spread source rows into a response.

- [ ] **Step 4: Run foundation tests and full tests**

Run: `node --test packages/core/test/mobile-control-foundation.test.mjs && npm test`

Expected: new tests PASS and the existing 431 tests remain green.

### Task 2: Codex app-server persistent notifications and runtime

**Files:**
- Modify: `apps/desktop/src/codex-app-server.mjs`
- Create: `apps/desktop/src/mobile-control/codex-runtime.mjs`
- Test: `packages/core/test/codex-mobile-runtime.test.mjs`

**Interfaces:**
- `CodexAppServerClient.subscribe(handler): () => void`
- `CodexAppServerClient.request(method, params, timeoutMs)`
- `createCodexRuntime({ client, models })` implementing `AgentRuntime`

```ts
interface AgentRuntime {
  listSessions(input): Promise<MobileSession[]>
  readSession(sessionId): Promise<MobileSessionDetail>
  createSession(input): Promise<{ sessionId: string }>
  sendMessage(sessionId, input): Promise<{ accepted: true }>
  setModel(sessionId, modelId, effort?): Promise<void>
  cancel(sessionId): Promise<void>
  rename(sessionId, title): Promise<void>
  archive(sessionId): Promise<void>
  unarchive(sessionId): Promise<void>
  delete(sessionId): Promise<void>
  fork(sessionId): Promise<{ sessionId: string }>
}
```

- [ ] **Step 1: Write failing tests for notification routing and next-turn model changes**
- [ ] **Step 2: Run `node --test packages/core/test/codex-mobile-runtime.test.mjs` and verify RED**
- [ ] **Step 3: Teach `CodexAppServerClient` to distinguish response, notification and server request frames**
- [ ] **Step 4: Implement Codex methods using `thread/list`, `thread/read`, `thread/start`, `turn/start`, `turn/interrupt`, `thread/settings/update`, `thread/name/set`, `thread/archive`, `thread/unarchive`, `thread/delete` and `thread/fork`**
- [ ] **Step 5: Verify runtime tests and existing handoff tests**

Run: `node --test packages/core/test/codex-mobile-runtime.test.mjs packages/core/test/session-handoff.test.mjs`

Expected: PASS with notification subscriptions receiving ordered events.

### Task 3: ACP transport and Claude Code / Grok / OpenCode runtimes

**Files:**
- Create: `apps/desktop/src/mobile-control/acp-client.mjs`
- Create: `apps/desktop/src/mobile-control/claude-runtime.mjs`
- Create: `apps/desktop/src/mobile-control/grok-runtime.mjs`
- Create: `apps/desktop/src/mobile-control/opencode-runtime.mjs`
- Test: `packages/core/test/mobile-agent-runtimes.test.mjs`

**Interfaces:**
- `createAcpClient({ command, args, spawnProcess })`
- Runtime adapters implement the exact `AgentRuntime` interface from Task 2.

- [ ] **Step 1: Write fake-stdio ACP tests covering initialize, list/load/new, prompt, cancel, set_model, rename/fork/delete capability gating**
- [ ] **Step 2: Run tests and verify RED**
- [ ] **Step 3: Implement newline-delimited ACP transport with response, notification, request and process-exit handling**
- [ ] **Step 4: Implement Claude via `@agentclientprotocol/claude-agent-acp`; use Switchyard overlay for rename/archive**
- [ ] **Step 5: Implement Grok via `grok agent stdio`; use native rename/fork/delete and overlay archive when the capability is absent**
- [ ] **Step 6: Implement OpenCode via `opencode acp` or its local Server API; use native title/archive/fork/delete/model operations**
- [ ] **Step 7: Run runtime tests; skip only when a local binary is absent, never treat absence as runtime success**

### Task 4: Unified registry, model filtering and write lease

**Files:**
- Create: `apps/desktop/src/mobile-control/session-registry.mjs`
- Test: `packages/core/test/mobile-session-registry.test.mjs`

**Interfaces:**
- `createSessionRegistry({ runtimes, store, readConfig, listAgentSessions, readAgentSession })`
- `registry.availableModels(agentId, sessionId)`
- `registry.setSessionModel(sessionId, modelId, effort, ownerId)`
- `registry.perform(sessionId, action, payload, ownerId)`

- [ ] **Step 1: Write failing tests for capability projection, unavailable-model filtering and lease conflicts**
- [ ] **Step 2: Verify RED**
- [ ] **Step 3: Implement logical model filtering from `listModelsForClient()` and runtime capability intersection**
- [ ] **Step 4: Enforce lease before all write methods and return a stable `SESSION_WRITE_CONFLICT` error**
- [ ] **Step 5: Run registry tests and full tests**

### Task 5: Authenticated loopback HTTP API and SSE replay

**Files:**
- Create: `apps/desktop/src/mobile-control/server.mjs`
- Create: `apps/desktop/src/mobile-control-host.mjs`
- Modify: `apps/desktop/src/main.mjs`
- Test: `packages/core/test/mobile-control-server.test.mjs`

**Interfaces:**
- `createMobileControlServer({ host, port, store, registry, ledger, publicDir })`
- `startMobileControl()`, `stopMobileControl()`, `mobileControlStatus()`

- [ ] **Step 1: Write failing HTTP tests for disabled-by-default behavior, pairing, bearer auth, CORS/origin rejection, DTO allowlist, message idempotency and SSE `after` replay**
- [ ] **Step 2: Verify RED**
- [ ] **Step 3: Implement endpoints**

```text
POST   /mobile/pair/complete
GET    /mobile/v1/agents
GET    /mobile/v1/models?agent=<id>&session_id=<id>
GET    /mobile/v1/sessions
GET    /mobile/v1/sessions/:id
POST   /mobile/v1/sessions
POST   /mobile/v1/sessions/:id/messages
POST   /mobile/v1/sessions/:id/model
POST   /mobile/v1/sessions/:id/cancel
POST   /mobile/v1/sessions/:id/rename
POST   /mobile/v1/sessions/:id/archive
POST   /mobile/v1/sessions/:id/unarchive
POST   /mobile/v1/sessions/:id/fork
DELETE /mobile/v1/sessions/:id
GET    /mobile/v1/events?after=<event_id>
POST   /mobile/v1/devices/self/revoke
```

- [ ] **Step 4: Wire server startup/shutdown into Electron without coupling it to gateway `:17888`**
- [ ] **Step 5: Run server tests, `npm run check`, and full tests**

### Task 6: Mobile PWA core screens

**Files:**
- Create: `apps/mobile/index.html`
- Create: `apps/mobile/app.js`
- Create: `apps/mobile/styles.css`
- Create: `apps/mobile/manifest.webmanifest`
- Create: `apps/mobile/sw.js`
- Test: `packages/core/test/mobile-pwa-structure.test.mjs`

**Interfaces:**
- Consumes only `/mobile/pair/*` and `/mobile/v1/*`.
- Stores only the mobile device token and last event cursor in browser storage.

- [ ] **Step 1: Write failing structure tests for task list, new task, approvals, workspaces, settings, model selector, rename/archive/fork/delete actions and absence of Provider/API-key controls**
- [ ] **Step 2: Verify RED**
- [ ] **Step 3: Implement mobile-first task list and detail view with bottom navigation**
- [ ] **Step 4: Implement new task form, next-turn model selector, effort selector, stop and session management menus**
- [ ] **Step 5: Implement SSE reconnect with cursor replay and idempotent `message_id`**
- [ ] **Step 6: Verify structure tests and perform a 390px viewport browser smoke test**

### Task 7: Desktop mobile-control settings and device management

**Files:**
- Modify: `apps/desktop/renderer/index.html`
- Modify: `apps/desktop/renderer/renderer.js`
- Modify: `apps/desktop/renderer/styles.css`
- Modify: `apps/desktop/src/main.mjs`
- Test: `packages/core/test/mobile-desktop-integration.test.mjs`

**Interfaces:**
- IPC: `mobile-control:status`, `mobile-control:enable`, `mobile-control:disable`, `mobile-control:pair-start`, `mobile-control:devices`, `mobile-control:device-revoke`

- [ ] **Step 1: Write failing integration tests for settings controls and IPC channels**
- [ ] **Step 2: Verify RED**
- [ ] **Step 3: Add settings card showing loopback URL, Tailscale guidance, enable state and paired devices**
- [ ] **Step 4: Add one-time pairing code/QR-compatible URL and immediate revoke action**
- [ ] **Step 5: Verify tests and desktop syntax**

### Task 8: Approval policy, security audit and end-to-end acceptance

**Files:**
- Create: `apps/desktop/src/mobile-control/approval-policy.mjs`
- Modify: runtime modules from Tasks 2–3
- Test: `packages/core/test/mobile-approval-policy.test.mjs`
- Modify: `docs/MOBILE-CONTROL-V1.zh-CN.md`

- [ ] **Step 1: Write failing policy tests for workspace-only edits, low-risk commands, sudo/root, mass delete, secret reads, system config and permanent allow**
- [ ] **Step 2: Verify RED**
- [ ] **Step 3: Implement `allow_once` / `deny_once`; route high-risk requests to `waiting_for_desktop_approval`**
- [ ] **Step 4: Run full automated verification**

Run:

```bash
npm run check
npm test
node --test apps/desktop/renderer/renderer-structure.test.mjs
```

Expected: all tests PASS with no syntax errors.

- [ ] **Step 5: Run local end-to-end smoke**

Verify:

```text
Desktop creates Codex task → phone/PWA sees same thread → phone sends next turn
Phone changes model → current turn stays unchanged → next turn reports new model
Phone disconnects and reconnects → events replay after cursor without duplicates
Rename/archive/delete follow native/overlay capability metadata
Claude/Grok/OpenCode missing binary is shown as unavailable, not silently successful
Mobile token cannot call :17888 and no response contains keys, OAuth tokens or raw paths
```

- [ ] **Step 6: Update documentation with exact Tailscale Serve command and verified limitations**


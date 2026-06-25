# Codex Official Direct Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Codex 官方模型默认可走官方直连，也允许用户显式新增 `OpenAI Codex（OAuth）` 高风险代理供应商；该供应商必须采用 cc-switch/Hermes 风格的 Codex OAuth 请求方式，并在页面显著标注账号风险。

**Architecture:** 核心层新增 Codex 接入模式：`switchyard_proxy` 保持当前 `model_provider = "custom"`、本地 `/codex/v1`、模型 catalog/cache；`official_direct` 只移除 Switchyard 管理的 Codex 配置块，让 Codex App/CLI 自己使用官方登录态。`codex-oauth` provider 作为可见但高风险的官方代理预设保留，固定 `apiFormat = "openai_responses"`、`providerType/authMode = "codex_oauth"`、`baseUrl = "https://chatgpt.com/backend-api/codex"`，请求头和 Responses body 对齐 cc-switch/Hermes；桌面端新增和编辑该供应商时必须展示显著风险提示。

**Tech Stack:** Node.js ESM, Electron IPC, Codex TOML profile writer, node:test, renderer plain JavaScript/CSS.

---

## 文件结构

- Modify: `packages/core/src/profile-writer.mjs`
  - 新增 `CODEX_ACCESS_MODES`、`mergeCodexOfficialDirectProfile()`、`applyCodexOfficialDirect()`。
  - 扩展 `applyProfile()` / `previewCodexProfile()` 支持 `{ mode: "official_direct" }`。
  - 保留 `applyCodex()` 作为三方代理写入路径，继续使用 `model_provider = "custom"` 保持现有代理会话分组。
- Modify: `packages/core/src/provider-presets.mjs`
  - `listProviderPresets()` 继续返回 `codex-oauth`，但该项带 `experimental: true`、`riskLevel: "high"`、`riskNote`。
  - `codex-oauth` 必须固定 Codex OAuth 的 endpoint、wire API 和认证模式，不允许被当成普通 OpenAI-compatible 供应商。
- Modify: `packages/core/src/upstream/clients.mjs`
  - 固化 cc-switch/Hermes 风格 Codex OAuth 请求头：`Authorization`、`OpenAI-Beta`、`originator`、`User-Agent`、`chatgpt-account-id`。
  - Codex OAuth 请求默认 `noKeepAlive`、网络错误重试，避免官方 Codex 流式连接更容易断。
- Modify: `packages/core/src/upstream/dispatch.mjs`
  - Codex OAuth Responses body 固定 `store = false`、强制上游 `stream = true`、补 `instructions`、删除不兼容参数，并走 Responses SSE 聚合。
- Modify: `packages/core/test/profile-writer.test.mjs`
  - 增加官方直连清理测试。
  - 保留代理模式 catalog/cache/重试参数回归测试。
- Modify: `packages/core/test/provider-presets.test.mjs`
  - 验证新增供应商列表展示 Codex OAuth，但标记高风险和实验。
- Modify: `packages/core/test/upstream-auth.test.mjs`
  - 验证 Codex OAuth 请求头对齐 cc-switch/Hermes。
- Modify: `packages/core/test/dispatch.test.mjs`
  - 验证 Codex OAuth 请求强制使用 ChatGPT Codex Responses 形态和流式聚合。
- Modify: `apps/desktop/src/main.mjs`
  - `profile:apply` / `profile:preview` 接收 `{ clientId, mode }`。
  - 官方直连不要求 Gateway running，不触发 Switchyard Codex artifact sync。
- Modify: `apps/desktop/renderer/renderer.js`
  - Codex 客户端卡片增加“官方直连”和“Switchyard 三方代理”按钮。
  - 官方直连说明认证归 Codex App/CLI，Switchyard 不读取 token。
  - 新增或编辑 `codex-oauth` / `authMode === "codex_oauth"` 供应商时展示显著高风险提示。
- Modify: `apps/desktop/renderer/styles.css`
  - 增加 Codex 模式区块样式。

## 核心行为约束

- `switchyard_proxy`：当前三方代理模式。写入 `model_provider = "custom"`、`model_catalog_json`、`[model_providers.custom] base_url = "http://127.0.0.1:17888/codex/v1"`，模型列表来自 Switchyard。
- `official_direct`：真正直连。Switchyard 不代理官方请求，不读取 `~/.codex/auth.json`，不写本地 `base_url`，只清理自己曾经写入的配置。
- 官方直连认证：由 Codex App 官方登录或 `codex login` 处理。Switchyard UI 只负责说明和切换配置，不保存、刷新、复制官方 token。
- 会话分组：代理模式保留 `custom` 分组；官方直连会回到 Codex 官方 provider 分组，可能看不到 `custom` 下的会话，UI 必须明示。
- 新增供应商：普通入口可以展示 `OpenAI Codex（OAuth）`，但该选项必须视觉上标为高风险/实验，并在选择后立即显示风险提示。
- cc-switch/Hermes-style 官方代理适配：Codex OAuth 供应商不能走普通 OpenAI-compatible 请求；必须强制 `chatgpt.com/backend-api/codex`、Responses wire、Codex OAuth 请求头、上游流式聚合和官方 Codex 兼容 body。

---

### Task 1: 核心层支持 Codex 官方直连模式

**Files:**
- Modify: `packages/core/src/profile-writer.mjs`
- Test: `packages/core/test/profile-writer.test.mjs`

- [ ] **Step 1: 写官方直连失败测试**

在 `packages/core/test/profile-writer.test.mjs` 的 Codex profile 测试区追加：

```js
test("codex profile · official direct removes Switchyard routing without touching user blocks", () => {
  const file = pw.codexConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# managed-by: managed-by-switchyard',
    'model_provider = "custom"',
    `model_catalog_json = "${pw.codexModelCatalogPath()}"`,
    'openai_base_url = "http://127.0.0.1:17888/v1"',
    'model_reasoning_effort = "low"',
    'model = "deepseek/deepseek-v4-pro"',
    '',
    '[mcp]',
    'foo = "bar"',
    '',
    '[model_providers.custom]',
    'name = "Switchyard"',
    'base_url = "http://127.0.0.1:17888/codex/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    ''
  ].join("\n"), "utf8");

  const result = pw.applyCodexOfficialDirect();
  const text = fs.readFileSync(file, "utf8");

  assert.equal(result.mode, "official_direct");
  assert.equal(result.path, file);
  assert.ok(result.backup, "backup created");
  assert.doesNotMatch(text, /managed-by-switchyard/);
  assert.doesNotMatch(text, /model_provider\s*=\s*"custom"/);
  assert.doesNotMatch(text, /model_catalog_json/);
  assert.doesNotMatch(text, /openai_base_url\s*=\s*"http:\/\/127\.0\.0\.1:17888\/v1"/);
  assert.doesNotMatch(text, /\[model_providers\.custom\]/);
  assert.doesNotMatch(text, /\/codex\/v1/);
  assert.match(text, /\[mcp\]/);
  assert.match(text, /foo = "bar"/);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- packages/core/test/profile-writer.test.mjs
```

Expected: FAIL，错误包含 `pw.applyCodexOfficialDirect is not a function`。

- [ ] **Step 3: 新增官方直连 profile 函数**

在 `packages/core/src/profile-writer.mjs` 的 `const MARKER = "managed-by-switchyard";` 后追加：

```js
export const CODEX_ACCESS_MODES = Object.freeze({
  SWITCHYARD_PROXY: "switchyard_proxy",
  OFFICIAL_DIRECT: "official_direct"
});
```

在 `mergeCodexProfile()` 后追加：

```js
export function mergeCodexOfficialDirectProfile(existing) {
  const stripped = stripSwitchyardCodexBlock(existing || "", { replaceModel: true });
  return stripped.replace(/\s+$/, "") + "\n";
}
```

在 `applyCodex()` 后追加：

```js
export function applyCodexOfficialDirect({ dryRun } = {}) {
  const file = codexConfigPath();
  const existing = readText(file);
  const next = mergeCodexOfficialDirectProfile(existing);
  if (dryRun) {
    return {
      mode: CODEX_ACCESS_MODES.OFFICIAL_DIRECT,
      path: file,
      preview: next,
      existing,
      auth: "codex_official_login",
      note: "Switchyard removed its managed Codex proxy config. Codex official auth remains owned by Codex App/CLI."
    };
  }
  const result = writeText(file, next);
  return { ...result, mode: CODEX_ACCESS_MODES.OFFICIAL_DIRECT, auth: "codex_official_login" };
}
```

- [ ] **Step 4: 让 apply/preview 按 mode 分发**

把 `previewCodexProfile(target)` 替换为：

```js
export function previewCodexProfile(target = {}) {
  if (target.mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) {
    return mergeCodexOfficialDirectProfile(readText(codexConfigPath()));
  }
  return renderCodexProfile(target);
}
```

把 `applyProfile(id, opts)` 替换为：

```js
export function applyProfile(id, opts = {}) {
  if (id === "codex") {
    if (opts.mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT) return applyCodexOfficialDirect(opts);
    return applyCodex(opts);
  }
  if (id === "claude-code") return applyClaudeCode(opts);
  if (id === "hermes") return applyHermes(opts);
  throw new Error(`Unknown profile id: ${id}`);
}
```

- [ ] **Step 5: 运行 profile-writer 测试**

Run:

```bash
npm test -- packages/core/test/profile-writer.test.mjs
```

Expected: PASS，且现有 `codex profile · merges with existing TOML without losing user blocks` 仍通过。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/profile-writer.mjs packages/core/test/profile-writer.test.mjs
git commit -m "feat: add codex official direct profile mode"
```

---

### Task 2: 新增供应商预设展示 Codex OAuth，并标为高风险实验

**Files:**
- Modify: `packages/core/src/provider-presets.mjs`
- Test: `packages/core/test/provider-presets.test.mjs`

- [ ] **Step 1: 改写预设测试**

把 `packages/core/test/provider-presets.test.mjs` 中第一个测试替换为：

```js
test("provider presets · expose defaults including high-risk Codex OAuth", () => {
  const presets = listProviderPresets();
  const ids = presets.map((preset) => preset.id);
  assert.ok(ids.includes("codex-oauth"));
  assert.ok(ids.includes("openai"));
  assert.ok(ids.includes("anthropic"));
  assert.ok(ids.includes("deepseek"));

  const codex = presets.find((preset) => preset.id === "codex-oauth");
  assert.equal(codex.label, "OpenAI Codex（OAuth）");
  assert.equal(codex.apiFormat, "openai_responses");
  assert.equal(codex.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(codex.defaultAuthMode, "codex_oauth");
  assert.equal(codex.experimental, true);
  assert.equal(codex.riskLevel, "high");
  assert.match(codex.riskNote, /官方文档|账号风险|封号|限制/);

  const opencode = presets.find((preset) => preset.id === "opencode-go");
  assert.equal(opencode.baseUrl, "https://opencode.ai/zen/go/v1");

  const xiaomi = presets.find((preset) => preset.id === "xiaomi-mimo");
  assert.equal(xiaomi.apiFormat, "openai_chat");
  assert.equal(xiaomi.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.ok(presetModelHints(xiaomi).has("mimo-v2.5-pro"));
});
```

保留第二个测试 `provider presets · can be resolved from saved provider metadata`，它继续验证 `providerPresetFor({ id: "codex", presetId: "codex-oauth" })` 能解析历史配置。

把第二个测试扩展为：

```js
test("provider presets · can resolve Codex OAuth metadata for existing configs", () => {
  const preset = providerPresetFor({ id: "codex", presetId: "codex-oauth" });
  assert.equal(preset.id, "codex-oauth");
  assert.equal(preset.experimental, true);
  assert.equal(preset.riskLevel, "high");
  assert.match(preset.riskNote, /官方文档|账号风险|封号|限制/);
  const hints = presetModelHints(preset);
  assert.ok(hints.has("gpt-5.5"));
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
npm test -- packages/core/test/provider-presets.test.mjs
```

Expected: FAIL，原因通常是 `codex-oauth` 缺少 `experimental` / `riskLevel` / `riskNote`，或 label/API/auth 元数据不符合高风险预设要求。

- [ ] **Step 3: 给 Codex OAuth 预设补齐高风险元数据**

在 `codex-oauth` 预设对象里确认或增加：

```js
experimental: true,
riskLevel: "high",
riskNote: "官方文档和社区实践均提示：通过本地网关复用 Codex 官方 OAuth/内部接口可能带来账号限制或封号风险。推荐优先使用官方直连；仅在明确理解风险时使用该 cc-switch/Hermes-style 代理适配。",
```

不要过滤 `codex-oauth`。`listProviderPresets()` 保持返回所有新增供应商预设：

```js
export function listProviderPresets({ includeHidden = false } = {}) {
  return PROVIDER_PRESETS.map((preset) => ({ ...preset }));
}
```

如果当前实现里已经有 `hiddenFromAddProvider` 过滤逻辑，删除过滤；如果没有，保持现状。

- [ ] **Step 4: 运行预设测试**

Run:

```bash
npm test -- packages/core/test/provider-presets.test.mjs
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provider-presets.mjs packages/core/test/provider-presets.test.mjs
git commit -m "feat: mark codex oauth preset as high risk"
```

---

### Task 3: 对齐 cc-switch/Hermes 的 Codex OAuth 请求方式

**Files:**
- Modify: `packages/core/src/upstream/clients.mjs`
- Modify: `packages/core/src/upstream/dispatch.mjs`
- Test: `packages/core/test/upstream-auth.test.mjs`
- Test: `packages/core/test/dispatch.test.mjs`

- [ ] **Step 1: 扩展 Codex OAuth header 测试**

在 `packages/core/test/upstream-auth.test.mjs` 的 `codex oauth auth · reads ~/.codex/auth.json and builds Codex headers` 测试中追加断言：

```js
assert.equal(headers.originator, "codex_cli_rs");
assert.match(headers["User-Agent"], /^codex_cli_rs\/0\.0\.0/);
assert.equal(headers["OpenAI-Beta"], "responses=experimental");
assert.equal(headers["chatgpt-account-id"], "acct_123");
```

再新增测试：

```js
test("codex oauth auth · provider is ready only when codex login token exists", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-codex-ready-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const mod = await import(`../src/upstream/clients.mjs?v=${Date.now()}`);
    const provider = { id: "codex", authMode: "codex_oauth", providerType: "codex_oauth", baseUrl: "https://chatgpt.com/backend-api/codex" };
    assert.equal(mod.providerReady(provider), false);
    fs.mkdirSync(path.join(tmpHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: fakeJwt({}) } }), "utf8");
    assert.equal(mod.providerReady(provider), true);
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 增加 Codex OAuth Responses body 测试**

在 `packages/core/test/dispatch.test.mjs` 增加测试，使用本地 upstream 捕获请求：

```js
test("dispatchResponses → codex oauth forces ChatGPT Codex streaming request shape", async (t) => {
  let received = null;
  let headers = null;
  const up = await spawnUpstream((req, res, body) => {
    headers = req.headers;
    received = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"ok"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_1","output":[]}}',
      '',
      ''
    ].join("\n"));
  });
  t.after(() => close(up));
  const provider = {
    id: "codex",
    authMode: "codex_oauth",
    providerType: "codex_oauth",
    apiFormat: "openai_responses",
    baseUrl: `http://127.0.0.1:${up.address().port}/backend-api/codex`
  };

  const result = await dispatchResponses(provider, "gpt-5.5", {
    model: "gpt-5.5",
    stream: false,
    max_output_tokens: 100,
    input: "ping"
  });

  assert.equal(result.kind, "json");
  assert.equal(received.model, "gpt-5.5");
  assert.equal(received.store, false);
  assert.equal(received.stream, true);
  assert.equal(received.instructions, "");
  assert.equal(Object.prototype.hasOwnProperty.call(received, "max_output_tokens"), false);
  assert.equal(headers.accept, "text/event-stream");
});
```

- [ ] **Step 3: 实现强制 Codex OAuth 请求形态**

在 `packages/core/src/upstream/clients.mjs` 确保 `codexOAuthHeaders(provider)` 返回：

```js
return {
  Authorization: `Bearer ${auth.accessToken}`,
  "OpenAI-Beta": "responses=experimental",
  originator: "codex_cli_rs",
  "User-Agent": "codex_cli_rs/0.0.0",
  ...(auth.accountId ? { "chatgpt-account-id": auth.accountId } : {})
};
```

在 `callOpenAIResponses()` 中保持 Codex OAuth 的连接策略：

```js
noKeepAlive: opts?.noKeepAlive ?? codexOAuth,
retryOnFetchError: opts?.retryOnFetchError ?? codexOAuth
```

- [ ] **Step 4: 实现非流式也走上游 SSE 聚合**

在 `packages/core/src/upstream/dispatch.mjs` 的 `dispatchResponses()` 中，把 Codex OAuth 分支改成：

```js
const codexOAuth = isCodexOAuthProvider(provider);
if (codexOAuth) {
  upstreamBody.store = false;
  upstreamBody.stream = true;
  if (!Object.prototype.hasOwnProperty.call(upstreamBody, "instructions")) upstreamBody.instructions = "";
  delete upstreamBody.max_output_tokens;
  Object.assign(upstreamBody, normalizeChatgptCodexResponsesBody(upstreamBody));
}
const upstream = await callOpenAIResponses(provider, upstreamBody, upstreamOptsWithOverrides);
if (responsesBody?.stream) return { kind: "stream", upstream, translate: "responses", requestOverrides: requestOverrideSummary(requestOverrides) };
if (!upstream.ok) return { kind: "error", status: upstream.status, payload: await readJsonResponse(upstream), requestOverrides: requestOverrideSummary(requestOverrides) };
if (codexOAuth) {
  const chatLike = await responsesStreamToChatResponse(upstream, upstreamModel);
  return { kind: "json", status: upstream.status, payload: applyInbound(chatLike, ctx), requestOverrides: requestOverrideSummary(requestOverrides) };
}
```

这与 cc-switch 的“客户端非流式、上游仍强制流式并聚合”一致，也与 Hermes 对 ChatGPT Codex backend 的流式处理方式对齐。

- [ ] **Step 5: 运行相关测试**

Run:

```bash
npm test -- packages/core/test/upstream-auth.test.mjs packages/core/test/dispatch.test.mjs
```

Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/upstream/clients.mjs packages/core/src/upstream/dispatch.mjs packages/core/test/upstream-auth.test.mjs packages/core/test/dispatch.test.mjs
git commit -m "fix: align codex oauth proxy requests with codex clients"
```

---

### Task 4: 页面展示 Codex OAuth 官方代理风险提示

**Files:**
- Modify: `apps/desktop/renderer/index.html`
- Modify: `apps/desktop/renderer/renderer.js`
- Modify: `apps/desktop/renderer/styles.css`

- [ ] **Step 1: 在供应商弹窗增加风险提示容器**

在 `apps/desktop/renderer/index.html` 的 provider form 中，放在认证模式说明 `provider-auth-note` 附近，追加：

```html
<div class="risk-callout hidden" id="provider-risk-note"></div>
```

如果 `provider-auth-note` 附近已有通用提示区，就复用现有位置，确保 `id="provider-risk-note"` 唯一。

- [ ] **Step 2: 增加风险提示渲染函数**

在 `apps/desktop/renderer/renderer.js` 的 `syncProviderAuthControls()` 前追加：

```js
function providerHasCodexOauthRisk(provider, preset, authMode) {
  return authMode === "codex_oauth" || preset?.id === "codex-oauth" || provider?.authMode === "codex_oauth";
}

function syncProviderRiskNote(provider = null) {
  const note = document.getElementById("provider-risk-note");
  if (!note) return;
  const preset = providerPresetById(document.getElementById("provider-preset-select")?.value) || providerPresetById(provider?.presetId);
  const authMode = document.getElementById("provider-auth-mode")?.value || provider?.authMode || "api_key";
  const risky = providerHasCodexOauthRisk(provider, preset, authMode);
  note.classList.toggle("hidden", !risky);
  if (!risky) {
    note.textContent = "";
    return;
  }
  note.textContent = preset?.riskNote || "高风险：该官方 Codex OAuth 代理方式会通过本地网关复用官方登录态，官方文档提示可能带来账号限制风险。推荐使用官方直连。";
}
```

- [ ] **Step 3: 在弹窗打开和认证切换时同步提示**

在 `openProviderDialog(editId)` 里，`renderAuthModeOptions(...)` 之后调用：

```js
syncProviderRiskNote(existing);
```

把认证模式 change handler 从：

```js
document.getElementById("provider-auth-mode").addEventListener("change", syncProviderAuthControls);
```

改为：

```js
document.getElementById("provider-auth-mode").addEventListener("change", () => {
  syncProviderAuthControls();
  syncProviderRiskNote(state.config.providers.find((p) => p.id === document.getElementById("provider-form")._editId) || null);
});
```

在 provider preset change handler 中 `refreshProviderCompatRecommendations()` 前追加：

```js
syncProviderRiskNote(state.config.providers.find((p) => p.id === document.getElementById("provider-form")._editId) || null);
```

- [ ] **Step 4: 新增和编辑高风险供应商时都显示提示**

`state.providerPresets` 应包含 `codex-oauth`。新增供应商时选择 `OpenAI Codex（OAuth）` 后，`syncProviderRiskNote(null)` 必须立即展示风险提示；编辑已有 `presetId === "codex-oauth"` 或 `authMode === "codex_oauth"` 的 provider 时，`syncProviderRiskNote(existing)` 也必须展示风险提示。

验收条件：下拉展示 `OpenAI Codex（OAuth）`，选中后立即出现高风险提示；编辑旧的 `codex` provider 也能看到同样提示。

- [ ] **Step 5: 样式补齐**

在 `apps/desktop/renderer/styles.css` 追加：

```css
.risk-callout {
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.1);
  color: var(--text);
  border-radius: 8px;
  padding: 10px;
  font-size: 12px;
  line-height: 1.5;
}

.risk-callout.hidden {
  display: none;
}
```

- [ ] **Step 6: 语法检查**

Run:

```bash
node --check apps/desktop/renderer/renderer.js
```

Expected: no output, exit 0。

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/renderer/index.html apps/desktop/renderer/renderer.js apps/desktop/renderer/styles.css
git commit -m "feat: warn on codex oauth proxy provider risk"
```

---

### Task 5: 桌面主进程支持 Codex 模式切换

**Files:**
- Modify: `apps/desktop/src/main.mjs`

- [ ] **Step 1: 引入模式常量**

把 `apps/desktop/src/main.mjs` 中 profile writer import 改成包含 `CODEX_ACCESS_MODES`：

```js
import {
  applyProfile, restoreProfile,
  profileTargets, listBackups,
  previewCodexProfile, previewClaudeCodeProfile, previewHermesProfile,
  syncClientModelArtifacts,
  CODEX_ACCESS_MODES
} from "../../../packages/core/src/profile-writer.mjs";
```

- [ ] **Step 2: 新增 mode 归一化函数**

在 `clientDefaultModel()` 后追加：

```js
function codexProfileMode(mode) {
  return mode === CODEX_ACCESS_MODES.OFFICIAL_DIRECT
    ? CODEX_ACCESS_MODES.OFFICIAL_DIRECT
    : CODEX_ACCESS_MODES.SWITCHYARD_PROXY;
}
```

- [ ] **Step 3: 改造 `profile:apply`**

把 handler 签名从：

```js
ipcMain.handle("profile:apply", async (_e, { clientId }) => {
```

改为：

```js
ipcMain.handle("profile:apply", async (_e, { clientId, mode } = {}) => {
```

在读取 gateway status 后增加：

```js
  const profileMode = clientId === "codex" ? codexProfileMode(mode) : undefined;
  if (!status.running && profileMode !== CODEX_ACCESS_MODES.OFFICIAL_DIRECT) throw new Error("Gateway not running");
```

删除原来的 `if (!status.running) throw new Error("Gateway not running");`。

在 `opts` 里增加：

```js
    mode: profileMode,
```

把同步条件改成：

```js
  if (clientId === "codex" && profileMode !== CODEX_ACCESS_MODES.OFFICIAL_DIRECT) syncCodexArtifacts("profile-apply");
```

日志对象增加：

```js
    mode: profileMode || null,
```

- [ ] **Step 4: 改造 `profile:preview`**

把 handler 签名从：

```js
ipcMain.handle("profile:preview", (_e, { clientId }) => {
```

改为：

```js
ipcMain.handle("profile:preview", (_e, { clientId, mode } = {}) => {
```

在 `opts` 里增加：

```js
    mode: clientId === "codex" ? codexProfileMode(mode) : undefined,
```

- [ ] **Step 5: 语法检查**

Run:

```bash
node --check apps/desktop/src/main.mjs
```

Expected: no output, exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main.mjs
git commit -m "feat: support codex profile access modes in desktop ipc"
```

---

### Task 6: 桌面端展示官方直连和三方代理两套操作

**Files:**
- Modify: `apps/desktop/renderer/renderer.js`
- Modify: `apps/desktop/renderer/styles.css`

- [ ] **Step 1: 增加前端模式常量**

在 `PROFILE_META` 前追加：

```js
const CODEX_PROFILE_MODES = {
  OFFICIAL_DIRECT: "official_direct",
  SWITCHYARD_PROXY: "switchyard_proxy"
};
```

- [ ] **Step 2: 更新 Codex profile 说明**

把 `PROFILE_META.codex.note` 改为：

```js
note: "可选择官方直连或 Switchyard 三方代理。三方代理写入 model_provider = custom；官方直连会移除 Switchyard 管理块，认证交给 Codex App/CLI。"
```

- [ ] **Step 3: 为 Codex 卡片增加模式按钮**

在 `renderClients()` 中 `historyActions` 后追加：

```js
    const codexModeActions = id === "codex" ? `
      <div class="codex-mode-box">
        <div class="client-section-label">Codex 接入模式</div>
        <div class="codex-mode-actions">
          <button class="btn" data-profile-preview-mode="official_direct">预览官方直连</button>
          <button class="btn primary" data-profile-apply-mode="official_direct">切到官方直连</button>
          <button class="btn" data-profile-preview-mode="switchyard_proxy">预览三方代理</button>
          <button class="btn primary" data-profile-apply-mode="switchyard_proxy">切到三方代理</button>
        </div>
        <p class="client-help">官方直连不经过 Switchyard，不读取官方 token；请使用 Codex App 官方登录或 codex login 完成认证。三方代理保留 custom 会话分组和 Switchyard 模型列表。</p>
      </div>
    ` : "";
```

在卡片 body 的 `${mappingHtml}` 和 `${actionsHtml}` 之间插入：

```js
        ${codexModeActions}
```

- [ ] **Step 4: 绑定模式按钮事件**

在 `renderClients()` 的事件绑定区追加：

```js
  grid.querySelectorAll("[data-profile-preview-mode]").forEach((b) => b.addEventListener("click", () => profilePreview("codex", b.dataset.profilePreviewMode)));
  grid.querySelectorAll("[data-profile-apply-mode]").forEach((b) => b.addEventListener("click", () => profileApply("codex", b.dataset.profileApplyMode)));
```

- [ ] **Step 5: 让 profilePreview/profileApply 透传 mode**

把函数签名改为：

```js
async function profilePreview(clientId, mode) {
```

把调用改为：

```js
const { text, path } = await invoke("profile:preview", { clientId, mode });
```

标题改为：

```js
const modeLabel = mode === CODEX_PROFILE_MODES.OFFICIAL_DIRECT ? "官方直连" : mode === CODEX_PROFILE_MODES.SWITCHYARD_PROXY ? "三方代理" : "";
document.getElementById("profile-dialog-title").textContent = `预览 · ${PROFILE_META[clientId]?.label || clientId}${modeLabel ? ` · ${modeLabel}` : ""}`;
```

把 `profileApply` 签名改为：

```js
async function profileApply(clientId, mode) {
```

把调用改为：

```js
const r = await invoke("profile:apply", { clientId, mode });
```

toast 里增加官方直连提示：

```js
const direct = r.mode === CODEX_PROFILE_MODES.OFFICIAL_DIRECT ? "；已切到官方直连，请确认 Codex App/CLI 已登录" : "";
toast(`已写入 ${r.path}${r.backup ? "（已备份）" : ""}${catalog}${modelCount}${ccSwitch}${direct}`);
```

- [ ] **Step 6: 样式补齐**

在 `apps/desktop/renderer/styles.css` 追加：

```css
.codex-mode-box {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  margin-top: 10px;
  background: rgba(255, 255, 255, 0.03);
}

.codex-mode-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
```

- [ ] **Step 7: 语法检查**

Run:

```bash
node --check apps/desktop/renderer/renderer.js
```

Expected: no output, exit 0。

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/renderer/renderer.js apps/desktop/renderer/styles.css
git commit -m "feat: expose codex direct and proxy modes in desktop"
```

---

### Task 7: 全量验证与手工验收

**Files:**
- Verify only

- [ ] **Step 1: 跑核心测试**

Run:

```bash
npm test -- packages/core/test/profile-writer.test.mjs packages/core/test/provider-presets.test.mjs
```

Expected: PASS。

- [ ] **Step 2: 跑全量测试**

Run:

```bash
npm test
```

Expected: PASS。如果有和当前 dirty worktree 里既有改动相关的失败，记录失败测试名、错误摘要和是否与本计划改动相关。

- [ ] **Step 3: 跑静态检查**

Run:

```bash
npm run check
```

Expected: PASS。

- [ ] **Step 4: 手工验证官方直连 preview**

Run:

```bash
node --input-type=module -e 'import { previewCodexProfile, CODEX_ACCESS_MODES } from "./packages/core/src/profile-writer.mjs"; console.log(previewCodexProfile({ mode: CODEX_ACCESS_MODES.OFFICIAL_DIRECT }))'
```

Expected: 输出中不包含 `127.0.0.1:17888`、`model_provider = "custom"`、`model_catalog_json`、`[model_providers.custom]`。

- [ ] **Step 5: 手工验证代理 preview**

Run:

```bash
node --input-type=module -e 'import { previewCodexProfile, CODEX_ACCESS_MODES } from "./packages/core/src/profile-writer.mjs"; console.log(previewCodexProfile({ mode: CODEX_ACCESS_MODES.SWITCHYARD_PROXY, host: "127.0.0.1", port: 17888, defaultModel: "deepseek/deepseek-v4-pro" }))'
```

Expected: 输出包含 `model_provider = "custom"`、`base_url = "http://127.0.0.1:17888/codex/v1"`、`request_max_retries = 5`、`stream_max_retries = 5`。

- [ ] **Step 6: 启动桌面端验收 UI**

Run:

```bash
npm run desktop:dev
```

Expected:
- Codex 客户端卡片出现“官方直连”和“三方代理”两套按钮。
- 新增供应商下拉列表出现 `OpenAI Codex（OAuth）`，并且该选项或选中后的表单显著标记高风险/实验。
- 新增或编辑 `presetId = codex-oauth` / `authMode = codex_oauth` 的供应商时出现高风险提示，文案明确说明官方文档提示该方式可能带来账号限制风险。
- 点击“预览官方直连”时预览内容不包含本地 Switchyard base_url。
- 点击“预览三方代理”时预览内容仍包含 `custom` 和 `/codex/v1`。

---

## 认证实现说明

- 官方直连不需要 Switchyard 自己做认证。切换到官方直连后，Codex App/CLI 按官方逻辑读取自己的登录态；用户未登录时，应在 Codex App 内登录或执行 `codex login`。
- Switchyard 不读取、复制或刷新 `~/.codex/auth.json`，也不生成 Codex 官方 OAuth 请求头。这样避免把官方账号请求伪装成 Codex CLI 代理流量。
- 三方代理继续使用 Switchyard 的供应商认证：API Key、Keychain、本机 none 模式都保留；这些只用于三方 provider。
- cc-switch/Hermes-style 官方代理适配作为可见但高风险的新增供应商选项保留；UI 必须展示高风险提示，后端必须使用 Codex OAuth 专用请求方式，而不是普通 OpenAI-compatible。
- 如果未来要进一步弱化风险，可以把创建入口放入高级折叠区或二次确认，但本计划按用户要求在新增供应商入口展示 `OpenAI Codex（OAuth）`。

## 风险与回滚

- 官方直连可能让 `custom` 分组下的历史会话暂时不可见，这是 Codex 按 `model_provider` 分组的结果，不是数据删除。回到三方代理或执行历史统一功能后可恢复到 `custom` 视图。
- 官方直连清理只删除 Switchyard 管理的顶层字段和 `[model_providers.custom]` 管理块，不删除 `[mcp]` 等用户自定义配置。
- 所有写入继续走 `writeText()`，会在 `~/.switchyard/backups/` 创建备份；需要回滚时可用现有“恢复备份”。

## Self-Review

- Spec coverage: 已覆盖“新增供应商入口展示 OpenAI Codex OAuth”、“采用 cc-switch/Hermes 请求方式”、“页面显著标注风险”、“官方直连不是代理”、“直连认证怎么做”、“三方代理继续支持 custom 会话与模型列表”。
- Placeholder scan: 没有未填充占位内容；每个任务都有文件、命令和预期结果。
- Type consistency: 统一使用 `official_direct` / `switchyard_proxy`，前端常量和核心 `CODEX_ACCESS_MODES` 值一致。

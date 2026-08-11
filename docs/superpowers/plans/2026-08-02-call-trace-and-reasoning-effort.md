# 调用可视化方案 A + 思考档位对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面「调用可视化」按方案 A 一眼展示请求参数与「请求→上游」思考档映射，并用可覆盖的能力表对齐全量供应商预设与 Codex/GPT-5.6 档位。

**Architecture:** 新增 `reasoning-effort-catalog.mjs` 负责逻辑档枚举、钳制、wire 映射与 trace；`reasoning-options` 改为优先读 catalog；`summarizeRequest` 写入 `reasoningEffortTrace`；桌面 Trace Tab 改为左列表 + 右「参数条 + Tab(时间线|原始 JSON)」；Codex 模型目录按模型族补齐 `max`（及条件 `ultra`）。

**Tech Stack:** Node.js ESM、现有 compat patch 体系、Electron 桌面 `renderer.js`/`index.html`/`styles.css`、`node --test`。

**Spec:** `docs/superpowers/specs/2026-08-02-call-trace-and-reasoning-effort-design.md`

---

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/core/src/reasoning-effort-catalog.mjs` | 逻辑档、preset 能力表、resolve/clamp/map/apply/trace |
| `packages/core/test/reasoning-effort-catalog.test.mjs` | catalog 单测 |
| `packages/core/src/compat/patches/reasoning-options.mjs` | 出站时优先走 catalog.apply |
| `packages/core/src/server.mjs` | `summarizeRequest` 增加 `reasoningEffortTrace` |
| `packages/core/src/provider-presets.mjs` | 每个 preset 挂 `reasoningEffort` 或复用 catalog 默认 |
| `packages/core/src/profile-writer.mjs` | Codex 目录 supported/default effort |
| `apps/desktop/src/mobile-control/codex-runtime.mjs` | 手机 effortOptions 按模型 |
| `apps/desktop/renderer/index.html` | Trace 面板 DOM 改为方案 A |
| `apps/desktop/renderer/styles.css` | 参数条 / Tab 样式 |
| `apps/desktop/renderer/renderer.js` | 参数条渲染、详情 Tab、去掉双卡 |
| `packages/core/test/compat.test.mjs` | 回归 DeepSeek/OpenRouter 映射 |
| `packages/core/test/workspace-manifests.test.mjs` | 若新增文件需进清单则更新 |

---

### Task 1: reasoning-effort-catalog 核心（TDD）

**Files:**
- Create: `packages/core/src/reasoning-effort-catalog.mjs`
- Create: `packages/core/test/reasoning-effort-catalog.test.mjs`

- [ ] **Step 1: 写失败单测**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  EFFORT_ORDER,
  clampEffort,
  mapEffortForWire,
  resolveReasoningCapability,
  buildReasoningEffortTrace,
  applyReasoningEffortCatalog
} from "../src/reasoning-effort-catalog.mjs";

test("EFFORT_ORDER is stable low-to-high", () => {
  assert.deepEqual(EFFORT_ORDER, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("clampEffort picks nearest supported", () => {
  assert.equal(clampEffort("xhigh", ["low", "medium", "high"]), "high");
  assert.equal(clampEffort("none", ["low", "medium", "high"]), "low");
  assert.equal(clampEffort("ultra", ["low", "medium", "high", "xhigh", "max"], { allowUltra: false }), "max");
});

test("deepseek mapEffortForWire", () => {
  assert.deepEqual(mapEffortForWire("none", { effortValueMode: "deepseek" }), {
    enabled: false,
    wireParam: "reasoning_effort",
    wireValue: null,
    thinking: { type: "disabled" }
  });
  assert.equal(mapEffortForWire("medium", { effortValueMode: "deepseek" }).wireValue, "high");
  assert.equal(mapEffortForWire("xhigh", { effortValueMode: "deepseek" }).wireValue, "high");
  assert.equal(mapEffortForWire("max", { effortValueMode: "deepseek" }).wireValue, "max");
});

test("resolveReasoningCapability prefers model override then preset", () => {
  const cap = resolveReasoningCapability({
    provider: { id: "deepseek", presetId: "deepseek" },
    model: {
      id: "deepseek/v4",
      reasoningEffort: {
        supportedEfforts: ["high", "max"],
        defaultEffort: "high",
        wire: { effortParam: "reasoning_effort", thinkingParam: "thinking", effortValueMode: "deepseek" }
      }
    }
  });
  assert.deepEqual(cap.supportedEfforts, ["high", "max"]);
});

test("applyReasoningEffortCatalog writes body and trace", () => {
  const { body, trace } = applyReasoningEffortCatalog(
    { messages: [], reasoning: { effort: "xhigh", summary: "detailed" } },
    {
      provider: { id: "deepseek", presetId: "deepseek", apiFormat: "openai_chat", baseUrl: "https://api.deepseek.com" },
      model: { id: "deepseek/deepseek-v4-flash", upstreamModel: "deepseek-v4-flash" }
    }
  );
  assert.equal(body.thinking?.type, "enabled");
  assert.equal(body.reasoning_effort, "high");
  assert.equal(trace.requested, "xhigh");
  assert.equal(trace.mapped, "high");
  assert.equal(trace.clamped, true);
  assert.equal(trace.wireValue, "high");
});
```

- [ ] **Step 2: 跑测确认失败**

```bash
node --test packages/core/test/reasoning-effort-catalog.test.mjs
```

Expected: FAIL（模块不存在或导出缺失）

- [ ] **Step 3: 实现 catalog 最小可用面**

在 `packages/core/src/reasoning-effort-catalog.mjs` 实现：

- `EFFORT_ORDER`
- `normalizeEffortToken(value)`（小写；`extra_high`→`xhigh`；off 系→`none`）
- `clampEffort(requested, supported, { allowUltra })`
- `PRESET_REASONING_EFFORT`：先实现分组模板 + 下列 preset id 映射（其余在 Task 4 补齐，但 resolve 必须对未知 preset 有 apiFormat 回退）：
  - `passthroughResponses`: `codex-oauth`, `openai`, `codex-account-pool`, `sub2api-codex`
  - `deepseek`: `deepseek`
  - `openrouter`: `openrouter`
  - `anthropic`: `anthropic`, `anthropic-oauth`, `custom-anthropic`
  - `enableThinking`: `alibaba-bailian`, `siliconflow`
  - `thinkingObject`: `zai`, `zhipu-glm`, `kimi-coding`, `moonshot`, `xiaomi-mimo`, `xiaomi-mimo-token-plan`
  - `minimax`: `minimax`
  - `stepfun`: `stepfun`
  - `chatPassthrough`: `xai`, `xai-account-pool`, `opencode-go`, `groq`, `together`, `mistral`, `custom-openai`…
  - `unsupported` / adapter: `ollama`, `lm-studio`, `cursor-subscription`, `antigravity-*`（标注 mode，apply 时可 no-op 并 trace.providerMode=`adapter`/`unsupported`）
- `resolveReasoningCapability(ctx)`
- `mapEffortForWire(effort, wireConfig)`
- `buildReasoningEffortTrace(...)`
- `applyReasoningEffortCatalog(body, ctx)`：仅当 body 显式带 `reasoning` / `reasoning_effort` 时改写；返回 `{ body, trace }`；把 trace 挂到 `body._switchyardReasoningEffortTrace`（内部字段，dispatch 已有 stripInternal 习惯则一并剥离出站）

`effortValueMode` 行为（必须写进实现）：

| mode | enabled=false | enabled=true |
|---|---|---|
| `passthrough` | `reasoning.effort=none` 或剥离 | 保留/写入 `reasoning.effort`（及 summary） |
| `deepseek` | `thinking.disabled`，删 effort | `thinking.enabled` + `reasoning_effort` in {low,high,max}；medium/xhigh→high |
| `openrouter` | `reasoning.effort=none` | `reasoning.effort`；max 可保留或按 openrouter 规则 |
| `low_high` | 关 thinking（若有） | effort low/high |
| `on_off` | thinkingParam=false/disabled | thinkingParam=true/enabled；无多档 wireValue |
| `anthropic` | 不写 output_config 或 effort 省略 | 由 anthropic adapter 路径消费；catalog 仍产出 trace.mapped |

- [ ] **Step 4: 跑测通过**

```bash
node --test packages/core/test/reasoning-effort-catalog.test.mjs
```

Expected: PASS

- [ ] **Step 5: Commit**（仅在用户要求提交时执行）

```bash
git add packages/core/src/reasoning-effort-catalog.mjs packages/core/test/reasoning-effort-catalog.test.mjs
git commit -m "$(cat <<'EOF'
feat: add reasoning effort capability catalog

EOF
)"
```

---

### Task 2: 出站 patch + request_summary trace

**Files:**
- Modify: `packages/core/src/compat/patches/reasoning-options.mjs`
- Modify: `packages/core/src/server.mjs`（`summarizeRequest` 附近约 442–482 行）
- Modify: `packages/core/test/compat.test.mjs`
- Create or Modify: 若需要单独测摘要，可加 `packages/core/test/request-summary-reasoning.test.mjs`（优先导出 `summarizeRequest` 困难则通过 `applyOutbound` + 手工调用 catalog.buildTrace 测）

- [ ] **Step 1: 扩展 compat 回归测**

在 `compat.test.mjs` 增加：

```js
test("reasoning-options uses catalog clamp for deepseek xhigh→high", () => {
  resetPatches();
  registerBuiltinPatches();
  const out = applyOutbound(
    { messages: [{ role: "user", content: "hi" }], reasoning: { effort: "xhigh" } },
    {
      provider: { id: "deepseek", presetId: "deepseek", apiFormat: "openai_chat", baseUrl: "https://api.deepseek.com/v1" },
      model: { id: "deepseek/deepseek-v4-flash", providerId: "deepseek", upstreamModel: "deepseek-v4-flash" },
      clientId: "codex"
    }
  );
  assert.equal(out.reasoning_effort, "high");
  assert.equal(out._switchyardReasoningEffortTrace?.requested, "xhigh");
  assert.equal(out._switchyardReasoningEffortTrace?.clamped, true);
  resetPatches();
});
```

- [ ] **Step 2: 跑测确认新断言失败或旧行为不符**

```bash
node --test packages/core/test/compat.test.mjs
```

- [ ] **Step 3: 改 `reasoning-options.mjs` outbound**

伪代码：

```js
import { applyReasoningEffortCatalog, resolveReasoningCapability } from "../../reasoning-effort-catalog.mjs";

outbound(body, ctx) {
  const request = requestedReasoning(body);
  if (!request.explicit) return body;
  const capability = resolveReasoningCapability(ctx);
  if (capability?.wire?.effortValueMode) {
    const { body: next, trace } = applyReasoningEffortCatalog(body, ctx);
    return { ...next, _switchyardReasoningEffortTrace: trace };
  }
  // 保留原启发式作为 fallback
  ...
}
```

- [ ] **Step 4: 改 `summarizeRequest`**

在返回对象中增加：

```js
reasoningEffortTrace: chatBody._switchyardReasoningEffortTrace || buildTraceFromParams(chatBody, route) || null,
params: {
  ...existing,
  reasoning: chatBody.reasoning,
  reasoningEffort: ...,
}
```

若 `applyOutbound` 发生在 `summarizeRequest` **之后**，则在写 `record.requestSummary` 的路径上，于 outbound 完成后把 `reasoningEffortTrace` merge 进 `record.requestSummary`（在 `server.mjs` 找到 outbound 完成后的 record 更新点；没有则在 dispatch 返回前由调用方写入）。实现时以「最终落库 summary 含 trace」为准，必要时在 outbound 后：

```js
if (!record.requestSummary) record.requestSummary = {};
record.requestSummary.reasoningEffortTrace = outboundBody._switchyardReasoningEffortTrace || record.requestSummary.reasoningEffortTrace;
```

- [ ] **Step 5: 跑回归**

```bash
node --test packages/core/test/compat.test.mjs packages/core/test/reasoning-effort-catalog.test.mjs
```

Expected: PASS

- [ ] **Step 6: Commit**（用户要求时）

```bash
git commit -m "$(cat <<'EOF'
feat: wire reasoning effort catalog into outbound and request summary

EOF
)"
```

---

### Task 3: 桌面调用可视化方案 A

**Files:**
- Modify: `apps/desktop/renderer/index.html`（`#panel-traces`，约 540–575 行）
- Modify: `apps/desktop/renderer/styles.css`
- Modify: `apps/desktop/renderer/renderer.js`（`refreshTraces` / `renderRequestTrace` / `renderLiveLogs` / `structuredSummaryHtml`）
- Modify: `packages/core/test/` 中若有 DOM 结构断言则更新；否则在 `workspace-manifests` 无需改 HTML 路径

- [ ] **Step 1: 改 HTML 结构为方案 A**

将 `#panel-traces` 右侧从「实时调用 + 历史时间线」双卡改为单卡：

```html
<div class="trace-detail-stack">
  <div class="card trace-detail-card">
    <div class="hd">
      <h3 id="trace-title">请求详情</h3>
      <span class="sub" id="trace-subtitle">选择左侧对象</span>
      <button class="btn" id="btn-trace-copy-params" style="display:none;">复制 params</button>
      <button class="btn" id="btn-trace-issue-bundle" style="display:none;">复制问题包</button>
      <button class="btn" id="btn-trace-issue-export" style="display:none;">导出问题包</button>
      <button class="btn" id="btn-trace-replay" style="display:none;">草稿回放到测试台</button>
    </div>
    <div class="bd">
      <div id="trace-params-bar" class="trace-params-bar"></div>
      <div class="trace-tabs" id="trace-tabs" style="display:none;">
        <button type="button" class="trace-tab on" data-trace-tab="timeline">时间线</button>
        <button type="button" class="trace-tab" data-trace-tab="raw">原始 JSON</button>
      </div>
      <div id="trace-timeline" class="trace-timeline"></div>
      <pre id="trace-raw" class="trace-raw" style="display:none;"></pre>
    </div>
  </div>
</div>
```

删除 `#structured-logs` / `#live-log-summary` 所在卡片（或隐藏）。

- [ ] **Step 2: 加 CSS**

```css
.trace-params-bar {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  padding: 10px 0 12px; border-bottom: 1px solid var(--border); margin-bottom: 8px;
  position: sticky; top: 0; background: var(--panel); z-index: 1;
}
.trace-params-bar:empty { display: none; }
.trace-tabs { display: flex; gap: 4px; margin: 8px 0; }
.trace-tab {
  border: 1px solid var(--border); background: var(--surface-muted);
  border-radius: 10px; padding: 6px 12px; font: inherit; cursor: pointer; color: var(--text-muted);
}
.trace-tab.on { background: var(--panel); color: var(--text); border-color: var(--border-strong); }
.trace-raw {
  margin: 0; padding: 12px; border-radius: 12px; background: var(--surface-muted);
  font-family: var(--code); font-size: 12px; white-space: pre-wrap; word-break: break-word;
  max-height: 60vh; overflow: auto;
}
.chip.map-warn { background: var(--warn-soft); color: var(--warn); }
```

- [ ] **Step 3: 实现参数条与 Tab 逻辑**

在 `renderer.js` 增加：

```js
function reasoningEffortChips(request, entry) {
  const trace = request?.reasoningEffortTrace;
  const requested = trace?.requested ?? request?.params?.reasoningEffort;
  const wire = trace?.wireValue ?? requested;
  if (requested == null && wire == null) return ['<span class="chip">effort 未指定</span>'];
  const clamped = Boolean(trace?.clamped) || (requested != null && wire != null && String(requested) !== String(wire));
  const cls = clamped ? "chip map-warn" : "chip key";
  return [
    `<span class="${cls}">effort 请求 ${escapeHtml(requested ?? "-")} → 上游 ${escapeHtml(wire ?? "-")}</span>`,
    trace?.wireParam ? `<span class="chip">${escapeHtml(trace.wireParam)}</span>` : ""
  ].filter(Boolean);
}

function renderTraceParamsBar(entry, request) {
  const host = document.getElementById("trace-params-bar");
  if (!host) return;
  const chips = [
    ...reasoningEffortChips(request, entry),
    entry?.model_id || entry?.modelId ? `<span class="chip mono">${escapeHtml(entry.model_id || entry.modelId)}</span>` : "",
    entry?.provider_id || entry?.providerId ? `<span class="chip">${escapeHtml(entry.provider_id || entry.providerId)}</span>` : "",
    request?.params?.stream != null ? `<span class="chip">stream ${request.params.stream ? "true" : "false"}</span>` : "",
    request?.params?.toolChoice != null ? `<span class="chip">tool_choice ${escapeHtml(typeof request.params.toolChoice === "string" ? request.params.toolChoice : JSON.stringify(request.params.toolChoice).slice(0, 40))}</span>` : ""
  ].filter(Boolean);
  host.innerHTML = chips.join("") || "";
}

function copyTraceParams(row) {
  const request = parseSummary(row.request_summary || row.requestSummary);
  const payload = {
    params: request?.params || null,
    reasoningEffortTrace: request?.reasoningEffortTrace || null,
    modelId: row.model_id || row.modelId,
    providerId: row.provider_id || row.providerId,
    upstreamModel: row.upstream_model || row.upstreamModel
  };
  return navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
}
```

- 改 `renderRequestTrace`：先 `renderTraceParamsBar`，再 timeline；填充 `#trace-raw` 为 `JSON.stringify({ request, response }, null, 2)`；显示 tabs 与复制按钮。
- Tab 切换只改 `#trace-timeline` / `#trace-raw` display，并切换 `.on`。
- `renderLiveLogs`：改为「有新 requestLog 时 `refreshTraces()` 并自动 `openTraceItem` 最新请求」，删除对 `#structured-logs` 的大段 HTML 渲染（若元素已删则 no-op）。
- `structuredSummaryHtml` 的「模型参数」继续展示 reasoning 字段（已有），并增加 effort trace 一行（若有）。

- [ ] **Step 4: 手动/结构验证**

```bash
# 若有 renderer 结构测试则跑；否则目视：
# 1) 打开桌面 → 调用可视化
# 2) 左侧点一条请求，顶部应见 effort chip
# 3) 切换「原始 JSON」可见 request_summary
# 4) 「复制 params」剪贴板含 reasoningEffortTrace（有数据时）
rg -n "structured-logs|trace-params-bar|data-trace-tab" apps/desktop/renderer
```

Expected: 无对已删 `#structured-logs` 的必要依赖；新 id 存在。

- [ ] **Step 5: Commit**（用户要求时）

```bash
git commit -m "$(cat <<'EOF'
feat(desktop): call trace UI with sticky params bar (option A)

EOF
)"
```

---

### Task 4: 全量 preset 挂载 + Codex/手机目录

**Files:**
- Modify: `packages/core/src/reasoning-effort-catalog.mjs`（补齐所有 `PROVIDER_PRESETS` id）
- Modify: `packages/core/src/provider-presets.mjs`（可选：preset 上挂 `reasoningEffort` 引用，避免双源；优先 catalog 单源）
- Modify: `packages/core/src/profile-writer.mjs`（`codexCatalogModelFrom` / `CODEX_MODEL_TEMPLATE`）
- Modify: `apps/desktop/src/mobile-control/codex-runtime.mjs`（`effortOptions`）
- Modify: `packages/core/test/reasoning-effort-catalog.test.mjs`（断言每个 preset id 可 resolve）
- Modify: 相关 profile-writer / mobile 测试（若已有）

- [ ] **Step 1: 单测「每个 presetId 都能 resolve」**

```js
import { PROVIDER_PRESETS } from "../src/provider-presets.mjs";
import { resolveReasoningCapability } from "../src/reasoning-effort-catalog.mjs";

test("every provider preset resolves a reasoning capability", () => {
  for (const preset of PROVIDER_PRESETS) {
    const cap = resolveReasoningCapability({
      provider: { id: preset.providerId || preset.id, presetId: preset.id, apiFormat: preset.apiFormat, baseUrl: preset.baseUrl },
      model: { id: `${preset.id}/sample`, providerId: preset.providerId || preset.id }
    });
    assert.ok(cap, `missing capability for preset ${preset.id}`);
    assert.ok(cap.wire?.effortValueMode || cap.unsupported, preset.id);
  }
});
```

- [ ] **Step 2: 跑测失败则补 PRESET 表直到 PASS**

- [ ] **Step 3: Codex 目录档位**

在 `codexCatalogModelFrom` 中按 upstream/slug 选择 levels：

```js
function supportedReasoningLevelsForCodexModel(slug, upstreamModel, providerId) {
  const id = `${slug} ${upstreamModel}`.toLowerCase();
  const level = (effort, description) => ({ effort, description });
  const base = [
    level("low", "Fast responses with lighter reasoning"),
    level("medium", "Balances speed and reasoning depth"),
    level("high", "Greater reasoning depth"),
    level("xhigh", "Extra high reasoning depth")
  ];
  if (/gpt-5\.6-(sol|terra)/.test(id)) {
    return {
      default_reasoning_level: /sol/.test(id) ? "low" : "medium",
      supported_reasoning_levels: [
        ...base,
        level("max", "Maximum reasoning depth for the hardest problems"),
        level("ultra", "Codex-only orchestration tier; not a generic API effort")
      ]
    };
  }
  if (/gpt-5\.6-luna|gpt-5\.6\b/.test(id)) {
    return {
      default_reasoning_level: "medium",
      supported_reasoning_levels: [...base, level("max", "Maximum reasoning depth for the hardest problems")]
    };
  }
  return {
    default_reasoning_level: "medium",
    supported_reasoning_levels: base
  };
}
```

替换当前「官方 GPT 一律 default=low + 模板四档」的粗暴逻辑；非 GPT 保持模板或 capability 推导。

- [ ] **Step 4: 手机 effortOptions**

`codex-runtime.mjs` 中：

```js
effortOptions: effortOptionsForModel(selectedModelId) // 从 catalog/levels 推导，回退 ["low","medium","high","xhigh"]
```

- [ ] **Step 5: 跑测**

```bash
node --test packages/core/test/reasoning-effort-catalog.test.mjs packages/core/test/compat.test.mjs
# 若有 profile-writer / codex-mobile 测试：
node --test packages/core/test/codex-mobile-runtime.test.mjs
```

Expected: PASS

- [ ] **Step 6: Commit**（用户要求时）

```bash
git commit -m "$(cat <<'EOF'
feat: cover provider presets and align Codex reasoning levels

EOF
)"
```

---

### Task 5: 清理与验收清单

**Files:**
- Modify: `packages/core/src/compat/patches/reasoning-options.mjs`（启发式仅 fallback）
- Modify: `docs/COMPATIBILITY-ROADMAP.zh-CN.md` 或规格旁加「实现状态」一小节（仅当仓库已有同类惯例；否则跳过文档）
- Modify: `apps/desktop/src/issue-bundle.mjs`（问题包带上 `reasoningEffortTrace` 若尚未包含 request_summary 全文）

- [ ] **Step 1: 确认问题包已包含 request_summary**（多数已整包带上）；若有字段白名单则加入 `reasoningEffortTrace`
- [ ] **Step 2: 跑更宽回归**

```bash
node --test packages/core/test/compat.test.mjs packages/core/test/compat-fixtures.test.mjs packages/core/test/dispatch.test.mjs packages/core/test/reasoning-effort-catalog.test.mjs
```

Expected: PASS

- [ ] **Step 3: 手工验收清单打勾**

1. Codex → 官方 GPT：`high`/`medium` 参数条显示请求=上游  
2. DeepSeek：`xhigh` 显示请求 xhigh → 上游 high，且告警色  
3. 复制 params JSON 含 trace  
4. 时间线 / 原始 JSON Tab 切换正常  
5. 左侧新请求会刷新并可选中  

- [ ] **Step 4: Commit**（用户要求时）

```bash
git commit -m "$(cat <<'EOF'
chore: finalize reasoning effort trace cleanup and verification

EOF
)"
```

---

## Spec Coverage Check

| Spec 要求 | Task |
|---|---|
| 逻辑档 + 能力表 + clamp/map | Task 1 |
| request_summary.reasoningEffortTrace | Task 2 |
| reasoning-options 接入 catalog | Task 2 |
| 方案 A UI + 复制 params + 去双卡 | Task 3 |
| 全量 preset | Task 4 |
| Codex/手机目录 max/ultra | Task 4 |
| 验证与清理 | Task 5 |
| 不做 pro UI / 不做完整 raw HTTP | 明确不在任务中 |

## Placeholder Scan

无 TBD；`ultra`/`pro` 边界已写明；commit 步骤保留但执行时遵守「用户未要求不提交」。

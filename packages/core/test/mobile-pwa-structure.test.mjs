import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isAgentContextTag, notificationStateLabel, parseStructuredNotification, splitStructuredContent, stripAgentContext } from "../../../apps/mobile/structured-notification.mjs";

test("mobile PWA contains chat, create, approval and settings surfaces without provider secrets", () => {
  const root = path.resolve("apps/mobile");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  assert.match(html, /会话/);
  assert.match(html, /新对话/);
  assert.match(html, /审批/);
  assert.match(html, /我的/);
  assert.match(html, /id="model-select"/);
  assert.match(html, /id="new-attachment-input"[^>]*multiple/);
  assert.match(html, /id="new-attach-control"/);
  assert.match(html, /id="attachment-input"[^>]*multiple/);
  assert.match(html, /id="attachment-viewer"/);
  assert.match(html, /id="attachment-viewer-done"/);
  assert.match(html, /id="attachment-viewer-open"/);
  assert.match(html, /关闭预览/);
  assert.match(html, /id="session-approval-inbox"/);
  assert.match(html, /id="session-queue"/);
  assert.match(html, /id="goal-panel"/);
  assert.match(html, /id="session-switcher"/);
  assert.match(html, /id="open-session-switcher"/);
  assert.match(html, /id="continue-current-session"/);
  assert.match(html, /选择工作目录/);
  assert.match(html, /新建文件夹/);
  assert.match(html, /id="open-model-sheet" class="runtime-shortcut"/);
  assert.match(js, /\/mobile\/v1\/sessions/);
  assert.match(js, /\/mobile\/v1\/workspaces\/browse/);
  assert.match(js, /\/mobile\/v1\/workspaces\/directories/);
  assert.match(js, /renderRuntimeShortcut/);
  assert.match(js, /下一轮生效|将在下一轮生效/);
  assert.match(js, /rename|archive|fork/);
  assert.match(js, /connectEvents/);
  assert.match(js, /scheduleFinalReconcile/);
  assert.doesNotMatch(js, /detailSyncTimer|setInterval\(\(\)\s*=>\s*\{\s*if\s*\(current/);
  assert.match(js, /正在发送/);
  assert.match(js, /发送失败/);
  assert.match(js, /input\.blur\(\)/);
  assert.match(js, /scheduleStreamingRichText/);
  assert.match(js, /if \(streamingRenderTimers\.has\(node\)\) return/);
  assert.doesNotMatch(js, /body\.textContent = last\.dataset\.raw/);
  assert.match(js, /class="me /);
  assert.match(js, /class="ai /);
  assert.match(js, /class="think"/);
  assert.match(js, /<b>思考摘要<\/b>/);
  assert.match(js, /class="work-group status-/);
  assert.match(js, /class="\$\{rowClass\}/);
  assert.match(js, /function workHeadHtml/);
  assert.match(js, /function renderPlanCard/);
  assert.match(js, /function parseEditPatch/);
  assert.match(js, /function renderDiffCard/);
  assert.match(js, /isPlanToolMessage/);
  assert.match(js, /function renderSessionQueue/);
  assert.match(js, /function renderGoalPanel/);
  assert.match(css, /\.goal-card\{/);
  assert.match(js, /data-queue-edit/);
  assert.match(js, /data-queue-cancel/);
  assert.match(js, /data-queue-resume/);
  assert.match(js, /queue\/resume/);
  assert.match(js, /clearQueue/);
  assert.match(css, /\.session-queue\{/);
  assert.match(css, /\.chat-header\{position:fixed/);
  assert.match(css, /--chat-header-height/);
  assert.match(js, /toolActivitySummary/);
  assert.match(js, /检查 \$\{counts\.read\} 个文件/);
  assert.match(js, /\$\{counts\.search\} 次搜索/);
  assert.match(js, /运行 \$\{counts\.command\} 个命令/);
  assert.match(js, /function buildConversationTurns/);
  assert.match(js, /function groupWorkByPhase/);
  assert.match(js, /function summarizeWork/);
  assert.match(js, /class="conversation-turn/);
  assert.match(js, /\[data-tool-id="/);
  assert.match(js, /const rowClass = `tl/);
  assert.match(js, /<button class="work-head"/);
  assert.match(css, /\.tl-detail\{display:none/);
  assert.match(css, /\.work-items\{/);
  assert.match(css, /\.work-head\{/);
  assert.match(css, /\.tl-row\{/);
  assert.match(css, /\.term-cmd\{/);
  assert.match(css, /\.diff-head\{/);
  assert.match(css, /\.plan-card\{/);
  assert.match(css, /\.plan-progress-pill\{/);
  assert.match(js, /currentIndex \+ 1/);
  assert.match(js, /正在执行|计划已完成/);
  assert.match(css, /\.tl-state \.badge\{/);
  assert.match(js, /richTextCache/);
  assert.match(js, /instant: true/);
  assert.match(js, /workspace-group|group-head/);
  assert.match(js, /end_turn/);
  assert.match(js, /defaultModelId/);
  assert.match(js, /data-workspace-delete/);
  assert.ok(js.includes('/mobile/v1/workspaces/directories'));
  assert.match(js, /swipe-item/);
  assert.match(js, /data-session-action/);
  assert.match(js, /data-workspace-rename/);
  assert.match(js, /finalizeStreamingMessages/);
  assert.match(js, /data-retry/);
  assert.ok(js.includes('/mobile/v1/workspaces/directories/rename'));
  assert.match(css, /\.think\{[^}]*box-sizing:border-box[^}]*overflow:hidden/);
  assert.match(css, /\.think-body\{[^}]*min-width:0[^}]*max-width:100%[^}]*overflow-wrap:anywhere/);
  assert.match(css, /\.msg-body pre,.think-body pre\{[^}]*width:100%[^}]*box-sizing:border-box[^}]*overflow-x:auto/);
  assert.match(css, /\.msg-body code,.think-body code\{[^}]*overflow-wrap:anywhere/);

  assert.doesNotMatch(html, /<span>任务<\/span>/);
  assert.doesNotMatch(js, /finally\s*\{\s*\$\("#send"\)\.disabled\s*=\s*false;\s*input\.focus\(\)/);
  assert.match(js, /switchyard_mobile_event_cursor/);
  assert.match(js, /\/mobile\/v1\/approvals/);
  assert.match(js, /newAttachments/);
  assert.match(js, /renderMessageAttachments/);
  assert.match(js, /hydrateAttachmentPreviews/);
  assert.match(js, /\/mobile\/v1\/assets\//);
  assert.match(js, /data-attachment-open/);
  assert.match(js, /data-file-open/);
  assert.match(js, /data-decision="allow_once"/);
  assert.doesNotMatch(js, /必须回到桌面端确认/);
  assert.match(js, /\/mobile\/v1\/commands\?agent=/);
  assert.match(js, /function commandTrigger/);
  assert.match(js, /match\(\/\(\^\|\\s\)\(\[\/\$@\]\)/);
  assert.match(js, /trigger\.prefix === "@" \? item\.kind === "mention"/);
  assert.match(js, /agent === "codex" \? item\.kind === "command"/);
  assert.match(js, /function chooseCommand/);
  assert.match(js, /input\.setSelectionRange\(cursor, cursor\)/);
  assert.match(js, /commandPickerKeydown/);
  assert.match(html, /id="command-picker"/);
  assert.match(html, /id="message-mode-sheet"/);
  assert.match(html, /id="conversation-behavior-sheet"/);
  assert.match(html, /id="edit-pairing-link"/);
  assert.match(html, /更换配对链接/);
  assert.match(js, /nativePairingEditAvailable/);
  assert.match(js, /editPairingLink/);
  assert.match(html, /data-message-mode="guide"/);
  assert.match(html, /data-conversation-send-mode="ask"/);
  assert.match(js, /conversationSendMode/);
  assert.match(js, /PREFERENCES_KEY/);
  assert.match(js, /hasNativeTokenStore/);
  assert.match(js, /Android uses Keystore-backed storage/);
  assert.match(js, /isPreferencesEndpointUnavailable/);
  assert.match(js, /待桌面端升级后同步/);
  assert.match(js, /deliveryMode/);
  assert.match(js, /submitComposerMessage/);
  assert.match(css, /\.send-button\.is-stop/);
  assert.match(js, /function markdownTableCells/);
  assert.match(js, /const INTERNAL_UI_DIRECTIVE/);
  assert.match(js, /function stripInternalUiDirectives/);
  assert.match(js, /filter\(\(line\) => !INTERNAL_UI_DIRECTIVE\.test\(line\.trim\(\)\)\)/);
  assert.match(js, /const prose = stripInternalUiDirectives\(chunks\[i\] \|\| ""\)/);
  assert.match(html, /app\.js\?v=98/);
  assert.match(html, /styles\.css\?v=98/);
  assert.match(js, /data-open-approvals/);
  assert.match(js, /showApprovalSheet\(approval\.id\)/);
  assert.doesNotMatch(js, /#approval-inbox"\)\?\.scrollIntoView/);
  assert.match(js, /function pollEventBatch/);
  assert.match(js, /function syncLiveEventCursor/);
  assert.match(js, /scheduleRunningReconcile/);
  assert.match(js, /function resumeMobileConnection/);
  assert.match(js, /window\.SwitchyardResume/);
  assert.doesNotMatch(js, /controller\.abort\(\), 20_000\)/);
  assert.match(js, /status === "failed"\) return/);
  assert.match(js, /event\.messageId/);
  assert.match(js, /duplicateByText/);
  assert.match(fs.readFileSync(path.join(root, "..", "desktop", "src", "mobile-control", "dto.mjs"), "utf8"), /messageId: cleanMobileText\(event\.messageId/);
  assert.match(fs.readFileSync(path.join(root, "..", "desktop", "src", "mobile-control", "session-registry.mjs"), "utf8"), /messageId: item\.messageId/);
  assert.match(js, /function stripAnsi/);
  assert.match(js, /function healMarkdownFences/);
  assert.match(js, /healMarkdownFences\(stripAnsi\(cacheKey\)/);
  assert.match(css, /\.stream-tail\.streaming::after/);
  assert.match(css, /@keyframes cursor-blink/);
  assert.match(html, /interactive-widget=resizes-content/);
  assert.match(js, /schedulePersistEventCursor/);
  assert.match(js, /flushEventCursor/);
  assert.match(js, /function safeStreamBoundary/);
  assert.match(js, /IntersectionObserver/);
  assert.match(js, /function autogrowTextarea/);
  assert.match(js, /setupViewportCompensation/);
  assert.match(js, /--keyboard-inset/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  // 根元素禁止 overscroll-behavior：Android WebView 对根滚动容器的 contain 处理
  // 有缺陷，会吞掉整页触摸滚动；只允许内层滚动容器各自 contain。
  assert.doesNotMatch(css, /html,body\{[^}]*overscroll-behavior/);
  assert.match(css, /\.model-list\{[^}]*overscroll-behavior:contain/);
  assert.match(css, /data-shell="android"/);
  assert.match(js, /function renderExecutionCard/);
  assert.match(js, /function executionProgressRing/);
  assert.match(js, /function agentContextDetailsHtml/);
  assert.match(js, /function renderSessionMenu/);
  assert.match(js, /function bindMessageLongPress/);
  assert.doesNotMatch(js, /function toggleVoiceInput/);
  assert.match(js, /function forkAndRerun/);
  assert.match(js, /allow_session/);
  assert.match(js, /data-action="unarchive"/);
  assert.match(js, /caps\.fork === true/);
  assert.match(js, /nativeCopyText/);
  assert.match(js, /function resetGroupExpandState/);
  assert.doesNotMatch(js, /share-summary/);
  assert.doesNotMatch(js, /compactCurrentSession/);
  assert.doesNotMatch(html, /id="turn-rail"/);
  assert.doesNotMatch(js, /function renderTurnRail/);
  assert.match(js, /export-markdown/);
  assert.match(js, /copy-session-id/);
  assert.match(js, /splitStructuredContent/);
  assert.match(js, /class="structured-notification/);
  assert.match(js, /class="agent-context/);
  assert.match(css, /\.structured-notification\{/);
  assert.match(css, /\.execution-ring/);
  assert.match(css, /\.quote-bar\{/);
  assert.match(css, /\.quote-bar\[hidden\]\{display:none!important\}/);
  assert.match(js, /SwitchyardHandleBack/);
  assert.match(js, /bindEdgeSwipeBack/);
  assert.doesNotMatch(html, /id="voice-control"/);
  assert.match(html, /id="message-action-sheet"/);
  {
    const androidSource = fs.readFileSync(path.resolve("apps/android/app/src/main/java/com/zhangyinglong/switchyard/MainActivity.java"), "utf8");
    const androidManifest = fs.readFileSync(path.resolve("apps/android/app/src/main/AndroidManifest.xml"), "utf8");
    assert.match(androidSource, /shareText\(/);
    assert.match(androidSource, /copyText\(/);
    assert.match(androidSource, /showNotification\(/);
    assert.match(androidManifest, /android\.intent\.action\.SEND/);
  }
  assert.match(css, /\.composer \.runtime-shortcut\{[^}]*display:flex/);
  assert.match(js, /function patchStats/);
  assert.match(js, /function refreshLiveExecutionCard/);
  assert.match(js, /execution-card/);
  assert.match(js, /function openSessionSwitcher/);
  assert.match(js, /sessionDetailCache/);
  assert.match(js, /INITIAL_MESSAGE_LIMIT = 120/);
  assert.match(js, /loadEarlierMessages/);
  assert.match(html, /id="approval-sheet"/);
  assert.match(html, /id="new-message-indicator"/);
  assert.match(html, /id="density-toggle"/);
  assert.match(js, /function renderApprovalSheet/);
  assert.match(js, /function renderNewMessageIndicator/);
  assert.match(js, /DENSITY_KEY/);
  assert.doesNotMatch(js, /data-turn-action/);
  assert.doesNotMatch(html, /data-action="fork"/);
  assert.match(js, /data-diff-filter/);
  assert.match(css, /\.conversation-turn\{/);
  assert.match(css, /\.turn-completion\{/);
  assert.match(css, /\.execution-card\{/);
  assert.match(css, /\.new-message-indicator\{/);
  assert.match(html, /id="session-select-toggle"/);
  assert.match(html, /id="session-selection-bar"/);
  assert.match(html, /id="session-delete-sheet"/);
  assert.match(html, /id="stop-session-sheet"/);
  assert.match(html, /id="stop-session-name"/);
  assert.match(js, /function renderStopSessionSheet/);
  assert.match(js, /resetGroupExpandState/);
    assert.match(js, /PINNED_PROJECTS_KEY/);
  assert.match(js, /data-open-active-sessions/);
  assert.match(js, /approval\.detail\?\.content/);
  assert.match(css, /\.approval-detail\{/);
  assert.match(js, /stopSessionQueueCount/);
  assert.match(css, /\.stop-session-sheet\{/);
  assert.match(html, /id="pull-to-refresh"/);
  assert.match(js, /function requestSessionDeletion/);
  assert.match(js, /function confirmSessionDeletion/);
  assert.match(js, /function refreshMobileData/);
  assert.match(js, /class="session-row\$\{sessionSelectionMode \? " selection-mode" : ""\} swipe-content"/);
  assert.match(js, /data-session-select/);
  assert.match(js, /sessionSelectionMode/);
  assert.match(css, /\.swipe-content\{[^}]*z-index:1[^}]*background:var\(--card\)/);
  assert.match(css, /\.session-selection-bar\{/);
  assert.match(css, /\.session-delete-sheet\{/);
  assert.match(css, /\.pull-to-refresh\{/);
  assert.match(js, /function createClientMessageId/);
  assert.match(js, /globalThis\.crypto\?\.randomUUID/);
  assert.match(js, /globalThis\.crypto\?\.getRandomValues/);
  assert.doesNotMatch(js, /messageId: crypto\.randomUUID/);
  assert.match(js, /function refreshSessionsInBackground/);
  assert.match(js, /data-switch-session/);
  assert.match(js, /function renderMarkdownTable/);
  assert.match(js, /function renderProducedFiles/);
  assert.match(js, /function renderDeliveredFile/);
  assert.match(js, /本轮交付/);
  assert.match(js, /asset\.source/);
  assert.match(js, /deliveryAt/);
  assert.match(js, /const MAX_ATTACHMENTS = 4/);
  assert.match(js, /const MAX_ATTACHMENT_BYTES = 8 \* 1024 \* 1024/);
  assert.match(js, /附件总大小不能超过 8MB/);
  assert.match(js, /本轮产物/);
  assert.match(js, /tool\.activity !== "edit"/);
  assert.match(css, /\.produced-files\{/);
  assert.match(js, /attachmentViewerHistoryOpen/);
  assert.match(js, /nativeAssetActionAvailable/);
  assert.match(js, /downloadAsset/);
  assert.match(js, /currentApproval/);
  assert.match(js, /switchyardAttachmentViewer/);
  assert.match(js, /window\.addEventListener\("popstate"/);
  assert.match(js, /closeAttachmentViewer\(\{ fromHistory: true \}\)/);
  assert.match(js, /markdown-table-wrap/);
  assert.match(css, /\.markdown-table-wrap\{/);
  assert.match(css, /\.markdown-table\{/);
  assert.match(css, /\.attachment-viewer-done\{/);
  assert.match(css, /\.attachment-viewer-actions\{/);
  assert.match(css, /\.attachment-viewer-open/);
  assert.match(css, /\.session-switcher-sheet\{/);
  assert.match(css, /\.continue-current-session\{/);
  assert.match(css, /\.command-picker\{/);
  assert.doesNotMatch(`${html}\n${js}`, /API Key|兼容包|Provider 配置|任意 Shell/);
  assert.match(js, /function setConnectionStatus/);
  assert.match(html, /id="detail-conn"/);
  assert.match(js, /function showInputSheet/);
  assert.match(js, /function closeInputSheet/);
  assert.match(html, /id="input-sheet"/);
  assert.doesNotMatch(js, /prompt\("编辑排队指令"|prompt\("会话名称"/);
  assert.match(js, /skel-msg/);
  assert.match(css, /\.skel\{/);
  assert.match(js, /distanceFromBottom/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /LAST_TASK_KEY/);
  assert.match(js, /rememberLastTask/);
  assert.match(js, /data-open-session/);
  assert.match(css, /\.app-shell\[data-page="detail"\] \.tabbar\{display:none\}/);
  assert.match(css, /--muted:#8a8175/);
  assert.match(css, /\.session-row\[data-state="failed"\]::before\{background:var\(--danger\)\}/);
  assert.match(js, /THEME_KEY/);
  assert.match(js, /function applyTheme/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(html, /id="theme-sheet"/);
  assert.match(js, /THEME_DEFS/);
  assert.match(js, /data-theme-choice/);
  assert.match(css, /:root\[data-theme="ink"\]\{/);
  assert.match(css, /:root\[data-theme="midnight"\]\{/);
  assert.match(css, /:root\[data-scheme="dark"\]/);
  assert.match(css, /\.theme-grid\{/);
  assert.match(js, /nativeOpenExternalUrlAvailable/);
  assert.match(js, /openConversationLink/);
  assert.match(js, /\.msg-body a\[href\]/);
  assert.doesNotMatch(js, /function toggleVoiceInput/);
  assert.doesNotMatch(html, /id="voice-control"/);
  assert.match(js, /\/mobile\/v1\/sessions\/search\?q=/);
  assert.match(js, /function renderContentHits/);
  assert.match(js, /escapeRegExp/);
  assert.match(css, /\.content-hit\{/);
  assert.equal(manifest.display, "standalone");
});

test("Android opens external links through the system browser via VIEW intent", () => {
  const manifest = fs.readFileSync(path.resolve("apps/android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(manifest, /android\.intent\.action\.VIEW/);
  assert.match(manifest, /android:scheme="https"/);
});


test("mobile structured notifications use one generic tagged-JSON adapter", () => {
  const subagent = parseStructuredNotification('<subagent_notification> {"agent_path":"019fac","status":{"completed":"已完成 **只读审查**"}}');
  assert.deepEqual(subagent, {
    tag: "subagent_notification",
    label: "子任务通知",
    state: "completed",
    text: "已完成 **只读审查**",
    agentPath: "019fac"
  });
  assert.equal(notificationStateLabel(subagent.state), "已完成");
  assert.deepEqual(
    parseStructuredNotification('<workflow_notice> {"status":{"running":"正在同步任务"}}'),
    { tag: "workflow_notice", label: "Workflow Notice", state: "running", text: "正在同步任务" }
  );
  assert.equal(parseStructuredNotification("<strong>普通 Markdown</strong>"), null);
  // 闭合标签容错：部分运行时会在 JSON 后补 </tag>。
  assert.deepEqual(
    parseStructuredNotification('<subagent_notification> {"message":"收尾汇报"} </subagent_notification>'),
    { tag: "subagent_notification", label: "子任务通知", state: "", text: "收尾汇报" }
  );
});

test("mobile structured notifications embedded in prose are extracted as segments", () => {
  const mixed = '前置说明\n<subagent_notification> {"status":{"completed":"嵌套 {json} 也要正确"}} </subagent_notification>\n后续正文';
  const segments = splitStructuredContent(mixed);
  assert.deepEqual(segments, [
    { type: "text", text: "前置说明\n" },
    { type: "notification", tag: "subagent_notification", label: "子任务通知", state: "completed", text: "嵌套 {json} 也要正确" },
    { type: "text", text: "\n后续正文" }
  ]);
  // 标签后不是 JSON、或 JSON 没有可展示文本时保持原文，不产生卡片。
  assert.deepEqual(splitStructuredContent("<strong>普通 Markdown</strong>"), [{ type: "text", text: "<strong>普通 Markdown</strong>" }]);
  assert.deepEqual(splitStructuredContent('<notice> {"foo":1}'), [{ type: "text", text: '<notice> {"foo":1}' }]);
  // 普通文本不受影响的快速路径。
  assert.deepEqual(splitStructuredContent("hello"), [{ type: "text", text: "hello" }]);
});

test("mobile collapses agent context envelopes without enumerating tag names", () => {
  assert.equal(isAgentContextTag("INSTRUCTIONS"), true);
  assert.equal(isAgentContextTag("SYSTEM_REMINDER"), true);
  assert.equal(isAgentContextTag("user_instructions"), true);
  assert.equal(isAgentContextTag("strong"), false);
  assert.equal(isAgentContextTag("thinking"), false);

  const mixed = [
    "这部分目前确实还没完成。",
    "",
    "# AGENTS.md instructions for /Users/demo/project",
    "<INSTRUCTIONS>",
    "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.",
    "## 角色定位",
    "你是长期执行型 Codex 合作者。",
    "</INSTRUCTIONS>",
    "",
    "然后继续正文。"
  ].join("\n");
  const segments = splitStructuredContent(mixed);
  assert.equal(segments[0].type, "text");
  assert.match(segments[0].text, /这部分目前确实还没完成/);
  assert.equal(segments[1].type, "context");
  assert.equal(segments[1].tag, "INSTRUCTIONS");
  assert.equal(segments[1].label, "系统指令");
  assert.match(segments[1].text, /AGENTS\.md instructions for/);
  assert.match(segments[1].text, /长期执行型/);
  assert.equal(segments[2].type, "text");
  assert.match(segments[2].text, /然后继续正文/);
  assert.equal(stripAgentContext(mixed), "这部分目前确实还没完成。\n\n然后继续正文。");
  // 未知大写信封也应收起；标签后 JSON 仍走通知卡。
  assert.equal(splitStructuredContent("<FOO_BAR>meta noise</FOO_BAR>")[0].type, "context");
  assert.equal(splitStructuredContent('<subagent_notification> {"message":"ok"}')[0].type, "notification");
});

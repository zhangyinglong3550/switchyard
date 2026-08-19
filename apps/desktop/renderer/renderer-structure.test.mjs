import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSetupProgress, providerCredentialState } from './setup-utils.mjs';

test('renderer provider/model copy controls stay outside table cell protocol markup', () => {
  const text = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  const providerBlock = text.match(/function renderProviders\(\) \{[\s\S]*?\n\}/)?.[0];
  const modelBlock = text.match(/function renderModels\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(providerBlock, 'renderProviders block missing');
  assert.ok(modelBlock, 'renderModels block missing');
  assert.match(providerBlock, /<span class="chip">\$\{escapeHtml\(PROTOCOL_LABEL\[p\.apiFormat\] \|\| p\.apiFormat\)\}<\/span>/);
  assert.match(providerBlock, /<span class="tiny muted">\$\{escapeHtml\(PROTOCOL_HELP\[p\.apiFormat\] \|\| ""\)\}<\/span>/);
  assert.match(providerBlock, /data-copy-provider/);
  assert.doesNotMatch(providerBlock, /data-copy-model/);
  assert.doesNotMatch(providerBlock, /function uniqueCopiedName|function duplicateProviderRow|function duplicateModelRow/);
  assert.match(modelBlock, /data-copy-model/);
  assert.doesNotMatch(modelBlock, /data-copy-provider/);
  assert.match(text, /function uniqueCopiedName\(baseName, exists\) \{/);
  assert.match(text, /function duplicateProviderRow\(providerId\) \{/);
  assert.match(text, /function duplicateModelRow\(modelId\) \{/);
});

test('clients tab lists OpenCode, Grok, and DeepSeek Harness with stable card order', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  assert.match(html, /一键写入 \/ 恢复 Codex、Claude Code、Hermes、OpenCode、Grok Build、DeepSeek Harness 配置/);
  assert.match(js, /const CLIENT_CARD_ORDER = \["codex", "claude-code", "hermes", "opencode", "grok", "deepseek-harness", "generic-openai"\]/);
  assert.match(js, /function orderedClientEntries\(/);
  assert.match(js, /const clients = orderedClientEntries\(config\.clients \|\| \{\}\)/);
  assert.match(js, /opencode: \{ label: "OpenCode"/);
  assert.match(js, /grok: \{ label: "Grok Build"/);
  assert.match(js, /"deepseek-harness": \{ label: "DeepSeek Harness"/);
});

test('retry sections expose empty-stream retry (streamCompat) fields on both forms', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  assert.match(html, /name="streamCompatAttempts"/);
  assert.match(html, /name="streamCompatBackoff"/);
  assert.match(js, /function collectStreamCompatFromRaw\(raw\)/);
  assert.match(js, /function fillStreamCompatFormFields\(form, streamCompat\)/);
  assert.match(js, /preludeRetryAttempts/);
  assert.match(js, /preludeRetryBackoffMs/);
  assert.match(js, /retryPreludeOnEof/);
  assert.match(js, /fillStreamCompatFormFields\(form, existing\.streamCompat\)/);
});

test('main flow has actionable setup and guarded gateway/provider saves', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  assert.match(html, /id="overview-setup-progress"/);
  assert.match(html, /id="overview-next-step"/);
  assert.match(js, /function runGatewayAction\(action\)/);
  assert.match(js, /网关操作失败/);
  assert.match(js, /保存失败：\$\{err\?\.message/);
  assert.match(js, /data-empty-action="provider"/);
  assert.match(js, /data-empty-action="model"/);
  assert.match(js, /data-setup-action/);
  assert.match(js, /复制全部地址/);
});

test('setup progress reflects provider credentials, gateway state, and health', () => {
  const config = {
    providers: [{ id: 'one', apiKeyEnv: 'ONE_KEY' }, { id: 'two', authMode: 'none' }],
    models: [{ id: 'model' }]
  };
  assert.equal(providerCredentialState(config.providers[0]), 'configured');
  assert.equal(providerCredentialState(config.providers[0], { status: 'healthy' }), 'verified');
  assert.equal(providerCredentialState(config.providers[0], { status: 'unhealthy' }), 'failed');
  assert.equal(providerCredentialState({}), 'missing');
  assert.deepEqual(buildSetupProgress(config, { running: false }, {}).checks.map((item) => item.done), [true, true, true, false]);
  assert.deepEqual(buildSetupProgress({ providers: [], models: [] }, { running: false }).checks.map((item) => item.done), [false, false, false, false]);
  assert.equal(buildSetupProgress(config, { running: true }, {}).next, null);
});

test('renderer entry module parses before packaging', async () => {
  const entry = new URL('./renderer.js', import.meta.url);
  await assert.rejects(
    import(`${entry.href}?parse-check=${Date.now()}`),
    (error) => error instanceof ReferenceError && /window is not defined/.test(error.message),
    'renderer module should parse; in Node it may only fail after parsing because browser globals are unavailable'
  );
});

test('provider dialog omits retired Cursor subscription UI', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="provider-cursor-subscription-panel"/);
  assert.doesNotMatch(html, /option value="cursor_subscription"/);
  assert.doesNotMatch(html, /Cursor 订阅桥接/);
  assert.doesNotMatch(js, /cursor-subscription:/);
});

test('provider dialog supports manual upstream models and omits directory sync', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="btn-provider-sync-models"/);
  assert.match(js, /data-discovery-upstream/);
  assert.match(js, /上游模型 ID/);
  assert.match(js, /请填写手动添加模型的上游模型 ID/);
  assert.match(js, /const modelsById = new Map/);
});

test('mobile control exposes live Tailscale Serve status and a repair action', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="mobile-tailscale-status"/);
  assert.match(html, /id="mobile-tailscale-url"/);
  assert.match(html, /id="btn-mobile-tailscale-repair"/);
  assert.match(js, /mobile-control:connection-status/);
  assert.match(js, /mobile-control:repair-connection/);
  assert.match(main, /ipcMain\.handle\("mobile-control:connection-status"/);
  assert.match(main, /ipcMain\.handle\("mobile-control:repair-connection"/);
});

test('desktop keeps single-instance behavior by default while allowing isolated package verification', () => {
  const main = fs.readFileSync(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(main, /SWITCHYARD_ALLOW_MULTIPLE_INSTANCES/);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
});

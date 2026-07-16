import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';

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

test('clients tab lists OpenCode and Grok with stable card order', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const js = fs.readFileSync(new URL('./renderer.js', import.meta.url), 'utf8');
  assert.match(html, /一键写入 \/ 恢复 Codex、Claude Code、Hermes、OpenCode、Grok Build 配置/);
  assert.match(js, /const CLIENT_CARD_ORDER = \["codex", "claude-code", "hermes", "opencode", "grok", "generic-openai"\]/);
  assert.match(js, /function orderedClientEntries\(/);
  assert.match(js, /const clients = orderedClientEntries\(config\.clients \|\| \{\}\)/);
  assert.match(js, /opencode: \{ label: "OpenCode"/);
  assert.match(js, /grok: \{ label: "Grok Build"/);
});

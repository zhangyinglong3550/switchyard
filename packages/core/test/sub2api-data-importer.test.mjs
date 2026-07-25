import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSub2ApiDataFiles, publicSub2ApiDataImport } from "../src/importers/sub2api-data.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function backup(name, { accounts = [], proxies = [] } = {}) {
  return {
    name,
    text: JSON.stringify({
      type: "sub2api-data",
      version: 1,
      exported_at: "2026-07-21T00:26:16Z",
      proxies,
      accounts
    })
  };
}

test("sub2api data importer · merges multiple account backup files without exposing credentials in the preview", () => {
  const parsed = parseSub2ApiDataFiles([
    backup("a.json", {
      accounts: [{ name: "account-a", platform: "openai", type: "oauth", credentials: { agent_private_key: "private-a" } }],
      proxies: [{ proxy_key: "proxy-a", name: "Proxy A" }]
    }),
    backup("b.json", {
      accounts: [{ name: "account-b", platform: "openai", type: "oauth", credentials: { agent_private_key: "private-b" } }]
    })
  ], { exportedAt: "2026-07-23T00:00:00.000Z" });

  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.type, "sub2api-data");
  assert.equal(parsed.data.version, 1);
  assert.equal(parsed.data.exported_at, "2026-07-23T00:00:00.000Z");
  assert.equal(parsed.data.accounts.length, 2);
  assert.equal(parsed.data.proxies.length, 1);

  const preview = publicSub2ApiDataImport(parsed);
  assert.deepEqual(preview.files, [
    { name: "a.json", accounts: 1, proxies: 1 },
    { name: "b.json", accounts: 1, proxies: 0 }
  ]);
  assert.deepEqual(preview.totals, { files: 2, accounts: 2, proxies: 1 });
  assert.equal(JSON.stringify(preview).includes("private-a"), false);
  assert.equal(JSON.stringify(preview).includes("private-b"), false);
});

test("sub2api data importer · rejects a bad file before it can be mixed into a batch", () => {
  const parsed = parseSub2ApiDataFiles([
    backup("valid.json", { accounts: [{ name: "account-a", credentials: {} }] }),
    { name: "invalid.json", text: JSON.stringify({ type: "other-backup", version: 1, accounts: [], proxies: [] }) }
  ]);

  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /invalid\.json/);
  assert.match(parsed.error, /Sub2API/);
});

test("sub2api data importer · accepts the legacy sub2api-bundle type for compatible backups", () => {
  const parsed = parseSub2ApiDataFiles([{
    name: "legacy.json",
    text: JSON.stringify({
      type: "sub2api-bundle",
      version: 1,
      exported_at: "2026-07-21T00:26:16Z",
      proxies: [],
      accounts: [{ name: "legacy-account", credentials: {} }]
    })
  }]);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.accounts.length, 1);
});

test("sub2api data importer · desktop exposes a multi-file native pool import flow", () => {
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.mjs"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/desktop/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/renderer.js"), "utf8");

  assert.match(main, /ipcMain\.handle\("import:sub2api:data-select"/);
  assert.match(main, /properties: \["openFile", "multiSelections"\]/);
  assert.match(main, /ipcMain\.handle\("import:sub2api:data-apply"/);
  assert.match(main, /importSub2ApiDataToCodexPool/);
  assert.match(html, /id="provider-sub2api-panel"/);
  assert.match(html, /id="btn-sub2api-data-import-select"/);
  assert.match(html, /不需要安装或运行 Sub2API/);
  assert.doesNotMatch(html, /Sub2API 管理 API 地址/);
  assert.match(renderer, /invoke\("import:sub2api:data-select"\)/);
  assert.match(renderer, /invoke\("import:sub2api:data-apply"/);
});

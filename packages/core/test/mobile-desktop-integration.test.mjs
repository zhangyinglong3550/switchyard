import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("desktop wires mobile control lifecycle, pairing and packaged PWA assets", () => {
  const root = path.resolve(import.meta.dirname, "../../..");
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.mjs"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/desktop/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/renderer/renderer.js"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(main, /startMobileControl/);
  assert.match(main, /stopMobileControl/);
  assert.match(main, /mobile-control:status/);
  assert.match(main, /mobile-control:enable/);
  assert.match(main, /mobile-control:disable/);
  assert.match(main, /mobile-control:pair-start/);
  assert.match(main, /mobile-control:devices/);
  assert.match(main, /mobile-control:device-revoke/);
  assert.ok(pkg.build.files.includes("apps/mobile/**/*"));
  assert.match(pkg.scripts.check, /mobile-control-host\.mjs/);
  for (const id of [
    "mobile-control-status",
    "btn-mobile-control-toggle",
    "btn-mobile-pair",
    "mobile-pairing-url",
    "mobile-devices"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-tab="mobile-control"/);
  assert.match(html, /id="panel-mobile-control"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="panel-settings"')), /id="mobile-control-card"/);
  assert.match(html, /Tailscale Serve/);
  assert.match(renderer, /tab === "mobile-control"/);
  assert.match(renderer, /refreshMobileControl/);
  assert.match(renderer, /mobile-control:enable/);
  assert.match(renderer, /mobile-control:disable/);
  assert.match(renderer, /mobile-control:pair-start/);
  assert.match(renderer, /mobile-control:device-revoke/);
  assert.match(renderer, /formatDate\(device\.lastSeenAt\)/);
});

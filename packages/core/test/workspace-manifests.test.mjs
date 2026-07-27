import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readPackageJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

test("desktop workspace declares the checked-in core workspace version", () => {
  const core = readPackageJson("packages/core/package.json");
  const desktop = readPackageJson("apps/desktop/package.json");

  assert.equal(desktop.dependencies[core.name], core.version);
});


test("Android release build uses environment-driven versioning and a local verification script", () => {
  const gradle = fs.readFileSync(path.join(repositoryRoot, "apps/android/app/build.gradle"), "utf8");
  const packageJson = readPackageJson("package.json");
  const readme = fs.readFileSync(path.join(repositoryRoot, "apps/android/README.zh-CN.md"), "utf8");
  assert.match(gradle, /SWITCHYARD_ANDROID_VERSION_CODE/);
  assert.match(gradle, /SWITCHYARD_ANDROID_VERSION_NAME/);
  assert.match(gradle, /SWITCHYARD_ANDROID_STORE_FILE/);
  assert.match(gradle, /signingConfigs/);
  assert.match(gradle, /else signingConfig signingConfigs\.debug/);
  assert.equal(packageJson.scripts["android:release:check"], "bash apps/android/scripts/verify-release.sh");
  const script = fs.readFileSync(path.join(repositoryRoot, "apps/android/scripts/verify-release.sh"), "utf8");
  assert.match(script, /ApkVerifier/);
  assert.match(script, /signed \(installable/);
  assert.match(readme, /assembleRelease/);
  assert.match(readme, /android:release:check/);
});


test("Android launcher uses the checked-in desktop Switchyard icon", () => {
  const manifest = fs.readFileSync(path.join(repositoryRoot, "apps/android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(manifest, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/ic_launcher"/);
  for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
    assert.ok(fs.existsSync(path.join(repositoryRoot, `apps/android/app/src/main/res/mipmap-${density}/ic_launcher.png`)));
  }
});

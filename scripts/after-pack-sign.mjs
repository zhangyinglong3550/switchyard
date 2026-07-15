import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * afterPack：体积裁剪 + macOS ad-hoc 签名。
 * - 清理 better-sqlite3 编译源（deps/src 不应打进安装包）
 * - 仅保留 en / zh 相关 Electron 语言包（electronLanguages 的兜底）
 */
export default async function (context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName; // darwin | win32 | linux
  const appName = context.packager.appInfo.productFilename;

  try {
    pruneBetterSqlite3(appOutDir, platform, appName);
    pruneElectronLocales(appOutDir, platform, appName);
  } catch (err) {
    console.warn(`⚠ afterPack prune failed (non-fatal): ${err?.message || err}`);
  }

  if (platform === "darwin") {
    const appPath = path.join(appOutDir, `${appName}.app`);
    try {
      execSync(`codesign --deep --force -s - ${JSON.stringify(appPath)}`, { stdio: "inherit" });
      console.log(`✓ ad-hoc signed: ${appPath}`);
    } catch (err) {
      console.warn(`⚠ ad-hoc signing failed (non-fatal): ${err.message}`);
    }
  }
}

function resourcesRoot(appOutDir, platform, appName) {
  if (platform === "darwin") {
    return path.join(appOutDir, `${appName}.app`, "Contents", "Resources");
  }
  return path.join(appOutDir, "resources");
}

function pruneBetterSqlite3(appOutDir, platform, appName) {
  const resources = resourcesRoot(appOutDir, platform, appName);
  const candidates = [
    path.join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3"),
    path.join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3", "deps"),
    path.join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3", "src")
  ];
  // 整包里只保留 build + lib + package.json
  const root = path.join(resources, "app.asar.unpacked", "node_modules", "better-sqlite3");
  if (!fs.existsSync(root)) return;
  for (const name of ["deps", "src", "deps", "binding.gyp"]) {
    rmrf(path.join(root, name));
  }
  // build 下只留 Release/*.node
  const buildDir = path.join(root, "build");
  if (fs.existsSync(buildDir)) {
    for (const entry of fs.readdirSync(buildDir)) {
      if (entry === "Release") continue;
      rmrf(path.join(buildDir, entry));
    }
    const release = path.join(buildDir, "Release");
    if (fs.existsSync(release)) {
      for (const entry of fs.readdirSync(release)) {
        if (entry.endsWith(".node")) continue;
        rmrf(path.join(release, entry));
      }
    }
  }
  console.log("✓ pruned better-sqlite3 build artifacts");
}

const KEEP_LOCALE = /^(en|en[-_]US|zh|zh[-_]CN|zh[-_]TW|zh[-_]Hans|zh[-_]Hant|zh[-_]HK|zh[-_]SG)(\.|$)/i;

function pruneElectronLocales(appOutDir, platform, appName) {
  let localesDir;
  if (platform === "darwin") {
    localesDir = path.join(
      appOutDir,
      `${appName}.app`,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Resources"
    );
  } else if (platform === "win32" || platform === "linux") {
    localesDir = path.join(appOutDir, "locales");
  } else {
    return;
  }
  if (!fs.existsSync(localesDir)) return;

  let removed = 0;
  let freed = 0;
  for (const entry of fs.readdirSync(localesDir)) {
    const full = path.join(localesDir, entry);
    // mac: *.lproj ; win/linux: *.pak
    const isLocale =
      entry.endsWith(".lproj") ||
      (entry.endsWith(".pak") && !["resources.pak", "chrome_100_percent.pak", "chrome_200_percent.pak"].includes(entry));
    if (!isLocale) continue;
    const base = entry.replace(/\.lproj$/i, "").replace(/\.pak$/i, "");
    if (KEEP_LOCALE.test(base)) continue;
    const size = dirSize(full);
    rmrf(full);
    removed += 1;
    freed += size;
  }
  if (removed) {
    console.log(`✓ pruned ${removed} Electron locales (~${(freed / 1048576).toFixed(1)} MB)`);
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function dirSize(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    let total = 0;
    for (const name of fs.readdirSync(p)) {
      total += dirSize(path.join(p, name));
    }
    return total;
  } catch {
    return 0;
  }
}

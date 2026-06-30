import { execSync } from "node:child_process";
export default async function (context) {
  const appOutDir = context.appOutDir;
  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  try {
    execSync(`codesign --deep --force -s - "${appPath}"`, { stdio: "inherit" });
    console.log(`✓ ad-hoc signed: ${appPath}`);
  } catch (err) {
    console.warn(`⚠ ad-hoc signing failed (non-fatal): ${err.message}`);
  }
}

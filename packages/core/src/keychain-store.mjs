import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_KEYCHAIN_SERVICE = "switchyard";

function defaultRunner(cmd, args, options = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, ...options });
}

export function keychainAccountForProvider(provider) {
  if (typeof provider === "string") return provider;
  return String(provider?.keychainAccount || provider?.id || "").trim();
}

export function describeKeychainSecret(account, { service = DEFAULT_KEYCHAIN_SERVICE, platform = process.platform } = {}) {
  const backend = platform === "darwin" ? "macOS Keychain" : platform === "win32" ? "Windows DPAPI" : "System secret store";
  return `${backend}(${service}/${String(account || "").trim() || "-"})`;
}

function secretStoreDir(dir) {
  return dir || process.env.SWITCHYARD_SECRET_STORE_DIR || path.join(os.homedir(), ".switchyard", "secrets");
}

function secretFile(account, { service = DEFAULT_KEYCHAIN_SERVICE, secretDir } = {}) {
  const key = crypto.createHash("sha256").update(`${service}:${account}`).digest("hex");
  return path.join(secretStoreDir(secretDir), `${key}.dpapi`);
}

function powerShellBin() {
  return process.env.SWITCHYARD_POWERSHELL || "powershell.exe";
}

function ensureSupportedPlatform(platform) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`System secret store is not supported on ${platform}`);
  }
}

function encryptWindowsSecret(secret, runner) {
  const script = [
    "$plain = [Console]::In.ReadToEnd()",
    "$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force",
    "$secure | ConvertFrom-SecureString"
  ].join("; ");
  return String(runner(powerShellBin(), ["-NoProfile", "-NonInteractive", "-Command", script], { input: String(secret || "") }) || "").trim();
}

function assertPromptSafeSecret(secret) {
  if (/[\r\n]/.test(String(secret || ""))) {
    throw new Error("Keychain secret cannot contain newlines");
  }
}

function decryptWindowsSecret(encrypted, runner) {
  const script = [
    "$encrypted = [Console]::In.ReadToEnd()",
    "$secure = ConvertTo-SecureString -String $encrypted",
    "$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
    "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }"
  ].join("; ");
  return String(runner(powerShellBin(), ["-NoProfile", "-NonInteractive", "-Command", script], { input: String(encrypted || "") }) || "").trim();
}

export function setKeychainSecret(account, secret, { service = DEFAULT_KEYCHAIN_SERVICE, runner = defaultRunner, platform = process.platform, secretDir } = {}) {
  const name = String(account || "").trim();
  if (!name) throw new Error("Keychain account is required");
  ensureSupportedPlatform(platform);
  if (platform === "win32") {
    const encrypted = encryptWindowsSecret(secret, runner);
    const file = secretFile(name, { service, secretDir });
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, encrypted, { encoding: "utf8", mode: 0o600 });
    return { ok: true, account: name, service, backend: "windows-dpapi" };
  }
  assertPromptSafeSecret(secret);
  runner("security", ["add-generic-password", "-a", name, "-s", service, "-U", "-w"], { input: `${String(secret || "")}\n${String(secret || "")}\n` });
  return { ok: true, account: name, service, backend: "macos-keychain" };
}

export function getKeychainSecret(account, { service = DEFAULT_KEYCHAIN_SERVICE, runner = defaultRunner, platform = process.platform, secretDir } = {}) {
  const name = String(account || "").trim();
  if (!name) return "";
  if (platform !== "darwin" && platform !== "win32") return "";
  try {
    if (platform === "win32") {
      const file = secretFile(name, { service, secretDir });
      if (!fs.existsSync(file)) return "";
      return decryptWindowsSecret(fs.readFileSync(file, "utf8"), runner);
    }
    return String(runner("security", ["find-generic-password", "-a", name, "-s", service, "-w"]) || "").trim();
  } catch {
    return "";
  }
}

export function hasKeychainSecret(account, opts = {}) {
  return Boolean(getKeychainSecret(account, opts));
}

export function deleteKeychainSecret(account, { service = DEFAULT_KEYCHAIN_SERVICE, runner = defaultRunner, platform = process.platform, secretDir } = {}) {
  const name = String(account || "").trim();
  if (!name) throw new Error("Keychain account is required");
  ensureSupportedPlatform(platform);
  if (platform === "win32") {
    fs.rmSync(secretFile(name, { service, secretDir }), { force: true });
    return { ok: true, account: name, service, backend: "windows-dpapi" };
  }
  try {
    runner("security", ["delete-generic-password", "-a", name, "-s", service]);
  } catch {}
  return { ok: true, account: name, service, backend: "macos-keychain" };
}

export function getProviderKeychainSecret(provider, opts = {}) {
  return getKeychainSecret(keychainAccountForProvider(provider), opts);
}

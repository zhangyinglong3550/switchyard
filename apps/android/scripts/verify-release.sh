#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
android_dir="$root/apps/android"
metadata="$android_dir/app/build/outputs/apk/release/output-metadata.json"

if [[ ! -f "$metadata" ]]; then
  echo "未找到 release APK 元数据：请先运行 ./gradlew assembleRelease" >&2
  exit 1
fi

apk_relative="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const row=(data.elements||[]).find((item)=>item.type==="SINGLE") || data.elements?.[0]; if (!row?.outputFile) process.exit(2); process.stdout.write(row.outputFile)' "$metadata")"
apk="$android_dir/app/build/outputs/apk/release/$apk_relative"
if [[ ! -f "$apk" ]]; then
  echo "未找到 release APK：$apk" >&2
  exit 1
fi

version_code="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const row=(data.elements||[]).find((item)=>item.type==="SINGLE") || data.elements?.[0]; if (!row?.versionCode) process.exit(2); process.stdout.write(String(row.versionCode))' "$metadata")"
version_name="$(node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const row=(data.elements||[]).find((item)=>item.type==="SINGLE") || data.elements?.[0]; if (!row?.versionName) process.exit(2); process.stdout.write(String(row.versionName))' "$metadata")"

if command -v jarsigner >/dev/null 2>&1; then
  signature="$(jarsigner -verify -certs "$apk" 2>&1 || true)"
  if [[ "$signature" == *"jar verified."* ]]; then
    signing="signed"
  else
    signing="unsigned"
  fi
else
  signing="unknown (jarsigner unavailable)"
fi

printf 'APK: %s\nversionCode: %s\nversionName: %s\nSigning: %s\n' "$apk" "$version_code" "$version_name" "$signing"

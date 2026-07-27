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

apksig_jar="$(find "$HOME/.gradle/caches/modules-2/files-2.1/com.android.tools.build/apksig" -path '*/8.5.2/*/*.jar' -type f 2>/dev/null | head -1 || true)"
if [[ -z "$apksig_jar" ]]; then
  echo "找不到 Android APK 签名验证库（apksig）" >&2
  exit 1
fi

verify_dir="$(mktemp -d)"
trap 'rm -rf "$verify_dir"' EXIT
cat > "$verify_dir/VerifyApk.java" <<'JAVA'
import com.android.apksig.ApkVerifier;
import java.io.File;

public final class VerifyApk {
  public static void main(String[] args) throws Exception {
    ApkVerifier.Result result = new ApkVerifier.Builder(new File(args[0])).build().verify();
    if (!result.isVerified()) System.exit(1);
    System.out.printf("v1=%s v2=%s v3=%s", result.isVerifiedUsingV1Scheme(), result.isVerifiedUsingV2Scheme(), result.isVerifiedUsingV3Scheme());
  }
}
JAVA
javac -cp "$apksig_jar" "$verify_dir/VerifyApk.java"
signature="$(java -cp "$apksig_jar:$verify_dir" VerifyApk "$apk")"

printf 'APK: %s\nversionCode: %s\nversionName: %s\nSigning: signed (installable; %s)\n' "$apk" "$version_code" "$version_name" "$signature"

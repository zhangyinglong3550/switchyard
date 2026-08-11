#!/bin/bash
# Android 模拟器端到端自测（无真机时用）
# 用法: export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
#       ./scripts/android-emulator-selftest.sh
set -uo pipefail

ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
APK="${1:-/Users/zhangyinglong/code/codex/switchyard/apps/android/app/build/outputs/apk/debug/app-debug.apk}"
SCRATCH="${SCRATCH:-/var/folders/21/w4zdc1hx60j3vjgzjfqbyfhr0000gn/T/grok-goal-766bcc6b1b4a/implementer}"
AVD_NAME="switchyard_selftest"

log() { echo "[selftest] $*"; }
step() { echo ""; echo "===== $* ====="; }

step "0. 创建 AVD"
if ! "$EMULATOR" -list-avds 2>/dev/null | grep -q "$AVD_NAME"; then
  echo "no" | "$AVDMANAGER" create avd \
    -n "$AVD_NAME" -k "system-images;android-34;google_apis;arm64-v8a" -d pixel_8 2>&1 | tail -2
  log "AVD 已创建: $AVD_NAME"
else
  log "AVD 已存在"
fi

step "1. 启动模拟器（无头）"
"$EMULATOR" -avd "$AVD_NAME" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot > "$SCRATCH/emulator.log" 2>&1 &
EMU_PID=$!
log "模拟器 PID: $EMU_PID"
"$ADB" wait-for-device
log "设备已连接，等待 boot 完成…"
"$ADB" shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 2; done'
log "boot 完成"

step "2. 安装 APK"
"$ADB" install -r "$APK" 2>&1 | tail -2

step "3. 启动 App"
# debug 版 applicationId 是 com.zhangyinglong.switchyard.debug，但 Activity 类在 com.zhangyinglong.switchyard 包
"$ADB" shell am start -n com.zhangyinglong.switchyard.debug/com.zhangyinglong.switchyard.MainActivity
sleep 3
"$ADB" exec-out screencap -p > "$SCRATCH/step3-launch.png"
log "首页截图: $SCRATCH/step3-launch.png"

step "4. 输入 Mac 地址 + 设备名（模拟器用 10.0.2.2 访问宿主机 daemon）"
"$ADB" shell input tap 300 400   # 聚焦 Mac 地址输入框
sleep 1
"$ADB" shell input text "http://10.0.2.2:17890"
"$ADB" shell input keyevent 61   # Tab 到设备名
sleep 1
"$ADB" shell input text "emulator-selftest"
"$ADB" exec-out screencap -p > "$SCRATCH/step4-filled.png"
log "填写后截图: $SCRATCH/step4-filled.png"

step "5. 点击连接并配对"
"$ADB" shell input tap 300 620
sleep 5
"$ADB" exec-out screencap -p > "$SCRATCH/step5-paired.png"
log "配对后截图: $SCRATCH/step5-paired.png"

step "6. 验证会话列表"
"$ADB" shell input swipe 400 1200 400 400 300  # 滑动列表
sleep 1
"$ADB" exec-out screencap -p > "$SCRATCH/step6-sessions.png"
log "会话列表截图: $SCRATCH/step6-sessions.png"

step "7. 验证滑动面板（切到 Grok 面板）"
"$ADB" shell input swipe 700 600 100 600 500   # 左滑到下一个面板
sleep 1
"$ADB" exec-out screencap -p > "$SCRATCH/step7-panel2.png"
log "滑动后截图: $SCRATCH/step7-panel2.png"

step "8. 打开一个会话"
"$ADB" shell input tap 200 400
sleep 2
"$ADB" exec-out screencap -p > "$SCRATCH/step8-detail.png"
log "会话详情截图: $SCRATCH/step8-detail.png"

step "9. 验证日志无崩溃"
"$ADB" logcat -d -t 200 2>/dev/null | grep -iE "FATAL|AndroidRuntime|switchyard" | tail -10 > "$SCRATCH/logcat-crash.log" || true
log "崩溃日志: $(wc -l < "$SCRATCH/logcat-crash.log") 行"

step "10. 关闭模拟器"
"$ADB" emu kill 2>/dev/null
log "完成"

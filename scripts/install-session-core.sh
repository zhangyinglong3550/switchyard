#!/bin/bash
# 安装 Session-Core daemon 为 launchd 常驻服务（用户级 LaunchAgent）。
# 用法: ./scripts/install-session-core.sh [install|uninstall|status|restart]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.zhangyinglong.switchyard.session-core"
PLIST_SRC="$REPO_ROOT/apps/desktop/session-core.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

# 解析 node 绝对路径（launchd 只给系统 PATH）
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.local/bin/node" ]; then
  NODE_BIN="$HOME/.local/bin/node"
fi
if [ -z "$NODE_BIN" ] && [ -x "$HOME/.nvm/current/bin/node" ]; then
  NODE_BIN="$HOME/.nvm/current/bin/node"
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误: 找不到 node 绝对路径" >&2
  exit 1
fi

generate_plist() {
  cat > "$PLIST_DST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_ROOT/apps/desktop/session-core.mjs</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>$HOME/.switchyard/mobile-control/session-core.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.switchyard/mobile-control/session-core.err.log</string>
</dict>
</plist>
EOF
  echo "已生成 $PLIST_DST"
}

case "${1:-install}" in
  install)
    generate_plist
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"
    echo "已加载 $LABEL"
    sleep 1
    "$REPO_ROOT/apps/desktop/session-core.mjs" status || true
    ;;
  uninstall)
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST"
    echo "已卸载 $LABEL"
    ;;
  status)
    launchctl list | grep "$LABEL" || echo "未运行"
    ;;
  restart)
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    launchctl load "$PLIST_DST"
    echo "已重启 $LABEL"
    ;;
  *)
    echo "用法: $0 [install|uninstall|status|restart]" >&2
    exit 1
    ;;
esac

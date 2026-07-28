# Switchyard Android 手机控制端

这是 Switchyard 移动控制端的 Android 原生壳。它不会运行 Agent，也不会持有模型 Provider 凭据；它只通过 Tailscale HTTPS 访问已配对桌面端的 Mobile Control API。

## 安全边界

- 仅接受 `https://` 配对链接，桌面端仍只监听回环地址，由 Tailscale Serve 提供 HTTPS。
- 配对 token 使用 Android Keystore 的 AES-GCM 加密后保存；不会写入 WebView 的 localStorage。
- 禁止明文 HTTP、任意文件访问和混合内容；聊天里的 `http(s)` 链接只会交给系统浏览器处理，不会在 WebView 内加载外部页面。
- 原生层仅向 Switchyard 的同源页面暴露存取 token、受控文件预览和外部链接打开的窄桥接，不向网页暴露 Shell、文件系统或模型凭据。
- 不申请麦克风权限；不提供语音输入、会话 Fork 等不稳定快捷操作。

## 可做什么

- 查看 Codex、Claude Code、Grok、OpenCode 的会话、实时输出、审批状态、目标与分步执行进度。
- 新建或继续任务；发送图片或文件；查看并下载 Agent 交付的文件。
- 搜索、刷新、置顶、归档、重命名、停止会话，以及批量选择删除会话。
- 在任务执行中发送引导或排队指令，并管理后续指令队列。

## 使用

1. 从 [GitHub Releases](https://github.com/zhangyinglong3550/switchyard/releases) 下载 `Switchyard-*-android.apk` 并安装。首次安装若被系统拦截，请仅对你确认来源的 APK 允许“安装未知应用”。
2. 桌面端开启移动控制，并通过 Tailscale Serve 暴露 `17889`。
3. 将桌面端显示的 Tailscale HTTPS 地址填入“手机控制”页，然后生成配对链接；链接形如 `https://<你的-tailscale-host>:17889/?challenge=...`。
4. 打开 Android App，粘贴该链接并连接。成功配对后，链接中的 challenge 会从地址栏移除。
5. 如果链接输错或连接失败，顶部会保留“修改链接”；点击即可回到输入页，不需要卸载重装。
6. 如需从系统跳转，可使用：`switchyard://pair?url=<URL-encoded-配对链接>`。

## 构建

```bash
cd apps/android
./gradlew assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

## Release APK

未配置正式 keystore 时，`assembleRelease` 会使用 Android 默认 debug keystore 签名，生成**可直接安装的内部测试 release APK**；它不能用于应用商店发布：

```bash
cd apps/android
./gradlew assembleRelease
npm --prefix ../.. run android:release:check
```

产物位于 `app/build/outputs/apk/release/`。检查脚本会读取 Gradle 输出元数据，报告 APK 路径、`versionCode`、`versionName` 和签名状态；只有显示 `signed (installable)` 的 APK 才应分发给测试手机。

正式发布时，推送 `vX.Y.Z` 标签会由 GitHub Actions 自动构建 Android Release APK、执行签名校验，并与 macOS / Windows 安装包一起上传到 GitHub Release。Android 的 `versionName` 使用该标签版本，`versionCode` 由语义版本确定性生成，保证后续版本可覆盖安装。

可通过环境变量（或同名 Gradle property）覆盖版本，不会修改已提交的构建文件：

```bash
SWITCHYARD_ANDROID_VERSION_CODE=5 \
SWITCHYARD_ANDROID_VERSION_NAME=0.1.4 \
./gradlew assembleRelease
```

如需发布签名，请只在本机环境变量或未提交的 Gradle 用户属性中配置以下全部值；不要将密钥或密码提交到仓库：

- `SWITCHYARD_ANDROID_STORE_FILE`
- `SWITCHYARD_ANDROID_STORE_PASSWORD`
- `SWITCHYARD_ANDROID_KEY_ALIAS`
- `SWITCHYARD_ANDROID_KEY_PASSWORD`

四项齐全时，`release` 会自动使用该签名配置；缺少任何一项时，构建保持未签名。

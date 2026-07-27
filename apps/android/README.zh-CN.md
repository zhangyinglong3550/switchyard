# Switchyard Android（首版）

这是 Switchyard 移动控制端的 Android 原生壳。它不会运行 Agent，也不会持有模型 Provider 凭据；它只通过 Tailscale HTTPS 访问已配对桌面端的 Mobile Control API。

## 安全边界

- 仅接受 `https://` 配对链接，桌面端仍只监听回环地址，由 Tailscale Serve 提供 HTTPS。
- 配对 token 使用 Android Keystore 的 AES-GCM 加密后保存；不会写入 WebView 的 localStorage。
- 禁止明文 HTTP、任意文件访问、混合内容和外部域名 WebView 跳转。
- 原生层仅向 Switchyard 的同源页面暴露存取 token 的窄桥接，不向网页暴露 Shell、文件系统或模型凭据。

## 使用

1. 桌面端开启移动控制，并通过 Tailscale Serve 暴露 `17889`。
2. 在桌面端生成配对链接；链接形如 `https://<你的-tailscale-host>/?challenge=...`。
3. 打开 Android App，粘贴该链接并连接。成功配对后，链接中的 challenge 会从地址栏移除。
4. 如果链接输错或连接失败，顶部会保留“修改链接”；点击即可回到输入页，不需要卸载重装。
5. 如需从系统跳转，可使用：`switchyard://pair?url=<URL-encoded-配对链接>`。

## 构建

```bash
cd apps/android
./gradlew assembleDebug
```

产物：`app/build/outputs/apk/debug/app-debug.apk`

## Release APK

默认可构建**未签名** release APK，适合本机安装验证：

```bash
cd apps/android
./gradlew assembleRelease
npm --prefix ../.. run android:release:check
```

产物位于 `app/build/outputs/apk/release/`。检查脚本会读取 Gradle 输出元数据，报告 APK 路径、`versionCode`、`versionName` 和签名状态。

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

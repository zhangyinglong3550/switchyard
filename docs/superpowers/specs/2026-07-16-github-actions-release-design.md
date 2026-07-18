# GitHub Actions 自动构建与发布设计

**日期：** 2026-07-16

**状态：** 已落地

**范围：** Switchyard 的 macOS 与 Windows 桌面安装包云端构建、制品保存与 GitHub Release 自动发布。

## 1. 目标与边界

将目前依赖本机执行的 Electron 打包迁移到 GitHub Actions，避免本地构建和上传耗时。

本期目标：

- 在 `main` 分支推送后，自动执行检查、测试和 macOS / Windows 打包；
- 将 `main` 构建产物保存为 GitHub Actions Artifact，保留 14 天；
- 推送严格格式为 `vX.Y.Z` 的正式版本 Tag 时，自动构建并创建 GitHub Release；
- Release 包含 macOS ARM64/x64 DMG、Windows x64 NSIS 安装包和 x64 ZIP；
- 发布前严格校验 Tag 与 `package.json` 的版本一致。

本期不包含：

- macOS Developer ID 签名、公证或 Windows 代码签名；
- Linux 安装包；
- 自动更新服务、部署到第三方分发平台；
- 预发布 Tag（如 `-beta`、`-rc`）。

## 2. 现状

仓库已具备 Electron Builder 配置和以下脚本：

| 能力 | 命令 | 现有输出 |
| --- | --- | --- |
| 静态检查 | `npm run check` | Node.js 运行时文件语法检查 |
| 单元测试 | `npm test` | `packages/core/test/*.mjs` |
| 发布前检查 | `npm run release:check` | 配置模板、测试、语法和打包必要文件检查 |
| macOS 打包 | `npm run desktop:dmg` | ARM64 与 x64 DMG |
| Windows 打包 | `npm run desktop:win` | x64 NSIS `.exe` 与 `.zip` |

`package.json` 要求 Node.js `>=20`。macOS 打包过程沿用 `scripts/after-pack-sign.mjs` 的 ad-hoc 签名；本工作流不引入任何签名证书或密钥。

## 3. 推荐方案：单一矩阵工作流

新增 `.github/workflows/release.yml`，以单个工作流承载持续验证与正式发布。

```text
push main 或 vX.Y.Z Tag
          │
          ▼
   build（矩阵并行）
   ├── macos-latest
   │   ├── npm ci
   │   ├── npm run check / npm test / npm run release:check
   │   ├── npm run desktop:dmg
   │   └── 上传两个 DMG
   └── windows-latest
       ├── npm ci
       ├── npm run check / npm test / npm run release:check
       ├── npm run desktop:win
       └── 上传 NSIS EXE 与 ZIP
          │
          ▼（仅 vX.Y.Z Tag 且两端均成功）
       release
       ├── 校验 Tag 与 package.json.version
       ├── 下载两个平台产物
       └── 创建 GitHub Release 并上传四个安装包
```

采用单一矩阵工作流的原因：两个平台可并行构建，配置、失败状态与制品传递集中管理；对当前两个目标平台而言，比多工作流编排更易维护。

## 4. 触发与版本规则

### 4.1 触发条件

```yaml
on:
  push:
    branches: [main]
    tags: ["v[0-9]+.[0-9]+.[0-9]+"]
```

- `main` 推送：运行完整校验和打包，并上传临时 Artifact；不创建 GitHub Release。
- `vX.Y.Z` Tag 推送：运行相同校验和打包；构建成功后创建正式 GitHub Release。
- 非正式 Tag（包括 `v2.2.11-beta.1`、`v2.2.11-rc.1`）不触发该工作流。

### 4.2 版本一致性校验

仅在 Tag 发布路径中检查版本：

1. 从 GitHub ref 取得 Tag，例如 `v2.2.11`；
2. 去掉开头的 `v`，得到 `2.2.11`；
3. 从 `package.json` 读取 `version`；
4. 两者必须严格相等，否则 `release` Job 失败，且不得创建 Release。

这避免 Tag、应用版本和文件名不一致。

## 5. 构建环境与制品

### 5.1 环境

| 项目 | 规则 |
| --- | --- |
| Node.js | 固定 Node 20 |
| 安装 | `npm ci`，以提交的 `package-lock.json` 保证可复现 |
| 缓存 | 仅启用 npm 下载缓存，不缓存 `node_modules`，避免跨平台原生依赖污染 |
| macOS Runner | `macos-latest` |
| Windows Runner | `windows-latest` |

每个构建 Job 在打包前按以下顺序运行：

```text
npm ci
npm run check
npm test
npm run release:check
平台对应打包命令
```

### 5.2 收集与命名

所有平台只从 `dist/` 中收集最终安装包：

| 平台 | 匹配文件 | 上传 Artifact | Release 附件 |
| --- | --- | --- | --- |
| macOS | `dist/*.dmg` | `switchyard-macos` | 两个 DMG |
| Windows | `dist/*.exe`、`dist/*.zip` | `switchyard-windows` | NSIS EXE、ZIP |

工作流不二次重命名 Electron Builder 产物，保持版本化默认文件名。构建输出找不到预期文件时，上传步骤必须失败，从而阻断不完整发布。

`main` 与 Tag 均保存 Actions Artifact；Artifact 保留 14 天，Tag 的长期下载入口为 GitHub Release。

## 6. 发布、权限与并发控制

### 6.1 发布

`release` Job 依赖 macOS、Windows 两个构建 Job 成功。仅当当前 ref 是正式 Tag 时：

1. 检出该 Tag；
2. 校验 Tag 与 `package.json.version`；
3. 下载两个 Artifact；
4. 使用 GitHub 内置 `GITHUB_TOKEN` 创建正式 Release 并上传附件。

任何构建或版本校验失败都会阻止创建 Release，避免出现空发布或缺少一个平台的发布。

### 6.2 最小权限

工作流声明：

```yaml
permissions:
  contents: write
```

该权限只用于创建 GitHub Release 和上传附件，不需要额外 GitHub Secrets。

### 6.3 并发

```yaml
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: true
```

同一分支或同一 Tag 的重复触发会取消仍在运行的旧任务，节省 macOS Runner 时间；不同 ref 可以并行执行。

## 7. 依赖 Action

使用以下 Action：

- `actions/checkout@v4`
- `actions/setup-node@v4`
- `actions/upload-artifact@v4`
- `actions/download-artifact@v4`
- `softprops/action-gh-release@v2`

## 8. 失败处理

- `npm ci`、检查、测试、发布前检查或打包失败：对应平台 Job 失败；
- 若任意平台 Job 失败：Tag 场景下 `release` Job 不执行；
- Tag 不符合版本一致性：`release` Job 失败；
- `dist/` 缺少任一预期扩展名文件：制品上传失败；
- Release 上传失败：工作流失败，GitHub 会显示失败日志，便于重新运行或在修复后重新推送正确 Tag。

## 9. 验证计划

完成实施后按以下顺序验证：

1. 本地执行 `npm ci`、`npm run check`、`npm test`、`npm run release:check`；
2. 检查工作流 YAML 和触发条件；
3. 推送到 `main`，确认 macOS / Windows Job 并行执行并产生可下载 Artifact；
4. 推送与 `package.json.version` 相同的正式 Tag，确认 GitHub Release 自动创建且带齐四类安装包；
5. 推送一个版本不匹配的正式 Tag，确认工作流失败且没有创建 Release。

## 10. 已知限制

- macOS 仅采用 ad-hoc 签名，未公证包初次运行可能受 Gatekeeper 拦截；
- Windows 安装包和 ZIP 未代码签名，可能触发 SmartScreen 提示；
- Linux 不在本期范围；
- `main` 的每次推送都会执行完整跨平台打包，符合持续验证要求，但会产生对应 GitHub-hosted Runner 用量。

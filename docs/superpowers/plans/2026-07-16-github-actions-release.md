# GitHub Actions 自动构建与发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `main` 自动构建 macOS/Windows 桌面安装包，并在匹配应用版本的正式 Tag 推送时自动创建包含安装包的 GitHub Release。

**Architecture:** 新增一个 GitHub Actions 工作流，以 macOS 和 Windows 矩阵 Job 并行执行现有的校验、测试和 Electron Builder 打包命令。一个仅在 Tag 场景执行的验证 Job 会使用正则严格验证 Tag 格式和 `package.json.version`，两个构建都成功后由 release Job 下载制品并创建 Release。

**Tech Stack:** GitHub Actions、Node.js 20、npm、Electron Builder、`actions/*@v4`、`softprops/action-gh-release@v2`。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `.github/workflows/release.yml` | `main` 验证构建、正式 Tag 校验、跨平台产物上传与 GitHub Release 创建。 |
| `docs/superpowers/plans/2026-07-16-github-actions-release.md` | 本实施计划。 |

> GitHub Actions 的 `on.push.tags` 仅支持 glob，不支持精确的语义版本正则。因此工作流使用 `v*` 接收候选 Tag，再由 `validate-release` Job 严格以 `^v[0-9]+\.[0-9]+\.[0-9]+$` 验证。非正式 Tag 会在验证阶段失败，绝不会构建、发布或创建 Release。

### Task 1: 新增跨平台构建与发布工作流

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: 新增 Tag 验证 Job，先阻止不合规发布**

在 `.github/workflows/release.yml` 写入以下工作流骨架和 `validate-release` Job：

```yaml
name: Build and release desktop app

on:
  push:
    branches:
      - main
    tags:
      - "v*"

permissions:
  contents: write

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: true

jobs:
  validate-release:
    if: github.ref_type == 'tag'
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
    steps:
      - uses: actions/checkout@v4

      - id: version
        shell: bash
        run: |
          set -euo pipefail
          tag_name="${GITHUB_REF_NAME}"
          if [[ ! "${tag_name}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "只允许正式版本 Tag：vX.Y.Z；实际为 ${tag_name}" >&2
            exit 1
          fi

          package_version="$(node --input-type=module -e 'import pkg from "./package.json" with { type: "json" }; console.log(pkg.version)')"
          tag_version="${tag_name#v}"
          if [[ "${tag_version}" != "${package_version}" ]]; then
            echo "Tag 版本 ${tag_version} 与 package.json 版本 ${package_version} 不一致" >&2
            exit 1
          fi

          echo "version=${package_version}" >> "${GITHUB_OUTPUT}"
```

- [ ] **Step 2: 确认验证命令在仓库当前 Node.js 环境可运行**

运行：

```bash
cd ~/code/codex/switchyard
node --input-type=module -e 'import pkg from "./package.json" with { type: "json" }; console.log(pkg.version)'
```

预期：输出当前版本 `2.2.10`（或执行时 `package.json` 中的版本），退出码为 0。

- [ ] **Step 3: 新增 macOS/Windows 矩阵构建 Job**

在同一文件的 `validate-release` Job 后追加：

```yaml
  build:
    needs: validate-release
    if: always() && (github.ref_type == 'branch' || needs.validate-release.result == 'success')
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            artifact_name: switchyard-macos
            package_command: npm run desktop:dmg
            artifact_path: dist/*.dmg
          - os: windows-latest
            artifact_name: switchyard-windows
            package_command: npm run desktop:win
            artifact_path: |
              dist/*.exe
              dist/*.zip
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci
      - run: npm run check
      - run: npm test
      - run: npm run release:check
      - run: ${{ matrix.package_command }}

      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact_name }}
          path: ${{ matrix.artifact_path }}
          if-no-files-found: error
          retention-days: 14
```

- [ ] **Step 4: 本地执行跨平台 Job 共同的质量门禁**

运行：

```bash
cd ~/code/codex/switchyard
npm ci
npm run check
npm test
npm run release:check
```

预期：四个命令均以退出码 0 完成；不执行本地 DMG 或 Windows 打包，因为其由对应 GitHub-hosted Runner 验证。

- [ ] **Step 5: 新增仅限成功正式 Tag 的 Release Job**

在同一文件的 `build` Job 后追加：

```yaml
  release:
    if: github.ref_type == 'tag'
    needs:
      - validate-release
      - build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with:
          path: release-assets
          merge-multiple: true

      - name: 确认四类发布安装包齐全
        shell: bash
        run: |
          set -euo pipefail
          shopt -s nullglob
          macos_packages=(release-assets/*.dmg)
          windows_installers=(release-assets/*.exe)
          windows_archives=(release-assets/*.zip)

          [[ ${#macos_packages[@]} -eq 2 ]] || { echo "期望 2 个 macOS DMG，实际为 ${#macos_packages[@]}" >&2; exit 1; }
          [[ ${#windows_installers[@]} -eq 1 ]] || { echo "期望 1 个 Windows NSIS EXE，实际为 ${#windows_installers[@]}" >&2; exit 1; }
          [[ ${#windows_archives[@]} -eq 1 ]] || { echo "期望 1 个 Windows ZIP，实际为 ${#windows_archives[@]}" >&2; exit 1; }

      - uses: softprops/action-gh-release@v2
        with:
          generate_release_notes: true
          files: |
            release-assets/*.dmg
            release-assets/*.exe
            release-assets/*.zip
```

- [ ] **Step 6: 校验 YAML 语法与工作流结构**

运行：

```bash
cd ~/code/codex/switchyard
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release.yml"); puts "release.yml YAML valid"'
grep -nE '^(name:|on:|permissions:|concurrency:|jobs:|  validate-release:|  build:|  release:)' .github/workflows/release.yml
```

预期：第一条命令输出 `release.yml YAML valid`；第二条命令列出三个 Job。YAML 解析只校验语法，GitHub Actions 的表达式会在远程触发时由平台解释。

- [ ] **Step 7: 检查变更范围并提交**

运行：

```bash
cd ~/code/codex/switchyard
git diff --check
git status --short
git add .github/workflows/release.yml docs/superpowers/plans/2026-07-16-github-actions-release.md
git commit -m "ci: add desktop build and release workflow"
```

预期：`git diff --check` 无输出并以退出码 0 完成；提交只包含工作流和本计划，不能把已有未跟踪的 `index.html` 纳入提交。

### Task 2: 在 GitHub 上执行端到端验证

**Files:**
- Verify: `.github/workflows/release.yml`
- Verify: GitHub Actions 运行记录与仓库 Releases 页面

- [ ] **Step 1: 推送包含工作流的 main 分支提交**

运行：

```bash
cd ~/code/codex/switchyard
git push origin main
```

预期：GitHub Actions 中出现 `Build and release desktop app` 运行；macOS 与 Windows 矩阵任务均运行，`release` Job 不运行。

- [ ] **Step 2: 验证 main 构建制品**

在 GitHub Actions 该运行的 Artifacts 区域检查：

- `switchyard-macos` 包含两个 `.dmg` 文件；
- `switchyard-windows` 包含一个 `.exe` 与一个 `.zip`；
- 两个 Artifact 的保留期均为 14 天。

- [ ] **Step 3: 在版本升级提交中同步 package.json 与 Tag**

将 `package.json` 中的 `version` 更新为下一个正式版本，例如：

```json
{
  "version": "2.2.11"
}
```

同步更新 `package-lock.json` 根包版本，运行完整本地质量门禁后提交并推送。不要移动或重用已存在的 Tag。

- [ ] **Step 4: 创建与 package.json 完全匹配的正式 Tag 并推送**

运行（以 `2.2.11` 为例）：

```bash
cd ~/code/codex/switchyard
git tag v2.2.11
git push origin v2.2.11
```

预期：两个平台 Job 成功后，`release` Job 创建 `v2.2.11` GitHub Release，包含 2 个 DMG、1 个 EXE 和 1 个 ZIP。

- [ ] **Step 5: 验证不匹配 Tag 被阻止（仅在后续有可废弃版本提交时执行）**

在一个不用于发布的测试提交上创建不一致 Tag，例如：

```bash
cd ~/code/codex/switchyard
git tag v999.999.999
git push origin v999.999.999
```

预期：`validate-release` Job 报告 Tag 版本和 `package.json.version` 不一致，`build` 与 `release` Job 不执行，GitHub Releases 中没有 `v999.999.999`。

验证完成后删除测试 Tag，避免仓库留下误导性版本：

```bash
git push origin --delete v999.999.999
git tag -d v999.999.999
```

## 实施前自检

- **规格覆盖：** Task 1 覆盖 `main` 制品、macOS/Windows 矩阵构建、Node 20/npm 缓存、14 天 Artifact、严格 Tag/版本校验、最小权限、并发控制、Release 附件完整性和无签名密钥；Task 2 覆盖远程成功与失败路径验证。
- **范围：** 不改变应用打包配置、不引入签名、Linux 或自动更新能力；不接触已有未跟踪 `index.html`。
- **歧义处理：** GitHub Actions Tag 触发仅支持 glob，故候选 Tag `v*` 会进入一个快速验证 Job；只有严格匹配 `vX.Y.Z` 的 Tag 能运行构建并发布。

---
title: Switchyard V0.5 交付
status: ready-for-review
created: 2026-06-23
---

# Switchyard V0.5 交付 — 团队可用版

## 交付范围

V0.5 把 V0.4 的工程产物打磨为可分发给同事的产品：
- macOS DMG 安装包
- 首次启动自动检测并提示导入 cc-switch 配置
- 同事安装手册
- README
- 干净安装演练验证

> 代码仓库：`/Users/zhangyinglong/code/codex/switchyard`
> DMG 输出：`dist/Switchyard-0.2.0-arm64.dmg`（96 MB）
> 对应产品文档章节：第 8.5 节
> 总单元测试：62 通过 / 0 失败

## 关键调整：导入而非导出

最初规划是「脱敏导出包让同事导入」。和用户确认后调整为：

**直接打 DMG → 同事装上 → 在自己机器上重新导入自己的 cc-switch 配置 → 在自己的终端设置自己的 key**。

这样同事拿到的是工具本身（DMG），不是「我的脱敏配置」，更符合实际工作流，也不需要在邮件/IM 里传输 JSON 文件。

## 首次启动自动导入流程

新代码：`apps/desktop/renderer/renderer.js` 的 `checkFirstLaunch()`。

当 Switchyard 首次启动（`~/.switchyard/config.json.providers.length === 0`）：

1. 自动调用 `import:ccswitch` IPC
2. 如果 `~/.cc-switch/cc-switch.db` 存在且有 provider，弹出导入对话框
3. 用户点「合并到配置」即完成首次设置

如果没有 cc-switch（同事是新机器），就什么都不弹，进入空白 UI，让用户手动添加 provider。

## DMG 打包

- 入口：`apps/desktop/src/main.mjs`
- 配置：package.json `main` + `build.extraMetadata.main` 双重设置
- 打包内容：
  - apps/desktop/**
  - packages/core/**
  - config/**
- 排除：`*.map`、所有测试文件、自动外置的 node_modules
- macOS：未签名（`identity: null`），首次启动需要「系统设置 → 隐私 → 仍要打开」
- 已验证：可启动、有窗口、5 秒后被信号杀掉退出码 0

构建命令：
```bash
npm run desktop:dmg
# → dist/Switchyard-0.2.0-arm64.dmg
```

## 干净安装演练（dryrun）

新脚本：`scripts/dryrun-fresh-install.mjs`。

模拟同事在新机器上的完整流程：
1. 备份当前 `~/.switchyard` 到 `/Users/zhangyinglong/file/codex/local-llm-switchboard-v0x-verify/dryrun-backup/*.tar`
2. 删除 `~/.switchyard`
3. 调用 `ensureConfig()` → 创建默认空白 config
4. 调用 `importProviders()` → 从 cc-switch 导入
5. 保存合并后的 config
6. 启动 gateway，验证 4 个客户端入口都能看到模型

实际运行结果：

```
Step 4: import:ccswitch
  import.providers: 11
  import.models   : 38
  import.deduped  : 14
  inline API Key leak: no

Step 6: start gateway
  gateway port: 60562
  codex.models       : 38
  claude-code.models : 38
  hermes.models      : 38
  generic.models     : 38

✓ DRYRUN PASS
```

10/10 验证检查全通过：empty.providers === 0、import succeeded、import 有内容、无密钥泄露、merged 成功、4 个客户端都能看到模型。

## 文档交付

| 文件 | 用途 |
|------|------|
| `README.md` | 项目概览、特性、版本路线 |
| `INSTALL.zh-CN.md` | 完整安装与使用手册（同事使用版） |
| `docs/PRODUCT-SCOPE.zh-CN.md` | 完整产品规划 |
| `docs/HANDOFF-V0.2.zh-CN.md` | V0.2 架构骨架 |
| `docs/HANDOFF-V0.3.zh-CN.md` | V0.3 客户端接入 |
| `docs/HANDOFF-V0.4.zh-CN.md` | V0.4 兼容矩阵 |
| `docs/HANDOFF-V0.5.zh-CN.md` | V0.5 团队可用版（本文件） |

## release-check 全绿

```
[OK] config.example.json contains no inline apiKey
[OK] core unit tests pass
[OK] syntax check (node --check)
[OK] electron-builder mac config exists
[OK] renderer assets present
[OK] core dispatch + importer assets present
[OK] V0.5 docs present
[OK] V0.4 compat patches present
```

## 单元测试

```
ℹ tests 62
ℹ pass 62
ℹ fail 0
```

| 类别 | 用例数 |
|------|--------|
| protocol adapters | 5 |
| compat registry | 3 |
| config | 5 |
| dispatch matrix | 5 + 9 |
| importer (cc-switch / codex / hermes) | 4 |
| profile-writer (V0.3) | 8 |
| router | 5 |
| server | 2 |
| V0.3 multi-client | 2 |
| V0.4 compat patches (5 个 × 2~3 用例 + 1 总测) | 12 |

## 同事拿到 DMG 后的使用路径（覆盖在 INSTALL.zh-CN.md）

```
1. 装 DMG → 「系统设置 → 隐私 → 仍要打开」
2. 启动 Switchyard
3. 如果同事已有 cc-switch：首次启动弹窗自动导入（点「合并到配置」即可）
   如果同事是新机器：UI 进入空白态，手动点「+ 新增供应商」
4. 在 ~/.zshrc 设置 SWITCHYARD_*_API_KEY 环境变量（每个 provider 一个）
5. 切到「客户端」tab → 对每个想用的客户端点「一键写入」
6. 切到「测试台」tab → 发请求验证
7. 打开 Codex / Claude Code / Hermes 即可使用
```

## 未授权动作（保留人工触发）

按 goal 边界约束，以下动作需用户明确授权后才执行：

- ⏸ GitHub Release：用户授权后执行 `gh release create` 并附 DMG
- ⏸ 飞书使用文档创建：用户授权后用 `lark-cli` 在 「05 工程工具与配置 / Codex Markdown 备份」目录下创建

DMG 文件已生成在 `dist/Switchyard-0.2.0-arm64.dmg`，可以直接分享给同事；同事按 `INSTALL.zh-CN.md` 操作即可。

## 已知约束

- macOS 签名公证证书暂未申请，DMG 未签名（同事首次启动需手动允许）
- 暂不支持自动更新（手动下载新 DMG 替换即可）
- DMG 仅 arm64（M 系列）；Intel Mac 暂未单独打包，同事如果是 Intel 机器需要从源码运行

## V0.5 成功标准对照

| 标准 | 状态 |
|------|------|
| 脱敏导入导出 | ✅ 调整为「同事在自己机器上直接导入自己的 cc-switch」，不需要脱敏导出 |
| 同事安装手册 | ✅ `INSTALL.zh-CN.md`（197 行，含 Step 1-5 完整流程） |
| 配置模板 | ✅ `config/config.example.json`（无 inline key） |
| GitHub Release | ⏸ 等用户授权 |
| 飞书使用文档 | ⏸ 等用户授权 |
| 自动更新或更新提示 | ⏸ 第一阶段不做（保留给 V1.0） |
| 常见问题诊断页 | ✅ INSTALL.zh-CN.md 「常见问题」章节（9 条 Q&A） |
| 同事干净安装演练 | ✅ `scripts/dryrun-fresh-install.mjs` 10/10 检查全通过 |

---

*此文档对应 PRODUCT-SCOPE.zh-CN.md 第 8.5 节的 V0.5 成功标准：同事安装 DMG 后，根据文档导入 cc-switch 配置 / 填入 key，即可使用已有模板接入 Codex / Claude Code / Hermes。*

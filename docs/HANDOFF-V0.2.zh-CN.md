---
title: Switchyard V0.2 交付
status: ready-for-review
created: 2026-06-23
---

# Switchyard V0.2 交付 — Electron 管理台骨架

## 交付范围

V0.2 的目标是跑通 Electron 管理台核心链路：配置管理（provider / model CRUD）、网关自动启动、客户端模型分发、cc-switch 一键导入、服务控制（启动/停止/重启/重载）、日志实时推送、自检诊断。

> 代码仓库：`/Users/zhangyinglong/code/codex/switchyard`
> 核心可执行：`npm run desktop`

## 产品文档对照

对应 [PRODUCT-SCOPE.zh-CN.md](./PRODUCT-SCOPE.zh-CN.md) 第 8.2 节。

## 已实现功能

### Electron 应用壳
- 主进程入口 `apps/desktop/src/main.mjs`：BrowserWindow 创建、IPC 通道注册（config:read/save/file/raw、gateway:start/stop/restart/reload/status/doctor、logs:snapshot/open-folder/open-file、dialog:info、import:ccswitch）
- 预加载桥 `apps/desktop/src/preload.cjs`：暴露 `window.lls.invoke` 和 `window.lls.onLog`

### 首页总览（overview tab）
- 服务状态卡片：运行/未启动、监听地址、配置文件路径、供应商/模型数
- 客户端接入卡片：4 个入口端点（Codex、Claude Code、Hermes、通用 OpenAI），一键复制
- 自检面板：调用 server 端 doctor 检查每个 provider 的 key 状态

### 供应商管理（providers tab）
- 表格展示：id、名称、协议、Base URL、API Key 类型、关联模型数
- 新增/编辑/删除供应商
- 从 cc-switch 导入（带预览和合并确认对话框）

### 模型管理（models tab）
- 表格展示：模型 ID、供应商、上游模型名、别名、能力标签
- 新增/编辑/删除模型
- 搜索过滤（按 id、别名、上游名）

### 客户端视图（clients tab）
- 按客户端分组展示已授权的模型列表
- 已导入 11 providers / 38 models 后，3 个客户端入口各可见 38 个模型

### 服务控制
- 启动/停止/重启/重载配置按钮
- 自动启动：Electron 启动时自动拉起 gateway 服务
- 服务状态侧栏动态更新

### 日志
- 实时日志流推送（通过 IPC subscribe）
- 清空显示 / 打开日志目录
- 500 条内存环形缓冲区持久化到 `~/.switchyard/logs/gateway.log`

### 偏好设置
- 配置文件路径展示

### cc-switch 导入器
- `packages/core/src/importers/ccswitch.mjs`：从 SQLite 读取 cc-switch 配置，去重后转换为 Switchyard 配置格式
- CLI 入口：`npm run import:ccswitch [--apply]`
- UI 导入对话框：预览导入结果 → 确认合并
- 所有 API Key 已映射为环境变量，**不写入 inline key**

## 核心架构

### Core Gateway (`packages/core/src/`)

| 文件 | 职责 |
|------|------|
| `config.mjs` | 配置加载/校验/持久化、模型按客户端过滤、`mergeWithDefaults` |
| `router.mjs` | 路由解析：alias → upstream model，按客户端可见性过滤 |
| `server.mjs` | HTTP 服务：4 个客户端前缀路由、3 种协议输入、热重载 |
| `utils.mjs` | 工具函数：configPath/logDir/backupDir、JSON 读写、文本提取 |
| `openai-adapter.mjs` | Chat ↔ Responses 双向协议转换 (inbound) |
| `openai-adapter-out.mjs` | Chat ← Responses 上行适配 (outbound) |
| `anthropic-adapter.mjs` | Messages ↔ Chat 双向协议转换 (inbound) |
| `anthropic-adapter-out.mjs` | Chat ← Messages 上行适配 (outbound) |
| `upstream/clients.mjs` | 3 个 HTTP client：openai_chat、openai_responses、anthropic_messages |
| `upstream/dispatch.mjs` | 按 provider.apiFormat 选路分发到对应 client |
| `compat/index.mjs` | provider/model 定向补丁注册中心 |
| `profile-writer.mjs` | 客户端配置文件生成（V0.3 启用） |
| `importers/ccswitch.mjs` | cc-switch SQLite 批量导入 |

### 核心链路

```
请求 → detectClient() → protocol adapter (input) → dispatchChat()
    → compat patches (outbound) → upstream client
    → compat patches (inbound) → protocol adapter (output)
```

### 多协议矩阵（全部 9 条路径已覆盖）

```
client=chat    × upstream=openai_chat       ✓
client=chat    × upstream=openai_responses   ✓
client=chat    × upstream=anthropic_messages ✓
client=responses × upstream=openai_chat     ✓
client=responses × upstream=openai_responses ✓
client=responses × upstream=anthropic_messages ✓
client=messages × upstream=openai_chat      ✓
client=messages × upstream=openai_responses  ✓
client=messages × upstream=anthropic_messages ✓
```

## 验证结果

### 单元测试（40/40 ✅）
```
npm test → 40 pass, 0 fail
```

### release-check 全线通过 ✅
```
config.example.json 无 inline API Key  ✓
core unit tests pass                   ✓
syntax check (node --check)            ✓
electron-builder mac config exists     ✓
renderer assets present                ✓
core dispatch + importer assets present ✓
```

### Electron 端到端冒烟 ✅
```
config.summary: 11 providers / 38 models
gateway autostart: 随机端口 ✓
/codex/v1/models: 38 个模型 status 200 ✓
/claude-code/v1/models: 38 个模型 status 200 ✓
/v1/models: 38 个模型 status 200 ✓
hot reload: config 重载成功 ✓
doctor: 11 个 provider key 状态 ✓
renderer HTML 正常加载 ✓
```

### 配置示例 `config/config.example.json`
- 包含一个完整 demo 配置（1 个 provider + 2 个 models + 3 个 clients）
- 不含任何 inline API Key

## 已知问题（不影响 V0.2 交付）

1. Electron 需要用户手动批准 `allow-scripts` 才能安装成功；后续 DMG 构建后用户无需担心此问题
2. cc-switch SQLite 依赖本机安装的 `sqlite3` 二进制（macOS 自带），如果用户卸载了则需要 `brew install sqlite3`
3. 测试台（Test Console）和 Hermes profile 写入规划在 V0.3
4. 开关机自动重启待 V0.5 评估

## 使用方式

```bash
cd /Users/zhangyinglong/code/codex/switchyard
npm install               # 安装依赖（首次需要 npm approve-scripts electron）
npm run desktop           # 启动 Electron 管理台
npm test                  # 运行 40 个单元测试
npm run release:check     # 发版前完整性检查
npm run import:ccswitch -- --apply   # 从 cc-switch 批量导入
```

## 下一步（V0.3）

1. Codex / Claude Code / Hermes Client Profile 一键写入、备份、恢复
2. alias 可视化编辑
3. `/v1/models` 按客户端返回不同可见模型列表
4. 测试台：文本、stream、多轮

---

*此文档对应 PRODUCT-SCOPE.zh-CN.md 第 8.2 节并完成 V0.2 成功标准：不手改 JSON 也可管理配置、Codex 和 Claude Code 可通过 UI 复制接入配置、自检可判断服务是否正常。*

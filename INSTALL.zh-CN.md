# Switchyard 安装与使用手册

> 版本：V0.5（团队可用版）
> 更新：2026-06-23

## 简介

Switchyard 是一个本机多客户端 AI 模型网关和桌面管理台。它让你：

- 在统一的 UI 中管理多个 AI 供应商（OpenAI / Anthropic / DeepSeek / Kimi / GLM 等）
- 同时为 Codex、Claude Code、Hermes 提供兼容协议入口
- 一键导入 cc-switch 现有配置
- 一键写入 Codex / Claude Code / Hermes 客户端配置文件
- 在测试台直接验证模型是否可用

**核心原则**：所有的密钥都通过环境变量加载，不进配置文件、不进日志、不进备份包。

## 系统要求

- macOS 14.0+（Sonoma / Sequoia，Apple Silicon）
- 网络可访问上游 AI 供应商 API
- 已使用 cc-switch（可选；首次启动会自动检测并提示导入）

## 安装

### 同事场景（最常见）：拿到 DMG

1. 同事把 `Switchyard-<版本>.dmg` 发给你（GitHub Release 或飞书附件）
2. 双击挂载，把 Switchyard.app 拖到「应用程序」
3. 首次启动时 macOS 会提示「未验证的开发者」：
   - 打开「系统设置 → 隐私与安全性 → 仍要打开」
   - 点击「打开」
4. Switchyard 启动后自动创建 `~/.switchyard/config.json`

> 当前 DMG 未签名公证，所以需要手动允许；后续会申请证书。

### 开发者场景：从源码运行

```bash
git clone https://github.com/zhangyinglong3550/switchyard.git switchyard
cd switchyard
npm install
npm run desktop
```

## 首次使用

### Step 1 · 启动 Switchyard

```bash
open -a Switchyard          # DMG 安装
# 或
cd switchyard && npm run desktop
```

### Step 2 · 导入 cc-switch 配置（自动）

如果你本机已经在用 cc-switch，**Switchyard 首次启动会自动检测 `~/.cc-switch/cc-switch.db`，弹窗提示一键导入**。点击「合并到配置」即可。

如果没自动弹，也可以手动触发：
- 总览页 → 点「从 cc-switch 导入…」
- 或 供应商页 → 同样按钮

导入会：
- 从 cc-switch SQLite 中读取所有 provider 和 model
- 自动识别协议类型（openai_chat / openai_responses / anthropic_messages）
- 自动给每个 provider 分配环境变量名（例：`SWITCHYARD_KIMI_API_KEY`）
- **不会**复制任何 API Key 到 Switchyard 配置里

### Step 3 · 在终端配置环境变量

导入完成后，UI 会显示需要设置的环境变量列表（也可以在「供应商」tab 看每个 provider 的 `apiKeyEnv` 字段）。

在 `~/.zshrc` 或 `~/.bash_profile` 中添加：

```bash
# 来自 cc-switch 的同一份 key，复制粘贴到 Switchyard 对应的 env 名下
export SWITCHYARD_CLAUDE_API_KEY="sk-ant-..."
export SWITCHYARD_KIMI_API_KEY="..."
export SWITCHYARD_DEEPSEEK_API_KEY="sk-..."
# ... 其他 provider 同理
```

然后 `source ~/.zshrc` 或关闭终端重开。

> 提示：cc-switch 的 key 通常存在 `~/.cc-switch/cc-switch.db` 中，可以用 `sqlite3 ~/.cc-switch/cc-switch.db "SELECT name, settings_config FROM providers"` 看到。Switchyard 不读取这些 key，只读取 provider/model 结构。

### Step 4 · 一键写入客户端配置

切到「客户端」tab，每个客户端卡片有三个按钮：

- **预览**：查看即将写入的内容
- **一键写入**：写入对应配置文件，原文件自动备份到 `~/.switchyard/backups/`
- **恢复备份**：回到上次写入前的状态

| 客户端 | 写入文件 |
|--------|----------|
| Codex | `~/.codex/config.toml` |
| Claude Code | `~/.claude/settings.json` |
| Hermes | `~/.hermes/config.json` |

写入后，重启对应客户端即可看到 Switchyard provider。

### Step 5 · 在测试台验证

切到「测试台」tab：
1. 选一个模型
2. 输入 prompt → 点「发送」
3. 看是否返回内容（如果返回 401，说明对应 provider 的环境变量没设对）

可勾选「启用 stream」测试流式回复。

## 接入其它工具

Switchyard 同时提供 4 个客户端入口路径：

| 客户端类型 | 入口路径示例 | 协议 |
|-----------|--------------|------|
| Codex | `http://127.0.0.1:<端口>/codex/v1` | OpenAI Responses |
| Claude Code | `http://127.0.0.1:<端口>/claude-code` | Anthropic Messages |
| Hermes | `http://127.0.0.1:<端口>/hermes/v1` | OpenAI Chat |
| 通用 OpenAI 兼容 | `http://127.0.0.1:<端口>/v1` | OpenAI Chat |

端口在「总览」tab 看到。

## 日常操作

### 添加新供应商

供应商 tab → 「+ 新增供应商」→ 填 id、协议、Base URL、API Key 环境变量名 → 保存。

### 添加新模型

模型 tab → 「+ 新增模型」→ 选供应商，填模型名 → 保存。
保存后所有客户端立刻可见，**不需要重启 Switchyard**。

### 重新导入 cc-switch

任意时刻可以在总览页点「从 cc-switch 导入…」重新预览/合并。已存在的 provider/model 会自动跳过，避免重复。

### 看日志

日志 tab 实时显示请求路由、错误。日志文件在 `~/.switchyard/logs/gateway.log`，按行 JSON。

## 常见问题

### Q: 启动后界面是空的

A: 如果是从源码运行，确认 `npm install` 成功；DMG 安装的检查启动权限。

### Q: 测试台返回 401

A: 对应 provider 的 API Key 环境变量没设。在终端 `echo $SWITCHYARD_XXX_API_KEY` 确认有值。**改完环境变量后需要重启 Switchyard**（它启动时读取一次）。

### Q: Codex 看不到 Switchyard 的模型

A: 在客户端 tab 对 Codex 点「一键写入」→ 然后**重启** Codex Desktop。

### Q: Claude Code 报连接拒绝

A: 检查 Switchyard 是否在运行（总览页服务状态）。如果停了，点「启动」。

### Q: 我有新的 provider 想加，但不在 cc-switch 里

A: 直接在供应商 tab 「+ 新增供应商」即可，不必经过 cc-switch。

### Q: 我手动改了 ~/.switchyard/config.json，Switchyard 不更新

A: 点总览页的「重载配置」按钮，或者 UI 操作任何 provider/model 也会触发自动重载。

### Q: 想恢复到没装 Switchyard 之前的 Codex / Claude Code 配置

A: 客户端 tab → 对应客户端卡片 → 「恢复备份」。

### Q: 默认端口 17888 和别人冲突

A: 编辑 `~/.switchyard/config.json` 的 `port` 字段，重启 Switchyard。

### Q: cc-switch 数据库不在默认路径

A: Switchyard 找 `~/.cc-switch/cc-switch.db`。如果你的 cc-switch 装在别处，可以做软链接：`ln -s /your/path/cc-switch.db ~/.cc-switch/cc-switch.db`。

## 安全须知

- 不要把 `~/.switchyard/config.json`、`~/.switchyard/logs/` 提交到 Git
- Switchyard 的配置文件**绝对**不应该有明文 API Key（导入器会确保这一点）
- 如果手动添加 provider 时勾了「直接保存 Key 到本机配置文件」，仅在自己机器上使用，**不要**把这个文件给同事
- 怀疑密钥泄露，立即在对应供应商管理后台轮换 key，然后更新本机环境变量

## 文档索引

- [README.md](./README.md) — 项目概览
- [docs/PRODUCT-SCOPE.zh-CN.md](./docs/PRODUCT-SCOPE.zh-CN.md) — 完整产品规划
- [docs/HANDOFF-V0.2.zh-CN.md](./docs/HANDOFF-V0.2.zh-CN.md) — V0.2 架构骨架
- [docs/HANDOFF-V0.3.zh-CN.md](./docs/HANDOFF-V0.3.zh-CN.md) — V0.3 客户端接入
- [docs/HANDOFF-V0.4.zh-CN.md](./docs/HANDOFF-V0.4.zh-CN.md) — V0.4 兼容矩阵
- [docs/HANDOFF-V0.5.zh-CN.md](./docs/HANDOFF-V0.5.zh-CN.md) — V0.5 团队可用版

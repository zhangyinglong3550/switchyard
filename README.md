# Switchyard

> 本机多客户端 AI 模型网关和桌面管理台。
> Local multi-client AI model gateway and desktop control panel.

[![tests](https://img.shields.io/badge/tests-228%20passing-brightgreen)]() [![license](https://img.shields.io/badge/license-MIT-blue)]() [![platform](https://img.shields.io/badge/platform-macOS-lightgrey)]()

Switchyard 让你在一个 macOS 桌面 app 里统一管理多个 AI 供应商（OpenAI / Anthropic / DeepSeek / Kimi / GLM / etc.），并同时为 Codex、Claude Code、Hermes 和任意 OpenAI-compatible / Anthropic-compatible 工具提供本机 HTTP 入口。

## 核心特性

- **统一供应商管理**：一个 UI 配置所有 provider/model/alias
- **多客户端同时服务**：Codex（Responses）、Claude Code（Messages）、Hermes、通用工具（Chat）共享同一份配置
- **一键写入 profile**：自动备份现有配置后写入 `~/.codex/config.toml`、`~/.claude/settings.json`、`~/.hermes/config.json`
- **协议自动适配**：客户端协议 ↔ canonical chat ↔ upstream 协议，3 × 3 矩阵全覆盖
- **provider/model 定向兼容补丁**：5 个 V0.4 内置补丁（Kimi 工具 schema、DeepSeek reasoning、GLM content、OpenCode 历史、官方 GPT），互不干扰
- **测试台**：在 UI 内直接发请求验证模型连通性
- **cc-switch 一键导入**：批量迁移已有配置
- **脱敏导出**：自动剥离密钥后生成可分享的 JSON
- **密钥永不入文件**：全部通过环境变量加载

## 快速开始

### 安装

详见 [INSTALL.zh-CN.md](./INSTALL.zh-CN.md)。

```bash
git clone https://github.com/zhangyinglong3550/switchyard.git switchyard
cd switchyard
npm install
npm run desktop
```

### 配置环境变量

```bash
# ~/.zshrc
export SWITCHYARD_DEEPSEEK_API_KEY="sk-..."
export SWITCHYARD_KIMI_API_KEY="..."
# ... 按需添加
```

### 启动 Switchyard

```bash
npm run desktop
```

或运行打包好的 DMG。

## 项目结构

```
switchyard/
├── apps/desktop/                  # Electron 主进程 + renderer
│   ├── src/
│   │   ├── main.mjs               # IPC handlers
│   │   ├── preload.cjs            # contextBridge
│   │   ├── gateway-host.mjs       # 网关生命周期
│   │   ├── config-store.mjs       # 配置 IO
│   │   └── logs.mjs               # 日志缓冲与推送
│   └── renderer/                  # A1 中文版 UI
├── packages/core/                 # Gateway 核心库
│   ├── src/
│   │   ├── server.mjs             # HTTP server (4 client prefixes)
│   │   ├── config.mjs             # 配置 schema + 校验
│   │   ├── router.mjs             # alias 路由
│   │   ├── upstream/              # 3 上游协议 client + dispatcher
│   │   ├── openai-adapter*.mjs    # chat ↔ responses
│   │   ├── anthropic-adapter*.mjs # chat ↔ messages
│   │   ├── compat/
│   │   │   ├── index.mjs          # 注册中心
│   │   │   └── patches/           # 5 个定向补丁
│   │   ├── profile-writer.mjs     # 客户端 profile 智能合并
│   │   └── importers/ccswitch.mjs # cc-switch 导入
│   ├── bin/gateway.mjs            # CLI 入口
│   └── test/                      # 核心单测
├── scripts/
│   ├── release-check.mjs          # 发版前检查
│   ├── sanitize-export.mjs        # 脱敏导出
│   ├── import-export.mjs          # 接收导出
│   └── import-ccswitch.mjs        # cc-switch CLI
├── docs/
│   ├── PRODUCT-SCOPE.zh-CN.md     # 产品规划
│   └── HANDOFF-V0.2..0.5.zh-CN.md # 每阶段交付文档
├── config/config.example.json     # 配置模板（无 inline key）
└── INSTALL.zh-CN.md               # 安装与使用手册
```

## 常用命令

```bash
npm test                            # unit tests
npm run check                       # syntax check
npm run gateway                     # CLI 启动（无 UI）
npm run gateway:init                # 初始化默认配置
npm run gateway:doctor              # 配置自检
npm run gateway:models              # 列出当前所有模型
npm run desktop                     # 启动 Electron UI
npm run desktop:dmg                 # 打包 macOS DMG（未签名）
npm run release:check               # 发版前全套检查
npm run import:ccswitch             # 从 cc-switch 导入（预览）
npm run import:ccswitch -- --apply  # 实际写入
node scripts/sanitize-export.mjs    # 生成脱敏导出包
node scripts/import-export.mjs <f>  # 接收脱敏导出包
```

## 版本路线

| 版本 | 内容 | 状态 |
|------|------|------|
| V0.1 | 技术探针 | 已完成（冻结仓库 local-llm-switchboard） |
| V0.2 | Electron 管理台骨架 | ✅ 已完成 |
| V0.3 | 客户端接入（Codex / Claude Code / Hermes） | ✅ 已完成 |
| V0.4 | 兼容矩阵（5 个定向补丁） | ✅ 已完成 |
| V0.5 | 团队可用版（脱敏导出 + 手册 + Release） | 🚧 进行中 |
| V1.0 | 稳定版（fallback / 健康监控 / 配额） | 规划中 |

详见 [docs/PRODUCT-SCOPE.zh-CN.md](./docs/PRODUCT-SCOPE.zh-CN.md)。

## 设计原则

- **不做**：fallback / retry / cooldown、provider 健康监控、CLIProxyAPI Management API、配额成本统计、Gemini 原生、Vision Bridge、远程公网网关、Computer Use、MCP / Skills 管理、商业计费
- **只做**：本机网关 + 多客户端协议适配 + provider/model 定向补丁 + Electron 桌面控制面板

## License

MIT

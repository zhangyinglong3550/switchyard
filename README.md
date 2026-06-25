# Switchyard

> 一份配置，所有 AI 代理都能用。
> One config. Every AI agent. Zero friction.

[![tests](https://img.shields.io/badge/tests-229%20passing-brightgreen)]()
[![license](https://img.shields.io/badge/license-MIT-blue)]()
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)]()
[![release](https://img.shields.io/badge/release-v0.5.1-blue)](https://github.com/zhangyinglong3550/switchyard/releases)

**Switchyard** 是一个本机多客户端 AI 模型网关和桌面管理台。它把 Codex、Claude Code、Hermes 以及任意兼容 OpenAI / Anthropic 协议的工具接入同一个可视化面板，让你用一份配置管理所有模型供应商，无需关心每个客户端的协议差异。

![Switchyard Overview](docs/assets/screenshots/01-overview.png)

---

## 为什么需要 Switchyard？

如果你同时使用 **Codex**、**Claude Code** 和 **Hermes**，你可能已经遇到过这些问题：

- ❌ 每个工具都要单独配 API Key，改一个模型要改好几个地方
- ❌ 有些模型 Codex 能用但 Claude Code 不行，因为协议不兼容
- ❌ DeepSeek 的思考过程在 Claude Code 里显示混乱
- ❌ Kimi 的工具调用 Schema 不符合 OpenAI 规范，直接报错
- ❌ 想切回官方 Codex，结果之前的会话全部找不到了
- ❌ cc-switch 很好用，但现在还要手动管理环境变量和配置文件

**Switchyard 一次性解决全部问题。**

```
┌───────────────────────────────────────────────────┐
│                  Switchyard                        │
│           本机统一 AI 代理网关                        │
├───────────────────────────────────────────────────┤
│  Codex  │ Claude Code │ Hermes │ 通用 OpenAI 工具   │
│  (Responses) │ (Messages) │ (Chat) │ (Chat)        │
├───────────────────────────────────────────────────┤
│        Protocol Auto-Adaptation (3×3 Matrix)       │
├───────────────────────────────────────────────────┤
│  OpenAI │ DeepSeek │ Kimi │ GLM │ Anthropic │ ...  │
└───────────────────────────────────────────────────┘
```

---

## 核心能力

### 统一供应商管理
在一个桌面面板里可视化配置所有 AI 供应商和模型。新加一个供应商，Codex、Claude Code、Hermes 同时可见，不需要手动改配置文件。

**支持**：OpenAI / Anthropic / DeepSeek / Kimi / GLM / MiniMax / 火山引擎 / 硅基流动 / OpenRouter / 任意 OpenAI-Compatible

### 协议自动适配
Switchyard 内部维护一个 **3×3 转换矩阵**：客户端协议（Chat / Responses / Messages）↔ 上游协议，自动转换。你不需要关心某个模型是 `openai_chat` 还是 `anthropic_messages`，Switchyard 帮你适配。

### 定向兼容补丁系统
不同模型供应商的 API 行为有差异，Switchyard 内置了 **十几个定向兼容补丁**，自动处理：

- Kimi：剥离 `$schema` / `anyOf` 等不兼容的 Function Calling 参数
- DeepSeek：正确映射 `reasoning_content` 到 Anthropic thinking
- GLM：自动处理 content 数组格式差异
- OpenRouter：reasoning effort 参数自动透传
- 硅基流动：DashScope enable_thinking 映射
- 多模型：工具调用名称规范化和历史顺序修复

### 一键 cc-switch 导入
已有 cc-switch 配置？一键导入所有 provider 和 model，**密钥不会写入 Switchyard 配置**，环境变量方式更安全。

### 会话历史不丢失
在官方直连和 Switchyard 代理之间切换时，旧会话的 `model_provider` 自动统一，**你的对话记录不会丢失**。

### 一键写入客户端 Profile
自动备份现有配置，写入 Codex / Claude Code / Hermes 的配置文件：

| 客户端 | 配置文件 |
|--------|----------|
| Codex | `~/.codex/config.toml` |
| Claude Code | `~/.claude/settings.json` |
| Hermes | `~/.hermes/config.json` |

### Provider 健康监控
实时检测每个上游的可达性和响应状态，在模型不可用时第一时间发现。

### 诊断中心
- **自动错误分类**：网关错误、上游错误、认证失败、协议不兼容，分类一目了然
- **兼容性报告**：诊断模型与网关的兼容性缺口
- **问题打包导出**：一键生成 sanitized 诊断包（自动剥离敏感信息）

### 内置测试台
直接在 UI 里选模型、写 prompt、发请求、看结果。支持流式和非流式两种模式，不需要打开终端。

### 视觉 Fallback
文字模型（如 DeepSeek v3、Kimi）不支持图片输入？Switchyard 自动将图片描述为文字再发给上游，**让所有模型都能"看图"**。

### 调用可视化
实时流量监控面板，展示每个请求的状态、延迟、token 消耗和路由信息，支持展开/收起。

### 多代理可见性控制
每个供应商和模型可以指定对哪些代理可见。例如，某个模型只给 Codex 用，不给 Claude Code 用。

---

## 快速开始

### 下载安装

从 [Releases](https://github.com/zhangyinglong3550/switchyard/releases) 下载最新版本：

| 平台 | 文件 | 说明 |
|------|------|------|
| macOS (Apple Silicon) | `Switchyard-0.5.1-arm64.dmg` | 双击拖入 Applications |
| Windows (x64) | `Switchyard Setup 0.5.1.exe` | 安装向导 |
| Windows (x64 便携) | `Switchyard-0.5.1-win.zip` | 解压即用 |

### 从源码运行

```bash
git clone https://github.com/zhangyinglong3550/switchyard.git
cd switchyard
npm install
npm run desktop
```

### 配置环境变量

```bash
# ~/.zshrc
export SWITCHYARD_DEEPSEEK_API_KEY="sk-..."
export SWITCHYARD_KIMI_API_KEY="..."
export SWITCHYARD_GLM_API_KEY="..."
# 按需添加
```

### 导入 cc-switch（可选）

如果你在用 cc-switch，首次启动 Switchyard 会自动检测并提示导入。也可以在总览页手动触发。导入后：

1. Provider 和 Model 一键迁移
2. 环境变量名自动分配
3. **密钥不写入配置**

---

## 架构

```
┌──────────────────────────────────────────────────┐
│                  Electron Desktop                 │
│   ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│   │ 供应商管理 │ │  模型管理  │ │  测试台 / 诊断    │ │
│   └──────────┘ └──────────┘ └──────────────────┘ │
├──────────────────────────────────────────────────┤
│                 Gateway Core                      │
│   ┌──────────────────────────────────────────┐   │
│   │        HTTP Server (4 client prefixes)    │   │
│   │   /codex  /claude-code  /hermes  /v1     │   │
│   ├──────────────────────────────────────────┤   │
│   │   Router → Protocol Adapters → Dispatch   │   │
│   │   3×3 Matrix: Chat / Responses / Messages │   │
│   ├──────────────────────────────────────────┤   │
│   │   Compat Patches (provider/model-targeted)│   │
│   ├──────────────────────────────────────────┤   │
│   │   Profile Writer (Codex / Claude / Hermes)│   │
│   └──────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

---

## 项目结构

```
switchyard/
├── apps/desktop/            # Electron 主进程 + renderer UI
│   ├── src/                 # IPC / 网关生命周期 / 配置 / 日志 / 诊断
│   └── renderer/            # HTML + JS 控制面板
├── packages/core/           # 网关核心库
│   ├── src/
│   │   ├── server.mjs       # HTTP Server (4客户端前缀)
│   │   ├── config.mjs       # 配置 schema + 校验
│   │   ├── router.mjs       # 模型路由
│   │   ├── upstream/        # 多协议上游 client + dispatcher
│   │   ├── openai-adapter*.mjs   # Chat ↔ Responses
│   │   ├── anthropic-adapter*.mjs # Chat ↔ Messages
│   │   ├── compat/          # 兼容补丁系统 (registry + 补丁)
│   │   ├── profile-writer.mjs    # 客户端 profile 生成
│   │   ├── history-unify.mjs     # 会话历史统一
│   │   ├── vision-fallback.mjs   # 图片转文字描述
│   │   └── reasoning.mjs         # 推理过程适配
│   └── test/                # 229 个核心单测
├── docs/                    # 文档和设计稿
├── scripts/                 # 发版/导入/脱敏等辅助脚本
└── config/                  # 配置模板
```

---

## 命令速查

```bash
npm test                     # 运行 229 个单元测试
npm run check                # 语法检查
npm run desktop              # 启动 Electron UI
npm run desktop:dmg          # 打包 macOS DMG
npm run desktop:win          # 打包 Windows NSIS + ZIP
npm run gateway              # CLI 模式启动（无 UI）
npm run import:ccswitch      # 从 cc-switch 导入
```

---

## 安全原则

- **密钥不进配置文件**：全部通过环境变量加载
- **脱敏导出**：导出诊断包时自动剥离 API Key 和敏感 header
- **日志安全**：请求/响应摘要自动截断并保留合法 JSON，不泄露 prompt 内容
- **零网络暴露**：默认仅监听 `127.0.0.1`，不会向外部网络开放

---

## 兼容供应商

目前已内置适配的供应商（更多持续加入）：

| 供应商 | 协议 | 特色处理 |
|--------|------|----------|
| OpenAI Codex OAuth | OpenAI Responses | 官方 GPT/Codex，OAuth 认证 |
| DeepSeek | OpenAI Chat | reasoning_content 映射 |
| Kimi (Moonshot) | OpenAI Chat | 工具 schema 清洗 |
| GLM (智谱) | OpenAI Chat | content 数组格式适配 |
| MiniMax | OpenAI Chat | reasoning_details 映射 |
| 火山引擎 Agent Plan | OpenAI Chat | 国产大模型代理 |
| Anthropic | Anthropic Messages | 原生 Messages 协议 |
| OpenRouter | OpenAI Chat | reasoning effort 透传 |
| 硅基流动 (SiliconFlow) | OpenAI Chat | enable_thinking 映射 |
| 任意 OpenAI-Compatible | OpenAI Chat | 通用适配 |

---

## License

MIT © 2026 [zhangyinglong3550](https://github.com/zhangyinglong3550)

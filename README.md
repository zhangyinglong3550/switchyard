# Switchyard

**本机 LLM 控制台 + 网关**：多家供应商打平进一张模型表，在 Claude Code / Codex / Hermes / OpenCode / Grok Build 里统一选择。

[![version](https://img.shields.io/badge/version-2.2.7-blue)]()
[![license](https://img.shields.io/badge/license-MIT-blue)]()
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)]()

---

## 简化版 · 详细版

侧栏默认是 **简化版**——只保留四个入口，避免一上来功能过载：

| 总览 | 供应商 | 模型 | 客户端 |
|------|--------|------|--------|

**日常路径**：加供应商 → 填 API Key → 同步客户端 → 在 Agent 里选模型。

需要诊断、用量、会话、Skills、调用可视化时，打开侧栏 **详细** 开关即可。  
进阶能力都在，但不会挡住只想接模型的人。

![总览（简化路径下的本机控制台）](docs/assets/screenshots/01-overview.png)

![供应商模板（多厂商一键接入）](docs/assets/screenshots/04-providers.png)

![模型列表（多供应商打平）](docs/assets/screenshots/05-models.png)

---

## 核心能力

### 1. 多供应商打平：在 Claude Code / Codex 里选「全部模型」

相对 **CC Switch** 一类「主要帮 Claude Code 切渠道 / 换 Key」的工具，Switchyard 的重心是 **把多家供应商收成一张模型表**，再挂到各个 Agent 上。

| | CC Switch 类 | Switchyard |
|--|--------------|------------|
| 主场景 | Claude Code 配置 / 渠道切换 | **本机网关 + 多客户端统一模型目录** |
| 供应商 | 往往围绕 Claude 链路 | OpenAI / Anthropic / 中转 / 公司网关 / 账号池… **可并行多条** |
| 在 Agent 里 | 多为「当前启用的那一家」 | 在 **Claude Code、Codex、Hermes、OpenCode、Grok Build** 的模型列表里 **一起出现**，按需切换 |

**你在面板里接入的所有模型，会打平成客户端可选列表**——不必为每个 Agent、每个供应商各配一套；DeepSeek、Kimi、GLM、公司 OpenAI 兼容网关、官方 Claude/GPT 等，都可以在同一套 Codex / Claude Code 里选。

![新增供应商：内置多厂商模板](docs/assets/screenshots/04-providers.png)

![模型列表（多供应商打平后）](docs/assets/screenshots/05-models.png)

---

### 2. 网关自动重试（Agent 无感知）

上游偶发失败时，Switchyard 在网关内有限重试（默认最多 3 次：网络失败 / 429 / 5xx），**成功后再回给 Agent**。

像 **讯飞** 等不稳定中转，中间失败不会立刻砸到 Codex / Claude Code——客户端仍像完成了一次正常调用。

| 规则 | 说明 |
|------|------|
| 会重试 | `0`（网络）、`429`、`5xx` |
| 不重试 | `400` / `401` / `403` 等明确错误 |
| 流式 | 仅在尚未向客户端写出内容前重试 |
| 可配 | 供应商 / 模型可关、可改最大次数 |

---

### 3. 非视觉模型的图片识别兜底

目标模型不看图时，可配置 **视觉兜底模型**：

```
贴图 → 视觉模型描述图片 → 注入 prompt → 非视觉模型继续推理
```

DeepSeek / 纯文本 Coding 模型也能处理「带图提问」，无需换主模型。

![视觉兜底](docs/assets/screenshots/10-vision-fallback.png)

---

### 4. Codex 账号池（内置 CLI2API 能力）

本机 **多 Codex / ChatGPT 订阅号** 轮询，**不必再单独跑 CLI2API / Sub2API 进程**。

- 直连官方 Responses  
- 批量导入账号 JSON / 文件夹  
- 失败自动换号  
- 单号额度：5 小时窗口 + 周窗口剩余  
- 凭证只在本机 `~/.switchyard/pools/`，不进 Git  

![Codex 账号池](docs/assets/screenshots/02-codex-account-pool.png)

---

### 5. Grok 账号池（内置 CLI2API 能力）

本机 **多 Grok / xAI 订阅号** 同样内置池化，**等价于内置了一套 CLI2API 式多号转发**。

- 直连 `api.x.ai`  
- 支持 SSO / refresh、CPA `xai-*.json` 导入  
- 加权轮询 / 最久未用 / 低错误率等策略  
- Access 自动续期（有 refresh 时）  

![Grok 账号池](docs/assets/screenshots/03-grok-account-pool.png)

> **Codex 池 + Grok 池** ≈ 本机内置 CLI2API 类能力：多号、换号、续 token，统一在 Switchyard 里管，少开中间件。

---

### 6. OpenCode / Grok Build 接三方模型

不只是 Codex / Claude Code——**OpenCode** 与 **Grok Build** 也能走同一张模型表。

| 客户端 | 网关入口 | 一键写入 | 说明 |
|--------|----------|----------|------|
| OpenCode | `/opencode/v1` | `~/.config/opencode/opencode.json` → `provider.switchyard` | 首次写入后增/改/启模型自动刷新 models |
| Grok Build | `/grok/v1` | `~/.grok/config.toml` 托管块 `[model.sy-*]` | 保留用户原有 model；`/model` 或 Ctrl+M 选 `sy-…` |

**Grok Build 两条线不要混：**

- **账号池**：官方 xAI 多号（供应商页）  
- **客户端托管**：经 Switchyard 用任意供应商（客户端页 / 偏好设置 → Grok Build 三方模型）

详细版里还可浏览 OpenCode / Grok 的 **Skills、会话、调用可视化**；偏好设置可编辑核心文件并查看 Grok 托管状态。

---

## 为什么用 Switchyard

| 你要什么 | Switchyard 怎么给 |
|----------|-------------------|
| 多家供应商进同一个 Agent | **打平模型目录**，Claude Code / Codex / OpenCode / Grok Build 里一起选 |
| 中转经常抖（如讯飞） | 网关重试，Agent 尽量无感 |
| 便宜模型也要能看图 | 视觉兜底链路 |
| 多 Codex / 多 Grok 号 | 内置账号池，少依赖 CLI2API |
| Grok Build 也想用公司/中转模型 | 一键写入 `sy-*` 托管块，走 `/grok/v1` |

**不是又一个公网转发站**，而是给 AI 编程 Agent 用的 **本机模型控制台**。

---

## 30 秒上手（简化版）

1. 从 [Releases](https://github.com/zhangyinglong3550/switchyard/releases) 安装并打开  
2. **供应商** → 选模板或自定义 → 填 API Key  
3. **模型** → 启用要用的模型  
4. **客户端** → 同步 Codex / Claude Code / Hermes / OpenCode / Grok Build  
5. 在 Agent 里直接选模型  

macOS 若提示「已损坏」：

```bash
xattr -cr /Applications/Switchyard.app
```

---

## 进阶能力（详细版）

侧栏打开 **详细** 后使用：

| 能力 | 说明 | 示意 |
|------|------|------|
| 诊断中心 | 供应商 / 模型可用性与修复建议（含 OpenCode / Grok 是否指向网关） | ![诊断](docs/assets/screenshots/06-diagnostics.png) |
| 会话 | 跨 Agent 会话浏览（Codex / Claude / Hermes / OpenCode / Grok） | ![会话](docs/assets/screenshots/07-sessions.png) |
| 调用可视化 / 链路追踪 | 请求状态、延迟、重试与换号过程 | ![调用可视化](docs/assets/screenshots/08-traces.png) |
| Skills | Skills 管理与安装（含 Grok / OpenCode 目录） | ![Skills](docs/assets/screenshots/09-skills.png) |
| 偏好设置 | 核心文件编辑；Grok Build 托管状态与一键写入 | — |
| 官方直连 vs 网关 | Codex 可仅写元数据、不转发 | ![接入模式](docs/assets/screenshots/12-official-direct.png) |

更多设计：[账号池文档](docs/ACCOUNT-POOL-MVP.zh-CN.md) · [CHANGELOG](CHANGELOG.md)

---

## 架构

![架构](docs/assets/screenshots/11-architecture.png)

```
Codex / Claude Code / Hermes / OpenCode / Grok Build / 兼容客户端
              │
              ▼
     Switchyard Gateway（本机）
   · 协议适配 Chat ↔ Responses ↔ Messages
   · 失败自动重试 · 视觉兜底
   · Codex / Grok 账号池（选号 → 刷新 → 换号）
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
 api.x.ai   Codex 官方   三方 / 公司 OpenAI 兼容 API
 (Grok 池)  (Codex 池)   (Key / 中转)
```

> **Grok Build 三方模型**：一键写入 `~/.grok/config.toml` 托管块 `[model.sy-*]`，网关入口 `/grok/v1`。  
> 官方 xAI 账号池与「经 Switchyard 使用任意供应商模型」是两条线：池管订阅号，客户端页 / 偏好设置管 Grok Build 接三方。

---

## 下载

| 平台 | 文件 |
|------|------|
| macOS Apple Silicon | `Switchyard-*-arm64.dmg` |
| macOS Intel | `Switchyard-*.dmg` |
| Windows x64 | `Switchyard Setup *.exe` 或 `*-win.zip` |

从 [GitHub Releases](https://github.com/zhangyinglong3550/switchyard/releases) 获取最新包。  
已装 2.0+ 时，应用内可检测更新并安装重开。

### 从源码运行

```bash
git clone https://github.com/zhangyinglong3550/switchyard.git
cd switchyard
npm install
npm run desktop
```

---


## License

MIT © 2026

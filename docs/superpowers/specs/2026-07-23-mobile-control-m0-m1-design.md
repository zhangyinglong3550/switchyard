# Switchyard 移动控制 M0–M1 设计

## 背景与目标

Switchyard 需要支持手机端使用，但不能将本地模型网关、供应商凭据或桌面文件系统直接暴露到移动设备。

本设计拆分两个彼此独立但连续的交付：

1. **M0：Codex 官方远程能力保护。** 当 Switchyard 将 Codex 路由到第三方模型时，继续由 Codex App/CLI 持有 `~/.codex/auth.json` 官方登录态。
2. **M1：只读移动控制台。** 手机查看桌面端受管 Agent 的任务摘要、脱敏事件和明确终态；不允许创建任务、发送消息、执行命令或修改 Provider。

M1 只读完成并稳定后，才评估 M2 的 Codex 手机续聊和 M3 的 Claude Code 受控 runner。

## 方案比较

### 方案 A：直接将现有 `:17888` 网关绑定到 LAN

优点是工作量最小。缺点是网关同时承载模型数据面和管理入口，移动设备可携带模型协议请求，安全边界不可接受。**拒绝。**

### 方案 B：复用桌面 Renderer 的 IPC，手机通过远程桌面访问

优点是无新服务。缺点是 Electron IPC 无网络身份边界、无法安全地接入手机浏览器，也无法做到设备撤销和事件补拉。**拒绝。**

### 方案 C：单独的最小权限 Mobile Control Server

Desktop main process 启动独立控制服务，默认仅 loopback；服务只暴露设备配对、会话摘要和脱敏事件。它从本地事件账本读取数据，不转发模型请求、不读取 Provider 明文凭据。远程访问使用 Tailscale HTTPS 或用户自有受控反向代理。**采用。**

## M0：Codex 官方远程能力保护

### 不变量

- `applyCodex()`、`applyCodexOfficialDirect()`、Codex profile 切换和模型目录同步都不得创建、删除或改写 `~/.codex/auth.json`。
- Switchyard 允许 `codex_oauth` 的显式刷新流程更新本机 OAuth token；该流程必须独立于 profile apply，且不由移动控制面触发。
- `config.toml`、模型 catalog 和 models cache 仍可由 Switchyard 管理。

### 验证

- 自动回归：预先写入一个 sentinel `auth.json`，执行两种 Codex profile apply 后逐字节验证文件未变化。
- 人工烟测：在实际已登录 Codex App 上，开启 Switchyard 代理并使用三方模型，确认官方 Codex 移动/远程入口仍能识别该账号。该验证依赖账号和设备，不纳入 CI。

## M1：只读移动控制台

### 服务边界

| 项目 | 设计 |
| --- | --- |
| 进程 | Electron main process 内的 `MobileControlServer` |
| 端口 | 默认 `127.0.0.1:17889`；与 `:17888` 网关分离 |
| 网络 | 默认关闭；显式启用远程时只接受 HTTPS 终结后的请求 |
| UI | 静态移动 Web 页面，后续才考虑 installable PWA |
| 数据 | 任务元数据和已脱敏事件，不读取 Provider 配置、密钥、原始 request body、路径树或环境变量 |
| 会话 | 设备 token 与 Provider/Codex OAuth token 完全分域 |

### 配对与设备认证

1. 桌面端显式启用移动控制，生成单次配对 challenge，10 分钟有效。
2. 手机用 QR 链接打开配对页，提交设备名称和一次性 challenge。
3. 桌面端保存设备记录：`id`、显示名、token 哈希、创建时间、最后访问时间、撤销时间。
4. 后续请求使用设备 token；服务端只保存 token 哈希。
5. 已撤销、过期或重放的 challenge 一律返回 401/409，不能恢复。

首版不要求浏览器生成设备密钥对；这样避免移动 Safari/WebView 的兼容复杂度。M2 之前如需更强防盗用，再升级为 WebCrypto 密钥绑定。

### 只读 API

```text
POST /mobile/pair/complete
GET  /mobile/v1/agents
GET  /mobile/v1/sessions?after=<cursor>
GET  /mobile/v1/sessions/:id
GET  /mobile/v1/events?after=<event_id>
POST /mobile/v1/devices/self/revoke
```

- 所有 `/mobile/v1/*` 要求设备 token。
- API 返回固定 DTO；不得将 Node `Error`、headers、完整路径、原始 payload 直接序列化。
- 事件有连续 `event_id`，重新连接必须传最后收到的 id 以补拉。
- M1 中不存在 `POST /threads`、`POST /messages`、Provider 修改或任意命令入口。

### 任务与事件模型

`MobileSession`：

```text
id, agent, title, state, updatedAt, lastEventId
```

允许的状态只有：

```text
queued | running | waiting_for_desktop_approval | completed | failed | cancelled | incomplete
```

`MobileEvent`：

```text
id, sessionId, type, createdAt, summary
```

`summary` 是文本摘要或固定状态说明。M1 不向手机推送完整 prompt、完整模型输出、工具参数、文件路径、堆栈或认证信息。

### 数据来源

- Switchyard 网关请求日志只提供脱敏状态/用量摘要。
- Codex app-server 的 thread notification 只在 M2 引入；M1 不依赖它，避免为只读状态页引入未完成的双向执行链路。
- Claude Code M1 只展示 Switchyard 已知会话摘要；不读取或修改 Claude Code 会话文件来伪造实时状态。

## 错误处理与安全

- 流式请求只有在已看见明确终态时才标记 `completed`；未见终态的连接关闭标为 `incomplete`。
- 未授权设备、无效 Origin、非 HTTPS 的远程请求和超出 DTO 范围的字段均 fail closed。
- 不能将 mobile token 作为模型网关的 `Authorization`、`x-api-key` 或 Provider credential 使用。
- 删除设备后立即让其 token 无效，不等待服务重启。

## 测试策略

1. Profile writer：`auth.json` 字节保持不变。
2. Pairing：过期、重复完成、错误 token、撤销后访问均被拒绝。
3. DTO：含 API key、Bearer、绝对路径、prompt 的源事件输出后不包含敏感值。
4. Event replay：给定 `after` cursor 只返回后续事件，顺序稳定且不重复。
5. Gateway terminal state：成功、失败、取消、不完整四种状态都能映射到移动状态。

## 非目标

- 公开互联网匿名访问、Cloudflare Tunnel/Funnel 自动开通；
- 手机端 shell、文件读写、MCP 配置、Provider 配置；
- 使用手机 token 调用 `:17888` 数据面；
- M1 阶段的 Codex/Claude Code 写入或运行控制。

## 交付判定

M0 的自动测试和人工烟测记录均完成，且 M1 的所有 API 在 loopback 下默认关闭。移动设备只能读取经过 DTO 投影的数据，并且设备撤销立即生效，才可进入 M2 设计。

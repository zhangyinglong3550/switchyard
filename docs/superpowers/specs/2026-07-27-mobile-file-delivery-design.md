---
title: 手机端文件交付与附件生命周期设计
date: 2026-07-27
status: partially_verified
scope: Switchyard Mobile Control、Android 壳与受控文件资产
---

# 手机端文件交付与附件生命周期设计

## 目标

让已配对手机能够在 Switchyard 对话中安全地获得 Agent 交付的工作区文件，并向 Agent 发送受控附件；同时限制本地文件暴露范围、控制附件存储增长，并给 Android 提供可复现的 release 构建与真机验证步骤。

## 非目标

- 不允许手机按任意绝对路径读取桌面文件。
- 不开放 Provider 凭据、Shell、通用文件管理或公网匿名下载。
- 不承诺在无解析器时“理解”PDF、Office、压缩包内容。
- 不在本期实现分片上传、后台断点续传、全文索引或文件版本 diff。

## 方案选择

采用 **结构化显式交付 + 现有结构化工具文件发现** 的组合：

1. Agent 或运行时可发送受控 `deliver_file` 结构化事件，显式声明要交付的工作区文件。
2. 既有 `tool.files` 继续自动登记，作为兼容与辅助发现路径。
3. 两条路径都必须经过同一资产注册器：限定工作区、真实文件、公开 DTO、token 鉴权下载。
4. 移动端将显式交付与写入类工具产物统一显示为“本轮交付”；读/搜索文件仅在工具详情中出现。

不从普通模型文本或命令输出中猜测路径，避免模型幻觉或提示注入导致的任意文件暴露。

## 数据模型与生命周期

资产区分两类：

| 类型 | 存储 | 生命周期 |
| --- | --- | --- |
| `upload`（手机上传） | Mobile Control 私有附件目录，0600 文件/0700 目录 | 默认保留 7 天；被会话或队列引用期间不删除；到期且无引用时清理 |
| `workspace`（工作区交付物） | 仅保存经校验的工作区引用 | 不复制、不删除源文件；请求时重新校验文件存在且仍位于会话工作区 |

资产元数据新增：`source`（`upload` / `tool` / `delivery`）、`createdAt`、`updatedAt`、`expiresAt`（仅 upload）、`deliveryAt`（显式交付时）。公开 DTO 只暴露安全字段，不暴露绝对路径。

每次存储初始化、资产写入与下载解析前执行轻量清理：

- 删除已过期且不再被历史消息、排队项引用的 upload；
- 删除其私有二进制文件；
- 保留 workspace 引用，但在源文件消失或越出工作区时使其不可读取；
- 设置私有附件总大小上限，超过后按最早的无引用 upload 清理；若仍无法释放足够空间则拒绝新上传并说明原因。

## 显式文件交付

运行时事件支持以下安全字段：

```json
{
  "type": "file_delivery",
  "summary": "已生成导出文件",
  "delivery": {
    "path": "relative/to/workspace/report.xlsx",
    "name": "report.xlsx",
    "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  }
}
```

会话注册表接收事件后：

1. 从该移动会话已登记的 `workspaceRoot` 解析相对路径；
2. 经资产注册器验证路径仍在工作区内且为普通文件；
3. 登记为 `source: delivery` 的 workspace 资产，写入事件/会话详情；
4. 前端在“本轮交付”展示，支持预览、下载和 Android 原生打开。

不提供外部 HTTP URL、绝对路径、目录、符号链接跳转或模型文本路径的交付能力。

## 上传附件支持

上传统一受现有请求总大小限制约束，并提供更清晰的客户端反馈：文件个数、单个大小、累计大小和支持类型。

| 类别 | 处理 |
| --- | --- |
| 图片 | 保持原有视觉输入处理 |
| 纯文本与常见源码 | UTF-8 文本注入 prompt，保留原始附件 |
| PDF/DOCX/XLSX/ZIP | 作为受控附件保留；前端明确提示二进制文件能否解析取决于当前 Agent，不假装已理解其内容 |
| 其他二进制 | 作为受控附件保留；运行时不支持时必须返回明确错误，不能假装已传递 |

运行时收到受控二进制附件时，仅使用 Switchyard 创建的私有附件副本；对不能传递该类型的运行时，返回明确“不支持该附件类型”的错误，不能假装已传递。

## API 与 UI

现有 `GET /mobile/v1/assets/:id` 保持设备 token、同源检查、`private, no-store` 和 `nosniff`。

移动端文件卡片新增：

- 来源：本轮交付、Agent 修改、手机上传；
- 文件大小与时间；
- 不可读/已更新状态；
- 预览、下载；Android 壳内额外显示“保存到下载”“打开”。

文件预览保留图片/PDF/文本能力。Office 与 zip 默认提示下载后打开，不在 WebView 内执行或渲染不可信内容。

## Android 发布与验证

Android 工程新增：

- `versionCode` 与 `versionName` 由单一 Gradle 属性或项目版本注入；
- `assembleRelease` 可在未配置签名时生成明确标记为 unsigned 的包，配置 keystore 属性后生成已签名 release；
- 提供验证脚本/文档，检查 APK 包名、版本、签名状态和 release 产物路径；
- 不将 keystore、密码、token 或本机 `local.properties` 提交到仓库。

真机烟测清单：

1. Android 与 iPhone（Safari/PWA）分别通过 Tailscale HTTPS 配对；
2. Agent 修改文本、生成 PDF 与生成 Office/压缩包时，手机能看到文件卡片；
3. 图片/文本/PDF 预览，任意文件下载；Android 保存到 Downloads 并通过系统应用打开；
4. 手机上传图片、文本、PDF、DOCX/XLSX、ZIP；确认支持提示与 Agent 实际接收结果一致；
5. 撤销设备后，资产读取接口返回 401；
6. 上传附件超过保留期且无引用后清理，工作区交付文件不会被删除。

## 测试策略

- 存储层：显式交付登记、工作区越界拒绝、upload 过期清理、引用保护、容量回收。
- 会话注册表：`file_delivery` 事件映射到公开资产，绝对路径不出现在 DTO。
- 服务端：有效 token 可读取资产；撤销/无 token 被拒绝；已过期 upload 返回 404。
- PWA：来源、时间、大小、交付标记与不可预览文件下载入口。
- Android：Gradle 配置与验证脚本的结构测试；实际保存/打开由真机烟测执行。

## 验收标准

- 已实现：运行时可通过结构化 `file_delivery` 事件把当前工作区内文件显式交付给手机；现有 Agent 运行时尚未自动产生该事件，仍由其结构化工具文件路径提供兼容发现。
- 自动工具发现与显式交付都不会泄漏绝对路径或越权读取工作区外文件；
- 上传附件具备可预测的类型、大小和失败反馈；
- 私有 upload 不无限增长，过期/无引用资产可清理；
- Android 具备可复现 release 构建与签名状态验证；
- 已完成自动测试、静态检查、Android unsigned release 构建与 APK 元数据/签名状态校验；尚待人工真机烟测：Tailscale 配对、Android 保存/打开、iPhone PWA 预览，以及各 Agent 对二进制附件的真实接收行为。

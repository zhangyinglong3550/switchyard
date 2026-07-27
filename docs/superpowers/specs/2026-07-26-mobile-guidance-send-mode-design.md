# 移动端会话：停止、引导与排队发送

日期：2026-07-26

## 已确认的交互

- 会话运行中且输入为空、没有附件时，底部发送按钮切换为停止按钮，复用既有“停止并清空队列 / 仅停止保留队列”选择。
- 会话运行中填写消息或添加附件后，发送时可选择“引导当前任务”或“加入队列”；设备设置可指定默认行为：每次询问、默认引导、默认排队。
- 设置入口位于移动端“我的 → 对话行为”。

## 引导的安全语义

不同 Agent Runtime 没有统一、经过验证的运行中 prompt 注入接口。运行时重复调用 `sendMessage` 可能造成并发 turn、冲突或新进程。

因此“引导当前任务”定义为：**当前 Agent 完成正在执行的步骤后，将该消息插入会话队列队首优先执行**。它不承诺实时改变已经运行中的输出。

“加入队列”插入队尾，保留 FIFO 顺序。已暂停的队列仍保持暂停，引导项只插入队首、不自动恢复。

## 持久化与接口

设备级偏好持久化在 Mobile Control Store 的设备记录中：

```text
conversationSendMode: ask | guide | queue
```

提供：

- `GET /mobile/v1/preferences`
- `POST /mobile/v1/preferences`，body 为 `{ conversationSendMode }`

消息接口接受 `deliveryMode: guide | queue`。未指定时保持现有队尾排队兼容行为。

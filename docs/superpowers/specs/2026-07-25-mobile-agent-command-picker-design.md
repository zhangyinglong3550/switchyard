# 手机端 Agent 命令与 Skill 选择器设计

## 目标

在手机端已有会话和新会话输入框中提供 Agent 感知的命令选择器。输入 `/` 时展示当前 Agent 的原生命令与已安装 Skills；Codex 输入 `$` 时只展示 Skills。选择条目只插入调用语法，不立即发送。

## 交互

- `/` 在光标所在 token 开头触发选择器，列表分为“命令”和“Skills”。
- Codex 的 `$` 只触发 Skills；其他 Agent 的 `$` 不触发。
- 继续输入按名称、描述过滤；支持触摸、上下键、回车和 Esc。
- 选择后替换当前 token，并在末尾补空格，保留后续参数输入。
- 选择器位于输入框上方，有最大高度和独立滚动，不覆盖发送按钮。

## 语法

- Codex Skill：`$skill-name`；命令：`/command`。
- Claude Code、OpenCode、Grok Skill：`/skill-name`；命令：`/command`。

## 数据

手机服务提供 `/mobile/v1/commands?agent=<id>`，仅返回安全字段：`id`、`kind`、`name`、`description`、`insertText`、`source`。Skills 从各 Agent 已启用的 `SKILL.md` 发现；命令由 Agent 内置目录、Claude 自定义 command 文件以及 ACP `available_commands_update` 合并。结果去重并短时缓存。

## 边界

- 不向手机暴露 Skill 正文、本机绝对路径、环境变量或密钥。
- 不新增直接执行 Shell 的接口；插入后的文本仍走现有消息发送链路与权限策略。
- 发现失败不阻止手动输入或发送。

## 验证

- 四个 Agent 分别验证 Skill 语法和命令过滤。
- 验证禁用 Skill 不出现、敏感路径不出现在 DTO。
- 验证触摸和键盘选择、token 替换、切换 Agent、空结果及移动视口不溢出。

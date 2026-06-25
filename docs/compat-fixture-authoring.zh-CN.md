# Switchyard 兼容 Fixture 编写指南

更新时间：2026-06-24

## 目标

兼容 fixture 用来把一次模型适配问题沉淀成可重复运行的最小复现。它面向维护者和开源用户：用户可以从脱敏 Issue Bundle 提炼出 fixture，维护者可以用 fixture 复现、修补并防止回归。

fixture 只允许 JSON，不执行远程代码，不包含密钥、Cookie、OAuth token、完整用户正文、图片原文或附件内容。

## 文件位置

```text
packages/core/test/compat-fixtures/*.json
```

运行方式：

```bash
node --test packages/core/test/compat-fixtures.test.mjs
```

全量验证：

```bash
npm run check
npm test
```

## 基本结构

```json
{
  "id": "short-stable-id",
  "title": "Human-readable purpose",
  "operation": "compat_outbound",
  "input": {},
  "expect": {
    "output": {}
  }
}
```

`id` 应与文件名一致，使用短横线命名。`title` 写清楚真实兼容风险，不写内部聊天记录。

## 支持的 operation

| operation | 用途 |
| --- | --- |
| `anthropic_to_chat` | 验证 Claude Code / Anthropic Messages 请求转 OpenAI Chat 中间态 |
| `anthropic_to_responses` | 验证 Claude thinking / tool_use 转 Codex Responses input item |
| `responses_to_anthropic_messages` | 验证 Codex Responses reasoning / function_call / tool output 回到 Anthropic Messages |
| `responses_stream_to_chat` | 验证 Responses SSE 事件聚合成 Chat completion |
| `compat_outbound` | 验证 provider/model 定向 compat patch 的 outbound 改写 |
| `runtime_rectifier` | 验证上游错误分类和同 provider 重试前的请求整流 |
| `private_field_filter` | 验证 `_` 私有字段过滤，同时保留 JSON Schema property 名 |

新增 operation 必须先修改 `packages/core/src/compat/fixture-runner.mjs`，不要在 fixture 里放脚本。

## 断言语法

`expect.output` 是结构化子集断言。普通对象只检查列出的字段；数组会按顺序和长度检查。

特殊断言：

```json
{ "$exists": false }
```

断言字段不存在。

```json
{ "$match": "^switchyard:anthropic-thinking:v1:" }
```

用正则检查字符串。

```json
{ "$contains": { "id": "toolu_1" } }
```

检查数组中存在一个匹配项，或字符串包含指定文本。

## 脱敏要求

fixture 中不得出现：

- `Authorization`、`Cookie`、API Key、OAuth token。
- 完整用户正文、会议纪要、附件、图片 base64 原文。
- 未脱敏的本机路径、账号、邮箱、组织内部链接。

允许保留：

- 合成模型 ID、provider ID、apiFormat。
- 最小 tool name、tool_call_id、错误消息片段。
- 伪造图片占位，例如 `data:image/png;base64,AAAA`。
- 只足够复现字段结构的短文本，例如 `read two files`、`file a`。

## 从 Issue Bundle 转成 Fixture

1. 根据失败日志确定 `clientId`、`apiFormat`、上游类型和错误分类。
2. 删除密钥、正文、附件和无关字段，只保留触发兼容问题的最小结构。
3. 选择最窄的 operation：
   - 工具字段或 thinking 在协议转换阶段丢失，优先用 adapter operation。
   - provider 参数错误，使用 `compat_outbound`。
   - 上游返回 400 后需要重试，使用 `runtime_rectifier`。
   - SSE 聚合问题，使用 `responses_stream_to_chat`。
4. 写入 `expect.output`，只断言关键字段，不把随机 id 和时间戳写死。
5. 运行 `node --test packages/core/test/compat-fixtures.test.mjs`。
6. 再运行 `npm run check` 和 `npm test`。

## 当前首批 Fixture

- `claude-code-tool-concurrency.json`
- `codex-responses-to-deepseek-thinking.json`
- `openrouter-reasoning-effort.json`
- `siliconflow-enable-thinking.json`
- `unsupported-image-reactive-retry.json`
- `thinking-signature-rectifier.json`
- `private-field-filter-schema.json`
- `responses-function-call-stream.json`

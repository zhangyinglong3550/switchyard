# Changelog

## 2.0.0 — 2026-07-14

### Highlights

- **账号池（Account Pool）一等公民能力**：本机多账号 OAuth 轮询 / 失败换号，凭证存 `~/.switchyard/pools/`，不进 `config.json`。
- **Grok / xAI 池**：粘贴 SSO/RT、CLIProxyAPI `xai-*.json`、加权轮询。
- **Codex 订阅池**：批量导入 CPA `type:codex` JSON / 多选文件 / 文件夹；`session_token` 可续 access；**单号额度查询**（5h / 周剩余）。
- **UI 2.0**：Claude Paper Light（C2）全浅奶油主题。
- 本版本为 **大版本**：新增账号池与额度能力，建议从 1.x 备份后升级。

### Account Pool

| poolKind | 上游 | 导入方式 |
|----------|------|----------|
| `xai_oauth` | `api.x.ai` 直连 | 粘贴 SSO/RT、CPA json |
| `codex_oauth` | ChatGPT Codex Responses 直连 | 多选 json / 文件夹 / 粘贴 / `~/.codex/auth.json` |
| `antigravity_oauth` | 实验性（可选 CPA 8317） | 文件夹 / 默认 auth-dir |

调度策略：加权轮询 / 最久未用 / 最低错误率。失败状态 `401/403/429/5xx` 自动换号（最多 3 次）。

### UI

- Theme **C2 Paper Light**：暖奶油底、蜜陶土强调、浅色侧栏。
- 账号池表：中文状态、额度列、Access 令牌过期说明、刷新额度。

### Docs / Release

- 新增 `docs/ACCOUNT-POOL-MVP.zh-CN.md`
- README 增加账号池说明；截图区标注 2.0 UI 刷新说明

### Breaking / 注意

- 账号池 token 仅本机；请勿提交 `~/.switchyard/pools/`。
- Codex 额度依赖 ChatGPT 会话/token 有效与网络代理。
- Grok 官方无稳定「剩余额度」公开 API，额度列仅展示团队/说明信息。

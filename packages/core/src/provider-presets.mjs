const CODEX_CHAT_REASONING = {
  deepseek: {
    supportsThinking: true,
    supportsEffort: true,
    thinkingParam: "thinking",
    effortParam: "reasoning_effort",
    effortValueMode: "deepseek",
    outputFormat: "reasoning_content"
  },
  openrouter: {
    supportsThinking: false,
    supportsEffort: true,
    thinkingParam: "none",
    effortParam: "reasoning.effort",
    effortValueMode: "openrouter",
    outputFormat: "auto"
  },
  enableThinking: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: "enable_thinking",
    effortParam: "none",
    outputFormat: "reasoning_content"
  },
  thinkingObject: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: "thinking",
    effortParam: "none",
    outputFormat: "reasoning_content"
  },
  minimax: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: "reasoning_split",
    effortParam: "none",
    outputFormat: "reasoning_details"
  }
};

export const PROVIDER_PRESETS = [
  {
    id: "codex-oauth",
    label: "OpenAI Codex（OAuth）",
    providerId: "codex",
    name: "OpenAI Codex",
    apiFormat: "openai_responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authModes: ["codex_oauth"],
    defaultAuthMode: "codex_oauth",
    experimental: true,
    riskLevel: "high",
    riskNote: "官方文档和社区实践均提示：通过本地网关复用 Codex 官方 OAuth/内部接口可能带来账号限制或封号风险。推荐优先使用官方直连；仅在明确理解风险时使用该 cc-switch/Hermes-style 代理适配。",
    dashboardUrl: "https://chatgpt.com",
    note: "默认复用本机 codex login；查询模型会优先读取 ChatGPT Codex 官方模型接口。",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", contextWindow: 128000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "codex-auto-review", displayName: "Codex Auto Review", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "xai-account-pool",
    label: "Grok / xAI 账号池",
    providerId: "grok-pool",
    name: "Grok 账号池",
    apiFormat: "openai_chat",
    baseUrl: "https://api.x.ai/v1",
    authModes: ["account_pool"],
    defaultAuthMode: "account_pool",
    poolKind: "xai_oauth",
    poolStrategy: "weighted_round_robin",
    experimental: true,
    riskLevel: "medium",
    riskNote: "使用自有 xAI / SuperGrok 订阅号的本机多账号池。token 仅保存在本机 ~/.switchyard/pools/，不上传。请遵守 xAI 服务条款，勿用于未授权的账号共享。",
    dashboardUrl: "https://console.x.ai",
    note: "支持从 CLIProxyAPI（~/.cli-proxy-api-grok）批量导入 xai-*.json，加权轮询 + 失败换号。保存供应商后在「账号池」面板管理账号。",
    models: [
      { id: "grok-4.5", displayName: "Grok 4.5", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "grok-4.3", displayName: "Grok 4.3", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "grok-build-0.1", displayName: "Grok Build 0.1", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "grok-composer-2.5-fast", displayName: "Grok Composer 2.5 Fast（上游 /models 可能不列出）", contextWindow: 256000, capabilities: { tools: true, stream: true } },
      { id: "grok-4.20-0309-reasoning", displayName: "Grok 4.20 Reasoning", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "grok-4.20-0309-non-reasoning", displayName: "Grok 4.20 Non-Reasoning", contextWindow: 256000, capabilities: { tools: true, stream: true } },
      { id: "grok-4.20-multi-agent-0309", displayName: "Grok 4.20 Multi-Agent", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "openai",
    label: "OpenAI（API Key）",
    providerId: "openai",
    name: "OpenAI",
    apiFormat: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "OPENAI_API_KEY",
    dashboardUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 400000, maxOutputTokens: 128000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "gpt-5", displayName: "GPT-5", contextWindow: 400000, maxOutputTokens: 128000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "gpt-4.1", displayName: "GPT-4.1", contextWindow: 1000000, maxOutputTokens: 32768, capabilities: { tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "anthropic",
    label: "Anthropic Claude（API Key）",
    providerId: "anthropic",
    name: "Anthropic Claude",
    apiFormat: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    authModes: ["api_key", "anthropic_oauth"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    dashboardUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-opus-4-5", displayName: "Claude Opus 4.5", contextWindow: 200000, maxOutputTokens: 32000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "anthropic-oauth",
    label: "Anthropic Claude（官方 / Claude Code 登录）",
    providerId: "anthropic-oauth",
    name: "Anthropic Claude Official",
    apiFormat: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    authModes: ["anthropic_oauth"],
    defaultAuthMode: "anthropic_oauth",
    experimental: true,
    riskLevel: "medium",
    riskNote: "对齐 CC Switch「Claude Official」：复用本机 Claude Code 登录态（Keychain / ~/.claude/.credentials.json）经本地网关调用官方 Messages API。请遵守 Anthropic 服务条款。",
    dashboardUrl: "https://www.anthropic.com/claude-code",
    note: "默认复用本机 claude login；也可在高级选项里浏览器 OAuth 或粘贴 refresh_token。",
    models: [
      { id: "claude-opus-4-5", displayName: "Claude Opus 4.5", contextWindow: 200000, maxOutputTokens: 32000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-opus-4-6", displayName: "Claude Opus 4.6", contextWindow: 200000, maxOutputTokens: 32000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "moonshot",
    label: "Moonshot / Kimi API",
    providerId: "moonshot",
    name: "Moonshot / Kimi",
    apiFormat: "openai_chat",
    baseUrl: "https://api.moonshot.ai/v1",
    compatPacks: ["kimi", "reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "MOONSHOT_API_KEY",
    dashboardUrl: "https://platform.moonshot.ai/console/api-keys",
    models: [
      { id: "kimi-k2-0711-preview", displayName: "Kimi K2", contextWindow: 128000, maxOutputTokens: 16384, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "moonshot-v1-128k", displayName: "Moonshot v1 128K", contextWindow: 128000, maxOutputTokens: 8192, capabilities: { tools: true, stream: true } },
      { id: "moonshot-v1-32k", displayName: "Moonshot v1 32K", contextWindow: 32000, maxOutputTokens: 8192, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    providerId: "deepseek",
    name: "DeepSeek",
    apiFormat: "openai_chat",
    baseUrl: "https://api.deepseek.com",
    compatPacks: ["deepseek"],
    codexChatReasoning: CODEX_CHAT_REASONING.deepseek,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
    usage_check: {
      templateType: "balance",
      balanceProvider: "deepseek"
    },
    models: [
      { id: "deepseek-chat", displayName: "DeepSeek Chat", contextWindow: 128000, maxOutputTokens: 8192, capabilities: { tools: true, stream: true } },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner", contextWindow: 128000, maxOutputTokens: 8192, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    providerId: "openrouter",
    name: "OpenRouter",
    apiFormat: "openai_chat",
    baseUrl: "https://openrouter.ai/api/v1",
    compatPacks: ["reasoning-chat"],
    codexChatReasoning: CODEX_CHAT_REASONING.openrouter,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "OPENROUTER_API_KEY",
    dashboardUrl: "https://openrouter.ai/keys",
    usage_check: {
      templateType: "balance",
      balanceProvider: "openrouter"
    }
  },
  {
    id: "xai",
    label: "xAI Grok",
    providerId: "xai",
    name: "xAI",
    apiFormat: "openai_chat",
    baseUrl: "https://api.x.ai/v1",
    compatPacks: ["reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "XAI_API_KEY",
    dashboardUrl: "https://console.x.ai",
    models: [
      { id: "grok-4", displayName: "Grok 4", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "grok-4-fast", displayName: "Grok 4 Fast", contextWindow: 2000000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "groq",
    label: "Groq",
    providerId: "groq",
    name: "Groq",
    apiFormat: "openai_chat",
    baseUrl: "https://api.groq.com/openai/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "GROQ_API_KEY",
    dashboardUrl: "https://console.groq.com/keys",
    models: [
      { id: "llama-3.3-70b-versatile", displayName: "Llama 3.3 70B Versatile", contextWindow: 128000, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "together",
    label: "Together AI",
    providerId: "together",
    name: "Together AI",
    apiFormat: "openai_chat",
    baseUrl: "https://api.together.xyz/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "TOGETHER_API_KEY",
    dashboardUrl: "https://api.together.xyz/settings/api-keys",
    models: [
      { id: "deepseek-ai/DeepSeek-V3.2", displayName: "DeepSeek V3.2", contextWindow: 128000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", displayName: "Qwen3 Coder 480B", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "perplexity",
    label: "Perplexity",
    providerId: "perplexity",
    name: "Perplexity",
    apiFormat: "openai_chat",
    baseUrl: "https://api.perplexity.ai",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "PERPLEXITY_API_KEY",
    dashboardUrl: "https://www.perplexity.ai/settings/api",
    models: [
      { id: "sonar-pro", displayName: "Sonar Pro", contextWindow: 200000, capabilities: { tools: false, stream: true } },
      { id: "sonar-reasoning-pro", displayName: "Sonar Reasoning Pro", contextWindow: 128000, capabilities: { reasoning: true, tools: false, stream: true } }
    ]
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    providerId: "fireworks",
    name: "Fireworks AI",
    apiFormat: "openai_chat",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "FIREWORKS_API_KEY",
    dashboardUrl: "https://fireworks.ai/account/api-keys",
    models: [
      { id: "accounts/fireworks/models/deepseek-v3p2", displayName: "DeepSeek V3.2", contextWindow: 128000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "mistral",
    label: "Mistral AI",
    providerId: "mistral",
    name: "Mistral AI",
    apiFormat: "openai_chat",
    baseUrl: "https://api.mistral.ai/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "MISTRAL_API_KEY",
    dashboardUrl: "https://console.mistral.ai/api-keys",
    models: [
      { id: "mistral-large-latest", displayName: "Mistral Large", contextWindow: 128000, capabilities: { tools: true, stream: true } },
      { id: "codestral-latest", displayName: "Codestral", contextWindow: 256000, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "cerebras",
    label: "Cerebras",
    providerId: "cerebras",
    name: "Cerebras",
    apiFormat: "openai_chat",
    baseUrl: "https://api.cerebras.ai/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "CEREBRAS_API_KEY",
    dashboardUrl: "https://cloud.cerebras.ai/platform",
    models: [
      { id: "llama3.1-70b", displayName: "Llama 3.1 70B", contextWindow: 128000, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    providerId: "opencode-go",
    name: "OpenCode Go",
    apiFormat: "openai_chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
    compatPacks: ["opencode-go", "kimi", "reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "OPENCODE_API_KEY",
    dashboardUrl: "https://opencode.ai/auth",
    models: [
      { id: "kimi-k2.7-code", displayName: "Kimi K2.7 Code", contextWindow: 200000, maxOutputTokens: 32768, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "zai",
    label: "Z.AI / GLM Coding Plan",
    providerId: "zai",
    name: "Z.AI / GLM",
    apiFormat: "openai_chat",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    compatPacks: ["glm"],
    codexChatReasoning: CODEX_CHAT_REASONING.thinkingObject,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "ZAI_API_KEY",
    dashboardUrl: "https://z.ai",
    usage_check: {
      templateType: "coding_plan",
      codingPlanProvider: "zhipu"
    },
    models: [
      { id: "glm-4.6", displayName: "GLM 4.6", contextWindow: 128000, maxOutputTokens: 32768, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "glm-5.2", displayName: "GLM 5.2", contextWindow: 128000, maxOutputTokens: 32768, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "xiaomi-mimo",
    label: "Xiaomi MiMo",
    providerId: "xiaomi-mimo",
    name: "Xiaomi MiMo",
    apiFormat: "openai_chat",
    baseUrl: "https://api.xiaomimimo.com/v1",
    compatPacks: ["reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "XIAOMI_MIMO_API_KEY",
    dashboardUrl: "https://platform.xiaomimimo.com/#/console/api-keys",
    models: [
      { id: "mimo-v2.5-pro", displayName: "MiMo V2.5 Pro", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "mimo-v2.5", displayName: "MiMo V2.5", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "xiaomi-mimo-token-plan",
    label: "Xiaomi MiMo Token Plan（中国）",
    providerId: "xiaomi-mimo-token-plan",
    name: "Xiaomi MiMo Token Plan",
    apiFormat: "openai_chat",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    compatPacks: ["reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "XIAOMI_MIMO_TOKEN_PLAN_API_KEY",
    dashboardUrl: "https://platform.xiaomimimo.com/#/console/plan-manage",
    models: [
      { id: "mimo-v2.5-pro", displayName: "MiMo V2.5 Pro", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "mimo-v2.5", displayName: "MiMo V2.5", contextWindow: 1048576, maxOutputTokens: 131072, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "volcengine-ark-agentplan",
    label: "火山引擎 Agent Plan",
    providerId: "volcengine-ark-agentplan",
    name: "火山引擎 Agent Plan",
    apiFormat: "openai_chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "VOLCENGINE_ARK_API_KEY",
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    usage_check: {
      templateType: "coding_plan",
      codingPlanProvider: "volcengine"
    },
    models: [
      { id: "ark-code-latest", displayName: "Ark Code Latest", contextWindow: 256000, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "doubao-seed",
    label: "豆包 Seed",
    providerId: "doubao-seed",
    name: "豆包 Seed",
    apiFormat: "openai_chat",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "DOUBAO_API_KEY",
    dashboardUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    models: [
      { id: "doubao-seed-2-0-code-preview-latest", displayName: "Doubao Seed Code Preview", contextWindow: 256000, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "byteplus-ark",
    label: "BytePlus ModelArk",
    providerId: "byteplus-ark",
    name: "BytePlus ModelArk",
    apiFormat: "openai_chat",
    baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "BYTEPLUS_ARK_API_KEY",
    dashboardUrl: "https://console.byteplus.com/ark",
    models: [
      { id: "ark-code-latest", displayName: "Ark Code Latest", contextWindow: 256000, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "zhipu-glm",
    label: "智谱 GLM",
    providerId: "zhipu-glm",
    name: "智谱 GLM",
    apiFormat: "openai_chat",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    compatPacks: ["glm"],
    codexChatReasoning: CODEX_CHAT_REASONING.thinkingObject,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "ZHIPU_API_KEY",
    dashboardUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    usage_check: {
      templateType: "coding_plan",
      codingPlanProvider: "zhipu"
    },
    models: [
      { id: "glm-5.1", displayName: "GLM 5.1", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "glm-5.2", displayName: "GLM 5.2", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "baidu-qianfan",
    label: "百度千帆 Coding Plan",
    providerId: "baidu-qianfan",
    name: "百度千帆",
    apiFormat: "openai_chat",
    baseUrl: "https://qianfan.baidubce.com/v2/coding",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "QIANFAN_API_KEY",
    dashboardUrl: "https://console.bce.baidu.com/qianfan/ais/console/applicationConsole/application",
    models: [
      { id: "qianfan-code-latest", displayName: "Qianfan Code Latest", contextWindow: 131072, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "alibaba-bailian",
    label: "阿里百炼 / DashScope",
    providerId: "alibaba-bailian",
    name: "阿里百炼 / DashScope",
    apiFormat: "openai_chat",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    compatPacks: ["reasoning-chat"],
    codexChatReasoning: CODEX_CHAT_REASONING.enableThinking,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    dashboardUrl: "https://bailian.console.aliyun.com/#/api-key",
    models: [
      { id: "qwen3-coder-plus", displayName: "Qwen3 Coder Plus", contextWindow: 1000000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "qwen3-max", displayName: "Qwen3 Max", contextWindow: 262144, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "kimi-coding",
    label: "Kimi For Coding",
    providerId: "kimi-coding",
    name: "Kimi For Coding",
    apiFormat: "openai_chat",
    baseUrl: "https://api.kimi.com/coding/v1",
    compatPacks: ["kimi", "reasoning-chat"],
    codexChatReasoning: CODEX_CHAT_REASONING.thinkingObject,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "KIMI_API_KEY",
    dashboardUrl: "https://www.kimi.com/code/",
    usage_check: {
      templateType: "coding_plan",
      codingPlanProvider: "kimi"
    },
    models: [
      { id: "kimi-for-coding", displayName: "Kimi For Coding", contextWindow: 262144, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "stepfun",
    label: "阶跃星辰 StepFun",
    providerId: "stepfun",
    name: "StepFun",
    apiFormat: "openai_chat",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "STEPFUN_API_KEY",
    dashboardUrl: "https://platform.stepfun.com/interface-key",
    usage_check: {
      templateType: "balance",
      balanceProvider: "stepfun"
    },
    models: [
      { id: "step-3.5-flash-2603", displayName: "Step 3.5 Flash 2603", contextWindow: 262144, capabilities: { tools: true, stream: true } },
      { id: "step-3.5-flash", displayName: "Step 3.5 Flash", contextWindow: 262144, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "modelscope",
    label: "ModelScope",
    providerId: "modelscope",
    name: "ModelScope",
    apiFormat: "openai_chat",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    compatPacks: ["glm", "reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "MODELSCOPE_API_KEY",
    dashboardUrl: "https://modelscope.cn/my/myaccesstoken",
    models: [
      { id: "ZhipuAI/GLM-5.1", displayName: "ZhipuAI / GLM 5.1", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "longcat",
    label: "LongCat",
    providerId: "longcat",
    name: "LongCat",
    apiFormat: "openai_chat",
    baseUrl: "https://api.longcat.chat/openai/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "LONGCAT_API_KEY",
    dashboardUrl: "https://longcat.chat/platform/api_keys",
    models: [
      { id: "LongCat-Flash-Chat", displayName: "LongCat Flash Chat", contextWindow: 262144, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "minimax",
    label: "MiniMax",
    providerId: "minimax",
    name: "MiniMax",
    apiFormat: "openai_chat",
    baseUrl: "https://api.minimaxi.com/v1",
    compatPacks: ["reasoning-chat"],
    codexChatReasoning: CODEX_CHAT_REASONING.minimax,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "MINIMAX_API_KEY",
    dashboardUrl: "https://platform.minimaxi.com",
    usage_check: {
      templateType: "coding_plan",
      codingPlanProvider: "minimax"
    },
    models: [
      { id: "MiniMax-M2.7", displayName: "MiniMax M2.7", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "bailing",
    label: "BaiLing / 蚂蚁灵",
    providerId: "bailing",
    name: "BaiLing",
    apiFormat: "openai_chat",
    baseUrl: "https://api.tbox.cn/api/llm/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "BAILING_API_KEY",
    dashboardUrl: "https://ling.tbox.cn/open",
    models: [
      { id: "Ling-2.5-1T", displayName: "Ling 2.5 1T", contextWindow: 131072, capabilities: { tools: true, stream: true } }
    ]
  },
  {
    id: "siliconflow",
    label: "SiliconFlow",
    providerId: "siliconflow",
    name: "SiliconFlow",
    apiFormat: "openai_chat",
    baseUrl: "https://api.siliconflow.cn/v1",
    compatPacks: ["reasoning-chat"],
    codexChatReasoning: CODEX_CHAT_REASONING.enableThinking,
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    dashboardUrl: "https://cloud.siliconflow.cn/account/ak",
    usage_check: {
      templateType: "balance",
      balanceProvider: "siliconflow"
    },
    models: [
      { id: "Pro/MiniMaxAI/MiniMax-M2.7", displayName: "Pro / MiniMax M2.7", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } },
      { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", displayName: "Qwen3 Coder 480B", contextWindow: 256000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "novita",
    label: "Novita AI",
    providerId: "novita",
    name: "Novita AI",
    apiFormat: "openai_chat",
    baseUrl: "https://api.novita.ai/openai/v1",
    compatPacks: ["glm", "reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "NOVITA_API_KEY",
    dashboardUrl: "https://novita.ai",
    usage_check: {
      templateType: "balance",
      balanceProvider: "novita"
    },
    models: [
      { id: "zai-org/glm-5.1", displayName: "GLM 5.1", contextWindow: 202800, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    providerId: "nvidia",
    name: "NVIDIA",
    apiFormat: "openai_chat",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    compatPacks: ["kimi", "reasoning-chat"],
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "NVIDIA_API_KEY",
    dashboardUrl: "https://build.nvidia.com/settings/api-keys",
    models: [
      { id: "moonshotai/kimi-k2.5", displayName: "Kimi K2.5", contextWindow: 262144, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "antigravity-cli2api",
    label: "Antigravity（外挂 CLIProxyAPI）",
    providerId: "antigravity",
    name: "Antigravity CLI2API",
    apiFormat: "openai_chat",
    baseUrl: "http://127.0.0.1:8317/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "CLIPROXY_API_KEY",
    dashboardUrl: "https://github.com/router-for-me/CLIProxyAPI",
    note: "外挂模式：号池与协议翻译都在 CLIProxyAPI。默认端口 8317，Key 与 cliproxy config 中 api-keys 一致。",
    models: [
      { id: "gemini-3.1-flash-lite", displayName: "Gemini 3.1 Flash Lite", contextWindow: 1000000, capabilities: { tools: true, stream: true, multimodal: true, images: true } },
      { id: "gemini-3-flash", displayName: "Gemini 3 Flash", contextWindow: 1000000, capabilities: { tools: true, stream: true, multimodal: true, images: true } },
      { id: "gemini-3.5-flash-low", displayName: "Gemini 3.5 Flash Low", contextWindow: 1000000, capabilities: { tools: true, stream: true } },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6（via Antigravity）", contextWindow: 200000, capabilities: { tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 Thinking（via Antigravity）", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "antigravity-account-pool",
    label: "Antigravity 账号池（内置管理）",
    providerId: "antigravity-pool",
    name: "Antigravity 账号池",
    apiFormat: "openai_chat",
    baseUrl: "http://127.0.0.1:8317/v1",
    authModes: ["account_pool"],
    defaultAuthMode: "account_pool",
    poolKind: "antigravity_oauth",
    poolStrategy: "weighted_round_robin",
    apiKeyEnv: "CLIPROXY_API_KEY",
    experimental: true,
    riskLevel: "medium",
    riskNote: "账号在 Switchyard 管理并同步到 ~/.cli-proxy-api；请求仍经 CLIProxyAPI 做协议翻译与多号轮询。请保持 8317 进程运行。",
    note: "从 CLIProxyAPI 导入 antigravity-*.json。保存/刷新后会同步回 auth-dir。本地 API Key 填 cliproxy 的 sk-…。",
    models: [
      { id: "gemini-3.5-flash-low", displayName: "Gemini 3.5 Flash Low", contextWindow: 1000000, capabilities: { tools: true, stream: true } },
      { id: "gemini-3-flash", displayName: "Gemini 3 Flash", contextWindow: 1000000, capabilities: { tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", contextWindow: 200000, capabilities: { tools: true, stream: true, multimodal: true, images: true } },
      { id: "claude-opus-4-6-thinking", displayName: "Claude Opus 4.6 Thinking", contextWindow: 200000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "codex-account-pool",
    label: "Codex 订阅账号池（多号）",
    providerId: "codex-pool",
    name: "Codex 订阅池",
    apiFormat: "openai_responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authModes: ["account_pool"],
    defaultAuthMode: "account_pool",
    poolKind: "codex_oauth",
    poolStrategy: "weighted_round_robin",
    experimental: true,
    riskLevel: "high",
    riskNote: "多 ChatGPT/Codex 订阅 OAuth 本地轮询，可能触发官方风控。仅建议用于自有账号；请遵守 OpenAI 服务条款。",
    note: "导入 ~/.codex/auth.json 或多份 tokens。直连官方 Codex Responses，支持加权轮询与失败换号。",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3-Codex-Spark", contextWindow: 128000, capabilities: { reasoning: true, tools: true, stream: true } }
    ]
  },
  {
    id: "sub2api-codex",
    label: "Sub2API（Codex 外挂中转）",
    providerId: "sub2api-codex",
    name: "Sub2API Codex",
    apiFormat: "openai_responses",
    baseUrl: "http://127.0.0.1:3000/v1",
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "SUB2API_API_KEY",
    dashboardUrl: "https://github.com/Wei-Shaw/sub2api",
    experimental: true,
    riskLevel: "medium",
    riskNote: "Sub2API 聚合订阅账号额度中转。请使用自建或可信实例；勿把管理后台密码写入 Switchyard。",
    note: "外挂 Sub2API：号池在 Sub2API 侧。Base URL 填到 /v1。",
    models: [
      { id: "gpt-5.5", displayName: "GPT-5.5 · Sub2API", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.4", displayName: "GPT-5.4 · Sub2API", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } },
      { id: "gpt-5.4-mini", displayName: "GPT-5.4-Mini · Sub2API", contextWindow: 272000, capabilities: { reasoning: true, tools: true, stream: true, multimodal: true, images: true } }
    ]
  },
  {
    id: "ollama",
    label: "Ollama（本机）",
    providerId: "ollama",
    name: "Ollama",
    apiFormat: "openai_chat",
    baseUrl: "http://localhost:11434/v1",
    authModes: ["none", "api_key"],
    defaultAuthMode: "none",
    apiKeyEnv: "",
    note: "本机服务通常不需要 Key。"
  },
  {
    id: "lm-studio",
    label: "LM Studio（本机）",
    providerId: "lm-studio",
    name: "LM Studio",
    apiFormat: "openai_chat",
    baseUrl: "http://localhost:1234/v1",
    authModes: ["none", "api_key"],
    defaultAuthMode: "none",
    apiKeyEnv: "",
    note: "本机服务通常不需要 Key。"
  },
  {
    // KE OpenAPI（ait.ke.com / openapi-ait.ke.com）：OpenAI Chat 兼容；模型目录无公开 /models，用预制列表。
    // 模型清单来源：https://ait.ke.com/models → meta/endpoint/details chat/completions（2026-07-15）
    id: "ke",
    label: "KE",
    providerId: "ke",
    name: "KE",
    apiFormat: "openai_chat",
    baseUrl: "https://openapi-ait.ke.com/v1",
    authModes: ["api_key", "keychain"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "KE_API_KEY",
    preferPresetModels: true,
    note: "OpenAI 兼容协议（openapi-ait.ke.com）。能力字段按 ait.ke.com 模型目录 meta 填写；API Key 本机自填，勿提交配置。",
    // Claude / GPT：按产品要求能力全开；DeepSeek / GLM：仍按 ait 目录
    models: [
      { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "claude-4.6-sonnet", displayName: "Claude 4.6 Sonnet", contextWindow: 200000, maxOutputTokens: 64000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "claude-opus-4.6", displayName: "Claude Opus 4.6", contextWindow: 200000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "gpt-5.5", displayName: "GPT-5.5", contextWindow: 922000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "gpt-5.4", displayName: "GPT-5.4", contextWindow: 1050000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", contextWindow: 1050000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", contextWindow: 1050000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra", contextWindow: 1050000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: true, images: true, stream: true, multimodal: true } },
      // DeepSeek / GLM：按目录，非全开
      { id: "Deepseek-V4-Pro", displayName: "DeepSeek V4 Pro", contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: false, images: false, stream: true, multimodal: false } },
      { id: "Deepseek-V4-Flash", displayName: "DeepSeek V4 Flash", contextWindow: 1000000, maxOutputTokens: 384000, capabilities: { text: true, tools: true, reasoning: false, images: false, stream: true, multimodal: false } },
      { id: "GLM-5.2", displayName: "GLM-5.2", contextWindow: 1000000, maxOutputTokens: 128000, capabilities: { text: true, tools: true, reasoning: false, images: false, stream: true, multimodal: false } },
      { id: "GLM-5.1", displayName: "GLM-5.1", capabilities: { text: true, tools: true, reasoning: false, images: false, stream: true, multimodal: false } }
    ]
  },
  {
    id: "custom-openai",
    label: "自定义 OpenAI-compatible",
    providerId: "custom",
    name: "自定义供应商",
    apiFormat: "openai_chat",
    baseUrl: "",
    authModes: ["api_key", "none"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "CUSTOM_API_KEY"
  },
  {
    id: "custom-anthropic",
    label: "自定义 Anthropic-compatible",
    providerId: "custom-anthropic",
    name: "自定义 Claude 供应商",
    apiFormat: "anthropic_messages",
    baseUrl: "",
    authModes: ["api_key", "none"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "CUSTOM_ANTHROPIC_API_KEY"
  }
];

export const AUTH_MODE_LABELS = {
  api_key: "API Key",
  codex_oauth: "Codex OAuth（复用 codex login）",
  anthropic_oauth: "Anthropic 官方（复用 Claude Code 登录）",
  account_pool: "账号池（多账号）",
  none: "无需认证"
};

export function listProviderPresets() {
  return PROVIDER_PRESETS.map((preset) => ({ ...preset }));
}

export function getProviderPreset(id) {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) || null;
}

export function presetModelHints(presetOrId) {
  const preset = typeof presetOrId === "string" ? getProviderPreset(presetOrId) : presetOrId;
  const hints = new Map();
  for (const model of preset?.models || []) {
    hints.set(model.id, model);
  }
  return hints;
}

export function providerPresetFor(provider) {
  if (!provider) return null;
  if (provider.presetId) return getProviderPreset(provider.presetId);
  return PROVIDER_PRESETS.find((preset) => preset.providerId === provider.id || preset.id === provider.id) || null;
}

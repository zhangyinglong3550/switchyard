export const PROVIDER_PRESETS = [
  {
    id: "codex-oauth",
    label: "OpenAI Codex（OAuth）",
    providerId: "codex",
    name: "OpenAI Codex",
    apiFormat: "openai_responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    apiKeyBaseUrl: "https://api.openai.com/v1",
    authModes: ["codex_oauth", "api_key"],
    defaultAuthMode: "codex_oauth",
    apiKeyEnv: "OPENAI_API_KEY",
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
    label: "Anthropic Claude",
    providerId: "anthropic",
    name: "Anthropic Claude",
    apiFormat: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    authModes: ["api_key"],
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
    id: "moonshot",
    label: "Moonshot / Kimi API",
    providerId: "moonshot",
    name: "Moonshot / Kimi",
    apiFormat: "openai_chat",
    baseUrl: "https://api.moonshot.ai/v1",
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
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    dashboardUrl: "https://platform.deepseek.com/api_keys",
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
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "OPENROUTER_API_KEY",
    dashboardUrl: "https://openrouter.ai/keys"
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    providerId: "opencode-go",
    name: "OpenCode Go",
    apiFormat: "openai_chat",
    baseUrl: "https://opencode.ai/zen/go/v1",
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
    authModes: ["api_key"],
    defaultAuthMode: "api_key",
    apiKeyEnv: "ZAI_API_KEY",
    dashboardUrl: "https://z.ai",
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

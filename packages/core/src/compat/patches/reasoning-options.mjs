const REASONING_CONFIGS = {
  deepseek: {
    supportsThinking: true,
    supportsEffort: true,
    thinkingParam: "thinking",
    effortParam: "reasoning_effort",
    effortValueMode: "deepseek"
  },
  dashscope: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: "enable_thinking",
    effortParam: "none"
  },
  minimax: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: "reasoning_split",
    effortParam: "none"
  },
  openrouter: {
    supportsThinking: false,
    supportsEffort: true,
    thinkingParam: "none",
    effortParam: "reasoning.effort",
    effortValueMode: "openrouter"
  },
  thinkingObject: {
    supportsThinking: true,
    supportsEffort: false,
    thinkingParam: "thinking",
    effortParam: "none"
  },
  stepfun: {
    supportsThinking: true,
    supportsEffort: true,
    thinkingParam: "none",
    effortParam: "reasoning_effort",
    effortValueMode: "low_high"
  }
};

function haystack({ provider, model }) {
  return [
    provider?.id,
    provider?.name,
    provider?.displayName,
    provider?.baseUrl,
    model?.id,
    model?.providerId,
    model?.upstreamModel,
    model?.displayName,
    ...(model?.aliases || [])
  ].filter(Boolean).join(" ");
}

function platformHaystack({ provider }) {
  return [
    provider?.id,
    provider?.name,
    provider?.displayName,
    provider?.baseUrl
  ].filter(Boolean).join(" ");
}

function field(value, camel, snake) {
  if (!value || typeof value !== "object") return undefined;
  return value[camel] ?? value[snake];
}

function normalizeReasoningConfig(raw) {
  if (!raw || typeof raw !== "object") return null;
  const config = {
    supportsThinking: field(raw, "supportsThinking", "supports_thinking"),
    supportsEffort: field(raw, "supportsEffort", "supports_effort"),
    thinkingParam: field(raw, "thinkingParam", "thinking_param"),
    effortParam: field(raw, "effortParam", "effort_param"),
    effortValueMode: field(raw, "effortValueMode", "effort_value_mode"),
    outputFormat: field(raw, "outputFormat", "output_format")
  };
  if (config.supportsEffort === true && config.supportsThinking === undefined) {
    config.supportsThinking = true;
  }
  return config;
}

function explicitReasoningConfig(ctx) {
  const candidates = [
    ctx?.model?.codexChatReasoning,
    ctx?.model?.codex_chat_reasoning,
    ctx?.model?.meta?.codexChatReasoning,
    ctx?.model?.meta?.codex_chat_reasoning,
    ctx?.provider?.codexChatReasoning,
    ctx?.provider?.codex_chat_reasoning,
    ctx?.provider?.meta?.codexChatReasoning,
    ctx?.provider?.meta?.codex_chat_reasoning
  ];
  return candidates.map(normalizeReasoningConfig).find(Boolean) || null;
}

function ruleFromConfig(id, config) {
  return {
    id,
    apply(out, enabled, effort) {
      applyReasoningConfig(out, enabled, effort, config);
    }
  };
}

function selectedRule(ctx) {
  const explicit = explicitReasoningConfig(ctx);
  if (explicit) return ruleFromConfig("configured", explicit);

  const platform = platformHaystack(ctx).toLowerCase();
  if (platform.includes("openrouter")) return ruleFromConfig("openrouter", REASONING_CONFIGS.openrouter);
  if (platform.includes("siliconflow")) return ruleFromConfig("siliconflow", REASONING_CONFIGS.dashscope);

  const text = haystack(ctx).toLowerCase();
  if (text.includes("deepseek")) return ruleFromConfig("deepseek", REASONING_CONFIGS.deepseek);
  if (text.includes("stepfun") || text.includes("step-3.5-flash-2603")) return ruleFromConfig("stepfun", REASONING_CONFIGS.stepfun);
  if (/qwen|dashscope|bailian|aliyun/.test(text)) return ruleFromConfig("qwen-dashscope", REASONING_CONFIGS.dashscope);
  if (text.includes("minimax")) return ruleFromConfig("minimax", REASONING_CONFIGS.minimax);
  if (/kimi|moonshot|glm|zhipu|z-ai|zai|xiaomi|mimo|modelscope|novita|nvidia|longcat/.test(text)) {
    return ruleFromConfig("thinking-object", REASONING_CONFIGS.thinkingObject);
  }
  return null;
}

function requestedReasoning(body) {
  if (body?.reasoning_effort) return { explicit: true, enabled: !isOff(body.reasoning_effort), effort: String(body.reasoning_effort) };
  if (!Object.prototype.hasOwnProperty.call(body || {}, "reasoning")) return { explicit: false, enabled: false, effort: "" };
  const reasoning = body.reasoning;
  if (reasoning == null || reasoning === false) return { explicit: true, enabled: false, effort: "" };
  if (typeof reasoning === "string") return { explicit: true, enabled: !isOff(reasoning), effort: reasoning };
  if (typeof reasoning === "object") {
    const effort = typeof reasoning.effort === "string" ? reasoning.effort : "";
    return { explicit: true, enabled: !isOff(effort || "on"), effort };
  }
  return { explicit: true, enabled: Boolean(reasoning), effort: "" };
}

function isOff(value) {
  return /^(none|off|disabled|false|0)$/i.test(String(value || "").trim());
}

function mapEffort(value, mode) {
  const effort = String(value || "").trim().toLowerCase();
  if (mode === "deepseek") return effort === "max" || effort === "xhigh" ? "max" : "high";
  if (mode === "low_high") return effort === "minimal" || effort === "low" ? "low" : "high";
  if (mode === "openrouter") {
    if (effort === "max") return "xhigh";
    if (["xhigh", "high", "medium", "low", "minimal"].includes(effort)) return effort;
    return "high";
  }
  return effort || "high";
}

function stripGenericReasoningOptions(out) {
  delete out.reasoning_effort;
  delete out.reasoning;
  return out;
}

function applyReasoningConfig(out, enabled, effort, config) {
  const supportsEffort = config.supportsEffort === true || isEnabledParam(config.effortParam);
  const thinkingParam = String(config.thinkingParam || "thinking").trim().toLowerCase();
  const supportsThinking = config.supportsThinking === true ||
    (config.supportsThinking !== false && supportsEffort && thinkingParam !== "none");
  if (supportsThinking) {
    if (thinkingParam === "thinking") out.thinking = { type: enabled ? "enabled" : "disabled" };
    else if (thinkingParam === "enable_thinking") out.enable_thinking = enabled;
    else if (thinkingParam === "reasoning_split") out.reasoning_split = enabled;
  }

  const effortParam = String(config.effortParam || "reasoning_effort").trim().toLowerCase();
  if (!enabled) {
    if (effortParam === "reasoning.effort") out.reasoning = { effort: "none" };
    return;
  }
  if (!supportsEffort) return;
  const mapped = mapEffort(effort || "high", config.effortValueMode);
  if (!mapped) return;
  if (effortParam === "reasoning_effort") out.reasoning_effort = mapped;
  else if (effortParam === "reasoning.effort") out.reasoning = { effort: mapped };
}

function isEnabledParam(value) {
  const text = String(value || "").trim().toLowerCase();
  return Boolean(text && text !== "none");
}

export const reasoningOptionsPatch = {
  id: "reasoning-options",
  label: "Reasoning 请求参数适配",
  description: "把 Codex/OpenAI reasoning 请求翻译成各供应商 Chat Completions 使用的 thinking 参数。",
  trigger: "优先读取 provider/model 的 codexChatReasoning；未配置时按平台优先识别 OpenRouter/SiliconFlow，再按模型族识别 DeepSeek、Qwen/DashScope、Kimi、GLM、MiniMax、小米等。",
  changes: [
    "显式 codexChatReasoning 可覆盖启发式推断，兼容 CC Switch 的字段语义",
    "平台优先：OpenRouter/SiliconFlow 的参数形态覆盖模型名里的 DeepSeek/MiniMax 等厂商名",
    "DeepSeek: reasoning.effort -> thinking + reasoning_effort",
    "Qwen/DashScope: reasoning -> enable_thinking",
    "MiniMax: reasoning -> reasoning_split",
    "OpenRouter: reasoning.effort -> reasoning.effort，并把 max 钳到 xhigh",
    "Kimi/GLM/MiMo 等: reasoning -> thinking"
  ],
  risk: "仅在请求显式携带 reasoning/reasoning_effort 时改写；如果某个上游不支持 thinking，可关闭该规则。",
  tests: [
    "reasoning-options · maps Codex reasoning to DashScope enable_thinking",
    "reasoning-options · maps Codex reasoning to MiniMax reasoning_split",
    "reasoning-options · maps Codex reasoning to OpenRouter reasoning.effort"
  ],
  match(ctx) {
    return Boolean(selectedRule(ctx));
  },
  outbound(body, ctx) {
    const request = requestedReasoning(body);
    if (!request.explicit) return body;
    const rule = selectedRule(ctx);
    if (!rule) return body;
    const out = stripGenericReasoningOptions({ ...body });
    rule.apply(out, request.enabled, request.effort);
    return out;
  }
};

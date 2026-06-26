import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CATEGORY_HINTS = {
  auth: {
    title: "认证失败",
    hint: "检查供应商密钥、OAuth 登录状态或系统安全存储中保存的 Key 是否正确。"
  },
  network: {
    title: "网络连接失败",
    hint: "检查 Base URL、固定端口、代理配置和本机网络连通性。"
  },
  protocol: {
    title: "协议或接口路径不匹配",
    hint: "检查供应商协议类型是否选对，例如 OpenAI Chat、OpenAI Responses 或 Anthropic Messages。"
  },
  model_not_found: {
    title: "模型名不在供应商列表中",
    hint: "检查模型 ID 是否带了多余前缀，或重新查询模型列表后选择正确的上游模型名。"
  },
  schema: {
    title: "请求字段不被上游接受",
    hint: "这是兼容补丁问题，优先确认该补丁是否已经按 provider/model 定向生效。"
  },
  protocol_state: {
    title: "协议状态未完整回传",
    hint: "检查 thinking/reasoning、tool_use、function_call 等状态块是否在下一轮历史中原样回传。"
  },
  tool_result_order: {
    title: "工具结果顺序不兼容",
    hint: "并发工具调用后，所有 tool_result 通常需要紧跟同一条 user message 返回。"
  },
  role_compat: {
    title: "角色字段不兼容",
    hint: "部分上游不接受 developer 等扩展角色，建议转换为 system 或启用角色兼容规则。"
  },
  capability: {
    title: "模型能力声明不匹配",
    hint: "运行能力校准，确认该模型是否支持图片、工具调用、流式或推理字段。"
  },
  client_config: {
    title: "客户端配置漂移",
    hint: "重新安装对应客户端配置，让 Codex、Claude Code 或 Hermes 指回 Switchyard。"
  },
  unknown: {
    title: "未知错误",
    hint: "查看调用链路可视化和请求日志，确认上游返回体中的具体错误。"
  }
};

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonMaybe(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function okProbe(result) {
  return Boolean(result && result.ok);
}

function targetUrls({ host = "127.0.0.1", port = 17888 } = {}) {
  const origin = `http://${host}:${port}`;
  return {
    origin,
    codex: `${origin}/codex/v1`,
    claudeCode: `${origin}/claude-code`,
    hermes: `${origin}/hermes/v1`
  };
}

export function classifyGatewayError(error) {
  const text = asText(error);
  const lower = text.toLowerCase();
  let category = "unknown";

  if (/(401|403|unauthorized|forbidden|invalid api key|api[_ -]?key|x-api-key|access token|bearer|oauth|permission denied)/i.test(text)) {
    category = "auth";
  } else if (/(fetch failed|econnrefused|econnreset|etimedout|enotfound|network|socket hang up|certificate|proxy|status:\s*n\/a)/i.test(text)) {
    category = "network";
  } else if (/(model .*not found|was not found in this provider|unknown model|model_not_found|similar models)/i.test(text)) {
    category = "model_not_found";
  } else if (/(content\[\]\.thinking|thinking mode must be passed back|reasoning.*must be passed back|encrypted_content|signature.*thinking)/i.test(text)) {
    category = "protocol_state";
  } else if (/(tool use concurrency|tool_use ids were found without tool_result|tool_result blocks immediately after|parallel tool)/i.test(text)) {
    category = "tool_result_order";
  } else if (/(unsupported role|invalid role|role.*developer|developer.*not supported)/i.test(text)) {
    category = "role_compat";
  } else if (/(extra inputs are not permitted|extra_forbidden|invalid_request_error|schema|unknown field|unsupported field|field:|validation error)/i.test(text)) {
    category = "schema";
  } else if (/(does not support|not support|unsupported.*(image|vision|tool|function|stream|reasoning)|image input|tool use|multimodal)/i.test(text)) {
    category = "capability";
  } else if (/(404|not found|endpoint|route|path|method not allowed|wire_api|anthropic-version|responses api|chat completions)/i.test(text)) {
    category = "protocol";
  } else if (/(client config|model_provider|anthropic_base_url|base_url|配置漂移|未指向 switchyard)/i.test(lower)) {
    category = "client_config";
  }

  return {
    category,
    message: text.slice(0, 1000),
    ...CATEGORY_HINTS[category]
  };
}

export function suggestCapabilitiesFromProbeResults(model = {}, results = {}) {
  const current = { ...(model.capabilities || {}) };
  const visionOk = okProbe(results.vision) || okProbe(results.images) || okProbe(results.multimodal);
  const hasVisionResult = Boolean(results.vision || results.images || results.multimodal);
  const capabilities = {
    text: results.text ? okProbe(results.text) : Boolean(current.text),
    stream: results.stream ? okProbe(results.stream) : Boolean(current.stream),
    tools: results.tools ? okProbe(results.tools) : Boolean(current.tools),
    images: hasVisionResult ? visionOk : Boolean(current.images),
    multimodal: hasVisionResult ? visionOk : Boolean(current.multimodal),
    reasoning: results.reasoning ? okProbe(results.reasoning) : Boolean(current.reasoning)
  };
  return {
    modelId: model.id || model.modelId || "",
    upstreamModel: model.upstreamModel || model.id || "",
    capabilities,
    probes: { ...results }
  };
}

function probeFailureText(result) {
  if (!result) return "";
  return asText(result.error || result.bodyPreview || result.preview || result.classification?.message || "");
}

function probeCategory(result) {
  if (!result) return "unknown";
  if (result.classification?.category) return result.classification.category;
  return classifyGatewayError(probeFailureText(result)).category;
}

function anyProbeCategory(results, category) {
  return Object.values(results || {}).some((result) => result && result.ok === false && probeCategory(result) === category);
}

function recommendation(ruleId, title, reason, action = "review") {
  return { ruleId, title, reason, action };
}

export function buildCompatibilityProfile({ provider = {}, model = {}, results = {}, activeRules = [] } = {}) {
  const supportsDeveloperRole = results["developer-role"] ? okProbe(results["developer-role"]) : null;
  const schemaStrictness = anyProbeCategory(results, "schema") ? "high" : "unknown";
  const flags = {
    supportsText: results.text ? okProbe(results.text) : null,
    supportsStream: results.stream ? okProbe(results.stream) : null,
    supportsTools: results.tools ? okProbe(results.tools) : null,
    supportsVision: results.vision ? okProbe(results.vision) : null,
    supportsReasoning: results.reasoning ? okProbe(results.reasoning) : null,
    supportsDeveloperRole,
    requiresThinkingRoundtrip: anyProbeCategory(results, "protocol_state"),
    requiresToolResultsTogether: anyProbeCategory(results, "tool_result_order"),
    schemaStrictness,
    streaming: results.stream ? (okProbe(results.stream) ? "sse-standard" : "failed") : "unknown"
  };
  const recommendations = [];
  if (flags.requiresThinkingRoundtrip) {
    recommendations.push(recommendation(
      "anthropic-thinking-roundtrip",
      "保留 thinking / signature 回传",
      "上游要求下一轮历史携带上一轮 thinking 状态块。",
      "adapter"
    ));
  }
  if (flags.requiresToolResultsTogether) {
    recommendations.push(recommendation(
      "batch-parallel-tool-results",
      "合并并发工具结果",
      "上游要求并发 tool_use 的 tool_result 紧跟在同一条 user message。",
      "adapter"
    ));
  }
  if (supportsDeveloperRole === false) {
    recommendations.push(recommendation(
      "developer-to-system",
      "将 developer 角色转为 system",
      "上游不接受 developer 扩展角色。",
      "adapter"
    ));
  }
  if (schemaStrictness === "high") {
    recommendations.push(recommendation(
      "sanitize-tool-schema",
      "清理工具 JSON Schema",
      "上游拒绝部分通用 JSON Schema 字段。",
      "compat-rule"
    ));
  }
  if (flags.supportsStream === false) {
    recommendations.push(recommendation(
      "stream-fallback",
      "使用非流式兜底或更强 keepalive",
      "上游流式返回不稳定或格式不标准。",
      "runtime-policy"
    ));
  }
  return {
    providerId: provider.id || model.providerId || "",
    modelId: model.id || model.modelId || "",
    upstreamModel: model.upstreamModel || model.id || "",
    protocol: provider.apiFormat || "openai_chat",
    flags,
    recommendations,
    activeRules: Array.isArray(activeRules) ? activeRules : []
  };
}

function messageText(parts) {
  if (parts == null) return "";
  if (typeof parts === "string") return parts;
  if (Array.isArray(parts)) {
    return parts.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || part?.input_text || part?.value || "";
    }).filter(Boolean).join("\n");
  }
  if (typeof parts === "object") return parts.text || parts.content || parts.input_text || "";
  return String(parts);
}

function replayMessages(summary) {
  const messages = summary?.messages || summary?.request?.messages || [];
  if (Array.isArray(messages)) {
    return messages.map((message) => ({
      role: message.role || "user",
      content: messageText(message.content ?? message.text ?? message.parts)
    })).filter((message) => message.content);
  }
  const rows = [];
  for (const role of ["system", "user", "assistant"]) {
    const text = messageText(messages[role]);
    if (text) rows.push({ role, content: text });
  }
  return rows.length ? rows : [{ role: "user", content: summary?.prompt || "Hello" }];
}

export function buildReplayDraft(row = {}) {
  const summary = parseJsonMaybe(row.request_summary || row.requestSummary, {});
  const params = summary.params || summary.request || {};
  const messages = replayMessages(summary);
  return {
    sourceLogId: row.id,
    modelId: row.model_id || row.modelId || row.requested_model || row.requestedModel || "",
    requestedModel: row.requested_model || row.requestedModel || "",
    messages,
    stream: Boolean(params.stream ?? summary.stream),
    temperature: Number.isFinite(Number(params.temperature)) ? Number(params.temperature) : undefined,
    maxTokens: Number.isFinite(Number(params.maxTokens ?? params.max_tokens ?? params.max_completion_tokens))
      ? Number(params.maxTokens ?? params.max_tokens ?? params.max_completion_tokens)
      : undefined,
    tools: Array.isArray(summary.tools) ? summary.tools.map((tool) => ({
      name: tool.name || tool.function?.name || "tool",
      description: tool.description || tool.function?.description || "",
      propertyCount: Number(tool.propertyCount || 0)
    })) : []
  };
}

function statusResult(status, label, details = {}) {
  return {
    status,
    label,
    ...details
  };
}

function detectCodexConfig(codexText, urls) {
  if (codexText == null) return statusResult("missing", "未找到 Codex 配置", { expected: urls.codex });
  const text = String(codexText);
  const hasSwitchyardProvider = /model_provider\s*=\s*["']custom["']/.test(text);
  const hasProvider = /\[model_providers\.custom\]/.test(text);
  const hasBaseUrl = text.includes(urls.codex);
  const hasResponses = /wire_api\s*=\s*["']responses["']/.test(text);
  if (hasSwitchyardProvider && hasProvider && hasBaseUrl && hasResponses) {
    return statusResult("ok", "Codex 已指向 Switchyard", { expected: urls.codex });
  }
  return statusResult("drifted", "Codex 配置未指向 Switchyard", {
    expected: urls.codex,
    missing: [
      !hasSwitchyardProvider && "model_provider = custom",
      !hasProvider && "[model_providers.custom]",
      !hasBaseUrl && urls.codex,
      !hasResponses && "wire_api = responses"
    ].filter(Boolean)
  });
}

function detectClaudeCodeConfig(settings, urls) {
  if (settings == null) return statusResult("missing", "未找到 Claude Code 配置", { expected: urls.claudeCode });
  const text = asText(settings);
  if (text.includes(urls.claudeCode) || text.includes(`${urls.origin}/anthropic`)) {
    return statusResult("ok", "Claude Code 已指向 Switchyard", { expected: urls.claudeCode });
  }
  return statusResult("drifted", "Claude Code 配置未指向 Switchyard", { expected: urls.claudeCode });
}

function detectHermesConfig(yamlText, urls) {
  // Hermes 只读取 config.yaml，因此诊断只看 YAML。
  if (yamlText == null) return statusResult("missing", "未找到 Hermes 配置", { expected: urls.hermes });
  const text = asText(yamlText);
  if (text.includes(urls.hermes) || text.includes(`${urls.origin}/v1`)) {
    return statusResult("ok", "Hermes 已指向 Switchyard", { expected: urls.hermes });
  }
  return statusResult("drifted", "Hermes 配置未指向 Switchyard", { expected: urls.hermes });
}

export function doctorClientConfigContents(options = {}) {
  const urls = targetUrls(options);
  return {
    codex: detectCodexConfig(options.codexText, urls),
    "claude-code": detectClaudeCodeConfig(options.claudeSettings, urls),
    hermes: detectHermesConfig(options.hermesYamlText, urls)
  };
}

function readTextMaybe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    return { unreadable: true, error: err?.message || String(err), path: file };
  }
}

function readJsonMaybe(file) {
  const text = readTextMaybe(file);
  if (text == null || typeof text === "object") return text;
  try {
    return JSON.parse(text);
  } catch (err) {
    return { unreadable: true, error: err?.message || String(err), path: file };
  }
}

export function doctorClientConfigs({ host = "127.0.0.1", port = 17888, home = os.homedir() } = {}) {
  const codexPath = path.join(home, ".codex", "config.toml");
  const claudePath = path.join(home, ".claude", "settings.json");
  // Hermes 只读取 config.yaml；config.json 不再参与诊断。
  const hermesYamlPath = path.join(home, ".hermes", "config.yaml");
  const codexText = readTextMaybe(codexPath);
  const claudeSettings = readJsonMaybe(claudePath);
  const hermesYamlText = readTextMaybe(hermesYamlPath);

  const contents = doctorClientConfigContents({
    host,
    port,
    codexText: typeof codexText === "string" ? codexText : null,
    claudeSettings: claudeSettings && !claudeSettings.unreadable ? claudeSettings : null,
    hermesYamlText: typeof hermesYamlText === "string" ? hermesYamlText : null
  });

  return {
    ...contents,
    paths: {
      codex: codexPath,
      "claude-code": claudePath,
      hermes: hermesYamlPath
    },
    errors: [
      codexText?.unreadable && { client: "codex", ...codexText },
      claudeSettings?.unreadable && { client: "claude-code", ...claudeSettings },
      hermesYamlText?.unreadable && { client: "hermes", ...hermesYamlText }
    ].filter(Boolean)
  };
}

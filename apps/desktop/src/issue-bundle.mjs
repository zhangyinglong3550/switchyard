import { classifyGatewayError } from "./diagnostics.mjs";
import fs from "node:fs";
import path from "node:path";

const BUNDLE_KIND = "switchyard-compat-issue-bundle";
const BUNDLE_VERSION = 1;
const SENSITIVE_KEY_RE = /authorization|cookie|token|api[_-]?key|secret|password|credential|oauth/i;

function parseJsonMaybe(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function pick(row, ...keys) {
  for (const key of keys) {
    if (row?.[key] !== undefined && row[key] !== null) return row[key];
  }
  return "";
}

export function redactText(value, max = 500) {
  let text = value == null ? "" : String(value);
  text = text
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/gi, "[image-data]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/\b(Bearer|Authorization|Cookie|X-Api-Key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*["']?[^"',;\s]+/gi, "$1=[redacted]")
    .replace(/\/Users\/[^/\s)"']+(?:\/[^\s)"']*)?/g, "[local-path]")
    .replace(/\/var\/folders\/[^\s)"']+/g, "[local-path]")
    .replace(/~\/[^\s)"']+/g, "[local-path]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/https?:\/\/[^\s)"']+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}/[redacted-url]`;
      } catch {
        return "[url]";
      }
    });
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function redactObject(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactText(value, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactObject(item, depth + 1));
  if (typeof value !== "object") return redactText(value, 500);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : redactObject(item, depth + 1);
  }
  return out;
}

function stringList(values, max = 20) {
  return (Array.isArray(values) ? values : [])
    .map((value) => redactText(value, 120))
    .filter(Boolean)
    .slice(0, max);
}

function textStats(text) {
  const value = String(text || "");
  return {
    hasText: value.length > 0,
    chars: value.length,
    bytes: Buffer.byteLength(value, "utf8")
  };
}

function summarizeMessageSection(role, items = []) {
  return (Array.isArray(items) ? items : []).slice(0, 40).map((item) => ({
    role: item?.role || role,
    text: textStats(item?.text || item?.content || ""),
    toolCalls: (Array.isArray(item?.toolCalls) ? item.toolCalls : [])
      .map((call) => ({ name: redactText(call?.name || "", 120), hasId: Boolean(call?.id) }))
      .filter((call) => call.name)
      .slice(0, 20)
  }));
}

function summarizeMessages(summary = {}) {
  const messages = summary.messages || {};
  if (Array.isArray(messages)) {
    return {
      roleCounts: messages.reduce((acc, message) => {
        const role = message?.role || "unknown";
        acc[role] = (acc[role] || 0) + 1;
        return acc;
      }, {}),
      images: Number(summary.images || 0),
      skills: [],
      samples: messages.slice(0, 80).map((message) => ({
        role: message?.role || "user",
        text: textStats(message?.content || message?.text || "")
      }))
    };
  }
  const samples = [
    ...summarizeMessageSection("system", messages.system),
    ...summarizeMessageSection("user", messages.user),
    ...summarizeMessageSection("assistant", messages.assistant),
    ...summarizeMessageSection("tool", messages.tool)
  ];
  return {
    roleCounts: redactObject(messages.roleCounts || {}),
    images: Number(messages.images || 0),
    skills: stringList(messages.skills, 40),
    samples
  };
}

function safeTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).slice(0, 80).map((tool) => ({
    name: redactText(tool?.name || tool?.function?.name || "", 120),
    required: stringList(tool?.required || tool?.function?.parameters?.required, 30),
    propertyCount: Number(tool?.propertyCount || 0)
  })).filter((tool) => tool.name);
}

function safeToolCalls(calls = []) {
  return (Array.isArray(calls) ? calls : []).slice(0, 80).map((call) => ({
    name: redactText(call?.name || "", 120),
    hasArguments: Boolean(call?.argumentsPreview || call?.arguments),
    argumentBytes: Buffer.byteLength(String(call?.argumentsPreview || call?.arguments || ""), "utf8")
  })).filter((call) => call.name);
}

function compactRules(rulesByDirection = {}) {
  const out = {};
  for (const direction of ["outbound", "inbound", "stream"]) {
    out[direction] = (Array.isArray(rulesByDirection?.[direction]) ? rulesByDirection[direction] : [])
      .slice(0, 40)
      .map((rule) => ({
        id: rule.id || "",
        label: rule.label || rule.id || "",
        source: rule.source || "auto",
        risk: rule.risk || "",
        directions: Array.isArray(rule.directions) ? rule.directions : []
      }));
  }
  return out;
}

function compactRectifiers(items = []) {
  return (Array.isArray(items) ? items : []).slice(0, 20).map((item) => ({
    name: item?.name || item?.id || "rectifier",
    errorClass: item?.errorClass || item?.reason || "",
    retryStatus: item?.retryStatus ?? null,
    retryOk: item?.retryOk ?? null,
    changed: redactObject(Object.fromEntries(Object.entries(item || {})
      .filter(([key]) => !["body", "request", "response", "payload"].includes(key))))
  }));
}

function requestOverrideSummary(summary = {}) {
  const overrides = summary.requestOverrides || summary.request_overrides || null;
  if (!overrides) return null;
  return {
    sources: stringList(overrides.sources, 10),
    headerNames: stringList(overrides.headerNames, 20),
    bodyKeys: stringList(overrides.bodyKeys, 40)
  };
}

function safeParams(params = {}) {
  return {
    stream: Boolean(params.stream),
    temperature: Number.isFinite(Number(params.temperature)) ? Number(params.temperature) : null,
    maxTokens: Number.isFinite(Number(params.maxTokens ?? params.max_tokens)) ? Number(params.maxTokens ?? params.max_tokens) : null,
    toolChoice: redactObject(params.toolChoice ?? params.tool_choice ?? null)
  };
}

function buildFixtureDraft({ row, requestSummary, bundleId }) {
  const providerId = pick(row, "provider_id", "providerId") || requestSummary.providerId || "";
  const modelId = pick(row, "model_id", "modelId") || requestSummary.modelId || "";
  const upstreamModel = pick(row, "upstream_model", "upstreamModel") || requestSummary.upstreamModel || "";
  const apiFormat = pick(row, "api_format", "apiFormat") || requestSummary.protocol || "openai_chat";
  const firstUser = (requestSummary.messages?.user || [])[0];
  return {
    id: bundleId,
    note: "Draft only: replace redacted content with a minimal synthetic prompt before committing as a fixture.",
    operationHint: "compat_outbound",
    ctx: {
      provider: { id: providerId, apiFormat },
      model: { id: modelId, providerId, upstreamModel }
    },
    inputTemplate: {
      model: upstreamModel || modelId,
      messages: [
        {
          role: "user",
          content: `[redacted user text; chars=${String(firstUser?.text || "").length}]`
        }
      ],
      tools: safeTools(requestSummary.tools).map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          parameters: {
            type: "object",
            properties: {},
            required: tool.required
          }
        }
      }))
    },
    expect: { output: {} }
  };
}

export function buildIssueBundle(row = {}, { generatedAt = new Date().toISOString() } = {}) {
  const requestSummary = parseJsonMaybe(row.request_summary || row.requestSummary, {});
  const responseSummary = parseJsonMaybe(row.response_summary || row.responseSummary, {});
  const bundleId = `issue-${pick(row, "id") || Date.parse(generatedAt) || "manual"}`;
  const rawError = pick(row, "error") || responseSummary.error || requestSummary.errorClass || "";
  const classification = classifyGatewayError(rawError);
  const errorClass = requestSummary.errorClass || requestSummary.error_class || "";
  const bundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    id: bundleId,
    generatedAt,
    sanitization: {
      messageBodies: "removed",
      responseText: "removed",
      toolArguments: "removed",
      secrets: "redacted",
      localPaths: "redacted"
    },
    source: {
      requestLogId: pick(row, "id") || null,
      ts: pick(row, "ts") || "",
      method: pick(row, "method") || "",
      path: redactText(pick(row, "path") || "", 200),
      clientId: pick(row, "client_id", "clientId") || "",
      providerId: pick(row, "provider_id", "providerId") || requestSummary.providerId || "",
      modelId: pick(row, "model_id", "modelId") || requestSummary.modelId || "",
      requestedModel: pick(row, "requested_model", "requestedModel") || "",
      upstreamModel: pick(row, "upstream_model", "upstreamModel") || requestSummary.upstreamModel || "",
      apiFormat: pick(row, "api_format", "apiFormat") || "",
      status: Number(pick(row, "status") || 0),
      latencyMs: Number(pick(row, "latency_ms", "latencyMs") || 0)
    },
    classification: {
      category: classification.category,
      title: classification.title,
      hint: classification.hint,
      errorClass
    },
    compatibility: {
      conversionChain: redactObject(requestSummary.conversionChain || {}),
      compatRules: compactRules(requestSummary.compatRules || {}),
      rectifiers: compactRectifiers(requestSummary.rectifiers || []),
      requestOverrides: requestOverrideSummary(requestSummary)
    },
    request: {
      protocol: requestSummary.protocol || "",
      params: safeParams(requestSummary.params || {}),
      messages: summarizeMessages(requestSummary),
      vision: redactObject(requestSummary.vision || null),
      toolCount: Number(requestSummary.toolCount || 0),
      tools: safeTools(requestSummary.tools || [])
    },
    response: {
      status: Number(pick(row, "status") || responseSummary.status || 0),
      finishReason: responseSummary.finishReason || "",
      usage: redactObject(responseSummary.usage || {
        promptTokens: Number(pick(row, "prompt_tokens", "promptTokens") || 0),
        completionTokens: Number(pick(row, "completion_tokens", "completionTokens") || 0),
        totalTokens: Number(pick(row, "total_tokens", "totalTokens") || 0)
      }),
      text: textStats(responseSummary.text || pick(row, "response_preview", "responsePreview") || ""),
      reasoning: textStats(responseSummary.reasoning || ""),
      toolCalls: safeToolCalls(responseSummary.toolCalls || [])
    },
    error: {
      message: redactText(rawError, 500),
      rowErrorPresent: Boolean(pick(row, "error"))
    }
  };
  bundle.fixtureDraft = buildFixtureDraft({ row, requestSummary, bundleId });
  return bundle;
}

export function issueBundleToMarkdown(bundle) {
  const b = bundle || {};
  const rules = Object.entries(b.compatibility?.compatRules || {})
    .flatMap(([direction, items]) => (items || []).map((item) => `- ${direction}: ${item.label || item.id} (${item.source})`))
    .join("\n") || "- 无";
  const rectifiers = (b.compatibility?.rectifiers || [])
    .map((item) => `- ${item.name}: ${item.errorClass || "-"} retry=${item.retryStatus ?? "-"} ok=${item.retryOk ?? "-"}`)
    .join("\n") || "- 无";
  return [
    "# Switchyard 兼容问题包",
    "",
    "## 基本信息",
    "",
    `- Bundle: ${b.id || "-"}`,
    `- Generated: ${b.generatedAt || "-"}`,
    `- Client: ${b.source?.clientId || "-"}`,
    `- Path: ${b.source?.method || ""} ${b.source?.path || "-"}`.trim(),
    `- Provider/Model: ${b.source?.providerId || "-"} / ${b.source?.modelId || "-"}`,
    `- Upstream: ${b.source?.upstreamModel || "-"}`,
    `- API Format: ${b.source?.apiFormat || "-"}`,
    `- Status: ${b.source?.status ?? "-"}`,
    `- Latency: ${b.source?.latencyMs ?? "-"} ms`,
    "",
    "## 错误分类",
    "",
    `- Category: ${b.classification?.category || "-"}`,
    `- Error Class: ${b.classification?.errorClass || "-"}`,
    `- Hint: ${b.classification?.hint || "-"}`,
    `- Error: ${b.error?.message || "-"}`,
    "",
    "## 协议与兼容规则",
    "",
    `- Chain: ${(b.compatibility?.conversionChain?.steps || []).join(" -> ") || "-"}`,
    "",
    rules,
    "",
    "## 运行时整流",
    "",
    rectifiers,
    "",
    "## 脱敏请求形状",
    "",
    `- Role Counts: ${JSON.stringify(b.request?.messages?.roleCounts || {})}`,
    `- Images: ${b.request?.messages?.images ?? 0}`,
    `- Tools: ${(b.request?.tools || []).map((tool) => tool.name).join(", ") || "-"}`,
    `- Response Text Chars: ${b.response?.text?.chars ?? 0}`,
    `- Reasoning Chars: ${b.response?.reasoning?.chars ?? 0}`,
    "",
    "## Fixture 草案",
    "",
    "```json",
    JSON.stringify(b.fixtureDraft || {}, null, 2),
    "```",
    "",
    "> 脱敏说明：正文、响应文本、工具参数、密钥、本地路径和图片原文默认不导出。提交 issue 前请用最小合成提示词替换 fixture 草案中的 redacted 占位符。"
  ].join("\n");
}

export function buildIssueBundleReport(row = {}, opts = {}) {
  const bundle = buildIssueBundle(row, opts);
  return {
    bundle,
    markdown: issueBundleToMarkdown(bundle)
  };
}

export function issueBundleFileStem(bundle = {}) {
  const id = String(bundle.id || "issue").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "issue";
  const provider = String(bundle.source?.providerId || "provider").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  const model = String(bundle.source?.modelId || bundle.source?.requestedModel || "model").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  return `switchyard-${id}-${provider}-${model}`.slice(0, 160);
}

export function saveIssueBundleFiles(report = {}, markdownPath = "") {
  if (!markdownPath) throw new Error("缺少保存路径");
  const bundle = report.bundle || {};
  const markdown = report.markdown || issueBundleToMarkdown(bundle);
  const parsed = path.parse(markdownPath);
  const mdPath = path.join(parsed.dir, `${parsed.name || issueBundleFileStem(bundle)}.md`);
  const jsonPath = path.join(parsed.dir, `${parsed.name || issueBundleFileStem(bundle)}.json`);
  fs.mkdirSync(parsed.dir || process.cwd(), { recursive: true });
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { ok: true, markdownPath: mdPath, jsonPath };
}

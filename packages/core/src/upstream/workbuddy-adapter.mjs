// WorkBuddy 上游适配：上游只接受流式请求且要求首条消息是 system 提示，
// 非流式客户端请求由这里在本地聚合 SSE 成 Chat JSON 响应。
// 出站改写对齐 workbuddy2api（internal/upstream/payload.go + thinking.go）：
// 强制 stream、补 stream_options.include_usage、tool_choice 归一化、developer→system、
// DeepSeek 系注入 thinking.type=enabled + 默认档位、多轮 assistant reasoning_content 回填。
const WORKBUDDY_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const DEFAULT_DEEPSEEK_EFFORT = "high";

function isDeepSeekModel(model) {
  return String(model || "").trim().toLowerCase().startsWith("deepseek");
}

/** 上游 tool_choice 只接受 string：对象形式归一，none 时连 tools 一起抑制（对齐 payload.go）。 */
function normalizeToolChoice(body) {
  const suppress = () => {
    delete body.tools;
    delete body.functions;
  };
  if (!Object.prototype.hasOwnProperty.call(body, "tool_choice")) return;
  const choice = body.tool_choice;
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "none") {
      delete body.tool_choice;
      suppress();
    }
    return;
  }
  if (!choice || typeof choice !== "object") {
    delete body.tool_choice;
    return;
  }
  const type = String(choice.type || "").trim().toLowerCase();
  if (type === "none") {
    delete body.tool_choice;
    suppress();
    return;
  }
  if (type === "auto" || type === "required") {
    body.tool_choice = type;
    return;
  }
  if (type === "function") {
    const name = String(choice?.function?.name || choice?.name || "").trim();
    body.tool_choice = name || "auto";
    return;
  }
  delete body.tool_choice;
}

/** DeepSeek 系思维链开关（thinking.go injectThinking）：显式 disabled 尊重；其余注入 enabled + 默认档。 */
/**
 * @param {"strict"|"off"|undefined} mode
 *   strict = 开思维链（thinking.enabled + reasoning_effort），调用方保证历史能回传思考；
 *   off    = 只开 thinking 开关但不带 effort（上游按不思考应答，避免 11155）；
 *   undefined = 旧启发式（历史里有思考痕迹才开），保持向后兼容。
 */
function injectDeepSeekThinking(body, mode) {
  if (!isDeepSeekModel(body.model)) return;
  const thinking = body.thinking && typeof body.thinking === "object" ? body.thinking : null;
  const type = String(thinking?.type || "").trim();
  const explicitEffort = body.reasoning_effort !== undefined || body.reasoningEffort !== undefined;
  const strict = mode === "strict" ? true
    : mode === "off" ? false
    : hasReasoningTrace(body);
  if (type) {
    if (type.toLowerCase() === "disabled") {
      delete body.reasoning_effort;
      delete body.reasoningEffort;
      return;
    }
    if (!explicitEffort && strict) body.reasoning_effort = DEFAULT_DEEPSEEK_EFFORT;
    return;
  }
  if (thinking) {
    thinking.type = "enabled";
  } else {
    body.thinking = { type: "enabled" };
  }
  if (!explicitEffort && strict) body.reasoning_effort = DEFAULT_DEEPSEEK_EFFORT;
}

/**
 * 会话历史里是否存在真实思考痕迹（assistant 带非空 reasoning_content / reasoning）。
 * 上游要求：只要带 reasoning_effort（真开思维链），**每轮 assistant 都必须回传真实思考**，
 * 否则返回 11155。ZCode 这类客户端不回传思考，因此不能对它注入 effort。
 */
function hasReasoningTrace(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) return true;
    if (typeof message.reasoning === "string" && message.reasoning.trim()) return true;
  }
  return false;
}

/** 当前出站请求是否处于 thinking 模式（DeepSeek 系注入 thinking.enabled 后即为真）。 */
function isThinkingEnabled(body) {
  if (!isDeepSeekModel(body.model)) return false;
  const thinking = body.thinking && typeof body.thinking === "object" ? body.thinking : null;
  return String(thinking?.type || "").trim().toLowerCase() === "enabled";
}

/**
 * DeepSeek 多轮一致性（上游硬要求，实测 code 11155 reasoning_content_missing）：
 * 只要处于 thinking 模式，**所有** assistant 消息都必须带 reasoning_content 字段（string，可空串）。
 * 早先只在「历史里已有 reasoning 痕迹」时回填，导致普通多轮请求被上游 400 拒绝。
 */
function backfillReasoningContent(body) {
  if (!isThinkingEnabled(body)) return;
  // 只有严格模式（带 effort）才需要「所有 assistant 都带 reasoning_content」；
  // 非严格模式下补空串反而会被上游当作「有思考痕迹却没回传」，触发 11155。
  if (body.reasoning_effort === undefined && body.reasoningEffort === undefined) return
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (String(message.role || "") !== "assistant") continue;
    if (Object.prototype.hasOwnProperty.call(message, "reasoning_content")) continue;
    message.reasoning_content = typeof message.reasoning === "string" ? message.reasoning : "";
  }
}

/** 出站请求规范化：强制 stream:true；缺 system 头时补齐（上游 code 11128 要求）。 */
export function prepareWorkBuddyChatBody(body = {}, { thinkingMode } = {}) {
  const next = { ...body, stream: true };
  // 官方 CLI 流式必发 include_usage，上游据此在末帧返回用量；显式带则不覆盖。
  if (!next.stream_options) next.stream_options = { include_usage: true };
  const messages = Array.isArray(next.messages) ? next.messages.map((m) => (m && typeof m === "object" ? { ...m } : m)) : [];
  for (const message of messages) {
    if (message && typeof message === "object" && String(message.role || "").trim().toLowerCase() === "developer") {
      message.role = "system";
    }
  }
  const first = messages[0] && typeof messages[0] === "object" ? messages[0] : null;
  if (!first || String(first.role || "").trim().toLowerCase() !== "system") {
    messages.unshift({ role: "system", content: WORKBUDDY_DEFAULT_SYSTEM_PROMPT });
  }
  next.messages = messages;
  normalizeToolChoice(next);
  injectDeepSeekThinking(next, thinkingMode);
  backfillReasoningContent(next);
  return next;
}

function parseSseDataLines(text) {
  const frames = [];
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      frames.push(JSON.parse(data));
    } catch {
      // 非 JSON 帧（心跳/注释）跳过
    }
  }
  return frames;
}

/**
 * 把 Chat 风格 SSE 聚合成一次 Chat JSON 响应。
 * 保留 content / reasoning_content / tool_calls / usage / finish_reason。
 */
export function aggregateChatSseToChatResponse(text, fallbackModel = "") {
  const frames = parseSseDataLines(text);
  const message = { role: "assistant", content: "" };
  let finishReason = "stop";
  let model = fallbackModel;
  let id = "";
  let created = 0;
  let usage = null;
  const toolCalls = new Map();

  for (const frame of frames) {
    if (frame?.model) model = frame.model;
    if (frame?.id) id = frame.id;
    if (frame?.created) created = frame.created;
    if (frame?.usage) usage = frame.usage;
    const choice = frame?.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) message.content += delta.content;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      message.reasoning_content = (message.reasoning_content || "") + delta.reasoning_content;
    }
    for (const call of delta.tool_calls || []) {
      const index = Number(call.index || 0);
      const current = toolCalls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
      if (call.id) current.id = call.id;
      if (call.type) current.type = call.type;
      if (call.function?.name) current.function.name = call.function.name;
      if (call.function?.arguments) current.function.arguments += call.function.arguments;
      toolCalls.set(index, current);
    }
  }

  if (toolCalls.size) {
    message.tool_calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
    if (finishReason === "stop") finishReason = "tool_calls";
  }
  if (!message.content) delete message.content;

  return {
    id: id || `chatcmpl-workbuddy-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || fallbackModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {})
  };
}

/** 读取上游响应文本（含错误体），非流式聚合用。 */
export async function readWorkBuddyStreamText(response) {
  const text = await response.text();
  return text;
}

function hasValue(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * 上游每个 delta 都带一堆空字段（content:"" / tool_calls:[] / refusal:"" / function_call:null /
 * extra_fields:null / logprobs:null）。客户端会按这些空键判断「相位切换」，把一段连续思考
 * 切成多个思考块（ZCode 表现为「思考·持续了几秒」多块堆叠）。
 *
 * 这里按「只保留本帧真正携带的键」重建帧，形态对齐 workbuddy2api 的白名单重建：
 *   - delta 只保留有值的 role / content / reasoning_content / tool_calls / function_call
 *   - choice 只保留 index / delta / finish_reason（logprobs 为空时删除）
 *   - 事件保留 id / object / created / model / choices / usage（usage 允许为 null，与官方形态一致）
 */
export function normalizeWorkBuddyStreamLine(line) {
  if (typeof line !== "string" || !line.startsWith("data:")) return line;
  const raw = line.slice(5).trim();
  if (!raw || raw === "[DONE]") return line;
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return line;
  }
  if (!event || typeof event !== "object" || !Array.isArray(event.choices)) return line;
  const choices = event.choices.map((choice) => {
    const delta = choice?.delta && typeof choice.delta === "object" ? choice.delta : {};
    const cleanDelta = {};
    if (hasValue(delta.role)) cleanDelta.role = delta.role;
    if (hasValue(delta.reasoning_content)) cleanDelta.reasoning_content = delta.reasoning_content;
    if (hasValue(delta.content)) cleanDelta.content = delta.content;
    if (hasValue(delta.tool_calls)) cleanDelta.tool_calls = delta.tool_calls;
    if (hasValue(delta.function_call)) cleanDelta.function_call = delta.function_call;
    const cleanChoice = { index: choice?.index ?? 0 };
    if (Object.keys(cleanDelta).length) cleanChoice.delta = cleanDelta;
    if (choice && "finish_reason" in choice) cleanChoice.finish_reason = choice.finish_reason;
    if (hasValue(choice?.logprobs)) cleanChoice.logprobs = choice.logprobs;
    return cleanChoice;
  });
  const clean = {
    id: event.id,
    object: event.object,
    created: event.created,
    model: event.model,
    choices,
    usage: event.usage ?? null
  };
  return "data: " + JSON.stringify(clean);
}


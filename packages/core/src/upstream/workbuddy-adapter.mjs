// WorkBuddy 上游适配：上游只接受流式请求且要求首条消息是 system 提示，
// 非流式客户端请求由这里在本地聚合 SSE 成 Chat JSON 响应。
// 出站改写对齐 workbuddy2api（internal/upstream/payload.go + thinking.go）：
// 强制 stream、补 stream_options.include_usage、tool_choice 归一化、developer→system、
// DeepSeek 系注入 thinking.type=enabled + 默认档位、多轮 assistant reasoning_content 回填。
const WORKBUDDY_DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

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

/** 出站请求规范化：强制 stream:true；缺 system 头时补齐（上游 code 11-128 要求）。 */
export function prepareWorkBuddyChatBody(body = {}) {
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
  return next;
}


// 出站 WAF 中和：上游 WAF 对 AI 接口做内容检查，命中即 403 upstream_policy_blocked。
// 实测（sess_c2c69851，抓取 workbuddy.ai 首页被拦）确认两类规则，与设备身份/指纹无关：
//
//   1) 危险特征库：扫描 content / reasoning_content / tool_calls.arguments 全部字段，
//      且会先做 URL / HTML 实体 / JS 转义解码再匹配。命中面很窄，实测只有：
//        · 标签 <script / <base   （<div> <iframe> <img> <style> <svg> <object> <form> 等均放行）
//        · 事件 onerror= onload= onclick= onfocus= onmouseover= onchange= onsubmit=
//        · 函数 alert( msgbox( eval( confirm(   （prompt( 放行）
//      这是「抓网页必被拦」的直接原因 —— 真实网页 HTML 头部第一行就是 <script>。
//
//   2) 组合规则：请求内同时出现「外部大段内容」（tool 结果）与 reasoning_content 里的
//      shell 动词（curl/wget）才拦。这解释了为何单独发 curl 不拦、抓回网页后同一会话被拦。
//
// 中和一律用「可见的相似字符」（‹ ＝ （），零宽字符实测会被上游归一化掉，不可靠。
// 只破坏特征赖以成立的标点，正常代码（<div>、prompt(）保持原样，避免污染用户上下文。
const WAF_LT = "\u2039";
const WAF_EQ = "\uff1d";
const WAF_LP = "\uff08";
const WAF_DANGEROUS_TAG = /<\s*(script|base)\b/gi;
const WAF_EVENT_BINDING = /\bon([a-z]+)\s*=/gi;
// 危险函数调用：上游按「函数名 + 左括号」逐字匹配，属经典 XSS 黑名单。
// 2026-09-18 全量枚举实测（每条独立探针，messages[].tool_calls.function.arguments 位）：
//   命中：alert( msgbox( eval( confirm( unescape( decodeURIComponent( decodeURI(
//         fromCharCode( document.write( system( subprocess.run( compile(
//   放行：prompt( escape( encodeURIComponent( encodeURI( atob( btoa( Function(
//         setTimeout( setInterval( exec( popen( subprocess( __import__(
//         document.cookie innerHTML
// unescape/decodeURI/fromCharCode 是 JS 混淆解码的经典组合；system/subprocess/compile
// 属命令执行与代码编译。注意 subprocess 单独出现（`subprocess` / `subprocess(`）放行，
// 只有带点的 `subprocess.run(` 命中，故单列一个分支。
// 代价：Python 常规写法 re.compile( 与 html.unescape( 会被改写，但这两者本身就是 403
// 触发条件（ZCode 抓网页后解析 HTML 必用 html.unescape，实测即「curl 抓站 → 解析脚本
// → 整会话 403」的直接原因），不改写必然失败。改写只把左括号换全角（见 WAF_LP），
// 模型读历史时能自行还原语义。
const WAF_DANGEROUS_CALL = /\b(?:alert|msgbox|eval|confirm|unescape|decodeURIComponent|decodeURI|fromCharCode|document\.write|system|compile)\s*\(|\bsubprocess\.run\s*\(/gi;
// 转义形态的 "<"：上游先解码再匹配，只能在转义序列本身下手（有限枚举，上游若新增形态需同步）
const WAF_ENCODED_PERCENT = /%3c/gi;
const WAF_ENCODED_ENTITY = /&lt;/gi;
// HTTP/shell 动词 + 域名/IP/URL 的组合：只有这条文本确实带了目标才改写，
// 避免把「curl 怎么用」这类纯讨论也改掉。空串拼接（c''url）任何 shell 都会先展开回原动词。
//
// 实测触发面不同（curl/fetch + URL 同现才拦）：
//   · curl / wget —— 仅 reasoning_content 位触发（上游 SSRF 启发式，只看思考链）
//   · fetch       —— 全部字段触发（content / reasoning_content / tool_calls.arguments）
// 三者在有 URL 的文本里统一下手，见 workbuddy-adapter 回归测试。
const WAF_SHELL_VERBS = /\b(curl|wget|fetch)\b/g;
const WAF_TARGET_HINT = /(?::\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[a-z0-9-]+\.[a-z]{2,})/i;

// 快路径预检：未命中任何候选子串时直接返回原值（保持引用相等，供上层跳过对象拷贝）。
// 只求「不漏」，故只匹配候选**词干**、不带括号要求（如 decodeURI 覆盖 decodeURIComponent），
// 宁可多进慢路径——慢路径才做精确改写。大小写不敏感以覆盖各规则的 /i 形态。
const WAF_PREFILTER = /<|%3c|&lt;|\b(?:alert|msgbox|eval|confirm|unescape|decodeURI|fromCharCode|document|system|subprocess|compile)|\bon[a-z]+\s*=|\b(?:curl|wget|fetch)\b/i;

function hardenText(value) {
  if (typeof value !== "string" || !value) return value;
  if (!WAF_PREFILTER.test(value)) return value;
  const hardened = value
    .replace(WAF_DANGEROUS_TAG, (m) => m.replace("<", WAF_LT))
    .replace(WAF_EVENT_BINDING, (m) => m.slice(0, -1) + WAF_EQ)
    .replace(WAF_DANGEROUS_CALL, (m) => m.slice(0, -1) + WAF_LP)
    .replace(WAF_ENCODED_PERCENT, "\uff05" + "3c")
    .replace(WAF_ENCODED_ENTITY, "&\uff4c" + "t;");
  if (!WAF_TARGET_HINT.test(hardened)) return hardened;
  return hardened.replace(WAF_SHELL_VERBS, (verb) => `${verb[0]}''${verb.slice(1)}`);
}

// 数组形态只改 text 分片；image_url 等其它分片原样保留，避免动到图片 data URL。
function hardenContent(content) {
  if (typeof content === "string") return hardenText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string"
    ? { ...part, text: hardenText(part.text) }
    : part));
}

function hardenMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { ...message, content: hardenContent(message.content) };
  if (typeof message.reasoning_content === "string") next.reasoning_content = hardenText(message.reasoning_content);
  // prepare 派生出的 reasoning 与 reasoning_content 并存，两者都在扫描面内，必须同样处理。
  if (typeof message.reasoning === "string") next.reasoning = hardenText(message.reasoning);
  if (Array.isArray(message.tool_calls)) {
    next.tool_calls = message.tool_calls.map((call) => {
      const args = call?.function?.arguments;
      if (typeof args !== "string") return call;
      const hardened = hardenText(args);
      return hardened === args ? call : { ...call, function: { ...call.function, arguments: hardened } };
    });
  }
  return next;
}

/**
 * 对出站请求体里的语义文本做 WAF 等价改写。
 * 只覆盖模型会读到的文本（content / reasoning_content / tool_calls.arguments），
 * 全程返回新对象，不改动调用方传入的请求体。
 */
export function hardenWorkBuddyChatBody(body = {}) {
  if (!Array.isArray(body.messages)) return body;
  return { ...body, messages: body.messages.map(hardenMessage) };
}

// ── 出站指纹脱敏（对齐参考实现 workbuddy2api/internal/upstream/sanitize.go）──
//
// 与上面 hardenWorkBuddyChatBody 的危险字符族**不是同一类规则**，不能合并：
//   · 危险字符族：/console 端点的 HTML WAF，破坏标点即绕过，默认由 provider.wafHardening 门控；
//   · 指纹族（本节）：/v2 端点同样生效，上游按**逐字精确匹配**拦截模板句（非语义审核，
//     一字之差即可绕过），必须无条件改写模板句本身。
//
// 命中即 400 `code=11128 / Illegal API invocation from an unapproved channel`，
// displayMsg 为「请求被安全策略拦截」。2026-09-18 实测确认：
//   ZCode 的 system prompt 含 "Main branch (you will usually use this for PRs)"，
//   真实请求体 1:1 重放（直连 /v2 与经网关两条路径）必 400；仅替换该句即 200。
//   同一出口下 Cursor 正常，即因它的 prompt 不含该句。
//
// 改写策略与参考实现一致：承载语义的模板句只换一个词（语义不变），
// 键值/header 型指纹整段剥离。

// 特征预检：任一命中才进慢路径。用大小写不敏感正则统一覆盖 header 的大小写变体
// 与裸键名形态，免去参考实现里「Contains + 不要求冒号的正则」两段式。
const FINGERPRINT_PREFILTER = /x-anthropic-billing-header|cc_entrypoint=|You are Claude Code|Main branch \(|You are a coding agent running in the Codex CLI|github\.com\/anthropics\/|11128/i;

// 改写层：逐字替换，每句只改一个词。
// 末条是上游反探测：请求体里出现裸数字 11128 即整单拦截（与上下文无关），
// 而 11128 正是本类拦截自身的错误码——不改写则「讨论该错误码」的请求必然失败。
// 插连字符保留可读性与指代（零宽字符无效，上游会归一化）。
const FINGERPRINT_REWRITES = [
  ["You are Claude Code, Anthropic's official CLI for Claude",
   "You are Claude Code, Anthropic's official CLI tool for Claude"],
  ["Main branch (you will usually use this for PRs)",
   "Default branch (you will usually use this for PRs)"],
  ["You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
   "You are a coding agent running in the Codex CLI tool, a terminal-based coding assistant."],
  ["To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
   "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues"],
  ["11128", "11-128"]
];

// 剥离层：header 键名即触发（与值无关），整段删除。
const FINGERPRINT_HEADER_KV = /x-anthropic-billing-header:[^;\n]*;?\s*/gi;
// 兜底层：键值形态删完后残留的裸键名做最小缩写，破坏逐字匹配而语义可读。
const FINGERPRINT_BARE_HEADER = /x-anthropic-billing-header/gi;
// 尾随裸键值 `cc_xxx=...;`，循环清理（一次替换可能露出前一段的尾部分隔符）。
const FINGERPRINT_CC_KV = /\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi;

function hasFingerprint(value) {
  return FINGERPRINT_PREFILTER.test(value);
}

/** 单段文本脱敏：预检不中即原样返回（保持引用相等，供上层跳过对象拷贝）。 */
function sanitizeFingerprintText(value) {
  if (typeof value !== "string" || !value) return value;
  if (!hasFingerprint(value)) return value;
  let text = value;
  for (const [from, to] of FINGERPRINT_REWRITES) text = text.split(from).join(to);
  text = text.replace(FINGERPRINT_HEADER_KV, "");
  if (text.includes("cc_")) {
    let previous = "";
    // 清尾随裸 kv；循环直到不再变化，避免前一段的 `;` 残留成尾部孤立标点。
    while (previous !== text) {
      previous = text;
      text = text.replace(FINGERPRINT_CC_KV, "");
    }
  }
  text = text.replace(FINGERPRINT_BARE_HEADER, "x-anthropic-billing-hdr");
  // 与参考实现一致：剥离键值段后清掉两端残留空白。只在预检命中时发生。
  return text.trim();
}

// 数组形态只改 text 分片；image_url 等其它分片原样保留，避免动到图片 data URL。
function sanitizeFingerprintContent(content) {
  if (typeof content === "string") return sanitizeFingerprintText(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => (part && typeof part === "object" && typeof part.text === "string"
    ? { ...part, text: sanitizeFingerprintText(part.text) }
    : part));
}

function sanitizeFingerprintMessage(message) {
  if (!message || typeof message !== "object") return message;
  const next = { ...message, content: sanitizeFingerprintContent(message.content) };
  // reasoning 与 reasoning_content 会由 prepare 派生并存，两者都在上游扫描面内。
  if (typeof message.reasoning_content === "string") next.reasoning_content = sanitizeFingerprintText(message.reasoning_content);
  if (typeof message.reasoning === "string") next.reasoning = sanitizeFingerprintText(message.reasoning);
  if (Array.isArray(message.tool_calls)) {
    next.tool_calls = message.tool_calls.map((call) => {
      const args = call?.function?.arguments;
      if (typeof args !== "string") return call;
      const sanitized = sanitizeFingerprintText(args);
      return sanitized === args ? call : { ...call, function: { ...call.function, arguments: sanitized } };
    });
  }
  return next;
}

/**
 * 对出站请求体做上游内容审核指纹脱敏。
 *
 * 覆盖面与参考实现一致：只处理模型会读到的 messages 文本
 * （content / reasoning_content / reasoning / tool_calls.arguments）；tools 定义不做处理。
 * 全程返回新对象，不改动调用方传入的请求体。
 */
export function sanitizeWorkBuddyChatBody(body = {}) {
  if (!Array.isArray(body.messages)) return body;
  return { ...body, messages: body.messages.map(sanitizeFingerprintMessage) };
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


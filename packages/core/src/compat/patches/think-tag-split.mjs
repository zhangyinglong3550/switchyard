// Chat 直通路径的 <think> 标签拆分。
//
// 部分上游（MiniMax-M2.7 / M3 等）不返回 reasoning_content，而是把整段思考
// 用 <think>...</think> 包起来放进 content。Responses 协议路径已有
// ThinkTagStreamSplitter 处理这种格式，但 chat 直通（pipeStream）没有，
// 于是客户端拿到的正文里混着思考标签。
//
// 只处理「开头就是 <think>」的情况：标签必须紧贴首个非空内容，中途出现
// <think> 的正文（例如模型在讲解标签用法）原样透传，避免误拆。

const KNOWN_REASONING_RE = /deepseek|kimi|moonshot|glm|zhipu|z-ai|zai|qwen|dashscope|bailian|aliyun|modelscope|minimax|xiaomi|mimo|openrouter|novita|nvidia|longcat|stepfun|qianfan|doubao|volc|ark|byteplus|bailing|ling/i;

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

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

function targeted(ctx) {
  return KNOWN_REASONING_RE.test(haystack(ctx));
}

// 返回 value 末尾与 prefix 前缀匹配的最长长度，用于把可能被切开的标签留在缓冲里。
function suffixPrefixLength(value, prefix) {
  const max = Math.min(value.length, prefix.length - 1);
  for (let len = max; len > 0; len -= 1) {
    if (value.endsWith(prefix.slice(0, len))) return len;
  }
  return 0;
}

// 每个请求一份状态（挂在 ctx 上，ctx 由 dispatch 按请求新建）。
function stateFor(ctx) {
  if (!ctx._switchyardThinkTag) {
    ctx._switchyardThinkTag = {
      // undetermined: 还没确定首个非空内容长什么样
      // thinking:     已进入 <think> 块
      // passthrough:  确认不是 think 前缀，之后一律不动
      phase: "undetermined",
      buffer: ""
    };
  }
  return ctx._switchyardThinkTag;
}

// 把一段 content 按当前状态切成 { reasoning, text }。
function consume(state, chunk) {
  state.buffer += chunk;
  let reasoning = "";
  let text = "";

  while (state.buffer.length) {
    if (state.phase === "passthrough") {
      text += state.buffer;
      state.buffer = "";
      break;
    }

    if (state.phase === "undetermined") {
      // 首个非空内容为空串时先跳过，等真正的内容到达再判定。
      if (!state.buffer.trim()) {
        text += state.buffer;
        state.buffer = "";
        break;
      }
      if (state.buffer.startsWith(OPEN_TAG)) {
        state.buffer = state.buffer.slice(OPEN_TAG.length);
        state.phase = "thinking";
        continue;
      }
      // 可能是 <think> 的前缀（如 "<thi"），先缓冲等待后续分片。
      if (OPEN_TAG.startsWith(state.buffer)) break;
      // 确认不是 think 前缀：此后原样透传。
      state.phase = "passthrough";
      continue;
    }

    // phase === "thinking"
    const closeIndex = state.buffer.indexOf(CLOSE_TAG);
    if (closeIndex >= 0) {
      reasoning += state.buffer.slice(0, closeIndex);
      state.buffer = state.buffer.slice(closeIndex + CLOSE_TAG.length);
      state.phase = "passthrough";
      continue;
    }
    const keep = suffixPrefixLength(state.buffer, CLOSE_TAG);
    reasoning += keep ? state.buffer.slice(0, -keep) : state.buffer;
    state.buffer = keep ? state.buffer.slice(-keep) : "";
    break;
  }

  return { reasoning, text };
}

function splitStreamLine(line, ctx) {
  if (typeof line !== "string" || !line.startsWith("data:")) return line;
  let payload = line.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  if (!payload || payload === "[DONE]") return line;
  try {
    const parsed = JSON.parse(payload);
    const choices = parsed.choices;
    if (!Array.isArray(choices)) return line;
    let changed = false;
    for (const choice of choices) {
      const delta = choice?.delta;
      if (!delta || typeof delta !== "object") continue;
      if (typeof delta.content !== "string" || !delta.content) continue;
      // 已经是独立的思考字段时不介入，避免与 reasoning_content 上游冲突。
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) continue;

      const { reasoning, text } = consume(stateFor(ctx), delta.content);
      const next = { ...delta };
      if (reasoning) next.reasoning_content = reasoning;
      // content 为空时删除该字段，避免客户端把空串当作有效正文。
      if (text) next.content = text;
      else delete next.content;
      // 状态没推进且内容没变时保持原行，减少无谓改写。
      if (next.content === delta.content && next.reasoning_content === undefined) continue;
      choice.delta = next;
      changed = true;
    }
    return changed ? "data: " + JSON.stringify(parsed) : line;
  } catch {
    return line;
  }
}

export const thinkTagSplitPatch = {
  id: "think-tag-split",
  label: "Chat think 标签拆分",
  description: "把上游塞在 content 里的 <think>...</think> 思考拆到 reasoning_content，正文保持干净。",
  trigger: "provider/model/baseUrl 命中常见 reasoning 模型，且流式内容以 <think> 开头。",
  changes: [
    "流式 Chat SSE：首段 content 以 <think> 开头时，标签内文本改写到 reasoning_content",
    "标签闭合后的文本作为正文 content 继续下发",
    "标签被分片切开时按缓冲重组，不丢字符",
    "首段不是 <think> 的响应一律原样透传"
  ],
  risk: "若上游把 <think> 当作正文正常内容输出（例如讲解标签用法），首段命中时会被当作思考拆分；仅在首段紧贴标签时触发。",
  tests: [
    "think-tag-split · moves a leading think block into reasoning_content",
    "think-tag-split · keeps thinking deltas on reasoning_content across the block",
    "think-tag-split · reassembles an open tag split across deltas",
    "think-tag-split · reassembles a close tag split across deltas",
    "think-tag-split · does not touch a think tag that is not leading"
  ],
  match(ctx) { return targeted(ctx); },
  streamLine(line, ctx) {
    return splitStreamLine(line, ctx);
  }
};

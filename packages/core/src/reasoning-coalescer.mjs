// 思考分片合并（reasoning coalescer）
//
// 背景：WorkBuddy / CodeBuddy 上游按「词」切分思考增量（实测 384 个思考帧、每帧 1–5 字符），
// 直接透传时客户端会渲染成大量碎片（表现为「思考很分散」）。这里把连续的、只含
// reasoning_content 的 SSE 事件累积成较大的块再下发；正文、工具调用、结束帧一律立即透传，
// 因此不会推迟正文首字，也不改变事件语义。
//
// 合并边界：累计字符数达到 maxChars、距首片超过 flushMs、或遇到非思考事件/流结束 → 立即 flush。
const DEFAULT_MAX_CHARS = 60;
const DEFAULT_FLUSH_MS = 150;

function parseEvent(line) {
  if (typeof line !== "string" || !line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** 仅含思考的增量事件（有 reasoning_content，且没有 content / tool_calls / finish_reason）。 */
function reasoningOnly(event) {
  const choices = event?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  for (const choice of choices) {
    const delta = choice?.delta;
    if (!delta || typeof delta !== "object") return false;
    if (typeof delta.reasoning_content !== "string" || !delta.reasoning_content) return false;
    if (delta.content) return false;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return false;
    if (delta.function_call) return false;
    if (choice.finish_reason) return false;
  }
  return true;
}

/**
 * @param {object} options
 * @param {number} [options.maxChars] 累计到多少字符立即下发
 * @param {number} [options.flushMs]  最长暂存时间（毫秒），超时下发
 * @param {(line: string) => void} options.write 输出一行 SSE 的回调
 */
export function createReasoningCoalescer({ maxChars = DEFAULT_MAX_CHARS, flushMs = DEFAULT_FLUSH_MS, write, onDelta } = {}) {
  let buffer = "";
  let template = null; // 保留上游事件壳（id/model/created/usage 等），只替换思考文本
  let timer = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function flush() {
    if (!buffer || !template) {
      clearTimer();
      return;
    }
    const event = {
      ...template,
      choices: (template.choices || []).map((choice) => ({
        ...choice,
        delta: { ...(choice.delta || {}), reasoning_content: buffer }
      }))
    };
    buffer = "";
    template = null;
    clearTimer();
    write("data: " + JSON.stringify(event));
  }

  function scheduleFlush() {
    if (timer || !(flushMs > 0)) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, flushMs);
    // 不阻塞进程退出（Node 环境）。
    timer.unref?.();
  }

  return {
    /** 是否有暂存的思考未下发（pipeStream 用它决定空行要不要延后）。 */
    holding() {
      return Boolean(buffer && template);
    },
    /** 送入一行 SSE；思考分片会被暂存，其余行立即下发（下发顺序保持不变）。 */
    push(line) {
      const event = parseEvent(line);
      if (event && typeof onDelta === "function") {
        const delta = event.choices?.[0]?.delta || {};
        onDelta({
          reasoning: typeof delta.reasoning_content === "string" ? delta.reasoning_content : "",
          content: typeof delta.content === "string" ? delta.content : ""
        });
      }
      if (!event || !reasoningOnly(event)) {
        flush();
        write(line);
        return;
      }
      if (!template) template = event;
      buffer += event.choices?.[0]?.delta?.reasoning_content || "";
      if (buffer.length >= maxChars) {
        flush();
        return;
      }
      scheduleFlush();
    },
    flush,
    cancel() {
      clearTimer();
      buffer = "";
      template = null;
    }
  };
}

// Grok Build 严格协议兼容：Grok 用 Rust serde 强校验 OpenAI SSE chunk，
// 缺 id/object/created/model/choices 任何一个字段都会报 `missing field 'id'`
// 直接断流。OpenCode 等宽松客户端会吞下这种行，所以不能全局过滤。
//
// 上游有些聚合商（已观察到 opencode-go）会在 finish_reason: stop 之后
// 再追加私有扩展 chunk，例如：
//   data: {"choices":[],"x-opencode-type":"inference-cost","cost":"0.00191610",...}
//   data: {"choices":[],"cost":"0"}     ← 甚至出现在 [DONE] 之后
// 这些都不是合法 OpenAI chunk，Grok 会立即报序列化错误。

const OPENAI_CHAT_CHUNK_REQUIRED_FIELDS = ["id", "object", "created", "model", "choices"];

function isValidOpenAiChatChunk(payload) {
  if (!payload || typeof payload !== "object") return false;
  for (const key of OPENAI_CHAT_CHUNK_REQUIRED_FIELDS) {
    if (!(key in payload)) return false;
  }
  return Array.isArray(payload.choices);
}

// 提取 `data:` 后的 payload。兼容 `data: {...}`（带空格）与上游（如 KE 聚合商
// 的 deepseek）返回的 `data:{...}`（不带空格）。不带空格时旧实现会把整行
// （含 `data:` 前缀）当作 JSON 解析而失败，导致合法的 OpenAI chunk 被误吞成空流。
function sseDataPayload(line) {
  if (typeof line !== "string" || !line.startsWith("data:")) return null;
  let rest = line.slice(5);
  if (rest.startsWith(" ")) rest = rest.slice(1);
  return rest;
}

function sanitizeStreamLine(line) {
  const data = sseDataPayload(line);
  // 非 `data:` 事件（注释 / ping / 空行）不属于 OpenAI chunk，原样透传，
  // 避免把合法内容当自定义事件吞掉。
  if (data == null) return line;
  if (data === "") return line;
  if (data === "[DONE]") return line;
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch {
    // `data:` 但不是合法 JSON —— 这类行对 Grok 没意义，直接吞掉。
    return null;
  }
  if (!isValidOpenAiChatChunk(parsed)) return null;
  return line;
}

export const grokProtocolStrictPatch = {
  id: "grok-protocol-strict",
  label: "Grok 严格协议过滤",
  description: "Grok Build 使用 Rust serde 强校验 OpenAI SSE chunk，缺 id/object/created/model/choices 任一字段即报 missing field 错误并断流。本 patch 在 Grok 出口侧吞掉供应商私有扩展 chunk（如 opencode-go 的 x-opencode-type: inference-cost / cost），保证协议纯净。",
  trigger: "仅当客户端是 Grok（clientId === \"grok\"）时启用；其它宽松客户端不受影响。",
  changes: [
    "丢弃缺 id/object/created/model/choices 任一字段的 SSE data 行",
    "丢弃无法解析为 JSON 的非空 data 行",
    "保留 [DONE] 终止标记和合法 OpenAI chunk 原样通过"
  ],
  risk: "如果 Grok 客户端未来依赖某个非标准字段（极不可能，因为它走官方 OpenAI 协议），可能被一并吞掉；可在模型上关闭该规则。",
  tests: [
    "grok-protocol-strict · drops chunks missing required OpenAI fields",
    "grok-protocol-strict · drops chunks after [DONE]",
    "grok-protocol-strict · only active for grok clientId"
  ],
  match(ctx) {
    return String(ctx?.clientId || "") === "grok";
  },
  streamLine(line) {
    return sanitizeStreamLine(line);
  }
};

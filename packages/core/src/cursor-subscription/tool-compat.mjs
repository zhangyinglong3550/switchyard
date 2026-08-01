import { extractOpenCodeTextToolCalls } from "../opencode-text-tool-calls.mjs";
import { selectCursorBridgeTools } from "./tool-capabilities.mjs";

const MAX_EXPOSED_TOOLS = 10;
const MAX_TOOL_SCHEMA_CHARS = 3000;

function textPart(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return "";
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sanitizeToolResultText(text) {
  return String(text || "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function functionDefinition(tool) {
  if (tool?.type !== "function" || !tool?.function || typeof tool.function !== "object") return null;
  const name = String(tool.function.name || "").trim();
  if (!name) return null;
  return {
    name,
    description: String(tool.function.description || "").trim(),
    parameters: tool.function.parameters && typeof tool.function.parameters === "object"
      ? tool.function.parameters
      : { type: "object", properties: {} }
  };
}

export function cursorFunctionTools(tools = []) {
  return (tools || []).map(functionDefinition).filter(Boolean);
}

/** 对标 9router：tool 结果用结构化 XML，避免残缺 protobuf tool_results 引发空转。 */
export function buildToolResultBlock(toolName, toolCallId, resultText) {
  return [
    "<tool_result>",
    `<tool_name>${escapeXml(toolName || "tool")}</tool_name>`,
    `<tool_call_id>${escapeXml(toolCallId || "")}</tool_call_id>`,
    `<result>${escapeXml(sanitizeToolResultText(resultText))}</result>`,
    "</tool_result>"
  ].join("\n");
}

export function buildCursorWorkInstruction(tools = []) {
  const names = cursorFunctionTools(tools).map((item) => item.name);
  if (!names.length) return "";
  const hasExec = names.some((name) => ["exec_command", "bash", "shell", "run_command"].includes(name));
  const hasPatch = names.includes("apply_patch");
  const lines = [
    "You are bridging into a coding agent (Codex/OpenCode). Prefer real work tools over planning.",
    "Never call update_plan repeatedly. Do not narrate that you will edit code and then only update a plan.",
    hasPatch
      ? "To change files, call apply_patch or a write/edit tool immediately."
      : "To change files, call the available write/edit/shell tool immediately.",
    hasExec ? "Use exec_command/bash for inspection and verification." : "",
    "If the user asked for a code change, your next action must be a file/shell tool call, not commentary-only."
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildCursorToolCompatibilityInstruction(tools = []) {
  const functions = cursorFunctionTools(tools);
  if (!functions.length) return "";
  // Send ALL tool names so the model knows they exist, but only include
  // descriptions for the first MAX_EXPOSED_TOOLS. This keeps the prompt
  // small (Codex sends 191 tools; full schemas would be 50KB+) while
  // still letting the model call any tool the user might need.
  const allNames = functions.map((f) => f.name).join(", ");
  const detailed = functions.slice(0, MAX_EXPOSED_TOOLS)
    .map((f) => ({ name: f.name, desc: f.description.slice(0, 80) }));
  let catalogJson = "";
  try { catalogJson = JSON.stringify(detailed); } catch { catalogJson = "[]"; }
  if (catalogJson.length > MAX_TOOL_SCHEMA_CHARS) catalogJson = catalogJson.slice(0, MAX_TOOL_SCHEMA_CHARS);
  return [
    buildCursorWorkInstruction(tools),
    "You are an API endpoint. You have NO Cursor IDE shell/file tools of your own.",
    "To call a function, reply ONLY with: <tool_calls><tool_call name=\"NAME\"><arguments>{json}</arguments></tool_call></tool_calls>",
    `All available tools: ${allNames}`,
    `Detailed (first ${detailed.length}): ${catalogJson}`,
    "If no function is needed, answer normally."
  ].join("\n");
}

function assistantToolCallSummary(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls.map((call) => ({
    id: call?.id || "",
    name: call?.function?.name || "unknown",
    arguments: call?.function?.arguments || "{}"
  })) : [];
  if (!calls.length) return textPart(message?.content);
  const content = textPart(message?.content);
  const callText = calls.map((call) =>
    `<tool_call name="${escapeXml(call.name)}" id="${escapeXml(call.id)}"><arguments>${escapeXml(call.arguments)}</arguments></tool_call>`
  ).join("\n");
  return [content, "<assistant_tool_calls>", callText, "</assistant_tool_calls>"].filter(Boolean).join("\n");
}

function toolNameFromHistory(messages, toolCallId) {
  for (const message of messages || []) {
    for (const call of message?.tool_calls || []) {
      if (String(call?.id || "") === String(toolCallId || "")) {
        return String(call?.function?.name || "tool");
      }
    }
  }
  return "tool";
}

function transcriptLine(role, value, messages = []) {
  if (role === "tool") {
    return buildToolResultBlock(
      toolNameFromHistory(messages, value?.tool_call_id),
      value?.tool_call_id || "",
      textPart(value?.content)
    );
  }
  if (role === "assistant") {
    return `ASSISTANT:\n${assistantToolCallSummary(value)}`;
  }
  return `USER:\n${textPart(value?.content)}`;
}

export function prepareCursorConversation(messages = [], tools = []) {
  const bridgeTools = selectCursorBridgeTools(tools);
  const systemParts = [];
  const transcript = [];
  for (const message of messages || []) {
    if (message?.role === "system") {
      const content = textPart(message.content);
      if (content) systemParts.push(content);
      continue;
    }
    transcript.push(transcriptLine(
      message?.role === "tool" ? "tool" : message?.role === "assistant" ? "assistant" : "user",
      message,
      messages
    ));
  }
  const instruction = buildCursorToolCompatibilityInstruction(bridgeTools);
  if (instruction) systemParts.push(instruction);
  return {
    system: systemParts.join("\n\n"),
    user: transcript.length
      ? `Continue the following API conversation faithfully.\n\n${transcript.join("\n\n")}`
      : "Continue."
  };
}

/**
 * AgentService 专用：当前 user 轮 + 结构化 history，避免整段拍扁。
 * system/work 规则放进当前 user 文本前缀（custom_system_prompt field 8 会被上游拒）。
 */
export function prepareCursorAgentTurn(messages = [], tools = []) {
  const bridgeTools = selectCursorBridgeTools(tools);
  const systemParts = [];
  const chat = [];
  for (const message of messages || []) {
    if (message?.role === "system") {
      const content = textPart(message.content);
      if (content) systemParts.push(content);
      continue;
    }
    chat.push(message);
  }
  const work = buildCursorWorkInstruction(bridgeTools);
  if (work) systemParts.push(work);

  let currentIndex = -1;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (chat[i]?.role === "user") {
      currentIndex = i;
      break;
    }
  }
  // 活跃轮 = 最近一条 user 及其后的 assistant/tool（Codex 工具回传后往往没有新的 user）。
  const history = currentIndex >= 0 ? chat.slice(0, currentIndex) : chat.slice(0, Math.max(chat.length - 1, 0));
  const active = currentIndex >= 0 ? chat.slice(currentIndex) : chat.slice(-1);

  const toHistoryText = (message) => {
    if (message?.role === "tool") {
      return {
        role: "user",
        content: buildToolResultBlock(
          toolNameFromHistory(messages, message.tool_call_id),
          message.tool_call_id || "",
          textPart(message.content)
        )
      };
    }
    if (message?.role === "assistant") {
      const content = assistantToolCallSummary(message);
      return content ? { role: "assistant", content } : null;
    }
    const content = textPart(message?.content);
    return content ? { role: "user", content } : null;
  };

  const historyTexts = history.map(toHistoryText).filter(Boolean);
  const activeBits = active.map((message) => {
    if (message?.role === "tool") {
      return buildToolResultBlock(
        toolNameFromHistory(messages, message.tool_call_id),
        message.tool_call_id || "",
        textPart(message.content)
      );
    }
    if (message?.role === "assistant") return assistantToolCallSummary(message);
    return textPart(message?.content);
  }).filter(Boolean);

  const prefix = systemParts.join("\n\n");
  const currentUser = activeBits.join("\n\n") || "Continue.";

  return {
    bridgeTools,
    currentUserText: prefix ? `${prefix}\n\n${currentUser}` : currentUser,
    historyMessages: historyTexts
  };
}

export function applyCursorToolCompatibility(response, tools = []) {
  const functions = cursorFunctionTools(tools);
  if (!functions.length) return response;
  const message = response?.choices?.[0]?.message;
  if (!message || typeof message.content !== "string") return response;
  const decoded = extractOpenCodeTextToolCalls(message.content, { tools });
  if (!decoded.toolCalls.length) return response;
  const nextMessage = {
    ...message,
    content: decoded.text || "",
    tool_calls: decoded.toolCalls
  };
  return {
    ...response,
    choices: response.choices.map((choice, index) => index === 0
      ? { ...choice, message: nextMessage, finish_reason: "tool_calls" }
      : choice)
  };
}

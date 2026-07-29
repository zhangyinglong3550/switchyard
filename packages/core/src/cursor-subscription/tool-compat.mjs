import { extractOpenCodeTextToolCalls } from "../opencode-text-tool-calls.mjs";

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

export function buildCursorToolCompatibilityInstruction(tools = []) {
  const functions = cursorFunctionTools(tools);
  if (!functions.length) return "";
  // Send ALL tool names so the model knows they exist, but only include
  // descriptions for the first MAX_EXPOSED_TOOLS. This keeps the prompt
  // small (Codex sends 191 tools; full schemas would be 50KB+) while
  // still letting the model call any tool the user might need.
  const allNames = functions.map(f => f.name).join(", ");
  const detailed = functions.slice(0, MAX_EXPOSED_TOOLS)
    .map(f => ({ name: f.name, desc: f.description.slice(0, 80) }));
  let catalogJson = "";
  try { catalogJson = JSON.stringify(detailed); } catch { catalogJson = "[]"; }
  if (catalogJson.length > MAX_TOOL_SCHEMA_CHARS) catalogJson = catalogJson.slice(0, MAX_TOOL_SCHEMA_CHARS);
  return [
    "You are an API endpoint. You have NO shell, file, or Agent tools.",
    "To call a function, reply ONLY with: <tool_calls><tool_call name=\"NAME\"><arguments>{json}</arguments></tool_call></tool_calls>",
    `All available tools: ${allNames}`,
    `Detailed (first ${detailed.length}): ${catalogJson}`,
    "If no function is needed, answer normally."
  ].join("\n");
}

function transcriptLine(role, value) {
  const content = textPart(value?.content);
  if (role === "tool") return `TOOL RESULT (${String(value?.tool_call_id || "unknown")}):\n${content}`;
  if (role === "assistant") {
    const calls = Array.isArray(value?.tool_calls) ? value.tool_calls.map((call) => ({
      name: call?.function?.name || "unknown",
      arguments: call?.function?.arguments || "{}"
    })) : [];
    const callText = calls.length ? `\nASSISTANT TOOL CALLS (already requested): ${JSON.stringify(calls)}` : "";
    return `ASSISTANT:\n${content}${callText}`;
  }
  return `USER:\n${content}`;
}

export function prepareCursorConversation(messages = [], tools = []) {
  const systemParts = [];
  const transcript = [];
  for (const message of messages || []) {
    if (message?.role === "system") {
      const content = textPart(message.content);
      if (content) systemParts.push(content);
      continue;
    }
    transcript.push(transcriptLine(message?.role === "tool" ? "tool" : message?.role === "assistant" ? "assistant" : "user", message));
  }
  const instruction = buildCursorToolCompatibilityInstruction(tools);
  if (instruction) systemParts.push(instruction);
  return {
    system: systemParts.join("\n\n"),
    user: transcript.length
      ? `Continue the following API conversation faithfully.\n\n${transcript.join("\n\n")}`
      : "Continue."
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

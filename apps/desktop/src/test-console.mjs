export const TEST_IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsAtlAPtXsYQRfAuDFVim67UICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwWpVjxPGt1UBkAAAAASUVORK5CYII=";
export const TEST_IMAGE_LABEL = "64x64 PNG 红色方块";

export function parseTestMessages(text) {
  const raw = String(text || "").trim();
  if (!raw) return [{ role: "user", content: "你好，请用一句话简短自我介绍。" }];
  const markers = roleMarkers();
  const lines = raw.split(/\r?\n/);
  const messages = [];
  let current = null;

  function pushCurrent() {
    if (current?.content?.trim()) {
      messages.push({ role: current.role, content: current.content.trim() });
    }
  }

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_ -]+|系统|用户|助手|工具|开发者)\s*[:：]\s*(.*)$/);
    const role = match ? markers.get(match[1].trim().toLowerCase()) : "";
    if (role) {
      pushCurrent();
      current = { role, content: match[2] || "" };
      continue;
    }
    if (!current) current = { role: "user", content: "" };
    current.content += `${current.content ? "\n" : ""}${line}`;
  }
  pushCurrent();
  return messages.length ? messages : [{ role: "user", content: raw }];
}

function roleMarkers() {
  return new Map([
    ["system", "system"],
    ["sys", "system"],
    ["系统", "system"],
    ["developer", "developer"],
    ["dev", "developer"],
    ["开发者", "developer"],
    ["user", "user"],
    ["human", "user"],
    ["用户", "user"],
    ["assistant", "assistant"],
    ["ai", "assistant"],
    ["助手", "assistant"],
    ["tool", "tool"],
    ["工具", "tool"]
  ]);
}

export function clientPrefix(clientId) {
  const map = {
    codex: "/codex",
    "claude-code": "/claude-code",
    hermes: "/hermes",
    "generic-openai": ""
  };
  return map[clientId] ?? "";
}

export function buildTestRequest({
  base,
  clientId,
  protocol,
  model,
  messages,
  stream,
  includeImage,
  temperature,
  maxTokens
}) {
  const prefix = clientPrefix(clientId);
  const normalized = normalizeMessages(messages);
  const system = normalized.filter((message) => message.role === "system" || message.role === "developer").map((message) => message.content).join("\n\n");
  const conversation = normalized.filter((message) => message.role !== "system" && message.role !== "developer");
  const max = Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0 ? Number(maxTokens) : 512;
  const temp = Number.isFinite(Number(temperature)) ? Number(temperature) : undefined;

  if (protocol === "anthropic_messages") {
    const body = {
      model,
      max_tokens: max,
      stream: Boolean(stream),
      messages: toAnthropicMessages(withImageOnLastUser(conversation, includeImage, "anthropic_messages"))
    };
    if (system) body.system = system;
    if (temp !== undefined) body.temperature = temp;
    return {
      url: `${base}${prefix}/v1/messages`,
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": "switchyard-local" },
      body
    };
  }

  if (protocol === "openai_responses") {
    const input = toResponsesInput(withImageOnLastUser(conversation, includeImage, "openai_responses"));
    const body = {
      model,
      stream: Boolean(stream),
      input
    };
    if (system) body.instructions = system;
    if (temp !== undefined) body.temperature = temp;
    if (max) body.max_output_tokens = max;
    return {
      url: `${base}${prefix}/v1/responses`,
      headers: { "Content-Type": "application/json", Authorization: "Bearer switchyard-local" },
      body
    };
  }

  const chatMessages = withImageOnLastUser(normalized, includeImage, "openai_chat");
  const body = { model, stream: Boolean(stream), messages: chatMessages };
  if (temp !== undefined) body.temperature = temp;
  if (max) body.max_tokens = max;
  return {
    url: `${base}${prefix}/v1/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: "Bearer switchyard-local" },
    body
  };
}

function normalizeMessages(messages) {
  const list = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: "你好，请用一句话简短自我介绍。" }];
  return list
    .map((message) => ({
      role: ["system", "developer", "user", "assistant", "tool"].includes(message?.role) ? message.role : "user",
      content: contentText(message?.content)
    }))
    .filter((message) => message.content);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || part?.input_text || "";
    }).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") return content.text || content.content || content.input_text || "";
  return "";
}

function withImageOnLastUser(messages, includeImage, protocol) {
  if (!includeImage) return messages.map((message) => ({ ...message }));
  const out = messages.map((message) => ({ ...message }));
  let index = out.findLastIndex((message) => message.role === "user");
  if (index < 0) {
    out.push({ role: "user", content: "请判断这张图片的主要颜色，只回答颜色。" });
    index = out.length - 1;
  }
  out[index] = { ...out[index], content: imagePrompt(out[index].content, protocol) };
  return out;
}

function imagePrompt(prompt, protocol) {
  if (protocol === "anthropic_messages") {
    return [
      { type: "text", text: prompt },
      { type: "image", source: { type: "base64", media_type: "image/png", data: TEST_IMAGE_DATA_URL.split(",")[1] } }
    ];
  }
  if (protocol === "openai_responses") {
    return [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: TEST_IMAGE_DATA_URL }
    ];
  }
  return [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: TEST_IMAGE_DATA_URL } }
  ];
}

function toResponsesInput(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { type: "message", role: "user", content: `工具结果：${message.content}` };
    }
    return {
      type: "message",
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    };
  });
}

function toAnthropicMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") return { role: "user", content: `工具结果：${message.content}` };
    return {
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    };
  });
}

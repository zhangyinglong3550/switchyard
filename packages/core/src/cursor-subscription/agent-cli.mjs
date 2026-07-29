import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCursorConversation } from "./tool-compat.mjs";
import { collapseCursorSubscriptionModelCatalog } from "./model-catalog.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;

function executable(file, fsImpl = fs) {
  try {
    const stat = fsImpl.statSync(file);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Locate Cursor Agent explicitly. Never invoke the bare `agent` command:
 * users commonly have unrelated CLIs named agent earlier in PATH.
 */
export function findCursorAgentExecutable({ home = os.homedir(), env = process.env, fsImpl = fs } = {}) {
  const configured = String(env.SWITCHYARD_CURSOR_AGENT_PATH || "").trim();
  if (configured && executable(configured, fsImpl)) return configured;
  const versionsDir = path.join(home, ".local", "share", "cursor-agent", "versions");
  try {
    const candidates = fsImpl.readdirSync(versionsDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => path.join(versionsDir, version, "cursor-agent"));
    return candidates.find((file) => executable(file, fsImpl)) || "";
  } catch {
    return "";
  }
}

function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("\n");
}

/** Convert an OpenAI conversation into Cursor CLI's one-shot prompt. */
export function cursorAgentPrompt(messages = [], tools = []) {
  const prepared = prepareCursorConversation(messages, tools);
  const transcript = [
    prepared.system ? { role: "system", content: prepared.system } : null,
    { role: "user", content: prepared.user }
  ].filter(Boolean);
  return transcript.map((message) => {
    const role = String(message?.role || "user").toUpperCase();
    const content = textContent(message?.content);
    return content ? `<${role}>\n${content}\n</${role}>` : "";
  }).filter(Boolean).join("\n\n") || "Continue.";
}

function hasUnsupportedCliContent(messages = []) {
  return messages.some((message) => Array.isArray(message?.content) &&
    message.content.some((part) => part && part.type !== "text"));
}

/**
 * Cursor's local CLI is materially faster than the legacy direct AgentService
 * transport. It cannot expose native function calls, so functions are carried
 * through Switchyard's existing XML compatibility envelope and transformed
 * back to OpenAI tool calls before they reach the client.
 */
export function isCursorAgentCliEligible(_body = {}) {
  // The direct AgentService Run is now as fast as the CLI (~3-4s) after
  // removing capability flags and using 9router-style headers. The CLI ask
  // mode is disabled entirely because it runs as an agent with its own
  // system prompt and tries to use Cursor's built-in tools instead of
  // returning OpenAI-compatible tool calls.
  return false;
}

export function legacyCursorAgentPrompt(messages = []) {
  return messages.map((message) => {
    const role = String(message?.role || "user").toUpperCase();
    const content = textContent(message?.content);
    return content ? `<${role}>\n${content}\n</${role}>` : "";
  }).filter(Boolean).join("\n\n") || "Continue.";
}

function modelArgument(model) {
  const value = String(model || "").trim();
  const legacyAliases = {
    "grok-4.5": "cursor-grok-4.5-high-fast",
    "composer-2.5": "composer-2.5-fast",
    "claude-opus-5": "claude-opus-5-high",
    "gpt-5.6-sol": "gpt-5.6-sol-medium",
    "claude-fable-5": "claude-fable-5-high",
    "claude-sonnet-5": "claude-sonnet-5-high",
    "gpt-5.6-terra": "gpt-5.6-terra-medium"
  };
  if (!value || value === "default") return "auto";
  return legacyAliases[value] || value;
}

function messageText(event) {
  return Array.isArray(event?.message?.content)
    ? event.message.content.filter((part) => part?.type === "text").map((part) => String(part.text || "")).join("")
    : "";
}

/**
 * Uses Cursor's supported local CLI instead of reproducing an undocumented
 * internal protobuf wire contract. `ask` keeps this bridge read-only; unlike
 * cursor-agent-api-proxy we deliberately never pass --yolo/--force.
 */
export async function* cursorAgentCliEvents({ messages = [], tools = [], model, signal, executablePath, cwd } = {}) {
  const command = executablePath || findCursorAgentExecutable();
  if (!command) {
    const error = new Error("未找到 Cursor Agent CLI；请在 Cursor 中安装 CLI 后重试");
    error.code = "CURSOR_AGENT_CLI_NOT_FOUND";
    throw error;
  }
  const safeCwd = cwd || path.join(os.tmpdir(), "switchyard-cursor-agent");
  fs.mkdirSync(safeCwd, { recursive: true });
  const args = ["-p", "--output-format", "stream-json", "--stream-partial-output", "--mode", "ask", "--trust", "--model", modelArgument(model), cursorAgentPrompt(messages, tools)];
  const child = spawn(command, args, { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], shell: false });
  let stderr = "";
  let buffer = "";
  let terminal = false;
  let settled = false;
  const events = [];
  let assistantText = "";
  let wake;
  const notify = () => { const resolve = wake; wake = null; resolve?.(); };
  const finish = (error = null) => { if (settled) return; settled = true; if (error) events.push({ type: "error", error }); notify(); };
  const abort = () => { try { child.kill("SIGTERM"); } catch {} };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener?.("abort", abort, { once: true });
  }
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event?.type === "assistant") {
          const text = messageText(event);
          if (text && text !== assistantText) {
            const delta = text.startsWith(assistantText) ? text.slice(assistantText.length) : text;
            if (delta) events.push({ type: "text", text: delta });
            assistantText = text.startsWith(assistantText) ? text : `${assistantText}${text}`;
          }
        }
        if (event?.type === "result") {
          terminal = true;
          events.push({ type: "terminal" });
        }
      } catch { /* Cursor CLI occasionally writes non-JSON progress; ignore it. */ }
    }
    notify();
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-1000); });
  child.on("error", (cause) => {
    const error = new Error(`Cursor Agent CLI 无法启动：${cause.message}`);
    error.code = "CURSOR_AGENT_CLI_START_FAILED";
    finish(error);
  });
  child.on("close", (code) => {
    if (!terminal) {
      const error = new Error(`Cursor Agent CLI 在完成前退出（code ${code ?? "unknown"}）${stderr ? `：${stderr.trim().slice(0, 300)}` : ""}`);
      error.code = "CURSOR_AGENT_CLI_INCOMPLETE_STREAM";
      finish(error);
    } else finish();
  });
  while (!settled || events.length) {
    if (!events.length) await new Promise((resolve) => { wake = resolve; });
    while (events.length) {
      const event = events.shift();
      if (event.type === "error") throw event.error;
      yield event;
    }
  }
}

export function cursorAgentCliModelCatalog({ executablePath, execFile = execFileSync } = {}) {
  const command = executablePath || findCursorAgentExecutable();
  if (!command) return { ok: false, reason: "cursor_agent_cli_not_found", models: [] };
  try {
    const output = String(execFile(command, ["--list-models"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] }) || "");
    const models = output.split(/\r?\n/).map((line) => line.match(/^([^\s]+)\s+-\s+(.+)$/)).filter(Boolean).map((match) => ({
      id: match[1], displayName: match[2], capabilities: { text: true, stream: true, reasoning: /thinking|\bhigh\b|\blow\b|\bmedium\b|xhigh|max/i.test(match[1]), tools: false, images: false, multimodal: false }
    }));
    const collapsed = collapseCursorSubscriptionModelCatalog(models);
    return collapsed.length ? { ok: true, source: "cursor-agent-cli", models: collapsed } : { ok: false, reason: "cursor_agent_cli_models_empty", models: [] };
  } catch {
    return { ok: false, reason: "cursor_agent_cli_models_unavailable", models: [] };
  }
}

export const CURSOR_AGENT_CLI_DEFAULT_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

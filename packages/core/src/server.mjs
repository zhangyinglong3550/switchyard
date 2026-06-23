// HTTP gateway server. Provides three client-facing protocol entry points and
// fans every request out to a single canonical chat-style call, regardless of
// what upstream protocol the chosen provider speaks. Compat patches plug in via
// applyOutbound/applyInbound and are provider/model targeted.
import http from "node:http";
import { listModelsForClient, loadConfig, publicModel } from "./config.mjs";
import { resolveRoute } from "./router.mjs";
import { dispatchChat } from "./upstream/dispatch.mjs";
import { json, readJsonBody } from "./utils.mjs";
import { responsesToChat, chatToResponse, streamChatAsResponses } from "./openai-adapter.mjs";
import { anthropicToChat, chatToAnthropic, streamChatAsAnthropic, countTokensApprox } from "./anthropic-adapter.mjs";
import { registerBuiltinPatches, applyStreamLine } from "./compat/index.mjs";
registerBuiltinPatches();

const CLIENT_PREFIXES = [
  { prefix: "/codex", clientId: "codex" },
  { prefix: "/claude-code", clientId: "claude-code" },
  { prefix: "/hermes", clientId: "hermes" },
  { prefix: "/openai", clientId: "generic-openai" },
  { prefix: "/anthropic", clientId: "generic-openai" }
];

function detectClient(req, url) {
  const headerClient = req.headers["x-switchyard-client"];
  if (typeof headerClient === "string" && headerClient) return headerClient;
  for (const { prefix, clientId } of CLIENT_PREFIXES) {
    if (url.pathname.startsWith(prefix + "/")) return clientId;
  }
  return null;
}

function stripClientPrefix(pathname) {
  for (const { prefix } of CLIENT_PREFIXES) {
    if (pathname.startsWith(prefix + "/")) return pathname.slice(prefix.length);
  }
  return pathname;
}

export function createServer({ onLog } = {}) {
  let config = loadConfig();
  const emit = (entry) => {
    try { if (typeof onLog === "function") onLog(entry); } catch {}
  };

  const server = http.createServer(async (req, res) => {
    const start = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const clientId = detectClient(req, url);
    const path = stripClientPrefix(url.pathname);
    try {
      if (req.method === "GET" && path === "/health") {
        json(res, 200, { ok: true, service: "switchyard", clients: Object.keys(config.clients || {}) });
        return;
      }
      if (req.method === "POST" && path === "/admin/reload") {
        config = loadConfig();
        json(res, 200, { ok: true, models: config.models.length, providers: config.providers.length });
        emit({ level: "info", msg: "config reloaded", models: config.models.length, providers: config.providers.length });
        return;
      }
      if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
        const models = clientId ? listModelsForClient(config, clientId) : config.models;
        json(res, 200, { object: "list", data: models.map(publicModel) });
        return;
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        await handleChat(config, req, res, clientId, emit);
        return;
      }
      if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        await handleResponses(config, req, res, clientId, emit);
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages" || path === "/messages")) {
        await handleAnthropicMessages(config, req, res, clientId, emit);
        return;
      }
      if (req.method === "POST" && (path === "/v1/messages/count_tokens" || path === "/messages/count_tokens")) {
        const body = await readJsonBody(req);
        json(res, 200, countTokensApprox(body));
        return;
      }
      json(res, 404, { error: "Not found", path: url.pathname });
    } catch (err) {
      emit({ level: "error", msg: err.message || String(err) });
      json(res, 500, { error: err.message || String(err) });
    } finally {
      emit({ level: "info", msg: "request", method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - start, clientId });
    }
  });

  server.reloadConfig = () => { config = loadConfig(); return { models: config.models.length, providers: config.providers.length }; };
  server.currentConfig = () => config;
  return server;
}

async function handleChat(config, req, res, clientId, emit) {
  const body = await readJsonBody(req);
  const route = resolveRoute(config, body.model || "", { clientId });
  if (!route) { json(res, 400, { error: `No route for model ${body.model || "(empty)"}` }); return; }
  const chatBody = { ...body, _modelId: route.model.id };
  if (body.stream) {
    // For stream we currently only support direct openai_chat passthrough.
    // Non-openai_chat streaming is a V0.3+ item.
    if ((route.provider.apiFormat || "openai_chat") !== "openai_chat") {
      json(res, 501, { error: "stream over non-openai_chat upstream is not supported yet" });
      return;
    }
    const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId, stream: true });
    return pipeStream(result.upstream, res, { provider: route.provider, model: route.model });
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId });
  if (result.kind === "error") { json(res, result.status, result.payload); return; }
  res.writeHead(result.status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result.payload));
  emit({ level: "info", msg: "chat", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat });
}

async function handleResponses(config, req, res, clientId, emit) {
  const body = await readJsonBody(req);
  const route = resolveRoute(config, body.model || "", { clientId });
  if (!route) { json(res, 400, { error: `No route for model ${body.model || "(empty)"}` }); return; }
  const chatBody = { ...responsesToChat(body, route.upstreamModel), _modelId: route.model.id };
  if (body.stream) {
    if ((route.provider.apiFormat || "openai_chat") !== "openai_chat") {
      json(res, 501, { error: "stream over non-openai_chat upstream is not supported yet" });
      return;
    }
    const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, { clientId });
    return streamChatAsResponses(result.upstream, res, body.model);
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId });
  if (result.kind === "error") { json(res, result.status, result.payload); return; }
  json(res, 200, chatToResponse(result.payload, body.model));
  emit({ level: "info", msg: "responses", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat });
}

async function handleAnthropicMessages(config, req, res, clientId, emit) {
  const body = await readJsonBody(req);
  const route = resolveRoute(config, body.model || "", { clientId });
  if (!route) { json(res, 400, { error: `No route for model ${body.model || "(empty)"}` }); return; }
  const chatBody = { ...anthropicToChat(body, route.upstreamModel), _modelId: route.model.id };
  if (body.stream) {
    if ((route.provider.apiFormat || "openai_chat") !== "openai_chat") {
      json(res, 501, { error: "stream over non-openai_chat upstream is not supported yet" });
      return;
    }
    const result = await dispatchChat(route.provider, route.upstreamModel, { ...chatBody, stream: true }, { clientId });
    return streamChatAsAnthropic(result.upstream, res, body.model);
  }
  const result = await dispatchChat(route.provider, route.upstreamModel, chatBody, { clientId });
  if (result.kind === "error") { json(res, result.status, result.payload); return; }
  json(res, 200, chatToAnthropic(result.payload, body.model));
  emit({ level: "info", msg: "messages", model: body.model, upstream: route.upstreamModel, apiFormat: route.provider.apiFormat });
}

async function pipeStream(upstream, res, ctx) {
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });
  if (!upstream.body) { res.end(); return; }
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    // SSE lines separated by \n; process complete lines
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line) { res.write("\n"); continue; }
      const transformed = ctx ? applyStreamLine(line, ctx) : line;
      if (transformed == null) continue;
      res.write(transformed + "\n");
    }
  }
  if (buf) {
    const transformed = ctx ? applyStreamLine(buf, ctx) : buf;
    if (transformed != null) res.write(transformed);
  }
  res.end();
}

export function startServer({ host, port, onLog } = {}) {
  const config = loadConfig();
  const server = createServer({ onLog });
  const actualHost = host || config.host || "127.0.0.1";
  const actualPort = Number(port || config.port || 17888);
  return new Promise((resolve) => {
    server.listen(actualPort, actualHost, () => {
      const addr = server.address();
      const realPort = typeof addr === "object" && addr ? addr.port : actualPort;
      console.error(`[switchyard] listening on http://${actualHost}:${realPort}`);
      resolve({ server, host: actualHost, port: realPort });
    });
  });
}

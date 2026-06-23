import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createServer } from "../src/server.mjs";

function writeTempConfig(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sy-mx-"));
  const p = path.join(tmp, "config.json");
  fs.writeFileSync(p, JSON.stringify(content, null, 2));
  process.env.SWITCHYARD_CONFIG = p;
  return tmp;
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}

function makeUpstreamOpenAIChat(replyText) {
  return http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "u1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }));
    });
  });
}

function makeUpstreamResponses(replyText) {
  return http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/responses");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "r1", object: "response", status: "completed", model: "u",
        output: [{ type: "message", id: "m1", status: "completed", role: "assistant", content: [{ type: "output_text", text: replyText, annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
}

function makeUpstreamAnthropic(replyText) {
  return http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => {
      assert.equal(req.url, "/v1/messages");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "m1", type: "message", role: "assistant", model: "claude",
        content: [{ type: "text", text: replyText }],
        stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }
      }));
    });
  });
}

async function listenOn(server) { await new Promise((r) => server.listen(0, "127.0.0.1", r)); return server.address().port; }
function closeServer(s) { return new Promise((r) => s.close(r)); }

const matrix = [
  { client: "chat", upstream: "openai_chat", maker: makeUpstreamOpenAIChat, baseSuffix: "/v1" },
  { client: "chat", upstream: "openai_responses", maker: makeUpstreamResponses, baseSuffix: "" },
  { client: "chat", upstream: "anthropic_messages", maker: makeUpstreamAnthropic, baseSuffix: "" },
  { client: "responses", upstream: "openai_chat", maker: makeUpstreamOpenAIChat, baseSuffix: "/v1" },
  { client: "responses", upstream: "openai_responses", maker: makeUpstreamResponses, baseSuffix: "" },
  { client: "responses", upstream: "anthropic_messages", maker: makeUpstreamAnthropic, baseSuffix: "" },
  { client: "messages", upstream: "openai_chat", maker: makeUpstreamOpenAIChat, baseSuffix: "/v1" },
  { client: "messages", upstream: "openai_responses", maker: makeUpstreamResponses, baseSuffix: "" },
  { client: "messages", upstream: "anthropic_messages", maker: makeUpstreamAnthropic, baseSuffix: "" }
];

for (const cell of matrix) {
  test(`matrix · client=${cell.client} × upstream=${cell.upstream}`, async (t) => {
    const upstream = cell.maker("HELLO_PONG");
    const upPort = await listenOn(upstream);
    const tmp = writeTempConfig({
      host: "127.0.0.1", port: 0,
      providers: [{ id: "p", apiFormat: cell.upstream, baseUrl: `http://127.0.0.1:${upPort}${cell.baseSuffix}`, apiKey: "k" }],
      models: [{ id: "p/m", providerId: "p", upstreamModel: "u", aliases: ["alpha"] }]
    });
    const server = createServer();
    const gwPort = await listenOn(server);
    t.after(async () => {
      await closeServer(server);
      await closeServer(upstream);
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    let url, body;
    if (cell.client === "chat") {
      url = `http://127.0.0.1:${gwPort}/v1/chat/completions`;
      body = { model: "p/m", messages: [{ role: "user", content: "ping" }] };
    } else if (cell.client === "responses") {
      url = `http://127.0.0.1:${gwPort}/v1/responses`;
      body = { model: "p/m", input: "ping" };
    } else {
      url = `http://127.0.0.1:${gwPort}/v1/messages`;
      body = { model: "p/m", messages: [{ role: "user", content: "ping" }], max_tokens: 64 };
    }
    const out = await fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(out.status, 200, `status: ${out.status} body: ${JSON.stringify(out.body)}`);
    let text;
    if (cell.client === "chat") text = out.body.choices?.[0]?.message?.content;
    else if (cell.client === "responses") text = out.body.output?.[0]?.content?.[0]?.text;
    else text = out.body.content?.[0]?.text;
    assert.equal(text, "HELLO_PONG");
  });
}

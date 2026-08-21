import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dispatchChat } from "../src/upstream/dispatch.mjs";
import { upsertAccounts, resetRoundRobinCursors } from "../src/account-pool/index.mjs";
import { __resetAntigravityReplayCache, collapseFetchedAntigravityModels, publicAntigravityModelId, resolveAntigravityWireModel } from "../src/antigravity-adapter.mjs";
import {
  buildAntigravityUserAgent,
  detectAntigravityCliVersion,
  fetchAntigravityAvailableModels,
  parseAntigravityCliVersion
} from "../src/upstream/clients.mjs";

function ccaResponse(parts, { finishReason = "STOP", usageMetadata = { promptTokenCount: 12, candidatesTokenCount: 3 } } = {}) {
  return {
    response: {
      candidates: [{ content: { parts }, finishReason }],
      usageMetadata
    }
  };
}

function nativeProvider(overrides = {}) {
  return {
    id: "antigravity",
    apiFormat: "antigravity",
    baseUrl: "https://cca.example.test",
    apiKey: "google-access-token",
    projectId: "project-123",
    ...overrides
  };
}

test("Antigravity catalog collapses effort variants into picker ids", () => {
  assert.equal(publicAntigravityModelId("gemini-3.7-flash-tiered"), "gemini-3.7-flash");
  assert.equal(publicAntigravityModelId("gemini-3.6-flash-high"), "gemini-3.6-flash");
  assert.equal(publicAntigravityModelId("gemini-pro-agent"), "gemini-3.1-pro");
  assert.equal(publicAntigravityModelId("tab_flash_lite_preview"), "");
  const collapsed = collapseFetchedAntigravityModels({
    models: {
      "gemini-3.7-flash-tiered": { displayName: "Gemini 3.7 Flash", maxTokens: 1048576 },
      "gemini-3.6-flash-low": { displayName: "Gemini 3.6 Flash Low", maxTokens: 1048576 },
      "gemini-3.6-flash-high": { displayName: "Gemini 3.6 Flash High", maxTokens: 1048576 },
      "gemini-pro-agent": { displayName: "Gemini 3.1 Pro" },
      "tab_jump_flash_lite_preview": { displayName: "Tab jump" },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", maxTokens: 200000 }
    }
  }, new Map([
    ["gemini-3.7-flash", { id: "gemini-3.7-flash", displayName: "Gemini 3.7 Flash" }],
    ["gemini-3.6-flash", { id: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash" }],
    ["gemini-3.1-pro", { id: "gemini-3.1-pro", displayName: "Gemini 3.1 Pro" }]
  ]));
  assert.deepEqual(collapsed.map((item) => item.id), [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.1-pro",
    "claude-sonnet-4-6"
  ]);
});

test("Antigravity fetches the live CCA model catalog", async () => {
  let received = null;
  const result = await fetchAntigravityAvailableModels(nativeProvider(), {
    fetchImpl: async (url, init) => {
      received = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        models: { "gemini-3.7-flash-tiered": { displayName: "Gemini 3.7 Flash" } }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.equal(received.url, "https://cca.example.test/v1internal:fetchAvailableModels");
  assert.deepEqual(received.body, { project: "project-123" });
  assert.equal(result.payload.models["gemini-3.7-flash-tiered"].displayName, "Gemini 3.7 Flash");
});

test("Antigravity Gemini 3.7 Flash routes through the tiered CCA runtime", () => {
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.7-flash", "high"), {
    wireModel: "gemini-3.7-flash-tiered",
    thinkingLevel: "high"
  });
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.7-flash"), {
    wireModel: "gemini-3.7-flash-tiered",
    thinkingLevel: "medium"
  });
  assert.deepEqual(resolveAntigravityWireModel("gemini-3.7-flash-low"), {
    wireModel: "gemini-3.7-flash-tiered",
    thinkingLevel: "low"
  });
});

test("Antigravity CLI fingerprint follows the locally installed agy version", () => {
  assert.equal(parseAntigravityCliVersion("antigravity 1.2.3\n"), "1.2.3");
  assert.equal(parseAntigravityCliVersion("agy 1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(parseAntigravityCliVersion("not a version"), "");
  assert.equal(detectAntigravityCliVersion({
    home: "/missing",
    exec: (command) => command === "agy" ? "1.3.7\n" : (() => { throw new Error("missing"); })()
  }), "1.3.7");
  assert.equal(
    buildAntigravityUserAgent({ cliVersion: "1.3.7", platform: "darwin", arch: "arm64" }),
    "antigravity/cli/1.3.7 (aidev_client; os_type=darwin; arch=arm64)"
  );
});

test("Antigravity native adapter builds CCA envelope and restores a Chat response", async () => {
  __resetAntigravityReplayCache();
  let received = null;
  const fetchImpl = async (url, init) => {
    received = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(ccaResponse([
      { text: "正在读取文件。" },
      { functionCall: { id: "tool_read_1", name: "read_file", args: { path: "README.md" } } }
    ], { finishReason: "STOP" })), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await dispatchChat(nativeProvider(), "gemini-3.6-flash", {
    messages: [
      { role: "system", content: "你是一个编程助手。" },
      { role: "user", content: "读取 README" }
    ],
    reasoning_effort: "high",
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "读取文件",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], $schema: "https://json-schema.org/draft/2020-12/schema" }
      }
    }]
  }, { fetchImpl });

  assert.equal(result.kind, "json");
  assert.equal(received.url, "https://cca.example.test/v1internal:generateContent");
  assert.equal(received.headers.Authorization, "Bearer google-access-token");
  assert.match(received.headers["User-Agent"], /^antigravity\/cli\/\d+\.\d+\.\d+/);
  assert.equal(received.body.model, "gemini-3.6-flash-high");
  assert.equal(received.body.project, "project-123");
  assert.equal(received.body.request.sessionId.startsWith("-"), true);
  assert.equal(received.body.request.systemInstruction.parts[0].text, "你是一个编程助手。");
  assert.equal(received.body.request.tools[0].functionDeclarations[0].parameters.$schema, undefined);
  assert.equal(received.body.request.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(result.payload.choices[0].message.content, "正在读取文件。");
  assert.deepEqual(result.payload.choices[0].message.tool_calls[0], {
    id: "tool_read_1",
    type: "function",
    function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
  });
  assert.equal(result.payload.usage.total_tokens, 15);
});

test("Antigravity native adapter converts OpenAI nullable tool types to CCA schema", async () => {
  __resetAntigravityReplayCache();
  let received = null;
  const fetchImpl = async (_url, init) => {
    received = JSON.parse(init.body);
    return new Response(JSON.stringify(ccaResponse([{ text: "ok" }])), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await dispatchChat(nativeProvider(), "gemini-3.6-flash", {
    messages: [{ role: "user", content: "调用工具" }],
    tools: [{
      type: "function",
      function: {
        name: "deepseek_style_tool",
        parameters: {
          type: "object",
          properties: {
            optional_text: { type: ["string", "null"] },
            mode: { type: ["string", "null"], enum: ["fast", "safe", null] },
            retry_count: { type: ["integer", "number"] }
          }
        }
      }
    }]
  }, { fetchImpl });

  const properties = received.request.tools[0].functionDeclarations[0].parameters.properties;
  assert.equal(properties.optional_text.type, "string");
  assert.equal(properties.optional_text.nullable, true);
  assert.equal(properties.mode.type, "string");
  assert.equal(properties.mode.nullable, true);
  assert.deepEqual(properties.mode.enum, ["fast", "safe"]);
  assert.equal(properties.retry_count.type, "integer");
  assert.equal(Array.isArray(properties.optional_text.type), false);
  assert.equal(Array.isArray(properties.mode.type), false);
});

test("Antigravity native adapter removes stale required entries throughout nested schemas", async () => {
  __resetAntigravityReplayCache();
  let received = null;
  const fetchImpl = async (_url, init) => {
    received = JSON.parse(init.body);
    return new Response(JSON.stringify(ccaResponse([{ text: "ok" }])), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  await dispatchChat(nativeProvider(), "gemini-3.6-flash", {
    messages: [{ role: "user", content: "调用复杂工具" }],
    tools: [{
      type: "function",
      function: {
        name: "complex_tool",
        parameters: {
          type: "object",
          properties: {
            options: {
              type: "array",
              items: [{
                type: "object",
                properties: { present: { type: "string" } },
                required: ["present", "removed"]
              }]
            },
            valid: { type: "boolean" }
          },
          required: ["valid", "missing"]
        }
      }
    }]
  }, { fetchImpl });

  const parameters = received.request.tools[0].functionDeclarations[0].parameters;
  assert.deepEqual(parameters.required, ["valid"]);
  assert.equal(Array.isArray(parameters.properties.options.items), false);
  assert.deepEqual(parameters.properties.options.items.required, ["present"]);
});

test("Antigravity native adapter replays Gemini thought signatures for the next tool turn", async () => {
  __resetAntigravityReplayCache();
  const bodies = [];
  let call = 0;
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    call += 1;
    const payload = call === 1
      ? ccaResponse([{
        thoughtSignature: "abcdefghijklmnop",
        functionCall: { id: "call_1", name: "read_file", args: { path: "a.txt" } }
      }], { finishReason: "STOP" })
      : ccaResponse([{ text: "完成。" }]);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const provider = nativeProvider();
  const firstTurn = {
    messages: [{ role: "user", content: "读取 a.txt" }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }]
  };

  const first = await dispatchChat(provider, "gemini-3.6-flash", firstTurn, { fetchImpl });
  assert.equal(first.kind, "json");

  const second = await dispatchChat(provider, "gemini-3.6-flash", {
    messages: [
      { role: "user", content: "读取 a.txt" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "文件内容" }
    ],
    tools: firstTurn.tools
  }, { fetchImpl });

  assert.equal(second.kind, "json");
  const modelTurn = bodies[1].request.contents.find((content) => content.role === "model");
  assert.equal(modelTurn.parts[0].thoughtSignature, "abcdefghijklmnop");
  const toolResultTurn = bodies[1].request.contents.find((content) => content.role === "user" && content.parts[0].functionResponse);
  assert.equal(toolResultTurn.parts[0].functionResponse.id, "call_1");
  assert.equal(toolResultTurn.parts[0].functionResponse.name, "read_file");
});

test("Antigravity CCA SSE is normalized to standard Chat SSE", async () => {
  __resetAntigravityReplayCache();
  const chunks = [
    `data: ${JSON.stringify(ccaResponse([{ text: "hello " }], { finishReason: "" }))}\n\n`,
    `data: ${JSON.stringify(ccaResponse([{ functionCall: { id: "call_1", name: "run", args: { command: "pwd" } } }], { finishReason: "STOP", usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }))}\n\n`
  ];
  const fetchImpl = async () => new Response(chunks.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });

  const result = await dispatchChat(nativeProvider(), "claude-sonnet-4-6", {
    stream: true,
    messages: [{ role: "user", content: "运行 pwd" }],
    tools: [{ type: "function", function: { name: "run", parameters: { type: "object", properties: {} } } }]
  }, { fetchImpl });

  assert.equal(result.kind, "stream");
  const text = await result.upstream.text();
  assert.match(text, /"content":"hello "/);
  assert.match(text, /"tool_calls"/);
  assert.match(text, /"name":"run"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
});

test("Antigravity account pool keeps one conversation on the same Google account", async () => {
  __resetAntigravityReplayCache();
  resetRoundRobinCursors();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-antigravity-affinity-"));
  const priorHome = process.env.SWITCHYARD_HOME;
  process.env.SWITCHYARD_HOME = home;
  try {
    upsertAccounts("anti-pool", [
      { id: "a1", email: "a1@example.com", accessToken: "token-one", projectId: "project-one" },
      { id: "a2", email: "a2@example.com", accessToken: "token-two", projectId: "project-two" }
    ], { poolKind: "antigravity_oauth", home, skipDuplicates: false });
    const seenTokens = [];
    const fetchImpl = async (_url, init) => {
      seenTokens.push(init.headers.Authorization);
      return new Response(JSON.stringify(ccaResponse([{ text: "ok" }])), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const provider = {
      id: "anti-pool",
      authMode: "account_pool",
      providerType: "account_pool",
      poolKind: "antigravity_oauth",
      apiFormat: "antigravity",
      baseUrl: "https://cca.example.test"
    };
    const body = { messages: [{ role: "user", content: "同一个任务" }] };
    const opts = { fetchImpl, incomingHeaders: { "x-codex-parent-thread-id": "thread-1" } };
    await dispatchChat(provider, "gemini-3.6-flash", body, opts);
    await dispatchChat(provider, "gemini-3.6-flash", body, opts);
    assert.equal(seenTokens.length, 2);
    assert.equal(seenTokens[0], seenTokens[1]);
  } finally {
    if (priorHome === undefined) delete process.env.SWITCHYARD_HOME;
    else process.env.SWITCHYARD_HOME = priorHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

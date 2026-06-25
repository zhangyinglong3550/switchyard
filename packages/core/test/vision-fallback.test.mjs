import test from "node:test";
import assert from "node:assert/strict";
import { applyVisionFallback } from "../src/vision-fallback.mjs";

test("vision fallback · describes images for configured text-only model", async () => {
  const config = {
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "https://text.example.com/v1" }, { id: "vision", apiFormat: "openai_chat", baseUrl: "https://vision.example.com/v1" }],
    models: [
      { id: "p/text", providerId: "p", upstreamModel: "text", capabilities: { text: true, images: false }, visionFallbackModelId: "vision/gpt-vision" },
      { id: "vision/gpt-vision", providerId: "vision", upstreamModel: "gpt-vision", capabilities: { text: true, images: true } }
    ],
    clients: { codex: { enabled: true, allowedModels: ["*"] } }
  };
  const route = {
    provider: config.providers[0],
    model: config.models[0],
    upstreamModel: "text"
  };
  const calls = [];
  const chatBody = {
    model: "p/text",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "这张图有什么？" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }
      ]
    }]
  };

  const next = await applyVisionFallback(config, route, chatBody, {
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: "x",
        choices: [{ message: { role: "assistant", content: "画面里有一个红色按钮。" } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "gpt-vision");
  assert.equal(JSON.stringify(calls[0]).includes("data:image/png;base64,AAAA"), true);
  assert.equal(JSON.stringify(next).includes("image_url"), false);
  assert.match(JSON.stringify(next), /画面里有一个红色按钮/);
  assert.match(JSON.stringify(next), /vision fallback/);
  assert.equal(next._switchyardVision.mode, "fallback");
  assert.equal(next._switchyardVision.fallbackOk, true);
  assert.equal(next._switchyardVision.fallbackModelId, "vision/gpt-vision");
});

test("vision fallback · describes each historical image separately", async () => {
  const config = {
    providers: [{ id: "p", apiFormat: "openai_chat", baseUrl: "https://text.example.com/v1" }, { id: "vision", apiFormat: "openai_chat", baseUrl: "https://vision.example.com/v1" }],
    models: [
      { id: "p/text", providerId: "p", upstreamModel: "text", capabilities: { text: true, images: false }, visionFallbackModelId: "vision/gpt-vision" },
      { id: "vision/gpt-vision", providerId: "vision", upstreamModel: "gpt-vision", capabilities: { text: true, images: true } }
    ],
    clients: { codex: { enabled: true, allowedModels: ["*"] } }
  };
  const route = {
    provider: config.providers[0],
    model: config.models[0],
    upstreamModel: "text"
  };
  const calls = [];
  const chatBody = {
    model: "p/text",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "第一张图是什么？" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
        ]
      },
      { role: "assistant", content: "第一张图的旧回答" },
      {
        role: "user",
        content: [
          { type: "text", text: "第二张图是什么？" },
          { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }
        ]
      }
    ]
  };

  const next = await applyVisionFallback(config, route, chatBody, {
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const text = JSON.stringify(body);
      assert.equal(text.includes("data:image/png;base64,AAAA") && text.includes("data:image/png;base64,BBBB"), false);
      if (text.includes("data:image/png;base64,AAAA")) {
        assert.match(text, /第一张图是什么/);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "第一张是终端模型选择框。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (text.includes("data:image/png;base64,BBBB")) {
        assert.match(text, /第二张图是什么/);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "第二张是代码编辑器。" } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error("missing image in fallback request");
    }
  });

  const serialized = JSON.stringify(next);
  assert.equal(calls.length, 2);
  assert.equal(serialized.includes("image_url"), false);
  assert.match(serialized, /第一张是终端模型选择框/);
  assert.match(serialized, /第二张是代码编辑器/);
  assert.equal(next._switchyardVision.mode, "fallback");
  assert.equal(next._switchyardVision.imageCount, 2);
  assert.equal(next._switchyardVision.fallbackCount, 2);
  assert.equal(next._switchyardVision.fallbackOk, true);
});

test("vision fallback · skips models that already support images", async () => {
  const config = {
    providers: [{ id: "vision", apiFormat: "openai_chat", baseUrl: "https://vision.example.com/v1" }],
    models: [{ id: "vision/gpt-vision", providerId: "vision", upstreamModel: "gpt-vision", capabilities: { text: true, images: true }, visionFallbackModelId: "vision/gpt-vision" }]
  };
  const route = { provider: config.providers[0], model: config.models[0], upstreamModel: "gpt-vision" };
  let called = false;
  const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
  const next = await applyVisionFallback(config, route, body, { fetchImpl: async () => { called = true; } });
  assert.notEqual(next, body);
  assert.equal(next._switchyardVision.mode, "direct");
  assert.equal(called, false);
});

test("vision fallback · reports unsupported image input when no fallback is configured", async () => {
  const config = {
    providers: [{ id: "text", apiFormat: "openai_chat", baseUrl: "https://text.example.com/v1" }],
    models: [{ id: "text/model", providerId: "text", upstreamModel: "text-upstream", capabilities: { text: true, images: false } }]
  };
  const route = { provider: config.providers[0], model: config.models[0], upstreamModel: "text-upstream" };
  const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
  const next = await applyVisionFallback(config, route, body);
  assert.equal(next._switchyardVision.mode, "unsupported_no_fallback");
  assert.equal(JSON.stringify(next).includes("image_url"), true);
});

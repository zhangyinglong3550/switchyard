import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("issue bundle · exports diagnostic fields without leaking prompt text or secrets", async () => {
  const mod = await import("../../../apps/desktop/src/issue-bundle.mjs");
  const row = {
    id: 42,
    ts: "2026-06-25T08:00:00.000Z",
    method: "POST",
    path: "/claude-code/v1/messages",
    client_id: "claude-code",
    provider_id: "deepseek",
    model_id: "deepseek/deepseek-v4-pro",
    requested_model: "claude-switchyard-deepseek",
    upstream_model: "deepseek-v4-pro",
    api_format: "openai_chat",
    status: 400,
    latency_ms: 1234,
    error: "Bearer sk-secret123 at /Users/alice/private.txt caused tool use concurrency issues",
    request_summary: JSON.stringify({
      protocol: "anthropic_messages",
      providerId: "deepseek",
      modelId: "deepseek/deepseek-v4-pro",
      upstreamModel: "deepseek-v4-pro",
      conversionChain: { steps: ["anthropic_messages", "openai_chat"] },
      errorClass: "tool.history-invalid",
      rectifiers: [{ name: "tool-history-adjacent", errorClass: "tool.history-invalid", retryStatus: 400, retryOk: false }],
      requestOverrides: {
        sources: ["provider"],
        headerNames: ["[redacted-header]"],
        bodyKeys: ["vendor_options"]
      },
      compatRules: {
        outbound: [{ id: "tool-history-adjacent", label: "Tool history adjacent", source: "auto", directions: ["outbound"] }]
      },
      params: { stream: true, temperature: 0.2, maxTokens: 128 },
      messages: {
        roleCounts: { system: 1, user: 1 },
        images: 1,
        system: [{ text: "System contains private project details" }],
        user: [{ text: "please read my private meeting notes and email me@example.com" }],
        skills: ["lark-minutes"]
      },
      tools: [{ name: "Read", description: "Read file", required: ["file_path"], propertyCount: 3 }],
      toolCount: 1,
      vision: { mode: "unsupported", source: "data:image/png;base64,AAAA" }
    }),
    response_summary: JSON.stringify({
      text: "private answer body",
      reasoning: "private chain",
      toolCalls: [{ name: "Read", argumentsPreview: "{\"file_path\":\"/Users/alice/private.txt\"}" }],
      usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 }
    })
  };

  const report = mod.buildIssueBundleReport(row, { generatedAt: "2026-06-25T08:01:00.000Z" });
  const text = JSON.stringify(report);
  assert.equal(report.bundle.kind, "switchyard-compat-issue-bundle");
  assert.equal(report.bundle.source.clientId, "claude-code");
  assert.deepEqual(report.bundle.compatibility.conversionChain.steps, ["anthropic_messages", "openai_chat"]);
  assert.equal(report.bundle.classification.errorClass, "tool.history-invalid");
  assert.equal(report.bundle.request.messages.roleCounts.user, 1);
  assert.equal(report.bundle.request.messages.samples.some((item) => item.text.chars > 0), true);
  assert.equal(report.bundle.request.tools[0].name, "Read");
  assert.equal(report.bundle.response.text.chars, "private answer body".length);
  assert.equal(report.bundle.response.toolCalls[0].hasArguments, true);
  assert.match(report.markdown, /Fixture 草案/);

  assert.equal(text.includes("please read my private meeting notes"), false);
  assert.equal(text.includes("private answer body"), false);
  assert.equal(text.includes("private chain"), false);
  assert.equal(text.includes("sk-secret123"), false);
  assert.equal(text.includes("/Users/alice"), false);
  assert.equal(text.includes("data:image/png;base64"), false);
  assert.equal(text.includes("me@example.com"), false);
});

test("issue bundle · redacts sensitive strings in markdown", async () => {
  const mod = await import("../../../apps/desktop/src/issue-bundle.mjs");
  const report = mod.buildIssueBundleReport({
    id: 7,
    status: 500,
    error: "Authorization: Bearer sk-live-secret Cookie=session /var/folders/private/cache https://example.com/path?token=abc"
  }, { generatedAt: "2026-06-25T09:00:00.000Z" });

  assert.match(report.markdown, /Authorization=\[redacted\]/);
  assert.equal(report.markdown.includes("sk-live-secret"), false);
  assert.equal(report.markdown.includes("/var/folders/private"), false);
  assert.equal(report.markdown.includes("token=abc"), false);
});

test("issue bundle · saves markdown and json files without leaking secrets", async () => {
  const mod = await import("../../../apps/desktop/src/issue-bundle.mjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-issue-bundle-"));
  try {
    const row = {
      id: 9,
      provider_id: "deepseek",
      model_id: "deepseek/deepseek-v4-pro",
      status: 500,
      error: "sk-live-secret at /Users/alice/private.txt",
      request_summary: JSON.stringify({
        messages: { roleCounts: { user: 1 }, user: [{ text: "private prompt" }] }
      }),
      response_summary: JSON.stringify({ text: "private response" })
    };
    const report = mod.buildIssueBundleReport(row, { generatedAt: "2026-06-25T10:00:00.000Z" });
    const result = mod.saveIssueBundleFiles(report, path.join(tmp, "bundle.md"));
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(result.markdownPath), true);
    assert.equal(fs.existsSync(result.jsonPath), true);
    const combined = `${fs.readFileSync(result.markdownPath, "utf8")}\n${fs.readFileSync(result.jsonPath, "utf8")}`;
    assert.equal(combined.includes("private prompt"), false);
    assert.equal(combined.includes("private response"), false);
    assert.equal(combined.includes("sk-live-secret"), false);
    assert.equal(combined.includes("/Users/alice"), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

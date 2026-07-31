import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  applySensitiveGuard,
  buildSensitiveOutboundPreview,
  previewSensitiveText,
  redactSensitiveText,
  allowSensitiveBypass,
  clearSensitiveBypass,
  normalizeSensitiveGuardConfig
} from "../src/sensitive-guard.mjs";
import { listSensitiveAudits, recordSensitiveAudit, sensitiveAuditFile } from "../src/sensitive-audit-store.mjs";

function validCnId() {
  // 生成带正确校验位的测试号（虚构）
  const base = "11010519900307857";
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(base[i]) * weights[i];
  return base + codes[sum % 11];
}

test("redacts phone, email, api key and private ip; hits keep originals for audit", () => {
  const text = "联系我 13812345678 或 a@corp.com，key=sk-abcdefghijklmnop，主机 10.1.2.3";
  const result = redactSensitiveText(text);
  assert.match(result.text, /\[REDACTED_PHONE\]/);
  assert.match(result.text, /\[REDACTED_EMAIL\]/);
  assert.match(result.text, /\[REDACTED_API_KEY\]/);
  assert.match(result.text, /\[REDACTED_INTERNAL_IP\]/);
  assert.equal(result.text.includes("13812345678"), false);
  assert.equal(result.text.includes("sk-abcdefghijklmnop"), false);
  const phoneHit = result.hits.find((hit) => hit.type === "phone");
  assert.ok(phoneHit);
  assert.ok(phoneHit.values.includes("13812345678"));
});

test("id card requires checksum", () => {
  const good = validCnId();
  const bad = "110105199003078570";
  assert.match(redactSensitiveText(`id=${good}`).text, /REDACTED_ID_CARD/);
  assert.equal(redactSensitiveText(`id=${bad}`).text.includes("REDACTED_ID_CARD"), false);
});

test("applySensitiveGuard redacts nested chat body and audits originals", () => {
  const body = {
    model: "gpt",
    messages: [
      { role: "user", content: "我的手机 13900001111，token Bearer abcdefghijklmnop" }
    ]
  };
  const result = applySensitiveGuard(body, { enabled: true });
  assert.equal(result.changed, true);
  assert.equal(result.shouldAudit, true);
  assert.equal(result.body.messages[0].content.includes("13900001111"), false);
  assert.match(result.body.messages[0].content, /REDACTED_PHONE/);
  assert.match(result.body.messages[0].content, /REDACTED_TOKEN/);
  assert.ok(result.hits.some((hit) => (hit.values || []).includes("13900001111")));
});

test("sensitive audit store can retain full original values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-sensitive-audit-"));
  const file = sensitiveAuditFile(root);
  const event = recordSensitiveAudit({
    clientId: "codex",
    modelId: "openai/gpt",
    providerId: "openai",
    retainOriginal: true,
    hits: [{
      ruleId: "cn_mobile",
      type: "phone",
      label: "手机号",
      count: 1,
      values: ["13900001111"]
    }],
    action: "redact"
  }, { file });
  assert.equal(event.total, 1);
  assert.equal(event.originals[0].value, "13900001111");
  const listed = listSensitiveAudits({ limit: 10, file });
  assert.equal(listed[0].hits[0].values[0], "13900001111");
});

test("sensitive audit store can omit originals when disabled", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-sensitive-audit-no-"));
  const file = sensitiveAuditFile(root);
  const event = recordSensitiveAudit({
    retainOriginal: false,
    hits: [{
      ruleId: "cn_mobile",
      type: "phone",
      label: "手机号",
      count: 1,
      values: ["13900001111"]
    }],
    action: "redact"
  }, { file });
  assert.deepEqual(event.originals, []);
  assert.deepEqual(event.hits[0].values, []);
});

test("whitelist skips example email and test phone", () => {
  const text = "打电话 13800138000 或写 test@example.com";
  const result = redactSensitiveText(text);
  assert.equal(result.text.includes("13800138000"), true);
  assert.equal(result.text.includes("test@example.com"), true);
  assert.equal(result.total, 0);
});

test("custom keywords and patterns redact", () => {
  const config = normalizeSensitiveGuardConfig({
    keywords: ["内部项目X"],
    patterns: [{ id: "ticket", label: "工单", pattern: "TKT-\\d{4,}", flags: "g", type: "ticket" }]
  });
  const result = redactSensitiveText("内部项目X 的工单 TKT-12345", { config });
  assert.match(result.text, /REDACTED_KEYWORD/);
  assert.match(result.text, /REDACTED_TICKET/);
  assert.equal(result.text.includes("内部项目X"), false);
  assert.equal(result.text.includes("TKT-12345"), false);
});

test("per-client disable skips redaction but still detects for audit", () => {
  const body = { messages: [{ role: "user", content: "手机 13900001111" }] };
  const config = { enabled: true, clients: { codex: false, hermes: true } };
  const skipped = applySensitiveGuard(body, config, { clientId: "codex" });
  assert.equal(skipped.action, "client_disabled");
  assert.equal(skipped.changed, false);
  assert.equal(skipped.shouldAudit, true);
  assert.equal(skipped.body.messages[0].content.includes("13900001111"), true);
  assert.ok(skipped.hits.some((hit) => (hit.values || []).includes("13900001111")));

  const active = applySensitiveGuard(body, config, { clientId: "hermes" });
  assert.equal(active.changed, true);
});

test("session bypass skips redaction but audits detected originals", () => {
  clearSensitiveBypass();
  allowSensitiveBypass({ clientId: "codex", sessionKey: "thread-abc", minutes: 10 });
  const body = { messages: [{ role: "user", content: "手机 13900001111" }] };
  const result = applySensitiveGuard(body, { enabled: true }, {
    clientId: "codex",
    sessionKey: "thread-abc"
  });
  assert.equal(result.action, "allow");
  assert.equal(result.bypass, true);
  assert.equal(result.shouldAudit, true);
  assert.equal(result.body.messages[0].content.includes("13900001111"), true);
  assert.ok(result.hits.some((hit) => (hit.values || []).includes("13900001111")));

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-sensitive-allow-"));
  const file = sensitiveAuditFile(root);
  const event = recordSensitiveAudit({
    action: "allow",
    clientId: "codex",
    sessionKey: "thread-abc",
    retainOriginal: true,
    hits: result.hits
  }, { file });
  assert.equal(event.action, "allow");
  assert.equal(event.originals[0].value, "13900001111");
  clearSensitiveBypass();
});

test("previewSensitiveText does not mutate and reports hits", () => {
  const preview = previewSensitiveText("a@corp.com 和 sk-abcdefghijklmnop");
  assert.equal(preview.changed, true);
  assert.match(preview.output, /REDACTED_EMAIL/);
  assert.match(preview.output, /REDACTED_API_KEY/);
});

test("does not redact Responses message ids that contain digit runs", () => {
  const body = {
    model: "gpt",
    input: [
      {
        type: "message",
        role: "user",
        id: "msg_019fb80b-3a621004881234567890123456e94936cd3",
        content: [{ type: "input_text", text: "手机 13900001111" }]
      }
    ]
  };
  const result = applySensitiveGuard(body, { enabled: true });
  assert.equal(result.body.input[0].id, body.input[0].id);
  assert.equal(result.body.input[0].id.includes("REDACTED"), false);
  assert.match(JSON.stringify(result.body.input[0].content), /REDACTED_PHONE/);
});

test("bank card and phone rules ignore digit runs glued to hex letters", () => {
  const id = "msg_019fb80b-3a621004881234567890123456e94936cd3";
  assert.equal(redactSensitiveText(id).total, 0);
  assert.equal(redactSensitiveText("a13900001111bcdef").text, "a13900001111bcdef");
  assert.equal(redactSensitiveText('{"id":"msg_019fb80b13900001111e94936cd3"}').text.includes("REDACTED"), false);
});

test("skips encrypted_content signature and data urls", () => {
  const jwtLike = "eyJhbGciOiJub25lIn0.eyJhIjoxMjM0NTY3OH0.signatureparthere123456";
  const body = {
    input: [
      { type: "reasoning", encrypted_content: jwtLike },
      { type: "message", signature: jwtLike, content: [{ type: "input_text", text: `token ${jwtLike}` }] }
    ],
    image_url: { url: `data:image/png;base64,${jwtLike}` }
  };
  const result = applySensitiveGuard(body, { enabled: true });
  assert.equal(result.body.input[0].encrypted_content, jwtLike);
  assert.equal(result.body.input[1].signature, jwtLike);
  assert.equal(result.body.image_url.url.includes("REDACTED"), false);
});

test("does not redact git urls or private ip inside http urls", () => {
  assert.equal(redactSensitiveText("git@github.com:org/repo.git").text.includes("REDACTED"), false);
  const body = {
    messages: [{
      role: "user",
      content: [{ type: "image_url", image_url: { url: "http://10.20.30.40:8080/a.png" } }]
    }]
  };
  const result = applySensitiveGuard(body, { enabled: true });
  assert.equal(result.body.messages[0].content[0].image_url.url, "http://10.20.30.40:8080/a.png");
});

test("builtin rule toggles can disable internal ip redaction", () => {
  const text = "主机 10.1.2.3 手机 13900001111";
  const off = redactSensitiveText(text, {
    config: { builtinRules: { private_ipv4: false } }
  });
  assert.equal(off.text.includes("10.1.2.3"), true);
  assert.match(off.text, /REDACTED_PHONE/);
  const on = redactSensitiveText(text, {
    config: { builtinRules: { private_ipv4: true } }
  });
  assert.match(on.text, /REDACTED_INTERNAL_IP/);
});

test("rejects timestamp-like ids that pass Luhn as bank cards", () => {
  const stamp = "20260731-195349";
  const result = redactSensitiveText(`文件 ${stamp} 与主机 10.1.2.3`);
  assert.equal(result.text.includes(stamp), true);
  assert.equal(result.text.includes("REDACTED_BANK_CARD"), false);
  assert.match(result.text, /REDACTED_INTERNAL_IP/);
});

test("still redacts spaced bank cards in prose", () => {
  const result = redactSensitiveText("卡号 4111-1111-1111-1111");
  assert.match(result.text, /REDACTED_BANK_CARD/);
  assert.equal(result.text.includes("4111-1111-1111-1111"), false);
});

test("outbound preview shows redacted snippets from actual outbound body", () => {
  const body = {
    messages: [{ role: "user", content: "请联系 13812345678 处理" }]
  };
  const guarded = applySensitiveGuard(body, { enabled: true });
  const preview = buildSensitiveOutboundPreview(guarded.body, {
    action: guarded.action,
    hits: guarded.hits
  });
  assert.equal(preview.kind, "redacted");
  assert.ok(preview.snippets.some((item) => item.includes("[REDACTED_PHONE]")));
  assert.equal(preview.snippets.some((item) => item.includes("13812345678")), false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-sensitive-preview-"));
  const file = sensitiveAuditFile(root);
  const event = recordSensitiveAudit({
    action: "redact",
    hits: guarded.hits,
    retainOriginal: true,
    outboundPreview: preview
  }, { file });
  assert.equal(event.outboundPreview.kind, "redacted");
  assert.match(event.outboundPreview.snippets[0], /REDACTED_PHONE/);
});

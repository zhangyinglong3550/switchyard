import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  parseCursorSubscriptionImportPayload,
  importCursorSubscriptionAccountsFromText,
  cursorJwtExpIso
} from "../src/cursor-subscription/pool-import.mjs";
import { loadPool } from "../src/account-pool/store.mjs";

// 用户粘贴的 Cursor 号池导出形态：email----password----xxx----userId::JWT
const SAMPLE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdXRoMHx1c2VyXzAxS1pNV0RQWEQzUEdKV0M4SlZaRTMyOTZOIiwidGltZSI6IjE3ODY0ODYzNTYiLCJyYW5kb21uZXNzIjoiMzM4OGZkZGItMjk4ZC00YWQxIiwiZXhwIjoxNzkxNjcwMzU2LCJpc3MiOiJodHRwczovL2F1dGhlbnRpY2F0aW9uLmN1cnNvci5zaCIsInNjb3BlIjoib3BlbmlkIHByb2ZpbGUgZW1haWwgb2ZmbGluZV9hY2Nlc3MiLCJhdWQiOiJodHRwczovL2N1cnNvci5jb20iLCJ0eXBlIjoid2ViIiwid29ya29zU2Vzc2lvbklkIjoic2Vzc2lvbl8wMUtaU0U0WTJRWlEwMERNQjRLOVY0V0M4USJ9.m5aq8RjsqUwTGJtTgq6mEqsZm2CFBZ7iMpH5RD3r79Y";

test("cursor pool import · parses user pasted account-list format", () => {
  const text = `cursor@example.com----uiydh907183----z9Ogoqn&Ah9v----user_01KZMWDPXD3PGJWC8JVZE3296N::${SAMPLE_JWT}\nsecond@example.com----pass2----xxxx----user_02ABCDEFGHIJKLMNOPQRSTUVWXYZ::${SAMPLE_JWT}`;
  const parsed = parseCursorSubscriptionImportPayload(text, { machineId: "local-machine-id-1234" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.accounts.length, 2);
  const first = parsed.accounts[0];
  assert.equal(first.email, "cursor@example.com");
  assert.equal(first.sub, "user_01KZMWDPXD3PGJWC8JVZE3296N");
  assert.equal(first.accessToken, SAMPLE_JWT);
  assert.equal(first.machineId, "local-machine-id-1234");
  assert.ok(first.expiresAt); // JWT exp 会被 normalizeAccount 解析出来
  const second = parsed.accounts[1];
  assert.equal(second.email, "second@example.com");
  assert.equal(second.sub, "user_02ABCDEFGHIJKLMNOPQRSTUVWXYZ");
});

test("cursor pool import · parses email----JWT and bare JWT lines", () => {
  const parsed = parseCursorSubscriptionImportPayload(
    `plain@example.com----${SAMPLE_JWT}\n${SAMPLE_JWT}`,
    { machineId: "mach-1" }
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.accounts[0].email, "plain@example.com");
  assert.equal(parsed.accounts[0].accessToken, SAMPLE_JWT);
  assert.equal(parsed.accounts[0].machineId, "mach-1");
  assert.equal(parsed.accounts[1].accessToken, SAMPLE_JWT);
});

test("cursor pool import · accepts non-eyJ token after :: as fallback", () => {
  const parsed = parseCursorSubscriptionImportPayload(
    "fallback@example.com----xxxx----user_09ZZZ::some-long-token-value-without-eyj-prefix-1234567890abcdef",
    { machineId: "mach-2" }
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.accounts.length, 1);
  assert.equal(parsed.accounts[0].email, "fallback@example.com");
  assert.equal(parsed.accounts[0].accessToken, "some-long-token-value-without-eyj-prefix-1234567890abcdef");
  assert.equal(parsed.accounts[0].machineId, "mach-2");
});

test("cursor pool import · parses JSON array / NDJSON with access_token", () => {
  const json = JSON.stringify([
    { email: "a@example.com", access_token: SAMPLE_JWT, machine_id: "json-mach" },
    { email: "b@example.com", accessToken: SAMPLE_JWT, userId: "user_09XYZ" }
  ]);
  const parsed = parseCursorSubscriptionImportPayload(json, { machineId: "fallback" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.sourceFormat, "json");
  assert.equal(parsed.accounts.length, 2);
  assert.equal(parsed.accounts[0].machineId, "json-mach");
  assert.equal(parsed.accounts[1].machineId, "fallback");
});

test("cursor pool import · rejects payload without any JWT", () => {
  const parsed = parseCursorSubscriptionImportPayload("hello world\nno token here", { machineId: "m" });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.accounts.length, 0);
});

test("cursor pool import · upsert persists to pool with cursor_subscription kind", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-cursor-pool-"));
  const providerId = "cursor-pool-test";
  const result = importCursorSubscriptionAccountsFromText(
    providerId,
    `a@example.com----x----user_01A::${SAMPLE_JWT}`,
    { machineId: "mach-local", home }
  );
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  const pool = loadPool(providerId, { poolKind: "cursor_subscription", home });
  assert.equal(pool.poolKind, "cursor_subscription");
  assert.equal(pool.accounts.length, 1);
  assert.equal(pool.accounts[0].accessToken, SAMPLE_JWT);
  assert.equal(pool.accounts[0].machineId, "mach-local");

  // 重复导入同一 email 应去重
  const again = importCursorSubscriptionAccountsFromText(
    providerId,
    `a@example.com----y----user_01A::${SAMPLE_JWT}`,
    { machineId: "mach-local", home }
  );
  assert.equal(again.ok, true);
  assert.equal(again.skipped, 1);
  assert.equal(loadPool(providerId, { poolKind: "cursor_subscription", home }).accounts.length, 1);

  // 同一 token 的导出如果邮箱字段变化，仍然必须按同一订阅账号去重。
  const changedEmail = importCursorSubscriptionAccountsFromText(
    providerId,
    `renamed@example.com----z----user_01A::${SAMPLE_JWT}`,
    { machineId: "mach-local", home }
  );
  assert.equal(changedEmail.ok, true);
  assert.equal(changedEmail.skipped, 1);
  assert.equal(loadPool(providerId, { poolKind: "cursor_subscription", home }).accounts.length, 1);
});

test("cursor pool import · jwtExpIso extracts exp from access JWT", () => {
  const iso = cursorJwtExpIso(SAMPLE_JWT);
  assert.ok(iso);
  assert.equal(new Date(iso).getTime(), 1791670356 * 1000);
});

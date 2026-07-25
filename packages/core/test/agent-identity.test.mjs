import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildAgentAssertion,
  ensureAgentIdentityTask,
  importSub2ApiDataToCodexPool,
  listPoolAccountsPublic,
  loadPool,
  bindProviderToAccount
} from "../src/account-pool/index.mjs";
import { callOpenAIResponses } from "../src/upstream/clients.mjs";

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "switchyard-agent-identity-"));
}

function makeAgentIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKey,
    agentRuntimeId: "agent-runtime-test",
    agentPrivateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    agentTaskId: "task-test"
  };
}

test("agent identity · signs a fresh assertion without exposing its key", () => {
  const identity = makeAgentIdentity();
  const value = buildAgentAssertion(identity, { now: new Date("2026-07-23T00:00:00.000Z") });
  assert.match(value, /^AgentAssertion /);
  const payload = JSON.parse(Buffer.from(value.slice("AgentAssertion ".length), "base64url").toString("utf8"));
  assert.equal(payload.agent_runtime_id, identity.agentRuntimeId);
  assert.equal(payload.task_id, identity.agentTaskId);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(`${payload.agent_runtime_id}:${payload.task_id}:${payload.timestamp}`),
      identity.publicKey,
      Buffer.from(payload.signature, "base64")
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify(payload), /private/i);
});

test("agent identity · registers a missing task with a signed request", async () => {
  const identity = { ...makeAgentIdentity(), agentTaskId: "" };
  let sent;
  const result = await ensureAgentIdentityTask(identity, {
    now: new Date("2026-07-23T00:00:00.000Z"),
    authBaseUrl: "https://auth.example.test/api/accounts",
    fetchImpl: async (url, init) => {
      sent = { url, init };
      return new Response(JSON.stringify({ task_id: "task-new" }), { status: 200 });
    }
  });
  assert.equal(result.registered, true);
  assert.equal(result.account.agentTaskId, "task-new");
  assert.equal(sent.url, "https://auth.example.test/api/accounts/v1/agent/agent-runtime-test/task/register");
  const body = JSON.parse(sent.init.body);
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(`${identity.agentRuntimeId}:${body.timestamp}`),
      identity.publicKey,
      Buffer.from(body.signature, "base64")
    ),
    true
  );
});

test("agent identity · imports a Sub2API backup into the native Codex pool", () => {
  const home = tmpHome();
  try {
    const identity = makeAgentIdentity();
    const result = importSub2ApiDataToCodexPool("sub2api-codex", {
      type: "sub2api-data",
      version: 1,
      proxies: [],
      accounts: [{
        name: "owned-account",
        platform: "openai",
        type: "oauth",
        credentials: {
          auth_mode: "agentIdentity",
          account_id: "account-test",
          email: "owner@example.test",
          plan_type: "plus",
          ...identity
        }
      }]
    }, { home });

    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    assert.equal(result.agentIdentity, 1);
    const publicPool = listPoolAccountsPublic("sub2api-codex", { poolKind: "codex_oauth", home });
    assert.equal(publicPool.accounts[0].hasAgentIdentity, true);
    assert.equal(publicPool.accounts[0].agentPrivateKey, undefined);

    const stored = loadPool("sub2api-codex", { poolKind: "codex_oauth", home }).accounts[0];
    const bound = bindProviderToAccount({
      id: "sub2api-codex",
      authMode: "account_pool",
      poolKind: "codex_oauth",
      baseUrl: "https://chatgpt.com/backend-api/codex"
    }, stored);
    assert.equal(bound.authMode, "codex_agent_identity");
    assert.equal(bound._agentIdentity.agentTaskId, identity.agentTaskId);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("agent identity · Responses transport uses AgentAssertion instead of bearer OAuth", async () => {
  const identity = makeAgentIdentity();
  let authorization = "";
  const response = await callOpenAIResponses({
    id: "agent-identity-transport",
    authMode: "codex_agent_identity",
    providerType: "codex_agent_identity",
    baseUrl: "https://chatgpt.example.test/backend-api/codex",
    _agentIdentity: identity
  }, { model: "gpt-5.5", input: "hello", stream: false }, {
    fetchImpl: async (_url, init) => {
      authorization = init.headers.Authorization;
      return new Response(JSON.stringify({ id: "resp-test" }), { status: 200 });
    }
  });
  assert.equal(response.status, 200);
  assert.match(authorization, /^AgentAssertion /);
});

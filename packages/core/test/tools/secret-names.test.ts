// secret_names: an agent learns the names, scope and presence of the secrets its own configuration refers to, through the
// ToolDispatcher and D109 policy, with one audit decision per call - and never a value.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { composeTools } from "../../src/composition/tools.ts";
import { secretNamesPort } from "../../src/composition/index.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { agentSecretRefs, agentRequiredSecrets } from "../../src/agents/secrets.ts";
import { SECRET_NAMES_TOOL } from "../../src/tools/secret-names.ts";
import { isReservedToolName } from "../../src/tools/reserved-names.ts";
import { METHODS } from "@plur1bus/rpc-schema";
import type { ChatRequest } from "../../src/session/provider.ts";

const VALUE = "agent-visible-never-4e9a1c77d0b3";
const owner = { kind: "owner" as const, id: "t" };
const config = () => {
  const cfg = defaults() as any;
  cfg.channels.telegram = { ...(cfg.channels.telegram ?? {}), tokenSecret: "telegram.bot" };
  cfg.providers.openai = { ...(cfg.providers.openai ?? {}), apiKeyRef: "openai.key" };
  cfg.modelProfiles.fast = { candidates: [{ model: "openai/gpt-4.1" }] };
  cfg.agents = { a1: { model: "fast", channels: ["telegram"] }, a2: { model: "fast" }, a3: {} };
  return cfg;
};
async function rig() {
  const cfg = config();
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }), fileFallback: () => false, audit: createMemoryAuditSink() });
  await store.set(owner, "openai.key", VALUE); // telegram.bot is referenced by a1 but not stored
  await store.set(owner, "unrelated.secret", `${VALUE}-other`);
  const audit = memoryAuditSink();
  const registry = await composeTools({ home: "/nonexistent", roots: [], grants: { list: () => [], get: () => undefined }, audit: memoryAuditSink(), secretNames: secretNamesPort({ config: () => cfg, secrets: store }) }, { agentId: "a1", principal: "p", signal: new AbortController().signal, messages: [] } as unknown as ChatRequest);
  const dispatcher = new ToolDispatcher({ registry, approvals: { request: async () => ({ approved: false }) }, grants: { list: () => [], get: () => undefined }, audit: createPolicyAudit({ sink: audit, clock: { now: () => 1 }, host: "h" }), clock: { now: () => 1 } });
  const ctx = (agentId: string): DispatchContext => ({ agentId, principal: "user:v1:o", sessionId: "s", surface: 1, signal: new AbortController().signal });
  return { cfg, store, registry, dispatcher, audit, ctx };
}

describe("secret_names", () => {
  it("lists exactly the secrets this agent's configuration refers to, with scope and presence", async () => {
    const { dispatcher, ctx } = await rig();
    const a1 = await dispatcher.call({ id: "1", name: SECRET_NAMES_TOOL, args: {} }, ctx("a1"));
    assert.ok(!a1.isError, JSON.stringify(a1));
    assert.deepEqual(a1.value, { secrets: [
      { name: "openai.key", scope: ["provider:openai"], present: true },
      { name: "telegram.bot", scope: ["channel:telegram"], present: false },
    ] });
    const a2 = await dispatcher.call({ id: "2", name: SECRET_NAMES_TOOL, args: {} }, ctx("a2"));
    assert.deepEqual(!a2.isError && a2.value, { secrets: [{ name: "openai.key", scope: ["provider:openai"], present: true }] });
    const a3 = await dispatcher.call({ id: "3", name: SECRET_NAMES_TOOL, args: {} }, ctx("a3"));
    assert.deepEqual(!a3.isError && a3.value, { secrets: [] });
    const unknown = await dispatcher.call({ id: "4", name: SECRET_NAMES_TOOL, args: {} }, ctx("ghost"));
    assert.deepEqual(!unknown.isError && unknown.value, { secrets: [] });
  });

  it("an unreferenced secret never shows up, and no result or audit line carries a value, length or prefix of one", async () => {
    const { dispatcher, ctx, audit } = await rig();
    const results = [];
    for (const agent of ["a1", "a2", "a3"]) results.push(await dispatcher.call({ id: agent, name: SECRET_NAMES_TOOL, args: {} }, ctx(agent)));
    const everything = JSON.stringify([results, audit.events]);
    assert.ok(!everything.includes("unrelated.secret"));
    assert.ok(!everything.includes(VALUE.slice(0, 6)), "no prefix of a value");
    for (const r of results) if (!r.isError) for (const entry of (r.value as { secrets: object[] }).secrets) assert.deepEqual(Object.keys(entry).sort(), ["name", "present", "scope"]);
  });

  it("the call cannot name another agent: arguments are refused by the schema", async () => {
    const { dispatcher, ctx } = await rig();
    const r = await dispatcher.call({ id: "x", name: SECRET_NAMES_TOOL, args: { agentId: "a1" } }, ctx("a3"));
    assert.ok(r.isError && r.error.code === "tool-call-invalid");
  });

  it("each call is a recorded D109 decision (secrets.use, allowed) plus its outcome", async () => {
    const { dispatcher, ctx, audit } = await rig();
    await dispatcher.call({ id: "1", name: SECRET_NAMES_TOOL, args: {} }, ctx("a1"));
    const lines = audit.events.map(e => JSON.stringify(e));
    assert.ok(lines.length >= 1, "an audit entry for the call");
    assert.ok(lines.some(l => l.includes(SECRET_NAMES_TOOL) && l.includes("secrets.use")), lines.join("\n"));
    assert.ok(lines.some(l => /allow/.test(l)));
  });

  it("is registered only when a port is wired, is a read with low risk, and its name collides with no RPC method or reserved prefix", async () => {
    const { registry } = await rig();
    const tool = registry.get(SECRET_NAMES_TOOL)!;
    assert.equal(tool.capability, "secrets.use"); assert.equal(tool.effect, "read"); assert.equal(tool.risk, "low"); assert.equal(tool.trust, "first-party");
    const bare = await composeTools({ home: "/nonexistent", roots: [], grants: { list: () => [], get: () => undefined }, audit: memoryAuditSink() }, { agentId: "a1", principal: "p", signal: new AbortController().signal, messages: [] } as unknown as ChatRequest);
    assert.equal(bare.get(SECRET_NAMES_TOOL), undefined);
    assert.ok(!(METHODS as readonly string[]).includes(SECRET_NAMES_TOOL));
    assert.equal(isReservedToolName(SECRET_NAMES_TOOL), false);
    for (const m of ["secret.list", "secret.get", "secret.set", "secret.delete", "secret.status"]) assert.equal(isReservedToolName(m), true, `${m} stays reserved as a tool name`);
  });

  it("scope derivation keeps agentRequiredSecrets unchanged", async () => {
    const cfg = config();
    assert.deepEqual(agentRequiredSecrets(cfg, cfg.agents.a1), agentSecretRefs(cfg, cfg.agents.a1).map(r => r.name));
    assert.deepEqual(agentRequiredSecrets(cfg, cfg.agents.a1), ["openai.key", "telegram.bot"]);
  });

  // KNOWN GAP: the store has no per-secret description and no per-agent lease right (an `agent` principal is refused every
  // store call); scope is therefore derived from the agent's configuration. A description needs a store/schema change.
  it("every listed secret carries an owner-written description", { todo: "KNOWN GAP: SecretMeta has no description field; adding one changes the secret file format and the secret.* wire schema" }, async () => {
    const { dispatcher, ctx } = await rig();
    const r = await dispatcher.call({ id: "d", name: SECRET_NAMES_TOOL, args: {} }, ctx("a1"));
    assert.ok(!r.isError);
    for (const entry of (r.value as { secrets: { description?: string }[] }).secrets) assert.equal(typeof entry.description, "string");
  });
});

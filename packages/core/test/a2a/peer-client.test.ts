import { it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { A2aPeerClient } from "../../src/a2a/peer-client.ts";
import { A2aPeerStore } from "../../src/a2a/peer-store.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { A2aExecution } from "../../src/tools/a2a-transport.ts";
import { AgentCard, generateAgentCardSignature } from "@a2a-js/sdk";

it("requires endpoint-bound confirmation and audits peer changes before committing them", async () => {
  const store = new A2aPeerStore({ path: join(tempDir("a2a-peer-confirmation-"), "peers.sqlite"), now: Date.now });
  const keys = generateKeyPairSync("ed25519");
  const endpoint = "https://peer.example/confirmed-endpoint";
  const card = await generateAgentCardSignature(keys.privateKey, { alg: "EdDSA", typ: "JWT", kid: "key" })(AgentCard.fromJSON({
    name: "Private card description", supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0", url: endpoint }],
  }));
  const audit = memoryAuditSink();
  let allow = false, confirmations = 0;
  const client = new A2aPeerClient({ store, audit, now: Date.now, enabled: () => true, signal: new AbortController().signal, transport: {
    async request() { return { status: 200, body: JSON.stringify(AgentCard.toJSON(card)), contentType: "application/json" }; },
    async confirmTrust(peer, actual, _execution, _signal, current) {
      confirmations++;
      assert.equal(actual, endpoint);
      assert.equal(current(), true);
      assert.equal(store.get(peer.id)?.state, "pending");
      if (!allow) throw Object.assign(new Error("refused"), { code: "approval-required" });
    },
  } });
  const owner = { kind: "person", role: "owner", userId: "owner" } as const;
  const execution: A2aExecution = { person: "owner", agent: "system:a2a-owner", session: "session", turn: "turn", project: "", surface: 3, policy: {} };
  const input = { id: "peer", kid: "key", cardUrl: "https://peer.example/card", publicKey: keys.publicKey.export({ format: "jwk" }) };
  const append = audit.append;
  const trust = (peer: { id: string; fingerprint: string; revision: string }) => client.trust(owner, peer, execution, new AbortController().signal);
  try {
    audit.append = () => { throw new Error("audit unavailable"); };
    assert.throws(() => client.add(owner, input));
    assert.equal(store.get("peer"), null);
    audit.append = append;
    const added = client.add(owner, input);
    await assert.rejects(trust(added));
    assert.equal(confirmations, 1);
    assert.equal(store.get("peer")?.state, "pending");
    allow = true;
    audit.append = () => { throw new Error("audit unavailable"); };
    await assert.rejects(trust(added));
    assert.equal(store.get("peer")?.state, "pending");
    audit.append = append;
    await trust(added);
    audit.append = () => { throw new Error("audit unavailable"); };
    assert.throws(() => client.remove(owner, "peer"));
    assert.equal(store.get("peer")?.state, "trusted");
    audit.append = append;
    assert.equal(client.remove(owner, "peer"), true);
    assert.deepEqual(audit.events.map(e => e.action), ["a2a.peer.added", "a2a.peer.trusted", "a2a.peer.removed"]);
    assert.ok(!JSON.stringify(audit.events).includes(endpoint));
    assert.ok(!JSON.stringify(audit.events).includes("Private card description"));
  } finally { client.close(); store.close(); }
});

it("rejects non-Owner execution even when a trusted peer is already assigned", async () => {
  const store = new A2aPeerStore({ path: join(tempDir("a2a-owner-execution-"), "peers.sqlite"), now: Date.now });
  let calls = 0;
  const client = new A2aPeerClient({ store, audit: memoryAuditSink(), now: Date.now,
    transport: { async request() { calls++; throw new Error("must not contact the peer"); }, async confirmTrust() { throw new Error("must not confirm"); } }, enabled: () => true, signal: new AbortController().signal });
  try {
    const added = store.add({ id: "peer", kid: "key", cardUrl: "https://peer.example/card", publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) });
    store.trust(added.id, added.fingerprint, added.revision, "https://peer.example/rpc");
    for (const role of ["admin", "member"] as const) {
      await assert.rejects(client.target.run({
        agentId: "a2a:peer", question: "Advice", context: "", signal: new AbortController().signal,
        principal: { kind: "person", role, userId: "person" }, origin: { fromAgent: "main", traceId: "trace", spanId: "span" },
        outbound: { person: "person", agent: "main", session: "session", turn: "turn", project: "project", surface: 3, policy: {} },
      }), { code: "denied" });
    }
    assert.equal(calls, 0);
  } finally { client.close(); store.close(); }
});

it("trust uses a reserved identity that cannot select a local agent privacy override", async () => {
  const { defaults, CONFIG_SCHEMA } = await import("@plur1bus/config-schema");
  const { localOnlyFor } = await import("../../src/privacy/local-only.ts");
  const { a2aPeerMethods } = await import("../../src/rpc/a2a-peers.ts");
  const { guardMethods } = await import("../../src/rbac/guard.ts");
  const config = defaults();
  config.privacy.localOnly = true;
  config.agents["a2a-owner"] = { ...Object.values(config.agents)[0]!, privacy: { localOnly: false } };
  let checked = false;
  const service = {
    async trust(_person: unknown, _input: unknown, execution: import("../../src/tools/a2a-transport.ts").A2aExecution) {
      assert.equal(new RegExp(CONFIG_SCHEMA.properties.agents.propertyNames.pattern).test(execution.agent), false);
      assert.equal(localOnlyFor(config, execution.agent), true);
      checked = true;
      return {};
    },
  } as unknown as A2aPeerClient;
  const methods = guardMethods(a2aPeerMethods(() => service), {
    resolve: () => ({ kind: "person", role: "owner", userId: "owner" }), now: Date.now,
  });
  await methods["a2a.peer.trust"]!({}, { requestId: "trust", connectionId: "owner", signal: new AbortController().signal });
  assert.equal(checked, true);
});

it("peer management is Owner-person only and add never silently trusts a key", () => {
  const store = new A2aPeerStore({ path: join(tempDir("a2a-client-"), "peers.sqlite"), now: Date.now });
  const client = new A2aPeerClient({ store, audit: memoryAuditSink(), now: Date.now,
    transport: { async request() { throw new Error("must not fetch on add"); }, async confirmTrust() { throw new Error("must not confirm on add"); } }, enabled: () => true, signal: new AbortController().signal });
  try {
    const input = { id: "peer", kid: "key", cardUrl: "https://peer.example/card", publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) };
    for (const who of [{ userId: "admin", kind: "person" as const, role: "admin" as const }, { userId: "bot", kind: "agent" as const, role: "owner" as const }]) {
      assert.throws(() => client.add(who, input), { code: "denied" });
      assert.throws(() => client.list(who), { code: "denied" });
      assert.throws(() => client.remove(who, "peer"), { code: "denied" });
    }
    const owner = { userId: "owner", kind: "person" as const, role: "owner" as const };
    const added = client.add(owner, input);
    assert.equal(added.state, "pending"); assert.equal(client.hasAgent("a2a:peer"), false);
    assert.equal(client.target.accepts("a2a:peer"), true);
    assert.equal(client.target.accepts("main"), false);
    assert.equal(client.list(owner).length, 1);
  } finally { client.close(); store.close(); }
});

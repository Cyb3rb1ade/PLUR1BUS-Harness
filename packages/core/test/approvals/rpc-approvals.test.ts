import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PRINCIPAL, OTHER_PERSON, PERSON, refused, rpcRig } from "./rpc-helpers.ts";
import { DAY, MIN, raw, tick } from "./service-helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 20_000 };

describe("approval.list and approval.get", () => {
  it("shows the pending queue with everything a person needs to decide, and never the nonce or the raw arguments", T, async () => {
    const r = await rpcRig();
    const { id, nonce } = await r.park({ args: { path: abs("/outside/dir/a.txt"), token: "sk-live-0123456789abcdefghijkl" }, targets: [abs("/outside/dir/a.txt")] });
    const list = await r.call("approval.list", { status: "pending" });
    assert.equal(list.approvals.length, 1);
    const a = list.approvals[0];
    assert.equal(a.id, id);
    assert.equal(a.status, "pending");
    assert.equal(a.capability, "fs.read");
    assert.equal(a.principal, "christian");
    assert.deepEqual(a.subject, { kind: "agent", id: "bernd" });
    assert.equal(a.actionHash, "ab".padEnd(64, "0"));
    assert.deepEqual(a.targets, [abs("/outside/dir/a.txt")]);
    assert.equal(a.createdAt, new Date(r.clock.now()).toISOString());
    assert.equal(a.expiresAt, new Date(r.clock.now() + DAY).toISOString());
    assert.equal(a.delegable, false);
    assert.equal(typeof a.summary, "string");
    assert.ok(!JSON.stringify(list).includes(nonce), "the nonce must not leave the core");
    assert.ok(!JSON.stringify(list).includes("sk-live-0123456789abcdefghijkl"), "a secret in the arguments must not leave the core");
    assert.ok(!("cancelledAt" in a) && !("flags" in a) && !("effect" in a));
    assert.deepEqual(await r.call("approval.get", { id }), a);
    r.service.dispose();
  });

  it("filters by status and agent, newest first, pages with a bound cursor", T, async () => {
    const r = await rpcRig();
    const mk = async (agentId: string, h: string) => { const p = await r.park({ agentId, actionHash: h.padEnd(64, "0") }); r.clock.advance(MIN); return p.id; };
    const a = await mk("bernd", "a1"); const b = await mk("other", "b1"); const c = await mk("bernd", "c1");
    assert.deepEqual((await r.call("approval.list")).approvals.map((x: any) => x.id), [c, b, a]);
    assert.deepEqual((await r.call("approval.list", { agent: "bernd" })).approvals.map((x: any) => x.id), [c, a]);
    assert.deepEqual((await r.call("approval.list", { status: "approved" })).approvals, []);
    const p1 = await r.call("approval.list", { limit: 2 });
    assert.deepEqual(p1.approvals.map((x: any) => x.id), [c, b]);
    const p2 = await r.call("approval.list", { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.approvals.map((x: any) => x.id), [a]);
    assert.equal(p2.nextCursor, undefined);
    assert.deepEqual(await refused(r.call("approval.list", { cursor: "x" })), { error: "E_INVALID_PARAMS", reason: "bad-cursor", detail: "cursor" });
    assert.deepEqual(await refused(r.call("approval.list", { limit: 2, cursor: p1.nextCursor, status: "pending" })), { error: "E_INVALID_PARAMS", reason: "bad-cursor", detail: "cursor" });
    r.service.dispose();
  });

  it("another person's request is invisible, exactly like an unknown id", T, async () => {
    const r = await rpcRig();
    const { id } = await r.park();
    r.who = OTHER_PERSON;
    assert.deepEqual((await r.call("approval.list")).approvals, []);
    assert.deepEqual(await refused(r.call("approval.get", { id })), { error: "E_NOT_FOUND" });
    assert.deepEqual(await refused(r.call("approval.get", { id: "apr_unknown" })), { error: "E_NOT_FOUND" });
    r.service.dispose();
  });
});

describe("approval.decide", () => {
  it("approve (default scope once): the waiting call is released, the record says approved, grant is null", T, async () => {
    const r = await rpcRig();
    const { id, answer } = await r.park();
    const out = await r.call("approval.decide", { id, decision: "approve" });
    assert.equal(out.approval.status, "approved");
    assert.equal(out.approval.decidedBy, "christian");
    assert.equal(out.approval.decisionSurface, 2);
    assert.equal(out.grant, null);
    assert.equal((await answer).approved, true);
    assert.ok(!r.audit.events.some((e) => JSON.stringify(e).includes("nonce")));
  });

  it("approve with a wider scope returns the grant that was created", T, async () => {
    const r = await rpcRig();
    const { id, answer } = await r.park();
    const out = await r.call("approval.decide", { id, decision: "approve", scope: "task", delegable: true });
    assert.equal(out.grant.scope, "task");
    assert.equal(out.grant.person, "christian");
    assert.equal(out.grant.createdBy, "christian");
    assert.equal(out.grant.surface, 2);
    assert.equal(out.grant.delegable, true);
    assert.equal(out.approval.delegable, true);
    assert.equal((await answer).scope, "task");
  });

  it("deny releases the call as not approved, with no grant", T, async () => {
    const r = await rpcRig();
    const { id, answer } = await r.park();
    const out = await r.call("approval.decide", { id, decision: "deny", scope: "always" });
    assert.equal(out.approval.status, "denied");
    assert.equal(out.grant, null);
    assert.equal((await answer).approved, false);
    assert.equal(r.stores.grants.inspect().length, 0);
  });

  it("the surface is derived and checked: T2 cannot approve a T3 request, an attested T3 connection can", T, async () => {
    const r = await rpcRig();
    const { id, answer } = await r.park({ capability: "money.spend", tool: "shop.buy", effect: "money", targets: [] });
    // A client cannot lift its own level: extra fields are ignored (and the schema forbids them).
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", surface: 3 }, { validate: false })), { error: "E_DENIED", reason: "surface-untrusted" });
    assert.equal((await r.call("approval.get", { id })).status, "pending");
    r.attestation = { kind: "desktop-app" };
    const out = await r.call("approval.decide", { id, decision: "approve" });
    assert.equal(out.approval.decisionSurface, 3);
    assert.equal((await answer).approved, true);
  });

  it("a scope the request does not offer is E_INVALID_PARAMS scope-unavailable", T, async () => {
    const r = await rpcRig();
    const { id } = await r.park({ capability: "pkg.change", tool: "pkg.install", effect: "local-destructive", targets: [] });
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", scope: "always" })), { error: "E_INVALID_PARAMS", reason: "scope-unavailable", detail: "scope" });
    assert.equal((await r.call("approval.get", { id })).status, "pending");
    r.service.dispose();
  });

  it("a nonce is optional over a session; when given it must match", T, async () => {
    const r = await rpcRig();
    const { id, nonce } = await r.park();
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve", nonce: "0".repeat(32) })), { error: "E_DENIED", reason: "approval-mismatch" });
    assert.equal((await r.call("approval.get", { id })).status, "pending");
    assert.equal((await r.call("approval.decide", { id, decision: "approve", nonce })).approval.status, "approved");
  });

  it("the first answer wins: a second decision is approval-used; after the TTL it is approval-expired", T, async () => {
    const r = await rpcRig();
    const first = await r.park();
    await r.call("approval.decide", { id: first.id, decision: "deny" });
    assert.deepEqual(await refused(r.call("approval.decide", { id: first.id, decision: "approve" })), { error: "E_DENIED", reason: "approval-used" });
    const second = await r.park({ actionHash: "b2".padEnd(64, "0") });
    r.timers.advance(DAY + MIN);
    await tick();
    assert.deepEqual(await refused(r.call("approval.decide", { id: second.id, decision: "approve" })), { error: "E_DENIED", reason: "approval-expired" });
  });

  it("an unknown id and another person's request are E_NOT_FOUND and stay pending", T, async () => {
    const r = await rpcRig();
    const { id } = await r.park();
    assert.deepEqual(await refused(r.call("approval.decide", { id: "apr_unknown", decision: "approve" })), { error: "E_NOT_FOUND" });
    r.who = OTHER_PERSON;
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve" })), { error: "E_NOT_FOUND" });
    r.who = PERSON;
    assert.equal((await r.call("approval.get", { id })).status, "pending");
    r.service.dispose();
  });
});

describe("approval.cancel and approval.verify", () => {
  it("cancel withdraws a pending request; the waiting call is released; a second cancel is E_CONFLICT", T, async () => {
    const r = await rpcRig();
    const { id, answer } = await r.park();
    const out = await r.call("approval.cancel", { id });
    assert.equal(out.status, "cancelled");
    assert.equal((await answer).approved, false);
    assert.deepEqual(await refused(r.call("approval.cancel", { id })), { error: "E_CONFLICT", reason: "not-pending" });
    assert.deepEqual(await refused(r.call("approval.cancel", { id: "apr_unknown" })), { error: "E_NOT_FOUND" });
    // The store treats a withdrawn request like one that can no longer be answered.
    assert.deepEqual(await refused(r.call("approval.decide", { id, decision: "approve" })), { error: "E_DENIED", reason: "approval-expired" });
  });

  it("another person cannot cancel: E_NOT_FOUND, still pending", T, async () => {
    const r = await rpcRig();
    const { id } = await r.park();
    r.who = OTHER_PERSON;
    assert.deepEqual(await refused(r.call("approval.cancel", { id })), { error: "E_NOT_FOUND" });
    r.who = PERSON;
    assert.equal((await r.call("approval.get", { id })).status, "pending");
    r.service.dispose();
  });

  it("verify reports the chain; a tampered chain is a finding, not an error", T, async () => {
    const r = await rpcRig();
    const empty = await r.call("approval.verify");
    assert.deepEqual(empty, { ok: true, entries: 0, head: null });
    const { id } = await r.park();
    await r.call("approval.decide", { id, decision: "approve" });
    const ok = await r.call("approval.verify");
    assert.equal(ok.ok, true);
    assert.ok(ok.entries >= 2);
    assert.match(ok.head.mac, /^[0-9a-f]{64}$/);
    const db = raw(r.path); // a second connection, as an attacker with the file would use; this one's cache sees its commit
    db.prepare("UPDATE approval_chain SET payload = payload || ' ' WHERE seq = 1").run();
    db.close();
    const bad = await r.call("approval.verify");
    assert.equal(bad.ok, false);
    assert.equal(typeof bad.brokenAt, "number");
    assert.equal(typeof bad.reason, "string");
    assert.ok(r.audit.events.some((e) => e.action === "approvals.integrity-failure"));
  });
});

describe("the approval handlers refuse every non-person", () => {
  for (const [name, params] of [
    ["approval.list", {}], ["approval.get", { id: "apr_x" }], ["approval.verify", {}],
    ["approval.decide", { id: "apr_x", decision: "approve" }], ["approval.cancel", { id: "apr_x" }],
  ] as const) {
    it(`${name}: an agent principal, one without a kind, and no principal`, T, async () => {
      const r = await rpcRig();
      const { id, answer } = await r.park();
      const p = name === "approval.get" || name === "approval.cancel" || name === "approval.decide" ? { ...params, id } : params;
      r.who = AGENT_PRINCIPAL;
      assert.deepEqual(await refused(r.call(name, p)), { error: "E_DENIED", reason: "agent-principal" });
      r.who = { userId: "christian", role: "owner" };
      assert.deepEqual(await refused(r.call(name, p)), { error: "E_DENIED", reason: "agent-principal" });
      r.who = null;
      assert.deepEqual(await refused(r.call(name, p)), { error: "E_UNAUTHORIZED", reason: "no-principal" });
      r.who = PERSON;
      assert.equal((await r.call("approval.get", { id })).status, "pending", "nothing was decided or cancelled");
      r.service.dispose();
      await answer;
    });
  }
});

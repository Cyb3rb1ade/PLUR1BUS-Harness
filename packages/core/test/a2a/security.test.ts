import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { authorizePeer, hashKey, resolvePeer, validatePeers } from "../../src/a2a/policy.ts";
import { A2A_ACTIONS } from "../../src/a2a/types.ts";
import { AGENTS, KEY_A, KEY_B, http, peers, rig, rpc, sendMsg } from "./helpers.ts";

const CARD = "/a2a/bernd/.well-known/agent-card.json";

describe("a2a-peer authentication (default deny)", () => {
  it("no credential, wrong key, wrong scheme, malformed header: 401 + challenge, nothing runs", async () => {
    const r = rig();
    for (const c of [{ key: null }, { key: "wrong-key-0123456789abcdef0123456789" }, { headers: { authorization: `Basic ${KEY_A}` }, key: null }, { headers: { authorization: "Bearer " }, key: null }, { headers: { authorization: `Bearer ${KEY_A} x` }, key: null }]) {
      const res = await http(r.h, { path: "/a2a/bernd/", body: { jsonrpc: "2.0", id: 1, method: "message/send", params: sendMsg("x") }, ...c });
      assert.equal(res.status, 401); assert.equal(res.headers["WWW-Authenticate"], "Bearer");
    }
    assert.equal((await http(r.h, { method: "GET", path: CARD, key: null })).status, 401);
    assert.equal(r.h.tasks.size, 0);
    assert.ok(r.audit.events.some((e) => e.action === "a2a.unauthenticated" && e.actor.user === "anonymous"));
  });
  it("401 does not reveal whether the agent exists", async () => {
    const r = rig();
    const a = await http(r.h, { method: "GET", path: CARD, key: null });
    const b = await http(r.h, { method: "GET", path: "/a2a/nobody/.well-known/agent-card.json", key: null });
    assert.deepEqual([a.status, a.body], [b.status, b.body]);
  });
  it("authenticated but not granted / not opted in / unknown agents are all the same 404", async () => {
    const r = rig();
    const codes = await Promise.all(["anna", "hidden", "nobody"].map(async (a) => { const x = await http(r.h, { path: `/a2a/${a}/`, body: { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "x" } } }); return [x.status, x.body]; }));
    assert.deepEqual(codes[0], codes[1]); assert.deepEqual(codes[1], codes[2]); assert.equal(codes[0]![0], 404);
    const reasons = r.audit.events.filter((e) => e.action === "a2a.denied").map((e) => e.detail.reason);
    assert.deepEqual(reasons, ["peer-not-granted-agent", "agent-not-exposed", "unknown-agent"]);
  });
  it("a granted agent but a missing action is 403 / invalid request, and is audited", async () => {
    const r = rig();
    // peer-b holds only card.read on bernd
    const res = await rpc(r.h, "message/send", sendMsg("x"), { key: KEY_B });
    assert.equal(res.json.error.code, -32600); assert.equal(res.json.error.data.reason, "forbidden");
    assert.equal(r.h.tasks.size, 0);
    assert.ok(r.audit.events.some((e) => e.action === "a2a.denied" && e.detail.reason === "action-not-granted" && e.actor.user === "a2a-peer:peer-b"));
  });
  it("an opt-out agent stays hidden even for a peer that lists it", async () => {
    const r = rig({ opts: { peers: [{ id: "p", keySha256: hashKey(KEY_A), grants: { hidden: [...A2A_ACTIONS] } }] } });
    assert.equal((await http(r.h, { method: "GET", path: "/a2a/hidden/.well-known/agent-card.json" })).status, 404);
  });
  it("an injected bearer verifier is the only credential check; a rejection never starts a turn", async () => {
    const r = rig({
      opts: {
        verifyBearer: (token) => token === KEY_A ? { kind: "a2a-peer", peerId: "peer-a" } : undefined,
      },
    });
    assert.equal((await http(r.h, { method: "GET", path: CARD, key: KEY_B })).status, 401);
    assert.equal((await http(r.h, { method: "GET", path: CARD, key: KEY_A })).status, 200);
    const denied = await rpc(r.h, "message/send", sendMsg("x"), { key: KEY_B });
    assert.equal(denied.status, 401);
    assert.equal(r.h.tasks.size, 0);
  });
  it("repeated failed authentication from one address is blocked before any key is compared", async () => {
    const r = rig({ opts: { limits: { failedAuthPerMinute: 3 } } });
    for (let i = 0; i < 3; i++) assert.equal((await http(r.h, { method: "GET", path: CARD, key: "bad-key-0123456789abcdef0123456789ab", remote: "10.0.0.9" })).status, 401);
    // even the right key is refused from that address now
    assert.equal((await http(r.h, { method: "GET", path: CARD, remote: "10.0.0.9" })).status, 429);
    // another address is unaffected, and the window refills
    assert.equal((await http(r.h, { method: "GET", path: CARD, remote: "10.0.0.8" })).status, 200);
    r.clock.advance(60_000);
    assert.equal((await http(r.h, { method: "GET", path: CARD, remote: "10.0.0.9" })).status, 200);
  });
});

describe("policy", () => {
  it("a peer table typo fails at start instead of granting", () => {
    const base = peers()[0]!;
    assert.throws(() => validatePeers([{ ...base, keySha256: "abc" }]), /64/);
    assert.throws(() => validatePeers([{ ...base, grants: { bernd: ["task.sned" as never] } }]), /unknown action/);
    assert.throws(() => validatePeers([base, { ...base, id: "other" }]), /shared/);
    assert.throws(() => validatePeers([base, { ...base, keySha256: hashKey("z") }]), /twice/);
    assert.throws(() => validatePeers([{ ...base, id: "bad id" }]), /invalid/);
    assert.throws(() => validatePeers([{ ...base, grants: { "../x": ["card.read"] } }]), /invalid/);
    assert.doesNotThrow(() => validatePeers(peers()));
  });
  it("resolvePeer matches by key hash only; authorizePeer is deny by default", () => {
    const ps = peers();
    assert.equal(resolvePeer(ps, KEY_A)?.peerId, "peer-a");
    assert.equal(resolvePeer(ps, KEY_A + "x"), undefined);
    assert.equal(resolvePeer(ps, ""), undefined);
    assert.equal(resolvePeer([], KEY_A), undefined);
    const a = resolvePeer(ps, KEY_A)!;
    assert.deepEqual(authorizePeer(ps, a, "task.send", "bernd", AGENTS.bernd), { effect: "allow" });
    assert.deepEqual(authorizePeer(ps, a, "task.send", "anna", AGENTS.anna), { effect: "deny", reason: "peer-not-granted-agent" });
    assert.deepEqual(authorizePeer(ps, a, "task.send", "__proto__", AGENTS.bernd), { effect: "deny", reason: "peer-not-granted-agent" });
    assert.deepEqual(authorizePeer([{ ...ps[0]!, grants: { bernd: [] } }], a, "task.send", "bernd", AGENTS.bernd), { effect: "deny", reason: "action-not-granted" });
    assert.deepEqual(authorizePeer(ps, a, "task.send", "x", undefined), { effect: "deny", reason: "unknown-agent" });
  });
  it("the a2a-peer is not a human role: nothing in the RBAC table mentions it", async () => {
    const { POLICY } = await import("../../src/rbac/policy.ts");
    assert.ok(!JSON.stringify(POLICY).includes("a2a"));
  });
});

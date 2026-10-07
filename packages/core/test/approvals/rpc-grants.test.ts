import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PRINCIPAL, OTHER_PERSON, PERSON, refused, rpcRig } from "./rpc-helpers.ts";
import { HOUR, MIN } from "./service-helpers.ts";
import { abs } from "../helpers/abs.ts";

const T = { timeout: 20_000 };
const create = (o: Record<string, unknown> = {}) => ({ capability: "fs.write", agent: "bernd", scope: "always", ...o });

describe("grant.create", () => {
  it("creates a standing grant for the calling person; the surface is derived, person and level in params are ignored", T, async () => {
    const r = await rpcRig();
    // The schema forbids `person` and `surface`; the handler must not honour them even when a client bypasses validation.
    const g = await r.call("grant.create", create({ scope: "session", sessionId: "s1", person: "mallory", surface: 3, createdBy: "mallory" }), { validate: false });
    assert.equal(g.person, "christian");
    assert.equal(g.createdBy, "christian");
    assert.equal(g.surface, 2);
    assert.equal(g.scope, "session");
    assert.equal(g.state, "active");
    assert.equal(g.capability, "fs.write");
    assert.equal(g.agent, "bernd");
    assert.deepEqual(g.match, { kind: "capability" });
    assert.equal(g.createdAt, new Date(r.clock.now()).toISOString());
    assert.equal(g.sessionId, "s1");
    assert.equal(g.delegable, false);
    assert.deepEqual(r.grantChanged.map((c) => [c.change, c.grant.id]), [["created", g.id]]);
    const line = r.audit.events.find((e) => e.action === "grant.created")!;
    assert.equal(line.actor.user, "christian");
    assert.equal(line.target, `grant:${g.id}`);
    assert.equal(line.detail.decisionSurface, 2);
  });

  it("a path match and an expiry are mapped to the store's shapes", T, async () => {
    const r = await rpcRig();
    const exp = new Date(r.clock.now() + 2 * HOUR).toISOString();
    const g = await r.call("grant.create", create({ capability: "fs.read", match: { kind: "path", path: abs("/work/notes"), access: "read", recursive: true }, expiresAt: exp }));
    assert.deepEqual(g.match, { kind: "path", path: abs("/work/notes"), access: "read", recursive: true });
    assert.equal(g.expiresAt, exp);
  });

  it("capability names are case-folded; a task grant takes its task id", T, async () => {
    const r = await rpcRig();
    const g = await r.call("grant.create", create({ capability: " FS.Read ", scope: "task", taskId: "t9", delegable: true }));
    assert.equal(g.capability, "fs.read");
    assert.equal(g.taskId, "t9");
    assert.equal(g.delegable, true);
  });

  it("refusals carry the documented reasons and create nothing", T, async () => {
    const r = await rpcRig();
    const e = async (params: Record<string, unknown>) => refused(r.call("grant.create", create(params)));
    assert.deepEqual(await e({ capability: "harness.admin" }), { error: "E_DENIED", reason: "policy-never" });
    assert.deepEqual(await e({ capability: "credential.entry", scope: "task", taskId: "t" }), { error: "E_DENIED", reason: "policy-never" });
    assert.deepEqual(await e({ capability: "policy.bypass" }), { error: "E_DENIED", reason: "policy-never" });
    assert.deepEqual(await e({ capability: "nope.nothing" }), { error: "E_INVALID_PARAMS", reason: "invalid-grant", detail: "capability" });
    assert.deepEqual(await e({ capability: "pkg.change" }), { error: "E_INVALID_PARAMS", reason: "ceiling-exceeded" });
    assert.deepEqual(await e({ capability: "sys.read" }), { error: "E_INVALID_PARAMS", reason: "ceiling-exceeded" });
    assert.deepEqual(await e({ capability: "fs.delete", scope: "session", sessionId: "s" }), { error: "E_INVALID_PARAMS", reason: "ceiling-exceeded" });
    assert.deepEqual(await e({ scope: "task" }), { error: "E_INVALID_PARAMS", reason: "invalid-grant" });
    assert.deepEqual(await e({ scope: "session" }), { error: "E_INVALID_PARAMS", reason: "invalid-grant" });
    assert.deepEqual(await e({ match: { kind: "action" } }), { error: "E_INVALID_PARAMS", reason: "invalid-grant" });
    assert.deepEqual(await e({ capability: "fs.read", match: { kind: "path", path: "relative/dir", access: "read", recursive: false } }), { error: "E_INVALID_PARAMS", reason: "invalid-grant" });
    assert.deepEqual(await e({ match: { kind: "path" } }), { error: "E_INVALID_PARAMS", reason: "invalid-grant", detail: "match" });
    assert.deepEqual(await e({ expiresAt: "not a date" }), { error: "E_INVALID_PARAMS", reason: "invalid-grant", detail: "expiresAt" });
    assert.deepEqual(await e({ agent: "ghost" }), { error: "E_AGENT_UNKNOWN", reason: "not-registered" });
    assert.equal(r.stores.grants.inspect().length, 0);
    assert.equal(r.grantChanged.length, 0);
  });

  it("the surface decides: T2 cannot create what needs T3, an attested T3 connection can", T, async () => {
    const r = await rpcRig();
    // os.grant needs T3 (minSurface); always-grants of fs.write for a path need T3 as well (outside roots, D109 §5).
    assert.deepEqual(await refused(r.call("grant.create", create({ capability: "os.grant" }))), { error: "E_DENIED", reason: "surface-untrusted" });
    assert.deepEqual(
      await refused(r.call("grant.create", create({ match: { kind: "path", path: abs("/elsewhere"), access: "write", recursive: true } }))),
      { error: "E_DENIED", reason: "surface-untrusted" },
    );
    assert.equal(r.stores.grants.inspect().length, 0);
    r.attestation = { kind: "desktop-app" };
    const g = await r.call("grant.create", create({ capability: "os.grant" }));
    assert.equal(g.surface, 3);
    assert.ok(await r.call("grant.create", create({ match: { kind: "path", path: abs("/elsewhere"), access: "write", recursive: true } })));
  });
});

describe("grant.list and grant.revoke", () => {
  it("lists the caller's grants newest first, filtered; another person's grants are not visible", T, async () => {
    const r = await rpcRig();
    const a = await r.call("grant.create", create({ capability: "fs.read" }));
    r.clock.advance(MIN);
    const b = await r.call("grant.create", create({ capability: "fs.write", agent: "other" }));
    r.clock.advance(MIN);
    r.who = OTHER_PERSON;
    const foreign = await r.call("grant.create", create({ capability: "fs.read" }));
    r.who = PERSON;
    assert.deepEqual((await r.call("grant.list")).grants.map((g: any) => g.id), [b.id, a.id]);
    assert.deepEqual((await r.call("grant.list", { agent: "bernd" })).grants.map((g: any) => g.id), [a.id]);
    assert.deepEqual((await r.call("grant.list", { capability: "fs.write" })).grants.map((g: any) => g.id), [b.id]);
    assert.deepEqual((await r.call("grant.list", { state: "revoked" })).grants, []);
    assert.ok(!JSON.stringify(await r.call("grant.list")).includes(foreign.id));
  });

  it("pages with a cursor that is bound to its filters", T, async () => {
    const r = await rpcRig();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { ids.unshift((await r.call("grant.create", create({ capability: "fs.read" }))).id); r.clock.advance(MIN); }
    const p1 = await r.call("grant.list", { limit: 2 });
    assert.deepEqual(p1.grants.map((g: any) => g.id), ids.slice(0, 2));
    assert.equal(typeof p1.nextCursor, "string");
    const p2 = await r.call("grant.list", { limit: 2, cursor: p1.nextCursor });
    assert.deepEqual(p2.grants.map((g: any) => g.id), ids.slice(2, 4));
    const p3 = await r.call("grant.list", { limit: 2, cursor: p2.nextCursor });
    assert.deepEqual(p3.grants.map((g: any) => g.id), ids.slice(4));
    assert.equal(p3.nextCursor, undefined);
    assert.deepEqual(await refused(r.call("grant.list", { limit: 2, cursor: "garbage" })), { error: "E_INVALID_PARAMS", reason: "bad-cursor", detail: "cursor" });
    assert.deepEqual(await refused(r.call("grant.list", { limit: 2, cursor: p1.nextCursor, agent: "bernd" })), { error: "E_INVALID_PARAMS", reason: "bad-cursor", detail: "cursor" });
  });

  it("revoke ends the grant at once, is idempotent, and is audited and announced once", T, async () => {
    const r = await rpcRig();
    const g = await r.call("grant.create", create());
    r.clock.advance(MIN);
    const done = await r.call("grant.revoke", { id: g.id });
    assert.equal(done.state, "revoked");
    assert.equal(done.revokedAt, new Date(r.clock.now()).toISOString());
    assert.equal(r.stores.grants.list({ person: "christian", agent: "bernd", capability: "fs.write" }).length, 0);
    r.clock.advance(MIN);
    assert.deepEqual(await r.call("grant.revoke", { id: g.id }), done);
    assert.deepEqual(r.grantChanged.map((c) => c.change), ["created", "revoked"]);
    assert.equal(r.audit.events.filter((e) => e.action === "grant.revoked").length, 1);
    assert.equal((await r.call("grant.list", { state: "revoked" })).grants.length, 1);
  });

  it("an unknown id and another person's grant are both E_NOT_FOUND", T, async () => {
    const r = await rpcRig();
    r.who = OTHER_PERSON;
    const foreign = await r.call("grant.create", create());
    r.who = PERSON;
    assert.deepEqual(await refused(r.call("grant.revoke", { id: "grt_unknown" })), { error: "E_NOT_FOUND" });
    assert.deepEqual(await refused(r.call("grant.revoke", { id: foreign.id })), { error: "E_NOT_FOUND" });
    assert.equal(r.stores.grants.inspect({ person: "anna" })[0]!.state, "active");
  });

  it("a consumed once grant is returned unchanged by revoke", T, async () => {
    const r = await rpcRig();
    const { id, nonce, answer } = await r.park();
    r.who = PERSON;
    await r.call("approval.decide", { id, decision: "approve", nonce });
    const a = await answer;
    assert.ok(r.stores.grants.consumeOnce(a.grantIds[0], { person: "christian", agent: "bernd", actionHash: "ab".padEnd(64, "0") }));
    const out = await r.call("grant.revoke", { id: a.grantIds[0] });
    assert.equal(out.state, "consumed");
    assert.equal(out.scope, "once");
  });
});

describe("the grant handlers refuse every non-person", () => {
  for (const [name, params] of [
    ["grant.list", {}], ["grant.create", create()], ["grant.revoke", { id: "grt_x" }],
  ] as const) {
    it(`${name}: an agent principal, one without a kind, and no principal`, T, async () => {
      const r = await rpcRig();
      r.who = AGENT_PRINCIPAL;
      assert.deepEqual(await refused(r.call(name, params)), { error: "E_DENIED", reason: "agent-principal" });
      r.who = { userId: "christian", role: "owner" };
      assert.deepEqual(await refused(r.call(name, params)), { error: "E_DENIED", reason: "agent-principal" });
      r.who = null;
      assert.deepEqual(await refused(r.call(name, params)), { error: "E_UNAUTHORIZED", reason: "no-principal" });
      assert.equal(r.stores.grants.inspect().length, 0);
    });
  }
});

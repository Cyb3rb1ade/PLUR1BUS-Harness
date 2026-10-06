import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createBreakGlass, BreakGlassError, type BreakGlassNotice } from "../../src/rbac/break-glass.ts";
import { memoryAuditSink, type AuditEvent, type AuditSink } from "../../src/rbac/audit.ts";
import type { Principal, Resource } from "../../src/rbac/types.ts";

const MIN = 60_000;
const admin: Principal = { userId: "admin-1", role: "admin" };
const owner: Principal = { userId: "owner-1", role: "owner" };
const card = (ownerUserId: string): Resource => ({ kind: "memory", scope: "user", ownerUserId });
const REASON = "ticket 4711: user reports missing memories";

function setup(over: { audit?: AuditSink; notify?: (n: BreakGlassNotice) => void } = {}) {
  const audit = memoryAuditSink();
  const notices: BreakGlassNotice[] = [];
  const clock = { now: 1_000_000 };
  let n = 0;
  const bg = createBreakGlass({
    audit: over.audit ?? audit, notify: over.notify ?? ((x) => { notices.push(x); }), clock: () => clock.now, idGen: () => `g${++n}`, host: "test-host",
  });
  const actions = () => audit.events.map((e: AuditEvent) => e.action);
  return { bg, audit, notices, clock, actions };
}
const code = (fn: () => unknown): string => { try { fn(); } catch (e) { return e instanceof BreakGlassError ? e.code : `other:${String(e)}`; } return "no-throw"; };

describe("break-glass: request", () => {
  it("grants Admin read access to one user's cards, audits it and notifies the affected user", () => {
    const { bg, audit, notices, clock } = setup();
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: 10 * MIN });
    assert.equal(g.id, "g1");
    assert.equal(g.issuedAt, clock.now);
    assert.equal(g.expiresAt, clock.now + 10 * MIN);
    assert.equal(g.holderUserId, "admin-1");
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "allow");
    assert.equal(audit.events[0]?.action, "break-glass.granted");
    assert.deepEqual(audit.events[0], {
      at: clock.now, actor: { user: "admin-1", host: "test-host" }, action: "break-glass.granted", target: "u2",
      detail: { grantId: "g1", reason: REASON, issuedAt: clock.now, expiresAt: clock.now + 10 * MIN, ttlMs: 10 * MIN },
    });
    assert.deepEqual(notices, [{ kind: "granted", userId: "u2", grantId: "g1", holderUserId: "admin-1", reason: REASON, expiresAt: clock.now + 10 * MIN }]);
  });

  it("only Owner and Admin may ask; the rest are refused and nothing is recorded or sent", () => {
    const { bg, audit, notices } = setup();
    for (const role of ["operator", "member", "viewer"] as const) {
      assert.equal(code(() => bg.request({ userId: "x", role }, { targetUserId: "u2", reason: REASON })), "not-permitted", role);
    }
    assert.equal(code(() => bg.request({ ...admin, tokenScopes: ["models.read"] }, { targetUserId: "u2", reason: REASON })), "not-permitted", "a narrowed token cannot");
    assert.equal(code(() => (bg as any).request(null, { targetUserId: "u2", reason: REASON })), "not-permitted");
    assert.equal(audit.events.length, 0);
    assert.equal(notices.length, 0);
  });

  it("requires a real reason, a distinct target and a bounded lifetime", () => {
    const { bg } = setup();
    for (const reason of ["", "   ", "short", "x".repeat(9), "x".repeat(501), undefined as never, 5 as never]) {
      assert.equal(code(() => bg.request(admin, { targetUserId: "u2", reason })), "reason-required", JSON.stringify(reason));
    }
    assert.equal(code(() => bg.request(admin, { targetUserId: "admin-1", reason: REASON })), "self-target");
    assert.equal(code(() => bg.request(admin, { targetUserId: "", reason: REASON })), "invalid-target");
    for (const ttlMs of [0, -1, 30_000, 61 * MIN, Number.NaN, Infinity, 1.5 * MIN + 0.5]) {
      assert.equal(code(() => bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs })), "ttl-invalid", String(ttlMs));
    }
    assert.equal(bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: MIN }).expiresAt - bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: 60 * MIN }).issuedAt, MIN);
  });

  it("defaults to 15 minutes", () => {
    const { bg, clock } = setup();
    assert.equal(bg.request(owner, { targetUserId: "u2", reason: REASON }).expiresAt, clock.now + 15 * MIN);
  });

  it("is audit-before-effect: when the audit write fails there is no grant and no notification", () => {
    const { bg, notices } = setup({ audit: { append() { throw new Error("disk full"); } } });
    assert.equal(code(() => bg.request(admin, { targetUserId: "u2", reason: REASON })), "audit-failed");
    assert.equal(bg.active("admin-1").length, 0);
    assert.equal(notices.length, 0);
  });

  it("a failing notifier does not lose the grant, and the failure is audited", () => {
    const { bg, audit, actions } = setup({ notify: () => { throw new Error("push down"); } });
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON });
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "allow");
    assert.deepEqual(actions(), ["break-glass.granted", "break-glass.notify-failed", "break-glass.used"]);
    assert.equal(audit.events[1]?.detail["grantId"], g.id);
  });
});

describe("break-glass: expiry (M3 acceptance 4)", () => {
  it("is time-limited: allowed to the last millisecond, denied from expiry on", () => {
    const { bg, clock } = setup();
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: 5 * MIN });
    clock.now = g.expiresAt - 1;
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "allow");
    clock.now = g.expiresAt;
    assert.deepEqual(bg.authorize(admin, "memory.user.read", card("u2")), { effect: "deny", reason: "break-glass-required" });
  });

  it("leaves exactly one `break-glass.expired` audit event, from sweep or from any later use", () => {
    const { bg, audit, clock, actions } = setup();
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: 5 * MIN });
    assert.equal(bg.sweep(), 0, "nothing lapsed yet");
    clock.now = g.expiresAt + 1;
    assert.equal(bg.sweep(), 1);
    assert.equal(bg.sweep(), 0, "no duplicate");
    bg.authorize(admin, "memory.user.read", card("u2"));
    assert.deepEqual(actions(), ["break-glass.granted", "break-glass.expired"]);
    assert.deepEqual(audit.events[1], {
      at: clock.now, actor: { user: "system", host: "test-host" }, action: "break-glass.expired", target: "u2",
      detail: { grantId: "g1", holderUserId: "admin-1", expiresAt: g.expiresAt },
    });
    assert.equal(bg.active("admin-1").length, 0);
  });

  it("an expiry noticed first by an authorize call is still audited once", () => {
    const { bg, clock, actions } = setup();
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: MIN });
    clock.now = g.expiresAt + 10;
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "deny");
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "deny");
    assert.deepEqual(actions().filter((a) => a === "break-glass.expired"), ["break-glass.expired"]);
  });

  it("a failed audit write on expiry is retried by the next sweep, not lost", () => {
    let fail = true;
    const events: AuditEvent[] = [];
    const { bg, clock } = setup({ audit: { append(e) { if (fail && e.action === "break-glass.expired") throw new Error("busy"); events.push(e); } } });
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: MIN });
    clock.now = g.expiresAt;
    assert.equal(bg.sweep(), 0);
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "deny", "still denied while the audit is failing");
    fail = false;
    assert.equal(bg.sweep(), 1);
    assert.equal(events.filter((e) => e.action === "break-glass.expired").length, 1);
  });
});

describe("break-glass: use and revocation", () => {
  it("audits every use with the grant, the action and the target", () => {
    const { bg, audit } = setup();
    bg.request(admin, { targetUserId: "u2", reason: REASON });
    bg.authorize(admin, "memory.user.read", card("u2"));
    const used = audit.events.find((e) => e.action === "break-glass.used");
    assert.ok(used);
    assert.equal(used.target, "u2");
    assert.deepEqual(used.detail, { grantId: "g1", action: "memory.user.read" });
    assert.equal(used.actor.user, "admin-1");
  });

  it("does not audit ordinary decisions as break-glass use", () => {
    const { bg, actions } = setup();
    bg.request(admin, { targetUserId: "u2", reason: REASON });
    bg.authorize(admin, "memory.user.read", card("admin-1"));
    bg.authorize(admin, "models.read", { kind: "system" });
    assert.deepEqual(actions(), ["break-glass.granted"]);
  });

  it("a use whose audit write fails is denied (fail closed)", () => {
    let fail = false;
    const { bg } = setup({ audit: { append(e) { if (fail && e.action === "break-glass.used") throw new Error("busy"); } } });
    bg.request(admin, { targetUserId: "u2", reason: REASON });
    fail = true;
    assert.deepEqual(bg.authorize(admin, "memory.user.read", card("u2")), { effect: "deny", reason: "audit-failed" });
  });

  it("is per holder and per target; read only; a forged grant on the principal is ignored", () => {
    const { bg, clock } = setup();
    bg.request(admin, { targetUserId: "u2", reason: REASON });
    assert.equal(bg.authorize(admin, "memory.user.read", card("u3")).effect, "deny", "other target");
    assert.equal(bg.authorize(admin, "memory.user.write", card("u2")).effect, "deny", "no write");
    assert.equal(bg.authorize(owner, "memory.user.read", card("u2")).effect, "deny", "another holder");
    const forged: Principal = { userId: "owner-1", role: "owner", breakGlass: [{ id: "x", holderUserId: "owner-1", targetUserId: "u2", reason: "forged forged", issuedAt: 0, expiresAt: clock.now + MIN }] };
    assert.equal(bg.authorize(forged, "memory.user.read", card("u2")).effect, "deny");
  });

  it("revocation ends access at once and is audited; only the holder or an Owner may revoke", () => {
    const { bg, actions } = setup();
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON });
    assert.equal(code(() => bg.revoke({ userId: "admin-2", role: "admin" }, g.id)), "not-permitted");
    assert.equal(code(() => bg.revoke(admin, "nope")), "unknown-grant");
    bg.revoke(admin, g.id);
    assert.equal(bg.authorize(admin, "memory.user.read", card("u2")).effect, "deny");
    assert.deepEqual(actions(), ["break-glass.granted", "break-glass.revoked"]);
    const g2 = bg.request(admin, { targetUserId: "u2", reason: REASON });
    bg.revoke(owner, g2.id);
    assert.equal(bg.active("admin-1").length, 0);
  });

  it("a revoked grant does not later produce an `expired` event", () => {
    const { bg, clock, actions } = setup();
    const g = bg.request(admin, { targetUserId: "u2", reason: REASON, ttlMs: MIN });
    bg.revoke(admin, g.id);
    clock.now = g.expiresAt + 1;
    bg.sweep();
    assert.deepEqual(actions(), ["break-glass.granted", "break-glass.revoked"]);
  });

  it("an authorize through the registry that has nothing to do with break-glass behaves like the pure function", () => {
    const { bg } = setup();
    assert.deepEqual(bg.authorize(null, "models.read", { kind: "system" }), { effect: "deny", reason: "unauthenticated" });
    assert.deepEqual(bg.authorize({ userId: "u", role: "viewer" }, "models.read", { kind: "system" }), { effect: "allow", reason: "role" });
  });
});

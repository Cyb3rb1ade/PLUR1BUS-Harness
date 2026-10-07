import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { DEFAULT_SESSION_LIMITS, OWNER, ownerTokenVerifier, readCookie, SessionStore } from "../src/session.ts";

const limits = { ...DEFAULT_SESSION_LIMITS, idleMs: 1000, absoluteMs: 5000, maxSessions: 2, csrfTtlMs: 1000, maxCsrfPerSession: 2 };

test("a session lives until its idle timer runs out, each use pushes it out, the absolute limit is final", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const { id } = s.create(OWNER);
  clock.advance(900); assert.ok(s.get(id));
  clock.advance(900); assert.ok(s.get(id));
  clock.advance(900); assert.ok(s.get(id));
  clock.advance(900); assert.ok(s.get(id));
  clock.advance(900); assert.ok(s.get(id));
  clock.advance(900); assert.equal(s.get(id), undefined); // 5400 ms in: past the 5000 ms absolute limit although used 900 ms ago
  assert.equal(s.size, 0);
});

test("an idle session expires", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const { id } = s.create(OWNER);
  clock.advance(1000); assert.equal(s.get(id), undefined);
});

test("unknown, empty and destroyed ids are not sessions", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const { id } = s.create(OWNER);
  assert.equal(s.get(undefined), undefined); assert.equal(s.get(""), undefined); assert.equal(s.get(id + "x"), undefined);
  assert.equal(s.destroy(id), true); assert.equal(s.get(id), undefined); assert.equal(s.destroy(id), false);
});

test("the session count is capped by dropping the oldest", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const a = s.create(OWNER); const b = s.create(OWNER); const c = s.create(OWNER);
  assert.equal(s.get(a.id), undefined); assert.ok(s.get(b.id)); assert.ok(s.get(c.id));
});

test("a CSRF token works once, only for its own session, and expires", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const a = s.create(OWNER); const b = s.create(OWNER);
  const t = s.issueCsrf(a.id)!;
  assert.equal(s.consumeCsrf(b.id, t.token), false, "bound to the session");
  assert.equal(s.consumeCsrf(a.id, "nope"), false);
  assert.equal(s.consumeCsrf(a.id, undefined), false);
  assert.equal(s.consumeCsrf(a.id, t.token), true);
  assert.equal(s.consumeCsrf(a.id, t.token), false, "one-time");
  const u = s.issueCsrf(a.id)!; clock.advance(1);
  assert.equal(s.consumeCsrf(a.id, u.token), true);
  const w = s.issueCsrf(a.id)!; clock.advance(500); s.get(a.id); clock.advance(600);
  assert.equal(s.consumeCsrf(a.id, w.token), false, "expired");
});

test("only the newest CSRF tokens stay valid", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const { id } = s.create(OWNER);
  const t1 = s.issueCsrf(id)!; const t2 = s.issueCsrf(id)!; const t3 = s.issueCsrf(id)!;
  assert.equal(s.consumeCsrf(id, t1.token), false); assert.equal(s.consumeCsrf(id, t2.token), true); assert.equal(s.consumeCsrf(id, t3.token), true);
});

test("the owner verifier accepts exactly the owner token", () => {
  const token = "a".repeat(64); const v = ownerTokenVerifier(token);
  assert.equal(v(token), true);
  for (const bad of ["", "a".repeat(63), "a".repeat(65), "b".repeat(64), undefined, null, 1, {}, "a".repeat(10_000)]) assert.equal(v(bad), false);
  assert.throws(() => ownerTokenVerifier("short"));
});

test("readCookie returns the first matching cookie only", () => {
  assert.equal(readCookie("a=1; plur1bus_session=abc; b=2", "plur1bus_session"), "abc");
  assert.equal(readCookie("plur1bus_session=one; plur1bus_session=two", "plur1bus_session"), "one");
  assert.equal(readCookie(undefined, "x"), undefined); assert.equal(readCookie("xplur1bus_session=1", "plur1bus_session"), undefined);
});

const ALICE = Object.freeze({ kind: "user", id: "u-alice", role: "member" } as const);

test("rotate gives the session a new cookie value: the old one dies, the lifetime is not extended, pending CSRF tokens are dropped", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, limits);
  const { id, session } = s.create(ALICE, { authVersion: 3 });
  const t = s.issueCsrf(id)!;
  clock.advance(800);
  const r = s.rotate(id)!;
  assert.notEqual(r.id, id); assert.equal(s.get(id), undefined, "the old value is dead");
  assert.equal(r.session.absoluteExpiresAt, session.absoluteExpiresAt, "no new lifetime");
  assert.equal(r.session.authVersion, 3);
  assert.equal(s.consumeCsrf(r.id, t.token), false, "a CSRF token does not move with the rotation");
  assert.equal(s.rotate("unknown"), undefined); assert.equal(s.rotate(undefined), undefined);
  assert.equal(s.size, 1);
});

test("markRotate flags only the principal's sessions; rotation clears the flag", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, { ...limits, maxSessions: 8 });
  const a1 = s.create(ALICE); const a2 = s.create(ALICE); const o = s.create(OWNER);
  assert.equal(s.markRotate(ALICE.id), 2);
  assert.equal(s.get(a1.id)!.mustRotate, true); assert.equal(s.get(a2.id)!.mustRotate, true); assert.equal(s.get(o.id)!.mustRotate, false);
  const r = s.rotate(a1.id)!; assert.equal(r.session.mustRotate, false);
});

test("destroyAllFor ends every session of one principal and no other", () => {
  const clock = new FakeClock(); const s = new SessionStore(clock, { ...limits, maxSessions: 8 });
  const a1 = s.create(ALICE); const a2 = s.create(ALICE); const o = s.create(OWNER);
  assert.equal(s.countFor(ALICE.id), 2);
  assert.equal(s.destroyAllFor(ALICE.id), 2);
  assert.equal(s.get(a1.id), undefined); assert.equal(s.get(a2.id), undefined); assert.ok(s.get(o.id));
  assert.equal(s.destroyAllFor(ALICE.id), 0); assert.equal(s.countFor(ALICE.id), 0);
});

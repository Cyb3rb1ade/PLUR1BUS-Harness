import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/clock.ts";
import { NoticeInbox } from "../src/notices.ts";
import type { BreakGlassNotice } from "../src/rbac-bridge.ts";

const notice = (grantId: string, userId = "u1", extra: Partial<BreakGlassNotice> = {}): BreakGlassNotice => ({
  kind: "granted", userId, grantId, holderUserId: "holder-1", reason: "incident", expiresAt: 5_000, ...extra,
});

describe("NoticeInbox.add", () => {
  it("copies the grant fields and stamps the notice with the clock time at add", () => {
    const clock = new FakeClock(1_000);
    const inbox = new NoticeInbox(clock);
    inbox.add(notice("g1", "u1", { reason: "disk full", expiresAt: 9_999, holderUserId: "h-9" }));
    clock.advance(250);
    inbox.add(notice("g2"));
    const [newest, oldest] = inbox.list("u1");
    assert.deepEqual(oldest, { kind: "break-glass.granted", grantId: "g1", holderUserId: "h-9", reason: "disk full", at: 1_000, expiresAt: 9_999 });
    assert.equal(newest?.at, 1_250, "the timestamp is taken when the notice is added, not when it is listed");
  });

  it("keeps Unicode and empty reasons verbatim", () => {
    const inbox = new NoticeInbox(new FakeClock());
    inbox.add(notice("g1", "u1", { reason: "Notfall: Zugriff auf Karten – 紧急 🚨" }));
    inbox.add(notice("g2", "u1", { reason: "" }));
    assert.deepEqual(inbox.list("u1").map((n) => n.reason), ["", "Notfall: Zugriff auf Karten – 紧急 🚨"]);
  });

  it("re-adding for a user refreshes that user to the most recent slot without touching other users", () => {
    const inbox = new NoticeInbox(new FakeClock(), 10, 2);
    inbox.add(notice("a1", "alice"));
    inbox.add(notice("b1", "bob"));
    inbox.add(notice("a2", "alice"));
    assert.deepEqual(inbox.list("alice").map((n) => n.grantId), ["a2", "a1"]);
    assert.deepEqual(inbox.list("bob").map((n) => n.grantId), ["b1"]);
  });
});

describe("NoticeInbox per-user bound", () => {
  it("drops the oldest notices once the per-user limit is reached", () => {
    const inbox = new NoticeInbox(new FakeClock(), 2);
    for (const id of ["g1", "g2", "g3", "g4", "g5"]) inbox.add(notice(id));
    assert.deepEqual(inbox.list("u1").map((n) => n.grantId), ["g5", "g4"]);
  });

  it("with a limit of zero keeps nothing for the user", () => {
    const inbox = new NoticeInbox(new FakeClock(), 0);
    inbox.add(notice("g1"));
    inbox.add(notice("g2"));
    assert.deepEqual(inbox.list("u1"), []);
  });

  it("applies the documented defaults: 50 notices per user", () => {
    const inbox = new NoticeInbox(new FakeClock());
    for (let i = 0; i < 60; i++) inbox.add(notice(`g${i}`));
    const listed = inbox.list("u1");
    assert.equal(listed.length, 50);
    assert.equal(listed[0]?.grantId, "g59");
    assert.equal(listed[49]?.grantId, "g10");
  });
});

describe("NoticeInbox user bound", () => {
  it("evicts the least recently added user when the user limit is exceeded", () => {
    const inbox = new NoticeInbox(new FakeClock(), 5, 2);
    inbox.add(notice("a", "u-a"));
    inbox.add(notice("b", "u-b"));
    inbox.add(notice("c", "u-c"));
    assert.deepEqual(inbox.list("u-a"), [], "the first user is gone");
    assert.deepEqual(inbox.list("u-b").map((n) => n.grantId), ["b"]);
    assert.deepEqual(inbox.list("u-c").map((n) => n.grantId), ["c"]);
  });

  it("a user who gets a new notice is protected from eviction ahead of an idle user", () => {
    const inbox = new NoticeInbox(new FakeClock(), 5, 2);
    inbox.add(notice("a1", "u-a"));
    inbox.add(notice("b1", "u-b"));
    inbox.add(notice("a2", "u-a"));
    inbox.add(notice("c1", "u-c"));
    assert.deepEqual(inbox.list("u-b"), [], "u-b was the idle one and is evicted");
    assert.deepEqual(inbox.list("u-a").map((n) => n.grantId), ["a2", "a1"]);
  });

  it("with a user limit of one only the latest user is kept", () => {
    const inbox = new NoticeInbox(new FakeClock(), 5, 1);
    inbox.add(notice("a", "u-a"));
    inbox.add(notice("b", "u-b"));
    assert.deepEqual(inbox.list("u-a"), []);
    assert.deepEqual(inbox.list("u-b").map((n) => n.grantId), ["b"]);
  });

  it("the default user limit of 1000 holds: user 1001 pushes out user 0 only", () => {
    const inbox = new NoticeInbox(new FakeClock());
    for (let i = 0; i <= 1000; i++) inbox.add(notice(`g${i}`, `user-${i}`));
    assert.deepEqual(inbox.list("user-0"), []);
    assert.equal(inbox.list("user-1")[0]?.grantId, "g1");
    assert.equal(inbox.list("user-1000")[0]?.grantId, "g1000");
  });
});

describe("NoticeInbox.list", () => {
  it("returns an empty list for a user with no notices", () => {
    assert.deepEqual(new NoticeInbox(new FakeClock()).list("nobody"), []);
  });

  it("returns a copy: changing the returned array does not change the inbox", () => {
    const inbox = new NoticeInbox(new FakeClock());
    inbox.add(notice("g1"));
    const first = inbox.list("u1");
    first.length = 0;
    first.push({ kind: "break-glass.granted", grantId: "forged", holderUserId: "x", reason: "x", at: 0, expiresAt: 0 });
    assert.deepEqual(inbox.list("u1").map((n) => n.grantId), ["g1"]);
  });

  it("treats user ids as exact strings", () => {
    const inbox = new NoticeInbox(new FakeClock());
    inbox.add(notice("g1", "User-1"));
    assert.deepEqual(inbox.list("user-1"), []);
    assert.deepEqual(inbox.list(""), []);
  });
});

// UNKLAR: maxUsers below zero (for example -1) is not validated. The eviction loop then finds no first key and breaks, so
// the inbox ends up empty. Whether a negative limit should be rejected or clamped to zero is not specified, so no
// expectation is asserted here.
it.skip("UNKLAR: a negative maxUsers is rejected or clamped to zero", () => {
  const inbox = new NoticeInbox(new FakeClock(), 5, -1);
  inbox.add(notice("a", "u-a"));
  assert.deepEqual(inbox.list("u-a"), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { InboxStore, INBOX_KINDS, InboxError, migrateBreakglassNotices, type InboxDraft } from "../../src/inbox/index.ts";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const DAY = 86_400_000;
const draft = (over: Partial<InboxDraft> = {}): InboxDraft => ({
  userId: "alice", kind: "approval", severity: "info", titleKey: "inbox.approval.requested",
  params: { agent: "main" }, ref: { route: "/approvals", objectId: "a1" }, dedupeKey: "approval:a1", ...over,
});
function fixture(o: { maxAgeMs?: number; maxEntries?: number } = {}) {
  let now = 1_000_000;
  const store = new InboxStore({ path: ":memory:", clock: () => now, ...o });
  return { store, tick: (ms: number) => { now += ms; }, now: () => now };
}

test("the kind set is closed and has exactly the eight documented kinds", () => {
  assert.deepEqual([...INBOX_KINDS], ["breakglass", "approval", "job-failed", "update", "media-index", "pairing", "channel", "system"]);
  const { store } = fixture();
  assert.throws(() => store.publish(draft({ kind: "other" as never })), (e: unknown) => e instanceof InboxError && e.code === "invalid");
  assert.throws(() => store.publish(draft({ severity: "loud" as never })), InboxError);
  store.close();
});

test("publish stores metadata only and returns the entry", () => {
  const { store, now } = fixture();
  const r = store.publish(draft());
  assert.equal(r.created, true);
  const [e] = store.list("alice", {}).entries;
  assert.deepEqual(e, { id: r.id, kind: "approval", severity: "info", titleKey: "inbox.approval.requested", params: { agent: "main" }, ref: { route: "/approvals", objectId: "a1" }, createdAt: now(), readAt: null, dismissedAt: null });
  store.close();
});

test("publishing the same dedupeKey twice yields exactly one entry (idempotent)", () => {
  const { store } = fixture();
  const a = store.publish(draft()), b = store.publish(draft());
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.id, a.id);
  assert.equal(store.list("alice", {}).entries.length, 1);
  // another person with the same key is a separate entry
  assert.equal(store.publish(draft({ userId: "bob" })).created, true);
  store.close();
});

test("a re-published entry does not resurrect a read or dismissed one", () => {
  const { store } = fixture();
  const { id } = store.publish(draft());
  store.dismiss("alice", [id]);
  store.publish(draft());
  assert.equal(store.list("alice", {}).entries.length, 0);
  assert.equal(store.list("alice", { includeDismissed: true }).entries.length, 1);
  store.close();
});

test("entries are scoped to their person", () => {
  const { store } = fixture();
  const { id } = store.publish(draft({ userId: "alice" }));
  store.publish(draft({ userId: "bob", dedupeKey: "approval:b1" }));
  assert.equal(store.list("bob", {}).entries.length, 1);
  assert.equal(store.markRead("bob", [id]), 0, "bob cannot touch alice's entry");
  assert.equal(store.dismiss("bob", [id]), 0);
  assert.equal(store.list("alice", {}).entries[0]!.readAt, null);
  store.close();
});

test("list filters by kind and unread, newest first", () => {
  const { store, tick } = fixture();
  const ids: string[] = [];
  for (const [i, kind] of (["approval", "channel", "approval"] as const).entries()) { tick(10); ids.push(store.publish(draft({ kind, dedupeKey: `k${i}` })).id); }
  assert.deepEqual(store.list("alice", {}).entries.map(e => e.id), [ids[2], ids[1], ids[0]]);
  assert.deepEqual(store.list("alice", { kinds: ["channel"] }).entries.map(e => e.id), [ids[1]]);
  store.markRead("alice", [ids[2]!]);
  assert.deepEqual(store.list("alice", { unreadOnly: true }).entries.map(e => e.id), [ids[1], ids[0]]);
  store.close();
});

test("cursor pages without gaps or duplicates, even when entries arrive between pages", () => {
  const { store, tick } = fixture();
  for (let i = 0; i < 7; i++) { tick(1); store.publish(draft({ dedupeKey: `k${i}` })); }
  const p1 = store.list("alice", { limit: 3 });
  assert.equal(p1.entries.length, 3);
  assert.ok(p1.nextCursor);
  store.publish(draft({ dedupeKey: "late" }));
  const p2 = store.list("alice", { limit: 3, cursor: p1.nextCursor! });
  const p3 = store.list("alice", { limit: 3, cursor: p2.nextCursor! });
  assert.equal(p3.nextCursor, undefined);
  const all = [...p1.entries, ...p2.entries, ...p3.entries].map(e => e.id);
  assert.equal(all.length, 7);
  assert.equal(new Set(all).size, 7);
  store.close();
});

test("a malformed cursor is a typed error", () => {
  const { store } = fixture();
  for (const cursor of ["", "nope", "!!!", Buffer.from("-1").toString("base64url"), Buffer.from("1.5").toString("base64url")])
    assert.throws(() => store.list("alice", { cursor }), (e: unknown) => e instanceof InboxError && e.code === "cursor");
  store.close();
});

test("count reports unread per kind with every kind present (badge input)", () => {
  const { store } = fixture();
  const a = store.publish(draft({ dedupeKey: "1" })).id;
  store.publish(draft({ dedupeKey: "2", kind: "channel" }));
  store.publish(draft({ dedupeKey: "3", kind: "channel" }));
  const c = store.count("alice");
  assert.deepEqual(Object.keys(c.unread), [...INBOX_KINDS]);
  assert.equal(c.unread.approval, 1);
  assert.equal(c.unread.channel, 2);
  assert.equal(c.unread.pairing, 0);
  assert.equal(c.total, 3);
  store.markRead("alice", [a]);
  assert.equal(store.count("alice").unread.approval, 0);
  store.dismiss("alice", [store.list("alice", { kinds: ["channel"] }).entries[0]!.id]);
  assert.equal(store.count("alice").unread.channel, 1, "dismissed entries do not count");
  store.close();
});

test("markRead 'all' marks every visible unread entry of the person only, and keeps the first read time", () => {
  const { store, tick } = fixture();
  store.publish(draft({ dedupeKey: "1" })); store.publish(draft({ dedupeKey: "2" }));
  store.publish(draft({ userId: "bob", dedupeKey: "3" }));
  assert.equal(store.markRead("alice", "all"), 2);
  const first = store.list("alice", {}).entries[0]!.readAt;
  tick(500);
  assert.equal(store.markRead("alice", "all"), 0);
  assert.equal(store.list("alice", {}).entries[0]!.readAt, first);
  assert.equal(store.count("bob").total, 1);
  assert.equal(store.count("bob").unread.approval, 1);
  store.close();
});

test("settle closes an entry by dedupe key (read + dismissed) and is a no-op when absent", () => {
  const { store } = fixture();
  store.publish(draft());
  assert.equal(store.settle("alice", "approval:a1"), true);
  assert.equal(store.settle("alice", "approval:a1"), false);
  assert.equal(store.settle("alice", "approval:zzz"), false);
  assert.equal(store.count("alice").total, 0);
  store.close();
});

test("retention: entries older than maxAgeMs are removed", () => {
  const { store, tick } = fixture({ maxAgeMs: 90 * DAY });
  store.publish(draft({ dedupeKey: "old" }));
  tick(91 * DAY);
  store.publish(draft({ dedupeKey: "new" }));
  assert.deepEqual(store.list("alice", { includeDismissed: true }).entries.map(e => e.params), [{ agent: "main" }]);
  assert.equal(store.list("alice", { includeDismissed: true }).entries.length, 1);
  store.close();
});

test("retention: only the newest maxEntries per person survive; other people are unaffected", () => {
  const { store, tick } = fixture({ maxEntries: 5 });
  for (let i = 0; i < 9; i++) { tick(1); store.publish(draft({ dedupeKey: `a${i}`, params: { n: i } })); }
  store.publish(draft({ userId: "bob", dedupeKey: "b" }));
  const mine = store.list("alice", { includeDismissed: true, limit: 100 }).entries;
  assert.deepEqual(mine.map(e => e.params.n), [8, 7, 6, 5, 4]);
  assert.equal(store.list("bob", {}).entries.length, 1);
  store.close();
});

test("defaults are 90 days and 1000 entries, and bad limits are rejected", () => {
  const { store } = fixture();
  assert.deepEqual(store.retention, { maxAgeMs: 90 * DAY, maxEntries: 1000 });
  store.close();
  assert.throws(() => new InboxStore({ path: ":memory:", clock: Date.now, maxEntries: 0 }), InboxError);
  assert.throws(() => new InboxStore({ path: ":memory:", clock: Date.now, maxAgeMs: -1 }), InboxError);
});

test("entries survive a restart (persisted on disk) and the file is not world-readable", async () => {
  const dir = await tempDir("inbox-");
  const path = join(dir, "state", "inbox.sqlite");
  const a = new InboxStore({ path, clock: () => 5 });
  const { id } = a.publish(draft());
  a.markRead("alice", [id]);
  a.close();
  const b = new InboxStore({ path, clock: () => 6 });
  const [e] = b.list("alice", {}).entries;
  assert.equal(e!.id, id);
  assert.equal(e!.readAt, 5);
  assert.equal(b.publish(draft()).created, false, "dedupe survives the restart");
  b.close();
  if (process.platform !== "win32") assert.equal((await import("node:fs")).statSync(path).mode & 0o077, 0);
});

test("a failed batch rolls back completely (atomic writes)", () => {
  const { store } = fixture();
  const a = store.publish(draft({ dedupeKey: "1" })).id;
  assert.throws(() => store.markRead("alice", [a, 42 as never]), InboxError);
  assert.equal(store.list("alice", {}).entries[0]!.readAt, null);
  store.close();
});

test("ids are validated: non-array, empty, oversized or non-string are refused", () => {
  const { store } = fixture();
  for (const bad of [[], "x", null, Array.from({ length: 501 }, (_, i) => String(i)), [""]] as unknown[])
    assert.throws(() => store.dismiss("alice", bad as never), (e: unknown) => e instanceof InboxError && e.code === "invalid");
  store.close();
});

test("break-glass notices in the legacy admin_notices table migrate into the inbox without loss, and only once", () => {
  const admin = new AdminStore({ path: ":memory:", ownerId: "owner" });
  const n = (grantId: string, userId: string) => ({ kind: "granted" as const, userId, grantId, holderUserId: "root", reason: "incident 42 forensic read", expiresAt: 9_999_999 });
  admin.notice(n("g1", "alice")); admin.notice(n("g2", "alice")); admin.notice(n("g3", "bob"));
  const { store } = fixture();
  assert.equal(migrateBreakglassNotices(store, admin.allNotices()), 3);
  assert.equal(migrateBreakglassNotices(store, admin.allNotices()), 0, "idempotent");
  const mine = store.list("alice", {}).entries;
  assert.equal(mine.length, 2);
  assert.ok(mine.every(e => e.kind === "breakglass" && e.severity === "critical" && e.titleKey === "inbox.breakglass.granted"));
  assert.deepEqual(mine.map(e => e.ref?.objectId).sort(), ["g1", "g2"]);
  assert.equal(store.list("bob", {}).entries[0]!.ref?.objectId, "g3");
  // no free text from the notice leaks into the inbox
  assert.ok(!JSON.stringify(store.list("alice", {})).includes("forensic"));
  // the legacy table is untouched, `breakglass.notices` keeps working
  assert.equal(admin.notices("alice").length, 2);
  store.close(); admin.close();
});

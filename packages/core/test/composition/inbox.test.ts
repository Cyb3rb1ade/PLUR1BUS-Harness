import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { openInbox, lateInboxPort, type InboxCompositionOptions } from "../../src/composition/inbox.ts";
import type { InboxChange, InboxKind, InboxNotice, InboxService } from "../../src/inbox/index.ts";
import type { BreakGlassNotice } from "../../src/rbac/break-glass.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-inbox-comp-");
const notice = (n: number, over: Partial<BreakGlassNotice> = {}): BreakGlassNotice => ({ kind: "granted", userId: `user-${n}`, grantId: `grant-${n}`, holderUserId: `holder-${n}`, reason: "redact-probe-alpha", expiresAt: 1_000 + n, ...over });

function open(stateDir: string, over: Partial<InboxCompositionOptions> = {}) {
  const changes: InboxChange[] = []; const published: InboxKind[] = []; const logs: [string, Record<string, unknown>][] = [];
  let now = 5_000;
  const inbox = openInbox({
    stateDir, clock: () => now, admins: () => ["admin-1", "admin-2"], legacyNotices: () => [],
    onChange: (c) => changes.push(c), onPublished: (k) => published.push(k), log: (m, f) => logs.push([m, f]), ...over,
  });
  return { inbox, changes, published, logs, setNow: (n: number) => { now = n; } };
}

describe("composition/inbox openInbox", () => {
  it("creates state/inbox.sqlite inside the given state directory, private to the owner", () => {
    const dir = tmp.make();
    const { inbox } = open(join(dir, "state"));
    try {
      const file = join(dir, "state", "inbox.sqlite");
      assert.ok(existsSync(file));
      if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600, "docs/inbox.md: mode 0600");
    } finally { inbox.close(); }
  });

  it("copies legacy break-glass notices once and reports how many were new", () => {
    const dir = tmp.make(); const legacy = [notice(1), notice(2), notice(3)];
    const first = open(dir, { legacyNotices: () => legacy });
    try {
      assert.equal(first.inbox.migrated, 3);
      assert.equal(first.inbox.service.count("user-1").unread.breakglass, 1);
      assert.equal(first.inbox.service.count("user-2").total, 1);
    } finally { first.inbox.close(); }
    const second = open(dir, { legacyNotices: () => legacy });
    try {
      assert.equal(second.inbox.migrated, 0, "keyed by grant id: a restart copies nothing twice");
      assert.equal(second.inbox.service.count("user-1").total, 1);
    } finally { second.inbox.close(); }
    const third = open(dir, { legacyNotices: () => [...legacy, notice(4)] });
    try { assert.equal(third.inbox.migrated, 1, "only the notice that is not in the inbox yet is copied"); } finally { third.inbox.close(); }
  });

  it("the copy carries grant, holder and expiry but never the reason text", () => {
    const dir = tmp.make();
    const { inbox } = open(dir, { legacyNotices: () => [notice(1, { reason: "redact-probe-alpha" })] });
    try {
      const entry = inbox.service.list("user-1", {}).entries[0]!;
      assert.equal(entry.kind, "breakglass"); assert.equal(entry.severity, "critical");
      assert.deepEqual(entry.params, { holderUserId: "holder-1", expiresAt: 1_001 });
      assert.deepEqual(entry.ref, { route: "/inbox", objectId: "grant-1" });
      assert.equal(JSON.stringify(entry).includes("redact-probe-alpha"), false);
    } finally { inbox.close(); }
  });

  it("copied entries are dated with the start that copied them (docs/inbox.md)", () => {
    const dir = tmp.make();
    const { inbox } = open(dir, { legacyNotices: () => [notice(1, { expiresAt: 42 })], clock: () => 777_000 });
    try { assert.equal(inbox.service.list("user-1", {}).entries[0]!.createdAt, 777_000); } finally { inbox.close(); }
  });

  it("a failing legacy source is logged and the inbox still opens empty", () => {
    const dir = tmp.make();
    const { inbox, logs } = open(dir, { legacyNotices: () => { throw new Error("notices unreadable"); } });
    try {
      assert.equal(inbox.migrated, 0);
      assert.equal(logs.length, 1);
      assert.equal(logs[0]![0], "break-glass notices were not copied to the inbox");
      assert.deepEqual(logs[0]![1], { error: "notices unreadable" });
      inbox.service.publish({ userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.test", dedupeKey: "system:1" });
      assert.equal(inbox.service.count("u").total, 1, "the service works after a failed migration");
    } finally { inbox.close(); }
  });

  it("a non-Error thrown by the legacy source is logged as text", () => {
    const dir = tmp.make();
    const { inbox, logs } = open(dir, { legacyNotices: () => { throw "plain string"; } });
    try { assert.deepEqual(logs[0]![1], { error: "plain string" }); } finally { inbox.close(); }
  });

  it("a malformed legacy notice is skipped and the valid notices behind it are still copied (docs/inbox.md: notices that are not in the inbox yet are copied over)", () => {
    const dir = tmp.make();
    const legacy = [notice(1), notice(2, { grantId: "" }), notice(3)];
    const { inbox } = open(dir, { legacyNotices: () => legacy });
    try {
      assert.equal(inbox.service.count("user-3").total, 1, "notice 3 must not be lost behind the malformed notice 2");
    } finally { inbox.close(); }
  });

  it("applies the retention override: maxEntries keeps only the newest entries per person", () => {
    const dir = tmp.make();
    const { inbox } = open(dir, { retention: { maxEntries: 2 } });
    try {
      for (let i = 1; i <= 3; i++) inbox.service.publish({ userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.test", dedupeKey: `system:${i}` });
      const keys = inbox.service.list("u", {}).entries.map((e) => e.titleKey);
      assert.equal(keys.length, 2);
      assert.equal(inbox.store.retention.maxEntries, 2);
    } finally { inbox.close(); }
  });

  it("maxAgeDays is converted to milliseconds and old entries are pruned on the next write", () => {
    const dir = tmp.make();
    const { inbox, setNow } = open(dir, { retention: { maxAgeDays: 1 } });
    try {
      assert.equal(inbox.store.retention.maxAgeMs, 86_400_000);
      setNow(1_000);
      inbox.service.publish({ userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.old", dedupeKey: "system:old" });
      setNow(1_000 + 86_400_000 + 1);
      inbox.service.publish({ userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.new", dedupeKey: "system:new" });
      assert.deepEqual(inbox.service.list("u", {}).entries.map((e) => e.titleKey), ["inbox.system.new"]);
    } finally { inbox.close(); }
  });

  it("defaults: 90 days and 1000 entries when no retention is given", () => {
    const { inbox } = open(tmp.make());
    try { assert.deepEqual(inbox.store.retention, { maxAgeMs: 90 * 86_400_000, maxEntries: 1000 }); } finally { inbox.close(); }
  });

  it("an invalid retention value fails the open instead of being clamped", () => {
    assert.throws(() => open(tmp.make(), { retention: { maxEntries: 0 } }), /maxEntries/);
    assert.throws(() => open(tmp.make(), { retention: { maxAgeDays: 0 } }), /maxAgeMs/);
  });

  it("audience admins fans out to every admin once, and onChange/onPublished see each creation", () => {
    const { inbox, changes, published } = open(tmp.make(), { admins: () => ["admin-1", "admin-2", "admin-1"] });
    try {
      const n: InboxNotice = { audience: "admins", kind: "job-failed", severity: "warning", titleKey: "inbox.job.failed", dedupeKey: "job-failed:run-1" };
      inbox.service.publish(n); inbox.service.publish(n);
      assert.deepEqual(changes.map((c) => [c.userId, c.change]), [["admin-1", "created"], ["admin-2", "created"]], "a duplicate publish produces no second change");
      assert.deepEqual(published, ["job-failed", "job-failed"]);
      assert.equal(inbox.service.count("admin-2").unread["job-failed"], 1);
    } finally { inbox.close(); }
  });

  it("a throwing change listener never undoes the write", () => {
    const logs: string[] = [];
    const { inbox } = open(tmp.make(), { onChange: () => { throw new Error("listener down"); }, log: (m) => logs.push(m) });
    try {
      inbox.service.publish({ userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.test", dedupeKey: "system:1" });
      assert.equal(inbox.service.count("u").total, 1);
      assert.ok(logs.includes("inbox change listener failed"));
    } finally { inbox.close(); }
  });

  it("close() closes the store: further writes through the service are logged, not thrown", () => {
    const { inbox, logs } = open(tmp.make());
    inbox.close();
    inbox.service.publish({ userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.test", dedupeKey: "system:1" });
    assert.ok(logs.some(([m]) => m === "inbox publish failed"));
  });
});

describe("composition/inbox lateInboxPort", () => {
  const notice1: InboxNotice = { userId: "u", kind: "system", severity: "info", titleKey: "inbox.system.test", dedupeKey: "system:1" };

  it("drops publish and settle without throwing while no service exists", () => {
    const port = lateInboxPort(() => null);
    assert.equal(port.publish(notice1), undefined);
    assert.equal(port.settle({ userId: "u" }, "system:1"), undefined);
  });

  it("is late-bound: the same port starts forwarding once the service appears and stops after it is gone", () => {
    const calls: [string, unknown[]][] = [];
    const service = { publish: (...a: unknown[]) => calls.push(["publish", a]), settle: (...a: unknown[]) => calls.push(["settle", a]) } as unknown as InboxService;
    let current: InboxService | null = null;
    const port = lateInboxPort(() => current);
    port.publish(notice1);
    current = service;
    port.publish(notice1); port.settle({ audience: "all" }, "system:1");
    current = null;
    port.publish(notice1);
    assert.deepEqual(calls, [["publish", [notice1]], ["settle", [{ audience: "all" }, "system:1"]]]);
  });

  it("forwards cooldownMs to the current service: the same cause can recur only after its cooldown", () => {
    const { inbox, setNow } = open(tmp.make());
    try {
      const port = lateInboxPort(() => inbox.service);
      const options = { cooldownMs: 3_600_000 };
      port.publish(notice1, options);
      inbox.service.dismiss("u", [inbox.service.list("u", {}).entries[0]!.id]);
      setNow(5_000 + options.cooldownMs - 1);
      port.publish(notice1, options);
      assert.equal(inbox.service.count("u").total, 0, "dismissal must not bypass the forwarded cooldown");
      setNow(5_000 + options.cooldownMs);
      port.publish(notice1, options);
      assert.equal(inbox.service.count("u").total, 1, "the same cause can publish at the cooldown boundary");
    } finally { inbox.close(); }
  });

  it("is a real inbox end to end: a published notice is readable, settling closes it", () => {
    const { inbox } = open(tmp.make());
    try {
      const port = lateInboxPort(() => inbox.service);
      port.publish(notice1);
      assert.equal(inbox.service.count("u").total, 1);
      port.settle({ userId: "u" }, "system:1");
      assert.equal(inbox.service.count("u").total, 0);
    } finally { inbox.close(); }
  });

  it("does not hold on to the first service it saw", () => {
    const seen: string[] = [];
    const mk = (name: string) => ({ publish: () => seen.push(name), settle: () => seen.push(name) }) as unknown as InboxService;
    let current = mk("a");
    const port = lateInboxPort(() => current);
    port.publish(notice1); current = mk("b"); port.publish(notice1);
    assert.deepEqual(seen, ["a", "b"]);
  });
});

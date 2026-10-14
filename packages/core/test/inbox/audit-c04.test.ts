// Audit c04: inbox findings. Each test was red before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { InboxStore, createInboxService, jobFailedToInbox, approvalToInbox, mediaToInbox, type InboxChange, type InboxDraft } from "../../src/inbox/index.ts";

const DAY = 86_400_000;
const draft = (over: Partial<InboxDraft> = {}): InboxDraft => ({ userId: "u1", kind: "system", severity: "info", titleKey: "inbox.test", dedupeKey: "system:a", ...over });

test("a producer string longer than a param allows is clipped, not a reason to lose the whole notification", () => {
  const store = new InboxStore({ path: ":memory:", clock: () => 5 });
  const service = createInboxService({ store, admins: () => ["root"] });
  jobFailedToInbox(service, { runId: "r1", job: "models.scan", reason: "x".repeat(500) });
  approvalToInbox(service, "approval.requested", { approval: { id: "a1", principal: "alice", capability: "c".repeat(300) } });
  mediaToInbox(service, "media.index.failed", { mediaId: "m1", stage: "s".repeat(300) });
  const root = store.list("root", {}).entries;
  assert.equal(root.length, 2, "job-failed and media-index both arrive");
  for (const e of root) for (const v of Object.values(e.params)) assert.ok(String(v).length <= 200);
  assert.equal(store.list("alice", {}).entries.length, 1);
  store.close();
});

test("a token-shaped job failure reason never reaches the inbox (metadata only, no secrets)", () => {
  const store = new InboxStore({ path: ":memory:", clock: () => 5 });
  const service = createInboxService({ store, admins: () => ["root"] });
  const token = `${"1234567890"}:${"Ab".repeat(15)}`; // telegram-shaped, built at runtime
  jobFailedToInbox(service, { runId: "r1", job: "models.scan", reason: `fetch https://api.example.org/bot${token}/getMe failed ${token}` });
  const e = store.list("root", {}).entries[0]!;
  assert.ok(!JSON.stringify(e).includes(token), "the token must not be stored");
  assert.equal(e.kind, "job-failed");
  store.close();
});

test("markRead/dismiss report every kind they changed, not just those among the newest 200", () => {
  const store = new InboxStore({ path: ":memory:", clock: () => 5 });
  const changes: InboxChange[] = [];
  const service = createInboxService({ store, admins: () => [], onChange: c => changes.push(c) });
  store.publish(draft({ kind: "pairing", dedupeKey: "pairing:old" }));
  for (let i = 0; i < 210; i++) store.publish(draft({ kind: "approval", dedupeKey: `approval:${i}` }));
  const oldest = store.list("u1", { kinds: ["pairing"] }).entries[0]!.id;
  service.markRead("u1", [oldest]);
  assert.deepEqual(changes.at(-1), { userId: "u1", change: "read", kinds: ["pairing"] });
  const oldApproval = store.list("u1", { kinds: ["approval"], limit: 200 }).entries.at(-1)!.id;
  store.publish(draft({ kind: "system", dedupeKey: "system:n" }));
  for (let i = 0; i < 210; i++) store.publish(draft({ kind: "update", dedupeKey: `update:${i}` }));
  service.dismiss("u1", [oldApproval]);
  assert.deepEqual(changes.at(-1), { userId: "u1", change: "dismissed", kinds: ["approval"] });
  service.markRead("u1", "all");
  assert.deepEqual([...changes.at(-1)!.kinds].sort(), ["approval", "system", "update"]);
  store.close();
});

test("an entry past its retention does not block a repeat event (docs/inbox.md: re-notify after it aged out)", () => {
  let now = 1000;
  const store = new InboxStore({ path: ":memory:", clock: () => now });
  const first = store.publish(draft({ dedupeKey: "channel:misconfigured:x", kind: "channel" }));
  store.dismiss("u1", [first.id]);
  now += 91 * DAY;
  const again = store.publish(draft({ dedupeKey: "channel:misconfigured:x", kind: "channel" }));
  assert.equal(again.created, true);
  assert.notEqual(again.id, first.id);
  store.close();
});

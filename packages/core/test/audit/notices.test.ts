import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { InboxStore, createInboxService } from "../../src/inbox/index.ts";
import { createAuditNotices } from "../../src/audit/notices.ts";
import { createAuditChain } from "../../src/audit/chain.ts";
import { createAuditHealth } from "../../src/audit/health.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const HOUR = 3_600_000;
test("audit causes publish metadata only to owners and use a rolling hour, not calendar buckets", () => {
  let now = HOUR - 1;
  const store = new InboxStore({ path: ":memory:", clock: () => now });
  const service = createInboxService({ store, admins: () => ["owner", "admin"] });
  const notices = createAuditNotices({ port: service, owners: () => ["owner"], clock: () => now });
  notices.refused("anchor-invalid");
  now = HOUR + 1; notices.refused("anchor-invalid");
  notices.refused("anchor-missing");
  assert.equal(store.list("owner", {}).entries.length, 2);
  assert.equal(store.list("admin", {}).entries.length, 0);
  const first = store.list("owner", {}).entries.find(e => e.params.code === "anchor-invalid")!;
  assert.deepEqual(Object.keys(first.params).sort(), ["at", "code", "count"]);
  assert.equal(first.kind, "system");
  now = 2 * HOUR - 1; notices.refused("anchor-invalid");
  assert.equal(store.list("owner", {}).entries.length, 3);
  store.close();
});
test("debounce survives restart, dismissal, retention and rollback; new owner gets its own notice", () => {
  let now = 100; const path = join(tempDir("audit-notice-"), "inbox.db");
  const open = () => new InboxStore({ path, clock: () => now, maxEntries: 1 });
  let store = open(); let owners = ["owner"];
  const notify = () => createAuditNotices({ port: createInboxService({ store, admins: () => [] }), owners: () => owners, clock: () => now });
  notify().refused("anchor-invalid");
  store.dismiss("owner", [store.list("owner", {}).entries[0]!.id]);
  store.publish({ userId: "owner", kind: "system", severity: "info", titleKey: "inbox.other", dedupeKey: "other" });
  store.close(); now = 50; store = open(); notify().refused("anchor-invalid");
  assert.equal(store.list("owner", { includeDismissed: true }).entries[0]!.titleKey, "inbox.other");
  now = 200; owners = ["new-owner"]; notify().refused("anchor-invalid");
  assert.equal(store.list("new-owner", {}).entries.length, 1);
  store.close();
});
test("health notices distinguish refusal, pending and overflow without details or actor data", () => {
  const dir = tempDir("audit-health-notice-"); const chain = createAuditChain({ dir });
  chain.append({ at: 1, actor: { user: "private-user", host: "private-host" }, action: "audit.config.set", target: "private-target", detail: { secret: "private-secret" } });
  writeFileSync(join(dir, "audit-chain.anchor"), "broken");
  writeFileSync(join(dir, "audit-chain.pending.jsonl"), JSON.stringify({ pendingDropped: 7 }) + "\n" + JSON.stringify({ at: 1, actor: { user: "private-user", host: "private-host" }, action: "audit.config.set", detail: { secret: "private-secret" } }) + "\n");
  const store = new InboxStore({ path: ":memory:", clock: () => 100 });
  const n = createAuditNotices({ port: createInboxService({ store, admins: () => [] }), owners: () => ["owner"], clock: () => 100 });
  n.observe(createAuditHealth({ dir }).status());
  const entries = store.list("owner", {}).entries;
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(e => [e.params.code, e.params.count]).sort(), [["anchor-invalid", 1], ["pending", 1], ["pending-overflow", 7]].sort());
  assert.doesNotMatch(JSON.stringify(entries), /private-/);
  store.close();
});
test("an immediate append refusal reports a bounded code even if the observer throws, preserving the original failure", () => {
  const dir = tempDir("audit-refusal-notice-"); const codes: string[] = [];
  const chain = createAuditChain({ dir, onRefusal: code => { codes.push(code); throw new Error("observer failed"); } });
  const row = { at: 1, actor: { user: "owner", host: "host" }, action: "test", target: "secret-target", detail: { secret: "secret" } };
  chain.append(row); writeFileSync(join(dir, "audit-chain.anchor"), "broken");
  const before = readFileSync(join(dir, "audit-chain.jsonl"));
  assert.throws(() => chain.append(row), /anchor is invalid/);
  assert.deepEqual(codes, ["anchor-invalid"]);
  assert.deepEqual(readFileSync(join(dir, "audit-chain.jsonl")), before);
});

test("a failed inbox insertion cannot consume the rolling cooldown", () => {
  let id = "same";
  const store = new InboxStore({ path: ":memory:", clock: () => 1, idGen: () => id });
  const draft = { userId: "owner", kind: "system" as const, severity: "warning" as const, titleKey: "inbox.audit.warning", dedupeKey: "cause-a" };
  assert.equal(store.publishRateLimited(draft, HOUR).created, true);
  assert.throws(() => store.publishRateLimited({ ...draft, dedupeKey: "cause-b" }, HOUR), /UNIQUE/);
  id = "next";
  assert.equal(store.publishRateLimited({ ...draft, dedupeKey: "cause-b" }, HOUR).created, true);
  for (const ms of [0, -1, NaN, Infinity]) assert.throws(() => store.publishRateLimited(draft, ms), /cooldownMs/);
  store.close();
});
test("unrecognized refusal text is replaced with a content-free bounded code", () => {
  const store = new InboxStore({ path: ":memory:", clock: () => 1 });
  const n = createAuditNotices({ port: createInboxService({ store, admins: () => [] }), owners: () => ["owner"], clock: () => 1 });
  n.refused("private-secret https://private.example");
  assert.equal(store.list("owner", {}).entries[0]!.params.code, "audit-unavailable");
  assert.doesNotMatch(JSON.stringify(store.list("owner", {})), /private/);
  store.close();
});

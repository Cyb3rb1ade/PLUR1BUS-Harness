import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { InboxStore, createInboxService, approvalToInbox, jobFailedToInbox, mediaToInbox, pairingToInbox, channelToInbox, breakglassToInbox, alwaysGrantsToInbox, type InboxChange } from "../../src/inbox/index.ts";
import { createSystemJobs } from "../../src/system-jobs/index.ts";
import { createPlatformCapabilities } from "../../src/platform.ts";
import { FakeClock } from "../../src/discovery/testing.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function fixture() {
  const store = new InboxStore({ path: ":memory:", clock: () => 5 });
  const changes: InboxChange[] = [];
  const service = createInboxService({ store, admins: () => ["root", "adm"], onChange: c => changes.push(c) });
  const all = (u: string) => store.list(u, { includeDismissed: true }).entries;
  return { store, service, changes, all };
}
const view = { id: "apr1", principal: "alice", capability: "fs.write", status: "pending" };

test("approval: one entry for the approving person; repeating it adds nothing; resolving closes it", () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) approvalToInbox(f.service, "approval.requested", { approval: view });
  assert.equal(f.all("alice").length, 1);
  assert.deepEqual([f.all("alice")[0]!.kind, f.all("alice")[0]!.ref], ["approval", { route: "/approvals", objectId: "apr1" }]);
  assert.equal(f.all("bob").length, 0);
  approvalToInbox(f.service, "approval.resolved", { approval: view, outcome: "approved" });
  approvalToInbox(f.service, "approval.resolved", { approval: view, outcome: "approved" });
  assert.equal(f.store.count("alice").total, 0);
  assert.equal(f.all("alice").length, 1, "the row stays until retention");
  approvalToInbox(f.service, "approval.parked", { approval: view });
  approvalToInbox(f.service, "approval.requested", { approval: { id: "", principal: "" } });
  assert.equal(f.all("alice").length, 1);
  assert.ok(!JSON.stringify(f.all("alice")).includes("nonce"));
  f.store.close();
});

test("job-failed: one entry per failed run for each owner/admin", () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) jobFailedToInbox(f.service, { runId: "r1", job: "models.scan", reason: "exception" });
  jobFailedToInbox(f.service, { runId: "r2", job: "models.scan" });
  assert.equal(f.all("root").length, 2);
  assert.equal(f.all("adm").length, 2);
  assert.equal(f.all("alice").length, 0);
  assert.equal(f.all("root")[1]!.kind, "job-failed");
  f.store.close();
});

test("system jobs report a failed run (thrown or returned) through onFailed, and only those", async () => {
  const dir = tempDir("inbox-jobs-");
  const failures: string[] = [];
  const jobs = createSystemJobs({
    ledgerPath: join(dir, "ledger.jsonl"), clock: new FakeClock(0) as never, securePath: createPlatformCapabilities({ platform: process.platform }).securePath,
    logger: { warn() {} }, engineHasJob: () => false, onFailed: r => failures.push(`${r.job}:${r.reason ?? ""}`),
  });
  const handler = (name: string, run: () => Promise<{ outcome: "completed" | "failed"; detail: unknown }>) => ({
    spec: { name, kind: "system" as const, needsLlm: false as const, singleton: true as const, schedule: { every: 1000, jitter: 0 } },
    nextRunAt: () => null, validateArgs: (a: unknown) => (a ?? {}) as Record<string, unknown>, run,
  });
  jobs.register(handler("ok", async () => ({ outcome: "completed", detail: null })));
  jobs.register(handler("bad", async () => ({ outcome: "failed", detail: null })));
  jobs.register(handler("boom", async () => { throw new Error("x"); }));
  await jobs.run("ok", {}, { trigger: "manual", signal: new AbortController().signal });
  await jobs.run("bad", {}, { trigger: "manual", signal: new AbortController().signal });
  await assert.rejects(jobs.run("boom", {}, { trigger: "manual", signal: new AbortController().signal }));
  assert.deepEqual(failures, ["bad:", "boom:exception"]);
});

test("media-index: a failure per media object and a finished backfill per fingerprint", () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) mediaToInbox(f.service, "media.index.failed", { mediaId: "m1", stage: "caption", message: "secret text must not be copied" });
  mediaToInbox(f.service, "media.index.failed", { mediaId: "m2", stage: "index" });
  for (let i = 0; i < 2; i++) mediaToInbox(f.service, "media.index.status", { backfill: { state: "done" }, fingerprint: "fp1" });
  mediaToInbox(f.service, "media.index.status", { backfill: { state: "running" }, fingerprint: "fp1" });
  mediaToInbox(f.service, "media.index.status", { backfill: { state: "done" }, fingerprint: "fp2" });
  assert.equal(f.all("root").length, 4);
  assert.ok(f.all("root").every(e => e.kind === "media-index"));
  assert.ok(!JSON.stringify(f.all("root")).includes("secret text"));
  f.store.close();
});

test("pairing: a claim waits in the person's inbox; confirm, decline or revoke closes it for whoever had it", () => {
  const f = fixture();
  const claim = { action: "identity.pair.claim", target: "p1", detail: { channel: "telegram", result: "awaiting-confirmation", humanId: "alice", accountId: "acct-123" } };
  pairingToInbox(f.service, claim); pairingToInbox(f.service, claim);
  pairingToInbox(f.service, { action: "identity.pair.claim", target: "x", detail: { result: "refused" } });
  pairingToInbox(f.service, { action: "identity.pair.start", target: "p9", detail: { humanId: "alice" } });
  assert.equal(f.all("alice").length, 1);
  assert.ok(!JSON.stringify(f.all("alice")).includes("acct-123"), "no foreign account ids");
  pairingToInbox(f.service, { action: "identity.pair.confirm", target: "p1", detail: { result: "declined" } });
  assert.equal(f.store.count("alice").total, 0);
  assert.deepEqual(f.changes.map(c => c.change), ["created", "settled"]);
  f.store.close();
});

test("channel: a misconfigured channel notifies owners and admins once", () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) channelToInbox(f.service, "channel.misconfigured", { channel: "telegram", reason: "secret-namespace" });
  channelToInbox(f.service, "channel.started", { channel: "telegram" });
  channelToInbox(f.service, "channel.misconfigured", { channel: "slack" });
  assert.equal(f.all("root").length, 2);
  assert.equal(f.all("adm").length, 2);
  f.store.close();
});

test("break-glass: the affected person gets one critical entry per grant, without the reason text", () => {
  const f = fixture();
  const n = { kind: "granted" as const, userId: "alice", grantId: "g1", holderUserId: "root", reason: "forensic read of incident 42", expiresAt: 99 };
  breakglassToInbox(f.service, n); breakglassToInbox(f.service, n);
  assert.equal(f.all("alice").length, 1);
  assert.equal(f.all("alice")[0]!.severity, "critical");
  assert.ok(!JSON.stringify(f.all("alice")).includes("forensic"));
  assert.equal(f.all("root").length, 0);
  f.store.close();
});

test("always-grants older than 90 days: one inbox item for that person, never audience all; a second run is deduped", () => {
  const f = fixture();
  const DAY = 86_400_000;
  const clock = new FakeClock(0);
  const grants = [{
    id: "grt_always1", person: "alice", agent: "bernd", capability: "fs.write",
    scope: "always" as const, createdAt: 0, match: { kind: "capability" as const },
  }];
  clock.advance(91 * DAY);
  alwaysGrantsToInbox(f.service, grants, clock.now());
  alwaysGrantsToInbox(f.service, grants, clock.now());
  assert.equal(f.all("alice").length, 1);
  assert.equal(f.all("alice")[0]!.kind, "system");
  assert.equal(f.all("bob").length, 0);
  assert.equal(f.all("root").length, 0);
  assert.ok(!JSON.stringify(f.all("alice")).includes("audience"));
  alwaysGrantsToInbox(f.service, [{
    ...grants[0]!, id: "grt_secret", capability: "fs.write sk-live-0123456789abcdefghijkl",
  }], clock.now());
  const secretEntry = f.all("alice").find(e => e.ref?.objectId === "grt_secret");
  assert.ok(secretEntry);
  assert.ok(!JSON.stringify(secretEntry).includes("sk-live-"));
  f.store.close();
});

test("a producer can never hurt its source: a closed store swallows every call", () => {
  const f = fixture();
  f.store.close();
  assert.doesNotThrow(() => { approvalToInbox(f.service, "approval.requested", { approval: view }); jobFailedToInbox(f.service, { runId: "r", job: "j" }); pairingToInbox(f.service, { action: "identity.pair.confirm", target: "p" }); });
});

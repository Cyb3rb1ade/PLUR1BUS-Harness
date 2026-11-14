import assert from "node:assert/strict";
import { test } from "node:test";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { openPermissionStores } from "../../src/grants/open.ts";
import { AUTO_JOB_ISSUER, USE_RECORD_GRANULARITY_MS } from "../../src/grants/store.ts";
import { grantExpiry } from "../../src/policy/decide.ts";
import { alwaysCap, DAY, dbFile, FakeClock, KEY } from "./helpers.ts";

test("owner grants use the chained issuance and turn lifecycle", async t => {
  const clock = new FakeClock();
  const recorded: unknown[] = [];
  const stores = await openPermissionStores({
    path: dbFile(), keys: staticKeySource(KEY), clock,
    audit: { record(action, fields) { recorded.push({ action, ...fields }); } },
  });
  t.after(() => stores.close());
  const { grants } = stores;
  assert.throws(() => grants.create(alwaysCap({ capability: "memory.jobs.run", person: AUTO_JOB_ISSUER, createdBy: AUTO_JOB_ISSUER, jobId: "engine:*" })));
  const first = grants.issueOwnerJobs("owner-a", "bernd", "rust-core-start");
  assert.ok(first);
  assert.equal(first.origin, "auto-agent-owner");
  assert.deepEqual(recorded[0], { action: "grant.created", person: "owner-a", agentId: "bernd", capability: "memory.jobs.run",
    grantId: first.id, grantScope: "always", matchKind: "capability", jobId: "engine:*", by: AUTO_JOB_ISSUER, origin: "auto-agent-owner", reason: "rust-core-start" });
  assert.equal(grants.issueOwnerJobs("owner-a", "bernd", "rust-core-start"), undefined);
  clock.advance(45 * DAY);
  grants.markUsed(first.id);
  assert.equal(grantExpiry(grants.get(first.id)!), first.createdAt + 90 * DAY);
  grants.renewJobGrantsFromTurn("owner-a", "bernd");
  assert.equal(grantExpiry(grants.get(first.id)!), clock.now() + 90 * DAY);
  assert.equal(grants.get(first.id)!.lastJobTurnAt, clock.now());

  clock.advance(91 * DAY);
  assert.equal(grants.issueOwnerJobs("owner-a", "bernd", "rust-core-start"), undefined);
  assert.equal(grants.issueOwnerJobs("owner-a", "bernd", "engine-switched-to-rust"), undefined);
  const returned = grants.issueOwnerJobs("owner-a", "bernd", "owner-returned");
  assert.ok(returned);
  assert.notEqual(returned.id, first.id);
  assert.equal((recorded.at(-1) as { reason: string }).reason, "owner-returned");
  assert.ok(grants.revoke(returned.id, "owner-a"));
  clock.advance(91 * DAY);
  assert.equal(grants.issueOwnerJobs("owner-a", "bernd", "owner-returned"), undefined);
  assert.equal(grants.issueOwnerJobs("owner-a", "bernd", "rust-core-start"), undefined);
});

test("a proved turn renews a job grant at most once per use-record interval", async t => {
  const clock = new FakeClock();
  const recorded: { action: string }[] = [];
  const stores = await openPermissionStores({
    path: dbFile(), keys: staticKeySource(KEY), clock,
    audit: { record(action, fields) { recorded.push({ action, ...fields }); } },
  });
  t.after(() => stores.close());
  const { grants } = stores;
  const grant = grants.issueOwnerJobs("owner-a", "bernd", "rust-core-start")!;
  const uses = () => recorded.filter(e => e.action === "grant.used").length;
  const chained = () => grants.chainEntries().filter(e => e.kind === "grant.used").length;

  clock.advance(DAY);
  grants.renewJobGrantsFromTurn("owner-a", "bernd");
  const renewedAt = clock.now();
  assert.equal(grants.get(grant.id)!.lastJobTurnAt, renewedAt);
  assert.deepEqual([uses(), chained()], [1, 1]);

  // Every further turn inside the interval leaves the chain and the audit alone: a chat of a hundred turns is one entry.
  for (let turn = 0; turn < 100; turn++) {
    clock.advance(30_000);
    grants.renewJobGrantsFromTurn("owner-a", "bernd");
  }
  assert.equal(grants.get(grant.id)!.lastJobTurnAt, renewedAt);
  assert.deepEqual([uses(), chained()], [1, 1]);

  clock.advance(USE_RECORD_GRANULARITY_MS);
  grants.renewJobGrantsFromTurn("owner-a", "bernd");
  assert.equal(grants.get(grant.id)!.lastJobTurnAt, clock.now());
  assert.deepEqual([uses(), chained()], [2, 2]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { UserJobs } from "../../src/user-jobs/index.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";

const owner: Principal = { kind: "person", userId: "owner", role: "owner" };
const alice: Principal = { kind: "person", userId: "alice", role: "member", agentRights: { main: "manage" } };
const user: Principal = { kind: "person", userId: "bob", role: "member", agentRights: { main: "use" } };
const stranger: Principal = { kind: "person", userId: "carol", role: "member", agentRights: {} };
const input = { name: "Daily", agentId: "main", prompt: "Summarize", schedule: { cron: "0 9 * * *", timezone: "UTC" }, enabled: true };
const directory: Record<string, Principal> = { owner, alice, bob: user, carol: stranger };

function rig() {
  const audit = memoryAuditSink();
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let hold = false;
  const jobs = new UserJobs({ path: join(tempDir("p1b-userjobs-v-"), "jobs.sqlite"), clock: () => Date.UTC(2026, 9, 14, 10), audit, agentExists: () => true, resolve: id => directory[id] ?? null, budgetBlocked: () => false, notify: () => { }, submitTurn: async () => { if (hold) await gate; return "completed"; } });
  return { jobs, audit, hold: () => { hold = true; }, release };
}
const denied = (e: any) => e.error === "E_DENIED";

test("foreign jobs: visible to owner, admins and holders of use/manage; hidden from everyone else", () => {
  const r = rig();
  try {
    const j = r.jobs.create(input, alice);
    assert.deepEqual(r.jobs.list(alice).map(x => x.id), [j.id]);
    assert.deepEqual(r.jobs.list(owner).map(x => x.id), [j.id]);
    assert.deepEqual(r.jobs.list(user).map(x => x.id), [j.id]);
    assert.deepEqual(r.jobs.list(stranger), []);
    assert.deepEqual(r.jobs.history(undefined, stranger), []);
  }
  finally {
    r.jobs.close();
  }
});

test("foreign jobs: use-only holders and strangers can neither edit nor delete; a manager can, and becomes runAs with an audit", () => {
  const r = rig();
  try {
    const j = r.jobs.create(input, owner);
    for (const p of [user, stranger]) {
      assert.throws(() => r.jobs.update({ id: j.id, name: "x" }, p), denied);
      assert.throws(() => r.jobs.delete(j.id, true, p), denied);
    }
    assert.throws(() => r.jobs.delete(j.id, false, owner), (e: any) => e.error === "E_INVALID_PARAMS");
    const edited = r.jobs.update({ id: j.id, name: "Mine now" }, alice);
    assert.equal(edited.runAs, "alice");
    assert.equal(edited.createdBy, "owner");
    const entry = r.audit.events.find(e => e.action === "jobs.runAs.changed")!;
    assert.deepEqual([entry.actor.user, entry.detail.oldRunAs, entry.detail.runAs], ["alice", "owner", "alice"]);
    assert.deepEqual(r.jobs.delete(j.id, true, alice), { id: j.id, deleted: true });
    assert.ok(r.audit.events.some(e => e.action === "jobs.deleted"));
    assert.throws(() => r.jobs.get(j.id), (e: any) => e.error === "E_NOT_FOUND");
  }
  finally {
    r.jobs.close();
  }
});

test("manual runs execute as runAs, record the requester, and a running job can be neither started twice nor deleted", async () => {
  const r = rig();
  try {
    const j = r.jobs.create(input, alice);
    r.hold();
    const first = r.jobs.run(j.id, user);
    await assert.rejects(r.jobs.run(j.id, user), (e: any) => e.error === "E_CONFLICT");
    assert.throws(() => r.jobs.delete(j.id, true, alice), (e: any) => e.error === "E_CONFLICT");
    r.release();
    const run = await first;
    assert.deepEqual([run.runAs, run.requestedBy, run.outcome], ["alice", "bob", "completed"]);
    await assert.rejects(r.jobs.run(j.id, stranger), denied);
  }
  finally {
    r.release();
    await r.jobs.drain();
    r.jobs.close();
  }
});

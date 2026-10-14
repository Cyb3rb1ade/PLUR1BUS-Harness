import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { UserJobs, type UserJobsOptions } from "../../src/user-jobs/index.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";

const owner: Principal = { kind: "person", userId: "owner", role: "owner" };
const member: Principal = { kind: "person", userId: "member", role: "member", agentRights: { main: "manage" } };
const viewer: Principal = { kind: "person", userId: "viewer", role: "viewer" };
const input = { name: "Morning", agentId: "main", prompt: "Summarize today", schedule: { cron: "0 9 * * *", timezone: "Europe/Berlin" }, enabled: true };
const code = (c: string) => (e: any) => e.error === c;

function rig(over: Partial<UserJobsOptions> = {}) {
  let now = Date.UTC(2026, 9, 14, 10);
  const calls: string[] = [];
  const audit = memoryAuditSink();
  const opts: UserJobsOptions = { path: join(tempDir("p1b-userjobs-h-"), "jobs.sqlite"), clock: () => now, audit, agentExists: id => id === "main", resolve: id => id === "owner" ? owner : member, budgetBlocked: () => false, notify: () => { }, submitTurn: async j => { calls.push(j.id); return "completed"; }, ...over };
  const jobs = new UserJobs(opts);
  return { jobs, opts, calls, audit, advance: (ms = 24 * 3600_000) => { now += ms; } };
}

test("a failure while opening a run record does not leave the job locked as running", async () => {
  let armed = -1;
  let calls = 0;
  const r = rig();
  const tickingClock = r.opts.clock;
  r.jobs.close();
  const jobs = new UserJobs({ ...r.opts, clock: () => { if (armed >= 0 && calls++ === armed) throw new Error("clock failure"); return tickingClock(); } });
  try {
    const j = jobs.create(input, member);
    // run(): the use-right check reads the clock once, #executeRun reads it second.
    armed = 1;
    await assert.rejects(jobs.run(j.id, owner), /clock failure/);
    armed = -1;
    const run = await jobs.run(j.id, owner);
    assert.equal(run.outcome, "completed");
    assert.deepEqual(jobs.delete(j.id, true, member), { id: j.id, deleted: true });
  }
  finally {
    jobs.close();
  }
});

test("a broken display-name directory degrades to the person id instead of failing the run", async () => {
  const r = rig({ displayName: () => { throw new Error("directory down"); } });
  try {
    const j = r.jobs.create(input, member);
    const run = await r.jobs.run(j.id, owner);
    assert.equal(run.outcome, "completed");
    assert.equal(run.runAsDisplayName, "member");
  }
  finally {
    r.jobs.close();
  }
});

test("a run interrupted by shutdown is abandoned and the job is runnable again after restart", async () => {
  let closeDuringRun = true;
  const r = rig({ onRecorded: () => { } });
  try {
    const j = r.jobs.create(input, member);
    r.opts.submitTurn = async () => { if (closeDuringRun) r.jobs.close(); return "completed"; };
    await assert.rejects(r.jobs.run(j.id, owner));
    closeDuringRun = false;
  }
  finally {
    r.jobs.close();
  }
  // Reopened store: the interrupted run is abandoned and the job is runnable again.
  const reopened = new UserJobs({ ...r.opts, submitTurn: async () => "completed" });
  try {
    const run = await reopened.run(reopened.list(owner)[0]!.id, owner);
    assert.equal(run.outcome, "completed");
  }
  finally {
    reopened.close();
  }
});

test("a schedule that can never fire is refused instead of creating a silently dead enabled job", () => {
  const r = rig();
  try {
    for (const cron of ["0 0 30 2 *", "0 0 31 4 *", "0 0 31 2,6,9,11 *"]) {
      assert.throws(() => r.jobs.create({ ...input, schedule: { cron, timezone: "UTC" } }, member), code("E_INVALID_PARAMS"), cron);
    }
    const ok = r.jobs.create({ ...input, schedule: { cron: "0 0 29 2 *", timezone: "UTC" } }, member);
    assert.equal(new Date(ok.nextRunAt!).toISOString(), "2028-02-29T00:00:00.000Z");
    const j = r.jobs.create(input, member);
    assert.throws(() => r.jobs.update({ id: j.id, schedule: { cron: "0 0 31 11 *", timezone: "UTC" } }, member), code("E_INVALID_PARAMS"));
    // A day-of-week alternative keeps an otherwise impossible day-of-month satisfiable (cron OR semantics).
    assert.ok(r.jobs.create({ ...input, schedule: { cron: "0 0 30 2 1", timezone: "UTC" } }, member).nextRunAt);
  }
  finally {
    r.jobs.close();
  }
});

test("31st-of-month and leap-day schedules land on real dates", () => {
  const r = rig();
  try {
    const at = (cron: string) => new Date(r.jobs.create({ ...input, schedule: { cron, timezone: "UTC" } }, member).nextRunAt!).toISOString();
    assert.equal(at("0 0 31 * *"), "2026-10-31T00:00:00.000Z");
    assert.equal(at("0 0 29 2 *"), "2028-02-29T00:00:00.000Z");
  }
  finally {
    r.jobs.close();
  }
});

test("renaming a job keeps names trimmed and keeps the reason it was disabled", async () => {
  let person: Principal | null = member;
  const r = rig({ resolve: () => person });
  try {
    const j = r.jobs.create(input, member);
    assert.equal(r.jobs.update({ id: j.id, name: "  Padded  " }, member).name, "Padded");
    person = { ...member, agentRights: {} };
    r.advance();
    await r.jobs.tick();
    assert.equal(r.jobs.get(j.id).disabledReason, "skipped_no_rights");
    const renamed = r.jobs.update({ id: j.id, name: "Renamed" }, member);
    assert.equal(renamed.enabled, false);
    assert.equal(renamed.disabledReason, "skipped_no_rights");
    const again = r.jobs.update({ id: j.id, enabled: false }, member);
    assert.equal(again.disabledReason, "skipped_no_rights");
    person = member;
    const enabled = r.jobs.update({ id: j.id, enabled: true }, member);
    assert.equal(enabled.disabledReason, undefined);
  }
  finally {
    r.jobs.close();
  }
});

test("callers without rights learn nothing about agents or definitions before authorization", () => {
  const r = rig();
  try {
    const unknown = { ...input, agentId: "ghost" };
    const known = { ...input, agentId: "main" };
    const probe = (p: Principal, i: typeof input) => { try { r.jobs.create(i, p); return "created"; } catch (e: any) { return `${e.error}:${e.message}`; } };
    assert.equal(probe(viewer, unknown), probe(viewer, known));
    assert.equal(probe(viewer, known).startsWith("E_DENIED"), true);
    const agent = { kind: "agent", userId: "robot", role: "owner" } as Principal;
    assert.equal(probe(agent, unknown), probe(agent, known));
    assert.equal(probe(agent, known).startsWith("E_DENIED"), true);
  }
  finally {
    r.jobs.close();
  }
});

test("definitions are closed: no stray schedule keys and no control characters in names", () => {
  const r = rig();
  try {
    assert.throws(() => r.jobs.create({ ...input, schedule: { ...input.schedule, extra: "x".repeat(10_000) } as any }, member), code("E_INVALID_PARAMS"));
    assert.throws(() => r.jobs.create({ ...input, name: "a\0b" }, member), code("E_INVALID_PARAMS"));
    assert.throws(() => r.jobs.create({ ...input, name: "a\nb" }, member), code("E_INVALID_PARAMS"));
  }
  finally {
    r.jobs.close();
  }
});

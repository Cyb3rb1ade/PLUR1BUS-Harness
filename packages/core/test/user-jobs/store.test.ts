import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { UserJobs } from "../../src/user-jobs/index.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
const owner: Principal = { kind: "person", userId: "owner", role: "owner" };
const member: Principal = { kind: "person", userId: "member", role: "member", agentRights: { main: "manage" } };
const input = { name: "Morning", agentId: "main", prompt: "Summarize today", schedule: { cron: "* * * * *", timezone: "Europe/Berlin" }, enabled: true };
function rig() {
  let now = Date.UTC(2026, 9, 14, 10);
  let person: Principal | null = member;
  let exists = true;
  let budget = false;
  const calls: any[] = [];
  const notices: any[] = [];
  const audit = memoryAuditSink();
  const opts = { path: join(tempDir("p1b-userjobs-"), "jobs.sqlite"), clock: () => now, audit, agentExists: () => exists, resolve: (id: string) => id === "owner" ? owner : person, budgetBlocked: () => budget, notify: (x: any) => notices.push(x), submitTurn: async (j: any, p: any) => { calls.push({ j, p }); return "completed" as const; } };
  const jobs = new UserJobs(opts);
  return { jobs, opts, calls, notices, audit, setNow: (v: number) => { now = v; }, advance: () => { now += 60000; }, setPerson: (v: Principal | null) => { person = v; }, deleteAgent: () => { exists = false; }, blockBudget: () => { budget = true; } };
}
test("jobs re-evaluate roles and rights, disable on loss, and never persist authority snapshots", async () => {
  const r = rig();
  try {
    const job = r.jobs.create(input, member);
    assert.equal(job.runAs, "member");
    assert.equal(job.createdBy, "member");
    assert.equal((job as any).role, undefined);
    r.advance();
    await r.jobs.tick();
    assert.equal(r.calls.length, 1);
    r.setPerson({ ...member, role: "viewer" });
    r.advance();
    await r.jobs.tick();
    assert.equal(r.jobs.history(job.id, owner)[0]!.outcome, "skipped_no_rights");
    assert.equal(r.jobs.get(job.id).enabled, false);
    assert.equal(r.calls.length, 1);
    r.setPerson({ ...member, agentRights: {} });
    assert.throws(() => r.jobs.update({ id: job.id, enabled: true }, member));
  }
  finally {
    r.jobs.close();
  }
});
test("inactive people and missing agents disable jobs; budgets skip without running", async () => {
  for (const mode of ["inactive", "agent", "budget"]) {
    const r = rig();
    try {
      const j = r.jobs.create(input, member);
      if (mode === "inactive")
        r.setPerson(null);
      if (mode === "agent")
        r.deleteAgent();
      if (mode === "budget")
        r.blockBudget();
      r.advance();
      await r.jobs.tick();
      assert.equal(r.calls.length, 0);
      assert.equal(r.jobs.history(j.id, owner)[0]!.outcome, { inactive: "skipped_owner_inactive", agent: "skipped_agent_missing", budget: "skipped_budget" }[mode]);
      assert.equal(r.jobs.get(j.id).enabled, mode === "budget");
    }
    finally {
      r.jobs.close();
    }
  }
});
test("an authorized editor takes runAs, with an audit; callers cannot choose a third person", () => {
  const r = rig();
  try {
    const j = r.jobs.create(input, member);
    const next = r.jobs.update({ id: j.id, name: "Updated" }, owner);
    assert.equal(next.runAs, "owner");
    assert.equal(next.createdBy, "member");
    assert.ok(r.audit.events.some(e => e.action === "jobs.runAs.changed"));
    assert.throws(() => r.jobs.update({ id: j.id, runAs: "third" } as any, owner));
  }
  finally {
    r.jobs.close();
  }
});
test("persisted scheduling claims avoid duplicates across restart and coalesce downtime", async () => {
  const r = rig();
  const j = r.jobs.create(input, member);
  r.advance();
  await r.jobs.tick();
  r.jobs.close();
  const reopened = new UserJobs(r.opts);
  try {
    await reopened.tick();
    assert.equal(r.calls.length, 1);
    r.setNow(Date.UTC(2026, 9, 15, 10));
    await reopened.tick();
    await reopened.tick();
    assert.equal(r.calls.length, 2);
    assert.equal(reopened.history(j.id, owner).length, 2);
  }
  finally {
    reopened.close();
  }
});
test("agent rights revoked between runs are re-evaluated independently of role", async () => {
  const r = rig();
  try {
    const j = r.jobs.create(input, member);
    r.advance();
    await r.jobs.tick();
    r.setPerson({ ...member, agentRights: {} });
    r.advance();
    await r.jobs.tick();
    assert.equal(r.calls.length, 1);
    assert.equal(r.jobs.history(j.id, owner)[0]!.outcome, "skipped_no_rights");
    assert.equal(r.jobs.get(j.id).enabled, false);
  }
  finally {
    r.jobs.close();
  }
});
test("disabled jobs do not run, agents cannot manage, system jobs stay immutable", async () => {
  const r = rig();
  try {
    const j = r.jobs.create({ ...input, enabled: false }, member);
    r.advance();
    await r.jobs.tick();
    assert.equal(r.calls.length, 0);
    assert.throws(() => r.jobs.create(input, { ...owner, kind: "agent" }));
    assert.throws(() => r.jobs.update({ id: "models.scan", name: "Changed" }, owner), (e: any) => e.error === "E_DENIED");
  }
  finally {
    r.jobs.close();
  }
});

test("overlapping scheduler scans do not replay a slot completed by the other scan", async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  r.opts.submitTurn = async (job: any) => { started.push(job.name); if (job.name === "First") await gate; return "completed"; };
  try {
    r.jobs.create({...input, name:"First"},member); r.jobs.create({...input,name:"Second"},member);
    r.advance(); const firstScan=r.jobs.tick();
    await new Promise(resolve=>setImmediate(resolve)); await r.jobs.tick(); release(); await firstScan;
    assert.equal(started.filter(name=>name==="Second").length,1);
  } finally { release(); await r.jobs.drain(); r.jobs.close(); }
});

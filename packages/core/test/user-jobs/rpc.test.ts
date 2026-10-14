import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir.ts";
import { UserJobs } from "../../src/user-jobs/index.ts";
import { attachUserJobMethods } from "../../src/user-jobs/rpc.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
const ctx = () => ({ requestId: "test", connectionId: "test", signal: new AbortController().signal });
test("user-job RPCs use actual human principals, current manage rights and the existing stricter jobs.run rule", async () => {
  let p: Principal | null = { kind: "person", userId: "alice", role: "member", agentRights: { main: "manage" } };
  const jobs = new UserJobs({ path: join(tempDir("userjobs-rpc-"), "jobs.sqlite"), clock: () => 0, audit: memoryAuditSink(), agentExists: () => true, resolve: () => p, budgetBlocked: () => false, notify: () => { }, execute: async () => "completed" });
  const methods = guardMethods(attachUserJobMethods({ "jobs.list": async () => ({ jobs: [] }), "jobs.history": async () => ({ runs: [] }), "jobs.run": async () => ({}) }, jobs, () => p), { resolve: () => p, now: () => 0 });
  try {
    const { job } = await methods["jobs.create"]!({ name: "Daily", agentId: "main", prompt: "Hello", schedule: { cron: "* * * * *", timezone: "UTC" }, enabled: true }, ctx()) as any;
    assert.equal(job.runAs, "alice");
    await assert.rejects(methods["jobs.run"]!({ job: job.id }, ctx()), (e: any) => e.error === "E_DENIED");
    p = { ...p!, agentRights: {} };
    await assert.rejects(methods["jobs.update"]!({ id: job.id, name: "Changed" }, ctx()), (e: any) => e.error === "E_DENIED");
    for (const forbidden of [{ kind: "agent", userId: "robot", role: "owner" }, null] as (Principal | null)[]) {
      p = forbidden;
      await assert.rejects(methods["jobs.create"]!({ agentId: "main" }, ctx()));
      await assert.rejects(methods["jobs.list"]!({ kind: "user" }, ctx()));
    }
  }
  finally {
    jobs.close();
  }
});

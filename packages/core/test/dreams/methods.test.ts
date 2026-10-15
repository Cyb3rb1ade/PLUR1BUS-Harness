// dreams/methods: the dreams.* RPC handlers over a real scheduler. Every agent-scoped method refuses an agent that is not
// registered (E_AGENT_UNKNOWN), an unavailable scheduler answers E_NOT_AVAILABLE, bad edits map to E_INVALID_PARAMS.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { RpcError } from "../../src/rpc/errors.ts";
import { buildDreamsMethods } from "../../src/dreams/methods.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import type { Principal, Role } from "../../src/rbac/types.ts";
import { harness, HOUR, settle, T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();
const ctx = (signal = new AbortController().signal) => ({ signal, connectionId: "c1" }) as never;

function setup(over: { registered?: string[]; unavailable?: string } = {}) {
  const h = harness(dirs, { agents: ["alpha", "beta"] });
  const registered = over.registered ?? ["alpha"];
  const agents = { list: () => registered, has: (id: string) => registered.includes(id), scaffold: () => {}, workspaceOf: (id: string) => (registered.includes(id) ? `/ws/${id}` : undefined) };
  const m = buildDreamsMethods({ dreams: () => h.sched, agents, ...(over.unavailable ? { unavailableBecause: () => over.unavailable } : {}) });
  const call = (name: string, params: unknown, signal?: AbortSignal) => (m[name] as (p: unknown, c: unknown) => Promise<any>)(params, ctx(signal));
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof RpcError ? `${e.error}${e.reason ? `:${e.reason}` : ""}${e.detail ? `/${e.detail}` : ""}` : `other:${String(e)}`));
  return { h, m, call, code };
}

describe("dreams.* methods: the registry decides who may be addressed", () => {
  const agentScoped: [string, object][] = [
    ["dreams.run", { agentId: "ghost", phase: "deep" }],
    ["dreams.run", { agentId: "ghost", phase: "deep", dryRun: true }],
    ["dreams.schedule.get", { agentId: "ghost" }],
    ["dreams.schedule.set", { agentId: "ghost", phase: "deep", enabled: false }],
    ["dreams.enable", { agentId: "ghost", phase: "deep" }],
    ["dreams.disable", { agentId: "ghost", phase: "deep" }],
    ["dreams.status", { agentId: "ghost" }],
    ["dreams.log", { agentId: "ghost" }],
    ["dreams.diary", { agentId: "ghost" }],
  ];
  for (const [name, params] of agentScoped) {
    it(`${name} ${JSON.stringify(params)} refuses an unregistered agent and has no effect`, async () => {
      const { h, code, m } = setup();
      h.captures("beta", 3); // beta exists in the scheduler's list but is not registered with the RPC layer
      assert.equal(await code((m[name] as never as (p: unknown, c: unknown) => Promise<unknown>)(params, ctx())), "E_AGENT_UNKNOWN:not-registered");
      assert.equal(h.engine.calls.length, 0); assert.equal(h.store.listRuns().length, 0);
    });
  }

  it("an agent that the scheduler knows but the registry does not (a switched or removed owner) cannot be run or edited over RPC", async () => {
    const { h, code, m } = setup({ registered: ["alpha"] });
    h.captures("beta", 3);
    assert.equal(await code(m["dreams.run"]!({ agentId: "beta", phase: "deep" }, ctx())), "E_AGENT_UNKNOWN:not-registered");
    assert.equal(await code(m["dreams.disable"]!({ agentId: "beta", phase: "deep" }, ctx())), "E_AGENT_UNKNOWN:not-registered");
    assert.equal(h.store.getSchedule("beta", "deep")!.enabled, true);
    assert.equal(h.engine.callsFor("beta"), 0);
  });

  it("dreams.status without an agent lists what the scheduler's agent list names, with the phases in order", async () => {
    const { call } = setup();
    const st = await call("dreams.status", {});
    assert.deepEqual(st.agents.map((a: any) => a.agentId), ["alpha", "beta"]);
    assert.deepEqual(st.agents[0].phases.map((p: any) => p.phase), ["light", "rem", "deep"]);
    assert.equal(st.schemaVersion, 1);
    assert.deepEqual(Object.keys(st.counters).sort(), ["breakerTrips", "reconciled", "runs", "skips", "triggers"]);
  });
});

describe("dreams.* methods: availability", () => {
  const all: [string, object][] = [
    ["dreams.status", {}], ["dreams.log", {}], ["dreams.run", { agentId: "alpha", phase: "deep" }], ["dreams.schedule.get", { agentId: "alpha" }],
    ["dreams.schedule.set", { agentId: "alpha", phase: "deep", enabled: true }], ["dreams.enable", { agentId: "alpha", phase: "deep" }], ["dreams.disable", { agentId: "alpha", phase: "deep" }],
    ["dreams.diary", { agentId: "alpha" }],
  ];
  for (const [name, params] of all) {
    it(`${name} answers E_NOT_AVAILABLE with the reason and the cause while the scheduler is down`, async () => {
      const m = buildDreamsMethods({ dreams: () => null, agents: { list: () => ["alpha"], has: () => true, scaffold: () => {}, workspaceOf: () => "/ws" }, unavailableBecause: () => "disk full" });
      await assert.rejects((m[name] as never as (p: unknown, c: unknown) => Promise<unknown>)(params, ctx()), (e: any) => e instanceof RpcError && e.error === "E_NOT_AVAILABLE" && e.reason === "dreams-unavailable" && e.detail === "disk full");
    });
  }
  it("without a cause the detail is simply absent", async () => {
    const m = buildDreamsMethods({ dreams: () => null, agents: { list: () => [], has: () => false, scaffold: () => {}, workspaceOf: () => "/ws" } });
    await assert.rejects(m["dreams.status"]!({}, ctx()), (e: any) => e.error === "E_NOT_AVAILABLE" && e.detail === undefined);
  });
  it("exposes exactly the eight documented methods", () => {
    const { m } = setup();
    assert.deepEqual(Object.keys(m).sort(), ["dreams.diary", "dreams.disable", "dreams.enable", "dreams.log", "dreams.run", "dreams.schedule.get", "dreams.schedule.set", "dreams.status"]);
  });
});

describe("dreams.run", () => {
  it("dryRun answers wouldRun and the reason, writes no ledger row and calls no engine job", async () => {
    const { h, call } = setup(); h.captures("alpha", 1);
    const plan = await call("dreams.run", { agentId: "alpha", phase: "deep", dryRun: true });
    assert.equal(plan.dryRun, true); assert.equal(plan.wouldRun, false); assert.equal(plan.reason, "min_corpus");
    assert.deepEqual(plan.jobs, ["consolidate-daily", "auto-accept-stale", "gc-run"]);
    assert.equal(h.store.listRuns().length, 0); assert.equal(h.engine.calls.length, 0);
  });

  it("a real run is a manual run: the row says manual, the projection has a duration and a closed schema shape", async () => {
    const { h, call } = setup(); h.captures("alpha", 3);
    const r = await call("dreams.run", { agentId: "alpha", phase: "rem" });
    assert.equal(r.trigger, "manual"); assert.equal(r.outcome, "completed"); assert.equal(r.durationMs, 0); assert.equal(r.claimed, true);
    assert.deepEqual(Object.keys(r).sort(), ["agentId", "claimed", "costMicros", "counts", "durationMs", "error", "finishedAt", "idempotencyKey", "jobId", "logPath", "outcome", "partition", "phase", "reason", "runId", "scheduledFor", "startedAt", "tokensIn", "tokensOut", "trigger"]);
    assert.ok(Object.values(r.counts).every((v) => typeof v === "number"));
  });

  it("the caller's abort signal reaches the run: a cancelled caller yields aborted/cancelled", async () => {
    const { h, call } = setup(); h.captures("alpha", 3);
    const ac = new AbortController();
    h.engine.behaviours.set("rem-dream", () => { ac.abort(); return {}; });
    const r = await call("dreams.run", { agentId: "alpha", phase: "rem" }, ac.signal);
    assert.equal(r.outcome, "aborted"); assert.equal(r.reason, "cancelled");
  });

  it("a failing engine job is an answered run (failed), not an RPC error", async () => {
    const { h, call } = setup(); h.captures("alpha", 3);
    h.engine.behaviours.set("rem-dream", () => { throw new Error("engine down"); });
    const r = await call("dreams.run", { agentId: "alpha", phase: "rem" });
    assert.equal(r.outcome, "failed"); assert.equal(r.error.message, "engine down");
  });
});

describe("dreams.status and dreams.log projections", () => {
  it("a run in flight has no finishedAt/duration; a disabled phase reports no next run", async () => {
    const { h, call } = setup(); h.captures("alpha", 3);
    let release!: () => void;
    h.engine.behaviours.set("rem-dream", () => new Promise((r) => { release = () => r({}); }));
    const running = h.sched.runPhase("alpha", "rem", { trigger: "manual" });
    await settle();
    const st = await call("dreams.status", { agentId: "alpha" });
    const rem = st.agents[0].phases.find((p: any) => p.phase === "rem");
    assert.equal(rem.running, true); assert.equal(rem.lastRun.outcome, null); assert.equal(rem.lastRun.finishedAt, null); assert.equal(rem.lastRun.durationMs, null);
    release(); await running;
    await call("dreams.disable", { agentId: "alpha", phase: "rem" });
    const after = (await call("dreams.status", { agentId: "alpha" })).agents[0].phases.find((p: any) => p.phase === "rem");
    assert.equal(after.enabled, false); assert.equal(after.nextRunAt, null); assert.equal(after.running, false);
  });

  it("dreams.log by phase and limit filters the ledger; by runId returns the run and its log text; an unknown id is E_NOT_FOUND", async () => {
    const { h, call, code, m } = setup(); h.captures("alpha", 3);
    const a = await call("dreams.run", { agentId: "alpha", phase: "rem" });
    await call("dreams.run", { agentId: "alpha", phase: "deep" });
    assert.equal((await call("dreams.log", { agentId: "alpha", phase: "rem" })).runs.length, 1);
    assert.equal((await call("dreams.log", { agentId: "alpha", limit: 1 })).runs.length, 1);
    assert.equal((await call("dreams.log", {})).runs.length, 2);
    const one = await call("dreams.log", { runId: a.runId });
    assert.equal(one.runs[0].runId, a.runId); assert.match(one.log, /job rem-dream completed/);
    assert.equal(await code(m["dreams.log"]!({ runId: "does-not-exist" }, ctx())), "E_NOT_FOUND");
  });
});

describe("dreams.schedule.* and enable/disable", () => {
  it("set validates before writing: a bad cron or timezone maps to E_INVALID_PARAMS with the field named, and the row is unchanged", async () => {
    const { h, call, code } = setup(); await call("dreams.schedule.get", { agentId: "alpha" });
    const before = h.store.getSchedule("alpha", "deep");
    assert.equal(await code(call("dreams.schedule.set", { agentId: "alpha", phase: "deep", cron: "61 * * * *" })), "E_INVALID_PARAMS/cron");
    assert.equal(await code(call("dreams.schedule.set", { agentId: "alpha", phase: "deep", cron: "* * *" })), "E_INVALID_PARAMS/cron");
    assert.equal(await code(call("dreams.schedule.set", { agentId: "alpha", phase: "deep", timezone: "Nowhere/Land" })), "E_INVALID_PARAMS/timezone");
    assert.deepEqual(h.store.getSchedule("alpha", "deep"), before);
  });

  it("set changes cron and timezone together and answers the recomputed next run in the new zone", async () => {
    const { call } = setup();
    const r = await call("dreams.schedule.set", { agentId: "alpha", phase: "deep", cron: "30 6 * * *", timezone: "Asia/Tokyo" });
    assert.deepEqual({ cron: r.schedule.cron, tz: r.schedule.timezone, enabled: r.schedule.enabled }, { cron: "30 6 * * *", tz: "Asia/Tokyo", enabled: true });
    assert.equal(new Date(r.schedule.nextRunAt).toISOString(), "2026-10-13T21:30:00.000Z"); // 06:30 JST on the 14th
  });

  it("get answers the three phases in order, each in the closed projection (no signal columns)", async () => {
    const { call } = setup();
    const g = await call("dreams.schedule.get", { agentId: "alpha" });
    assert.deepEqual(g.schedules.map((s: any) => s.phase), ["light", "rem", "deep"]);
    assert.deepEqual(Object.keys(g.schedules[0]).sort(), ["agentId", "cron", "enabled", "nextRunAt", "phase", "staggerOffsetS", "timezone"]);
    assert.equal(g.schedules[0].timezone, "UTC");
  });

  it("disable then enable: off reports no next run, on recomputes from now", async () => {
    const { h, call } = setup();
    assert.equal((await call("dreams.disable", { agentId: "alpha", phase: "light" })).schedule.nextRunAt, null);
    await h.clock.advance(5 * HOUR);
    const on = await call("dreams.enable", { agentId: "alpha", phase: "light" });
    assert.equal(on.schedule.enabled, true);
    assert.equal(new Date(on.schedule.nextRunAt).toISOString(), new Date(T0 + 8 * HOUR).toISOString(), "the first light slot after 05:00 is 08:00");
  });

  it("enabling an already enabled phase keeps its stored next run (no reset)", async () => {
    const { h, call } = setup();
    await call("dreams.schedule.get", { agentId: "alpha" });
    const before = h.store.getSchedule("alpha", "rem")!.nextRunAt;
    await h.clock.advance(10 * 60_000);
    const r = await call("dreams.enable", { agentId: "alpha", phase: "rem" });
    assert.equal(r.schedule.nextRunAt, before);
  });
});

describe("dreams.diary", () => {
  const asRole = (role: Role): Principal => ({ userId: "u-1", role, kind: "person" });

  it("Diary only with the right (viewer sees nothing foreign).", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] });
    const alphaDiary = path.join(h.dir, "alpha-dreaming.md");
    const betaDiary = path.join(h.dir, "beta-dreaming.md");
    writeFileSync(alphaDiary, "alpha private notes\nauthorization: Bearer x\n");
    writeFileSync(betaDiary, "beta private notes\n");
    const sched = h.make({ diaryPath: (id) => (id === "alpha" ? alphaDiary : id === "beta" ? betaDiary : null) });
    const agents = { list: () => ["alpha", "beta"], has: (id: string) => id === "alpha" || id === "beta", scaffold: () => {}, workspaceOf: (id: string) => `/ws/${id}` };
    const raw = buildDreamsMethods({ dreams: () => sched, agents });
    const wrap = (role: Role) => guardMethods(raw, { resolve: () => asRole(role), audit: memoryAuditSink(), now: () => T0 });
    const viewer = wrap("viewer");
    const owner = wrap("owner");
    await assert.rejects(viewer["dreams.diary"]!({ agentId: "alpha" }, ctx()), (e: any) => e instanceof RpcError && e.error === "E_DENIED");
    await assert.rejects(viewer["dreams.diary"]!({ agentId: "beta" }, ctx()), (e: any) => e instanceof RpcError && e.error === "E_DENIED");
    const alpha = await owner["dreams.diary"]!({ agentId: "alpha" }, ctx()) as { exists: boolean; text: string };
    assert.equal(alpha.exists, true);
    assert.match(alpha.text, /alpha private notes/);
    assert.equal(alpha.text.includes("Bearer x"), false);
    assert.equal(alpha.text.includes("beta private"), false);
    const beta = await owner["dreams.diary"]!({ agentId: "beta" }, ctx()) as { text: string };
    assert.match(beta.text, /beta private notes/);
  });

  it("redacts authorization headers in diary text", async () => {
    const h = harness(dirs, { agents: ["alpha"] });
    const diary = path.join(h.dir, "dreaming.md");
    writeFileSync(diary, "notes\nauthorization: Bearer x\n");
    const sched = h.make({ diaryPath: () => diary });
    const agents = { list: () => ["alpha"], has: () => true, scaffold: () => {}, workspaceOf: () => "/ws/alpha" };
    const m = buildDreamsMethods({ dreams: () => sched, agents });
    const r = await (m["dreams.diary"] as (p: unknown, c: unknown) => Promise<any>)({ agentId: "alpha" }, ctx());
    assert.equal(r.exists, true);
    assert.equal(r.text.includes("Bearer x"), false);
    assert.match(r.text, /authorization:/i);
  });

  it("an agent with no diary file answers exists false and empty text", async () => {
    const { call } = setup();
    const r = await call("dreams.diary", { agentId: "alpha" });
    assert.equal(r.agentId, "alpha");
    assert.equal(r.exists, false);
    assert.equal(r.text, "");
    assert.equal(r.truncated, false);
  });
});

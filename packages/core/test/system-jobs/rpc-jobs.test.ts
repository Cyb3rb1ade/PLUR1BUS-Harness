// jobs.list / jobs.run / jobs.history over the real method table with a real system-jobs registry: unknown jobs, the
// stored states, paging through the RPC, and RBAC (the module checks nothing itself; the guard in front of jobs.run does).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { guardMethods, type PrincipalResolver } from "../../src/rbac/guard.ts";
import type { Principal, Role } from "../../src/rbac/types.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { buildMethods } from "../../src/rpc/methods.ts";
import type { CallContext, Handler } from "../../src/rpc/server.ts";
import type { SystemJobOutcome } from "../../src/system-jobs/index.ts";
import { scriptedHandler, setup, T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();

function rpc(over: { withSystemJobs?: boolean } = {}) {
  const s = setup(dirs);
  const engineRuns: { name: string; agentId: string; opts: unknown }[] = [];
  const engineHistory: { agentId: string; opts: unknown }[] = [];
  const agentJobs = [{ name: "consolidate", needsLlm: true, singleton: true, phase: "deep" as const }, { name: "gc-run", needsLlm: false, singleton: true }];
  const engine = {
    jobs: {
      list: () => [...agentJobs],
      run: async (name: string, agentId: string, opts: unknown) => { engineRuns.push({ name, agentId, opts }); return { runId: "eng-run", job: name, agentId, trigger: "harness", startedAt: T0, finishedAt: T0 + 1, durationMs: 1, outcome: "completed", attempt: 1 }; },
      history: async (agentId: string, opts: unknown) => { engineHistory.push({ agentId, opts }); return [{ runId: "eng-h1", job: "consolidate", agentId }]; },
    },
  };
  const agents = { has: (id: string) => id === "bernd", workspaceOf: (id: string) => (id === "bernd" ? "/ws/bernd" : undefined), list: () => ["bernd"], scaffold: () => {} };
  const activity = { set() {}, idle() {}, get: () => ({ state: "idle", since: T0 }) };
  const methods = buildMethods({
    engine, config: () => ({}), agents, activity, logger: { warn() {}, info() {}, debug() {}, error() {} }, status: () => ({}), shutdown() {}, journalBacklog: () => 0,
    clock: () => s.clock.now(), captureSignal: new AbortController().signal, isStopping: () => false, adopt: () => ({}), onMigrated() {},
    ...(over.withSystemJobs === false ? {} : { systemJobs: s.jobs }),
  } as never);
  const ctx = (signal = new AbortController().signal): CallContext => ({ requestId: "r1", connectionId: "c1", signal });
  const call = (name: string, params: unknown, signal?: AbortSignal) => (methods[name] as Handler)(params as never, ctx(signal)) as Promise<any>;
  const err = (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof RpcError ? { error: e.error, detail: e.detail, reason: e.reason } : { other: String(e) }));
  return { s, call, err, methods, engineRuns, engineHistory, ctx };
}

describe("jobs.list", () => {
  it("defaults to the engine's (agent) jobs only; the same for kind 'agent' and for no params", async () => {
    const { s, call } = rpc(); s.jobs.register(scriptedHandler({ name: "models.scan" }).handler);
    const a = await call("jobs.list", undefined); const b = await call("jobs.list", {}); const c = await call("jobs.list", { kind: "agent" });
    assert.deepEqual(a.jobs.map((j: any) => j.name), ["consolidate", "gc-run"]);
    assert.deepEqual(a, b); assert.deepEqual(b, c);
  });

  it("'system' lists the system jobs in registration order, 'all' lists agent jobs first and then system jobs; both are repeatable", async () => {
    const { s, call } = rpc();
    for (const name of ["zz.scan", "aa.scan"]) s.jobs.register(scriptedHandler({ name }).handler);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual((await call("jobs.list", { kind: "system" })).jobs.map((j: any) => j.name), ["zz.scan", "aa.scan"]);
      assert.deepEqual((await call("jobs.list", { kind: "all" })).jobs.map((j: any) => `${j.kind ?? "agent"}:${j.name}`), ["agent:consolidate", "agent:gc-run", "system:zz.scan", "system:aa.scan"]);
    }
  });

  it("without a system-jobs registry 'system' is empty and 'all' is the agent jobs", async () => {
    const { call } = rpc({ withSystemJobs: false });
    assert.deepEqual((await call("jobs.list", { kind: "system" })).jobs, []);
    assert.deepEqual((await call("jobs.list", { kind: "all" })).jobs.map((j: any) => j.name), ["consolidate", "gc-run"]);
  });
});

describe("jobs.run", () => {
  it("an unknown job is E_INVALID_PARAMS: detail 'job' when the agent is addressed, 'agentId' when it is not", async () => {
    const { call, err, engineRuns, s } = rpc();
    assert.deepEqual(await err(call("jobs.run", { job: "nope", agentId: "bernd" })), { error: "E_INVALID_PARAMS", detail: "job", reason: undefined });
    assert.deepEqual(await err(call("jobs.run", { job: "nope" })), { error: "E_INVALID_PARAMS", detail: "agentId", reason: undefined });
    assert.deepEqual(engineRuns, []); assert.equal(existsSync(s.ledgerPath), false);
  });

  it("an unregistered agent is E_AGENT_UNKNOWN before the job is even looked up", async () => {
    const { call, err } = rpc();
    assert.equal((await err(call("jobs.run", { job: "nope", agentId: "ghost" })))!.error, "E_AGENT_UNKNOWN");
    assert.equal((await err(call("jobs.run", { job: "consolidate", agentId: "ghost" })))!.error, "E_AGENT_UNKNOWN");
  });

  it("an agent job goes to the engine with the harness trigger; no system run is recorded", async () => {
    const { call, engineRuns, s } = rpc();
    const r = await call("jobs.run", { job: "consolidate", agentId: "bernd" });
    assert.equal(r.runId, "eng-run"); assert.equal(engineRuns.length, 1); assert.equal(engineRuns[0]!.agentId, "bernd");
    assert.equal((engineRuns[0]!.opts as { trigger: string }).trigger, "harness");
    assert.deepEqual(s.jobs.history({}), []);
  });

  it("a system job run is a manual run and its record is the first row of jobs.history", async () => {
    const { s, call } = rpc(); s.jobs.register(scriptedHandler({ name: "models.scan" }).handler);
    const r = await call("jobs.run", { job: "models.scan" });
    assert.equal(r.trigger, "manual"); assert.equal(r.kind, "system"); assert.equal("agentId" in r, false);
    assert.deepEqual((await call("jobs.history", {})).runs[0], r);
  });

  it("the connection's signal reaches the job; a cancelled run is stored as the job reports it", async () => {
    const { s, call } = rpc();
    s.jobs.register(scriptedHandler({ name: "cancellable", run: async (_a, ctx) => (ctx.signal.aborted ? { outcome: "abandoned", reason: "aborted", detail: null } : { outcome: "completed", detail: null }) }).handler);
    const ac = new AbortController(); ac.abort();
    const r = await call("jobs.run", { job: "cancellable" }, ac.signal);
    assert.equal(r.outcome, "abandoned"); assert.equal(r.reason, "aborted");
    assert.equal((await call("jobs.history", { job: "cancellable" })).runs[0].outcome, "abandoned");
  });

  it("a job that throws surfaces its error to the caller and is stored as failed/exception; the next run is not blocked", async () => {
    const { s, call } = rpc(); let n = 0;
    s.jobs.register(scriptedHandler({ name: "flaky", run: async () => { if (++n === 1) throw new RpcError("E_INTERNAL", "scan blew up"); return { outcome: "completed", detail: null }; } }).handler);
    assert.deepEqual(await (async () => { try { await call("jobs.run", { job: "flaky" }); return null; } catch (e) { return (e as RpcError).error; } })(), "E_INTERNAL");
    assert.equal((await call("jobs.run", { job: "flaky" })).outcome, "completed");
    assert.deepEqual((await call("jobs.history", { job: "flaky" })).runs.map((r: any) => [r.outcome, r.reason]), [["completed", undefined], ["failed", "exception"]]);
    assert.equal(s.failed.length, 1);
  });

  it("every stored state survives the RPC: completed, skipped, failed, incomplete, abandoned", async () => {
    const { s, call } = rpc(); const seq: SystemJobOutcome["outcome"][] = ["completed", "skipped", "failed", "incomplete", "abandoned"]; let i = 0;
    s.jobs.register(scriptedHandler({ name: "states", run: async () => ({ outcome: seq[i++]!, reason: "r", detail: null }) }).handler);
    for (let k = 0; k < seq.length; k++) await call("jobs.run", { job: "states" });
    assert.deepEqual((await call("jobs.history", { job: "states" })).runs.map((r: any) => r.outcome), [...seq].reverse());
  });
});

describe("jobs.history", () => {
  async function filled() {
    const r = rpc(); for (const name of ["a.scan", "b.scan"]) r.s.jobs.register(scriptedHandler({ name }).handler);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) { await r.s.clock.advance(1000); ids.push((await r.call("jobs.run", { job: i % 2 ? "b.scan" : "a.scan" })).runId); }
    return { ...r, ids };
  }

  it("without agentId it is the system runs, newest first; limit, job and since page through them", async () => {
    const { call, ids, s } = await filled();
    const all = (await call("jobs.history", {})).runs; assert.deepEqual(all.map((r: any) => r.runId), [...ids].reverse());
    assert.deepEqual((await call("jobs.history", { limit: 2 })).runs.map((r: any) => r.runId), [...ids].reverse().slice(0, 2));
    assert.deepEqual((await call("jobs.history", { limit: 0 })).runs, []);
    assert.deepEqual((await call("jobs.history", { job: "a.scan" })).runs.map((r: any) => r.job), ["a.scan", "a.scan", "a.scan"]);
    assert.equal((await call("jobs.history", { since: T0 + 4000 })).runs.length, 3, `3 runs finished at or after ${new Date(T0 + 4000).toISOString()} (clock ${s.clock.now()})`);
    assert.equal((await call("jobs.history", { job: "a.scan", since: T0 + 4000, limit: 1 })).runs.length, 1);
  });

  it("with a registered agent it is that agent's engine history, with job/since/limit handed on; the system runs are not mixed in", async () => {
    const { call, engineHistory } = await filled();
    const r = await call("jobs.history", { agentId: "bernd", job: "consolidate", since: 5, limit: 3 });
    assert.deepEqual(r.runs, [{ runId: "eng-h1", job: "consolidate", agentId: "bernd" }]);
    assert.deepEqual(engineHistory, [{ agentId: "bernd", opts: { job: "consolidate", since: 5, limit: 3 } }]);
  });

  it("an agent with a system job's name is an empty list (system runs have no agent), and the engine is not asked", async () => {
    const { call, engineHistory } = await filled();
    assert.deepEqual((await call("jobs.history", { agentId: "bernd", job: "a.scan" })).runs, []);
    assert.deepEqual(engineHistory, []);
  });

  it("an unregistered agent is E_AGENT_UNKNOWN", async () => {
    const { call, err } = await filled();
    assert.equal((await err(call("jobs.history", { agentId: "ghost" })))!.error, "E_AGENT_UNKNOWN");
  });

  it("without a system-jobs registry the system history is empty", async () => {
    const { call } = rpc({ withSystemJobs: false });
    assert.deepEqual((await call("jobs.history", {})).runs, []);
  });
});

describe("RBAC in front of jobs.run", () => {
  const person = (role: Role, over: Partial<Principal> = {}): Principal => ({ userId: `u-${role}`, kind: "person", role, ...over });
  function guarded(resolve: PrincipalResolver) {
    const r = rpc(); const handlerCalls = scriptedHandler({ name: "models.scan" }); r.s.jobs.register(handlerCalls.handler);
    const audit = memoryAuditSink();
    const g = guardMethods(r.methods, { resolve, audit, now: () => r.s.clock.now() });
    const call = (name: string, params: unknown) => (g[name] as Handler)(params as never, r.ctx()) as Promise<any>;
    return { ...r, call, audit, handlerCalls };
  }

  for (const role of ["owner", "admin", "operator"] as const) {
    it(`${role} may run a system job`, async () => {
      const g = guarded(() => person(role));
      assert.equal((await g.call("jobs.run", { job: "models.scan" })).outcome, "completed");
      assert.equal(g.handlerCalls.calls.length, 1);
    });
  }
  for (const role of ["member", "viewer"] as const) {
    it(`${role} is refused (E_DENIED role-denied): the job does not start, nothing is written, the refusal is audited`, async () => {
      const g = guarded(() => person(role));
      assert.deepEqual(await g.err(g.call("jobs.run", { job: "models.scan" })), { error: "E_DENIED", detail: undefined, reason: "role-denied" });
      assert.equal(g.handlerCalls.calls.length, 0); assert.equal(existsSync(g.s.ledgerPath), false);
      assert.deepEqual(g.audit.events.map((e: any) => e.action), ["rbac.denied"]);
    });
  }

  it("no principal and a failing resolver are E_UNAUTHORIZED, and nothing runs", async () => {
    for (const resolve of [(() => null) as PrincipalResolver, (() => { throw new Error("x"); }) as PrincipalResolver]) {
      const g = guarded(resolve);
      assert.equal((await g.err(g.call("jobs.run", { job: "models.scan" })))!.error, "E_UNAUTHORIZED");
      assert.equal(g.handlerCalls.calls.length, 0);
    }
  });

  it("an API token's scopes narrow the role: a token without jobs.run is refused with token-scope, one with it passes", async () => {
    const without = guarded(() => person("admin", { tokenScopes: ["memory.*"] }));
    assert.deepEqual(await without.err(without.call("jobs.run", { job: "models.scan" })), { error: "E_DENIED", detail: undefined, reason: "token-scope" });
    const withScope = guarded(() => person("admin", { tokenScopes: ["jobs.run"] }));
    assert.equal((await withScope.call("jobs.run", { job: "models.scan" })).outcome, "completed");
  });

  it("an agent principal whose role is member or viewer cannot run a system job", async () => {
    for (const role of ["member", "viewer"] as const) {
      const g = guarded(() => ({ userId: "agent:bernd", kind: "agent", role }));
      assert.equal((await g.err(g.call("jobs.run", { job: "models.scan" })))!.reason, "role-denied", role);
      assert.equal(g.handlerCalls.calls.length, 0);
    }
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: jobs.run is not human-only, so an agent-kind principal that carries the operator role is let through", async () => {
    // docs/rbac.md secures jobs.run by role (Owner, Admin, Operator) and does not say what an agent principal may do here;
    // no shipped resolver gives an agent principal a role, so this is reachable only through a custom resolver.
    const g = guarded(() => ({ userId: "agent:bernd", kind: "agent", role: "operator" }));
    assert.equal((await g.call("jobs.run", { job: "models.scan" })).outcome, "completed");
  });

  it("jobs.list and jobs.history stay open to every role (docs/rbac.md: 'Not yet secured')", async () => {
    for (const role of ["owner", "viewer", "member"] as const) {
      const g = guarded(() => person(role));
      assert.ok(Array.isArray((await g.call("jobs.list", { kind: "all" })).jobs), role);
      assert.ok(Array.isArray((await g.call("jobs.history", {})).runs), role);
    }
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { connect, type CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../src/core.ts";
import { FakeClock } from "../src/discovery/testing.ts";
import { buildDreamsMethods } from "../src/dreams/methods.ts";
import { layout } from "../src/paths.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { mkHarness, T0 } from "./helpers/dreams.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const ctx = { signal: new AbortController().signal, connectionId: "c1" } as never;
const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

describe("dreams.* handlers", () => {
  const mk = () => {
    const h = mkHarness();
    const agents = { list: () => ["bernd"], has: (id: string) => id === "bernd", scaffold: () => {}, workspaceOf: (id: string) => (id === "bernd" ? "/ws/bernd" : undefined) };
    const m = buildDreamsMethods({ dreams: () => h.sched, agents });
    const call = async (name: string, params: unknown) => {
      assert.deepEqual(validateParams(name, params), { ok: true }, `${name} params`);
      const res = await (m[name] as (p: unknown, c: unknown) => Promise<unknown>)(params, ctx);
      assert.deepEqual(validateResult(name, res), { ok: true }, `${name} result ${JSON.stringify(res)}`);
      return res as any;
    };
    return { h, call, m };
  };

  it("every method answers in its closed schema shape", async () => {
    const { h, call } = mk();
    h.captures("bernd", 3);
    const status = await call("dreams.status", { agentId: "bernd" });
    assert.deepEqual(status.agents[0].phases.map((p: any) => p.phase), ["light", "rem", "deep"]);
    const run = await call("dreams.run", { agentId: "bernd", phase: "deep" });
    assert.equal(run.outcome, "completed"); assert.equal(run.durationMs, 0);
    const again = await call("dreams.run", { agentId: "bernd", phase: "deep" });
    assert.equal(again.reason, "idempotent");
    const plan = await call("dreams.run", { agentId: "bernd", phase: "deep", dryRun: true });
    assert.equal(plan.dryRun, true); assert.equal(plan.wouldRun, false); assert.equal(plan.reason, "idempotent");
    const log = await call("dreams.log", { agentId: "bernd", phase: "deep" });
    assert.equal(log.runs.length, 2);
    const one = await call("dreams.log", { runId: run.runId });
    assert.match(one.log, /finish outcome=completed/);
    const off = await call("dreams.disable", { agentId: "bernd", phase: "deep" });
    assert.equal(off.schedule.enabled, false); assert.equal(off.schedule.nextRunAt, null);
    const on = await call("dreams.enable", { agentId: "bernd", phase: "deep" });
    assert.equal(on.schedule.enabled, true); assert.ok(on.schedule.nextRunAt > T0);
    const set = await call("dreams.schedule.set", { agentId: "bernd", phase: "rem", cron: "30 2 * * *", timezone: "Europe/Berlin" });
    assert.equal(set.schedule.cron, "30 2 * * *");
    const get = await call("dreams.schedule.get", { agentId: "bernd" });
    assert.deepEqual(get.schedules.map((s: any) => s.phase), ["light", "rem", "deep"]);
  });

  it("refuses an unknown agent, a bad cron, a bad timezone, an unknown run, and an empty edit", async () => {
    const { m } = mk();
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof RpcError ? `${e.error}:${e.detail ?? e.reason ?? ""}` : String(e)));
    assert.equal(await code(m["dreams.run"]!({ agentId: "ghost", phase: "deep" }, ctx)), "E_AGENT_UNKNOWN:not-registered");
    assert.equal(await code(m["dreams.schedule.set"]!({ agentId: "bernd", phase: "deep", cron: "nope" }, ctx)), "E_INVALID_PARAMS:cron");
    assert.equal(await code(m["dreams.schedule.set"]!({ agentId: "bernd", phase: "deep", timezone: "Mars/Olympus" }, ctx)), "E_INVALID_PARAMS:timezone");
    assert.equal(await code(m["dreams.log"]!({ runId: "nope" }, ctx)), "E_NOT_FOUND:");
    assert.deepEqual(validateParams("dreams.schedule.set", { agentId: "bernd", phase: "deep" }).ok, false, "an edit that changes nothing is invalid");
    assert.deepEqual(validateParams("dreams.run", { agentId: "bernd", phase: "dawn" }).ok, false);
  });

  it("answers E_NOT_AVAILABLE while the scheduler is not running", async () => {
    const m = buildDreamsMethods({ dreams: () => null, agents: { list: () => ["bernd"], has: () => true, scaffold: () => {}, workspaceOf: () => "/ws" } });
    await assert.rejects(m["dreams.status"]!({}, ctx), (e: any) => e.error === "E_NOT_AVAILABLE" && e.reason === "dreams-unavailable");
  });
});

describe("dreams over a real core and engine", () => {
  const home = tempDir("p1b-dreams-core-");
  const clock = new FakeClock(T0);
  let core: Core; let c: CoreClient;
  before(async () => {
    const cfg = defaults(); cfg.agents.bernd = {};
    cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, runtime: { recallTimeoutMs: 10_000 } };
    cfg.engine.duplicateThreshold = 1.01;
    writeFileSync(layout(home).configPath, JSON.stringify(cfg));
    core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: true, clock, defaultTimezone: "UTC" } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("lists the dreams methods in core.auth, and status shows three scheduled phases", async () => {
    for (const n of ["dreams.status", "dreams.log", "dreams.run", "dreams.schedule.get", "dreams.schedule.set", "dreams.enable", "dreams.disable"]) assert.ok(c.hello.capabilities?.methods[n], n);
    const st = await c.call<any>("dreams.status", { agentId: "bernd" });
    assert.deepEqual(st.agents[0].phases.map((p: any) => [p.phase, p.enabled, p.cron, p.timezone]), [["light", true, "0 */4 * * *", "UTC"], ["rem", true, "15 1 * * *", "UTC"], ["deep", true, "0 4 * * *", "UTC"]]);
    assert.ok(st.agents[0].phases.every((p: any) => p.nextRunAt > T0));
  });

  it("captures feed the importance signal; a manual run goes through engine.jobs and leaves a ledger row, whatever its outcome", async () => {
    for (let i = 0; i < 3; i++) await c.call("memory.capture", { caller, agentId: "bernd", messages: [{ role: "user", content: `fact ${i}: the sky is ${i} blue` }, { role: "assistant", content: "Noted." }], wait: true });
    const before = await c.call<any>("dreams.status", { agentId: "bernd" });
    assert.equal(before.agents[0].phases[0].importance.capturesSinceRun, 3);
    const run = await c.call<any>("dreams.run", { agentId: "bernd", phase: "light" });
    assert.notEqual(run.outcome, null);
    if (run.outcome !== "completed") assert.ok(run.reason, "a non-completed run says why");
    const log = await c.call<any>("dreams.log", { agentId: "bernd" });
    assert.ok(log.runs.some((r: any) => r.runId === run.runId));
    const dry = await c.call<any>("dreams.run", { agentId: "bernd", phase: "rem", dryRun: true });
    assert.equal(dry.dryRun, true);
  });
});

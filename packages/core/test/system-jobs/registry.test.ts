// system-jobs registry (spec §2.3): registration refusals, the list entry shape, and a stable order.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scriptedHandler, setup, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();

describe("system-jobs registry: register and has", () => {
  it("registers a handler and reports it with has(); unknown names and prototype-ish names are not registered", () => {
    const { jobs } = setup(dirs);
    jobs.register(scriptedHandler({ name: "a.job" }).handler);
    assert.equal(jobs.has("a.job"), true);
    for (const name of ["b.job", "", "A.JOB", "a.job ", "__proto__", "constructor", "toString"]) assert.equal(jobs.has(name), false, JSON.stringify(name));
  });

  it("refuses a name the engine already has, and registers nothing", () => {
    const { jobs } = setup(dirs, { engineHasJob: (n) => n === "gc-run" });
    assert.throws(() => jobs.register(scriptedHandler({ name: "gc-run" }).handler), /job name conflict: engine already has job gc-run/);
    assert.equal(jobs.has("gc-run"), false); assert.deepEqual(jobs.list(), []);
  });

  it("refuses registering the same system job twice and keeps the first handler", async () => {
    const { jobs } = setup(dirs);
    const first = scriptedHandler({ name: "dup" }); const second = scriptedHandler({ name: "dup" });
    jobs.register(first.handler);
    assert.throws(() => jobs.register(second.handler), /system job already registered: dup/);
    await jobs.run("dup", {}, { trigger: "manual" });
    assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 0);
  });

  it("asks the engine registry at registration time, not later (a job the engine gains afterwards does not unregister)", () => {
    const engine = new Set<string>();
    const { jobs } = setup(dirs, { engineHasJob: (n) => engine.has(n) });
    jobs.register(scriptedHandler({ name: "late" }).handler);
    engine.add("late");
    assert.equal(jobs.has("late"), true);
  });
});

describe("system-jobs registry: list", () => {
  it("is empty without handlers", () => { assert.deepEqual(setup(dirs).jobs.list(), []); });

  it("an entry is the closed documented shape: name, kind system, needsLlm false, singleton true, schedule, nextRunAt", () => {
    const { jobs } = setup(dirs);
    jobs.register(scriptedHandler({ name: "x.y", schedule: { every: 3_600_000, jitter: 0.25 }, nextRunAt: () => 1234 }).handler);
    assert.deepEqual(jobs.list(), [{ name: "x.y", kind: "system", needsLlm: false, singleton: true, schedule: { every: 3_600_000, jitter: 0.25 }, nextRunAt: 1234 }]);
  });

  it("nextRunAt is asked of the handler at every call (live), null while nothing is scheduled", () => {
    const { jobs } = setup(dirs);
    let next: number | null = null;
    jobs.register(scriptedHandler({ nextRunAt: () => next }).handler);
    assert.equal(jobs.list()[0]!.nextRunAt, null);
    next = 99; assert.equal(jobs.list()[0]!.nextRunAt, 99);
  });

  it("the returned schedule is a copy: changing it does not change the job", () => {
    const { jobs } = setup(dirs);
    jobs.register(scriptedHandler({ schedule: { every: 1000, jitter: 0.1 } }).handler);
    const first = jobs.list()[0]!; first.schedule.every = 1;
    assert.equal(jobs.list()[0]!.schedule.every, 1000);
  });

  it("is stable: the order is the registration order on every call (characterization: Ist-Verhalten, nicht spezifiziert: not alphabetical)", () => {
    const { jobs } = setup(dirs);
    const names = ["zeta.scan", "alpha.scan", "mid.scan", "beta.scan"];
    for (const name of names) jobs.register(scriptedHandler({ name }).handler);
    for (let i = 0; i < 5; i++) assert.deepEqual(jobs.list().map((j) => j.name), names);
  });

  it("a registration that was refused leaves the list as it was", () => {
    const { jobs } = setup(dirs, { engineHasJob: (n) => n === "taken" });
    jobs.register(scriptedHandler({ name: "ok" }).handler);
    assert.throws(() => jobs.register(scriptedHandler({ name: "taken" }).handler));
    assert.throws(() => jobs.register(scriptedHandler({ name: "ok" }).handler));
    assert.deepEqual(jobs.list().map((j) => j.name), ["ok"]);
  });
});

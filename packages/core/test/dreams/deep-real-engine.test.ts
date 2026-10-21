// dreams/deep-real-engine: the deep phase over the REAL pinned engine (98dfe2f0, contract 1.16.0), not a scripted registry (#606).
// The pinned engine has no recall statistics, so the production candidate source yields content-only cards and the promotion gate
// passes nothing. The deep jobs must run anyway: `engine.jobs.run` is called for all three, the model-free ones complete.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { FakeClock } from "../../src/discovery/testing.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { createCandidateSource } from "../../src/dreams/producer.ts";
import { DreamScheduler } from "../../src/dreams/scheduler.ts";
import { DreamStore } from "../../src/dreams/store.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { T0 } from "./helpers.ts";

const AGENT = "bernd";
const timeout = 60_000;

describe("deep phase over the real engine (#606)", () => {
  it("runs consolidate-daily, auto-accept-stale and gc-run although no candidate can pass the recall-stats gate", { timeout }, async () => {
    const home = tempDir("dreams-deep-real-");
    const l = layout(home);
    mkdirSync(l.workspaceDir(AGENT), { recursive: true });
    const engine = createEngine(createTempHost(l.state, async (id: string) => l.workspaceDir(id)), buildEngineConfig(defaults(), l) as any, { internals: flatTestInternals() }) as any;
    const store = new DreamStore(path.join(home, "dreams.db"));
    try {
      assert.deepEqual(engine.jobs.list().filter((j: { phase?: string }) => j.phase === "deep").map((j: { name: string }) => j.name), ["consolidate-daily"], "the engine's own deep-phase job");
      const sched = new DreamScheduler({
        store, engine, clock: new FakeClock(T0), agents: () => [AGENT], logsDir: path.join(home, "logs"), defaultTimezone: "UTC", staggerWindowS: 0,
        logger: { info() {}, warn() {}, error() {} },
        // What production wires: content-only agent-private cards, no recalls, no uniqueQueries.
        candidates: createCandidateSource({ list: () => [{ content: "a fact the engine never reported a recall for", partition: "agent-private" }] }),
      });
      for (let i = 0; i < 3; i++) sched.recordCapture(AGENT, 1);
      const run = await sched.runPhase(AGENT, "deep", { trigger: "manual" });

      // Before #606 this run ended skipped/no_candidates with no engine call at all.
      assert.notEqual(run.reason, "no_candidates");
      assert.equal(run.counts.jobs, 3, "all three deep jobs went through engine.jobs.run");
      assert.equal(run.counts.candidates, 1); assert.equal(run.counts.promotable, 0); assert.equal(run.counts.promoted, undefined);
      assert.equal(store.listCandidates(AGENT, "promoted").length, 0, "nothing is promoted without recall statistics");
      assert.equal(store.listCandidates(AGENT, "shortlisted").length, 1);

      const history = (await engine.jobs.history(AGENT, { limit: 20 })) as { job: string; outcome: string; trigger: string; reason?: string }[];
      const byJob = new Map(history.map((h) => [h.job, h]));
      for (const job of ["consolidate-daily", "auto-accept-stale", "gc-run"]) assert.equal(byJob.get(job)?.trigger, "harness", `${job} ran through the scheduler`);
      assert.equal(byJob.get("auto-accept-stale")!.outcome, "completed");
      assert.equal(byJob.get("gc-run")!.outcome, "completed");
      // The engine ships consolidate-daily switched off (engine.dailyConsolidation.enabled defaults to false): it skips, and the
      // primary job decides the run, so the ledger honestly says skipped with the engine's reason and the corpus stays eligible.
      // With the key set to true the same run completes (needs a model, so not exercised here).
      assert.equal(byJob.get("consolidate-daily")!.outcome, "skipped");
      assert.equal(byJob.get("consolidate-daily")!.reason, "dailyConsolidation_disabled");
      assert.equal(run.outcome, "skipped"); assert.equal(run.reason, "dailyConsolidation_disabled");
    } finally {
      store.close();
      await engine.close({ budgetMs: 5_000 });
    }
  });
});

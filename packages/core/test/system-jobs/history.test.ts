// system-jobs history: newest first, the job/since/limit filters (the only paging the module offers), and a seeded oracle.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SystemRunRecord } from "../../src/system-jobs/index.ts";
import { mulberry32, scriptedHandler, setup, useTempDirs, type Setup } from "./helpers.ts";

const dirs = useTempDirs();

async function runs(s: Setup, plan: { job: string; gapMs: number; outcome?: "completed" | "failed" | "skipped" }[]): Promise<SystemRunRecord[]> {
  const out: SystemRunRecord[] = [];
  for (const p of plan) {
    await s.clock.advance(p.gapMs);
    out.push((await s.jobs.run(p.job, {}, { trigger: "manual" })).record);
  }
  return out;
}
function twoJobs(s: Setup, outcome?: () => "completed" | "failed" | "skipped") {
  for (const name of ["a.job", "b.job"]) s.jobs.register(scriptedHandler({ name, run: async () => ({ outcome: outcome ? outcome() : "completed", detail: null }) }).handler);
}

describe("system-jobs history: order and limit", () => {
  it("is empty before any run, with and without filters", () => {
    const s = setup(dirs); twoJobs(s);
    assert.deepEqual(s.jobs.history({}), []); assert.deepEqual(s.jobs.history({ job: "a.job", since: 0, limit: 5 }), []);
  });

  it("returns the newest run first", async () => {
    const s = setup(dirs); twoJobs(s);
    const all = await runs(s, [{ job: "a.job", gapMs: 10 }, { job: "b.job", gapMs: 10 }, { job: "a.job", gapMs: 10 }]);
    assert.deepEqual(s.jobs.history({}).map((r) => r.runId), all.map((r) => r.runId).reverse());
  });

  it("limit takes the newest N; 0 is an empty page; larger than the history returns everything; no limit returns everything", async () => {
    const s = setup(dirs); twoJobs(s);
    const all = await runs(s, Array.from({ length: 7 }, (_, i) => ({ job: i % 2 ? "a.job" : "b.job", gapMs: 5 })));
    const newest = all.map((r) => r.runId).reverse();
    assert.deepEqual(s.jobs.history({ limit: 3 }).map((r) => r.runId), newest.slice(0, 3));
    assert.deepEqual(s.jobs.history({ limit: 1 }).map((r) => r.runId), newest.slice(0, 1));
    assert.deepEqual(s.jobs.history({ limit: 0 }), []);
    assert.equal(s.jobs.history({ limit: 100 }).length, 7); assert.equal(s.jobs.history({}).length, 7);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: a negative limit is ignored (everything is returned)", async () => {
    const s = setup(dirs); twoJobs(s);
    await runs(s, [{ job: "a.job", gapMs: 1 }, { job: "a.job", gapMs: 1 }]);
    assert.equal(s.jobs.history({ limit: -1 }).length, 2);
  });

  it("paging is limit + since: continuing from the oldest finishedAt of a page walks the whole history without gaps", async () => {
    const s = setup(dirs); twoJobs(s);
    const all = await runs(s, Array.from({ length: 9 }, () => ({ job: "a.job", gapMs: 100 })));
    const seen: string[] = []; let cursor: number | undefined;
    // newest-first pages of 4 with an upper bound would need a "before" filter; the module has only `since`, so a consumer pages by growing the limit
    for (let limit = 4; ; limit += 4) {
      const page = s.jobs.history({ limit });
      seen.splice(0, seen.length, ...page.map((r) => r.runId));
      cursor = page.at(-1)?.finishedAt;
      if (page.length < limit) break;
    }
    assert.deepEqual(seen, all.map((r) => r.runId).reverse());
    assert.equal(cursor, all[0]!.finishedAt);
  });
});

describe("system-jobs history: filters", () => {
  it("job selects one job's runs, exactly; an unknown job or an empty string behaves as documented below", async () => {
    const s = setup(dirs); twoJobs(s);
    await runs(s, [{ job: "a.job", gapMs: 1 }, { job: "b.job", gapMs: 1 }, { job: "a.job", gapMs: 1 }]);
    assert.deepEqual(s.jobs.history({ job: "a.job" }).map((r) => r.job), ["a.job", "a.job"]);
    assert.deepEqual(s.jobs.history({ job: "b.job" }).map((r) => r.job), ["b.job"]);
    assert.deepEqual(s.jobs.history({ job: "c.job" }), []);
    assert.equal(s.jobs.history({ job: "" }).length, 3, "characterization: Ist-Verhalten, nicht spezifiziert: an empty job name means no job filter");
  });

  it("since keeps runs that finished at or after it (inclusive)", async () => {
    const s = setup(dirs); twoJobs(s);
    const all = await runs(s, [{ job: "a.job", gapMs: 1000 }, { job: "a.job", gapMs: 1000 }, { job: "a.job", gapMs: 1000 }]);
    assert.deepEqual(s.jobs.history({ since: all[1]!.finishedAt }).map((r) => r.runId), [all[2]!.runId, all[1]!.runId]);
    assert.deepEqual(s.jobs.history({ since: all[1]!.finishedAt + 1 }).map((r) => r.runId), [all[2]!.runId]);
    assert.deepEqual(s.jobs.history({ since: all[2]!.finishedAt + 1 }), []);
    assert.equal(s.jobs.history({ since: 0 }).length, 3);
  });

  it("filters combine: the limit applies after job and since", async () => {
    const s = setup(dirs); twoJobs(s);
    const all = await runs(s, [{ job: "a.job", gapMs: 10 }, { job: "b.job", gapMs: 10 }, { job: "a.job", gapMs: 10 }, { job: "b.job", gapMs: 10 }, { job: "a.job", gapMs: 10 }]);
    const aRuns = all.filter((r) => r.job === "a.job").map((r) => r.runId).reverse();
    assert.deepEqual(s.jobs.history({ job: "a.job", limit: 2 }).map((r) => r.runId), aRuns.slice(0, 2));
    assert.deepEqual(s.jobs.history({ job: "a.job", since: all[2]!.finishedAt, limit: 5 }).map((r) => r.runId), aRuns.slice(0, 2));
  });

  it("records carry every state a run can end in, and a failed run is in the history like any other", async () => {
    const s = setup(dirs); const seq = ["completed", "skipped", "failed", "completed"] as const; let i = 0;
    twoJobs(s, () => seq[i++]!);
    await runs(s, seq.map(() => ({ job: "a.job", gapMs: 1 })));
    assert.deepEqual(s.jobs.history({}).map((r) => r.outcome), [...seq].reverse());
  });
});

describe("system-jobs history: ordering is by start (characterization)", () => {
  it("characterization: Ist-Verhalten, nicht spezifiziert: runs that overlap are ordered by when they started, not by when they finished", async () => {
    const s = setup(dirs); const releases: (() => void)[] = [];
    s.jobs.register(scriptedHandler({ name: "slow", run: () => new Promise((r) => { releases.push(() => r({ outcome: "completed", detail: null })); }) }).handler);
    const first = s.jobs.run("slow", {}, { trigger: "manual" });
    await new Promise((r) => setImmediate(r)); await s.clock.advance(10);
    const second = s.jobs.run("slow", {}, { trigger: "manual" });
    await new Promise((r) => setImmediate(r));
    releases[1]!(); await second; // the later run finishes first
    releases[0]!(); await first;
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(s.jobs.history({}).map((r) => r.runId), [b.record.runId, a.record.runId]);
  });
});

describe("system-jobs history: seeded oracle", () => {
  it("300 runs over three jobs with random outcomes: every filter combination equals a plain filter of the list the test kept itself", async () => {
    const seed = 0x5eed1;
    const rnd = mulberry32(seed);
    const s = setup(dirs);
    const outcomes = ["completed", "skipped", "failed", "incomplete", "abandoned"] as const;
    for (const name of ["j.one", "j.two", "j.three"]) s.jobs.register(scriptedHandler({ name, run: async () => ({ outcome: outcomes[Math.floor(rnd() * outcomes.length)]!, detail: null }) }).handler);
    const kept: SystemRunRecord[] = [];
    for (let i = 0; i < 300; i++) {
      await s.clock.advance(1 + Math.floor(rnd() * 50));
      kept.push((await s.jobs.run(["j.one", "j.two", "j.three"][Math.floor(rnd() * 3)]!, {}, { trigger: "manual" })).record);
    }
    const newest = [...kept].reverse();
    for (let q = 0; q < 60; q++) {
      const job = rnd() < 0.5 ? ["j.one", "j.two", "j.three"][Math.floor(rnd() * 3)]! : undefined;
      const since = rnd() < 0.5 ? kept[Math.floor(rnd() * kept.length)]!.finishedAt : undefined;
      const limit = rnd() < 0.5 ? Math.floor(rnd() * 40) : undefined;
      let want = newest.filter((r) => (job === undefined || r.job === job) && (since === undefined || r.finishedAt >= since));
      if (limit !== undefined) want = want.slice(0, limit);
      const got = s.jobs.history({ ...(job !== undefined ? { job } : {}), ...(since !== undefined ? { since } : {}), ...(limit !== undefined ? { limit } : {}) });
      assert.deepEqual(got, want, `seed=${seed.toString(16)} query=${q} job=${job} since=${since} limit=${limit}`);
    }
  });
});

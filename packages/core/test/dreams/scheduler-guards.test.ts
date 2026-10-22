// dreams/scheduler guards and outcome mapping (docs/dreams.md "Guards"): idempotency windows, the per-agent breaker, the
// minimum corpus, engine results mapped to outcome and reason, candidates, tokens, and the run log.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCandidateSource, itemsFromEngineList } from "../../src/dreams/producer.ts";
import type { DreamJobRun } from "../../src/dreams/types.ts";
import { DAY, harness, HOUR, T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();
const manual = (h: ReturnType<typeof harness>, phase: "light" | "rem" | "deep", agent = "alpha") => h.sched.runPhase(agent, phase, { trigger: "manual" });

describe("dreams scheduler: engine result -> run outcome", () => {
  type Row = [string, Partial<DreamJobRun>, string, string | null];
  const table: Row[] = [
    ["failed with a reason passes the reason through", { outcome: "failed", reason: "lancedb_locked" }, "failed", "lancedb_locked"],
    ["failed without a reason is engine_error", { outcome: "failed" }, "failed", "engine_error"],
    ["incomplete is never completed", { outcome: "incomplete", reason: "budget" }, "failed", "incomplete:budget"],
    ["incomplete without a reason names the outcome", { outcome: "incomplete" }, "failed", "incomplete:incomplete"],
    ["abandoned is never completed", { outcome: "abandoned" }, "failed", "incomplete:abandoned"],
    ["a skipped primary job with an engine reason is a skipped run with that reason", { outcome: "skipped", reason: "nothing_to_do" }, "skipped", "nothing_to_do"],
    ["the engine's no_llm_* skip becomes no_llm_route", { outcome: "skipped", reason: "no_llm_credentials" }, "skipped", "no_llm_route"],
    ["a skipped primary job without a reason still carries one", { outcome: "skipped" }, "skipped", "skipped"],
  ];
  for (const [name, result, outcome, reason] of table) {
    it(name, async () => {
      const h = harness(dirs); h.captures("alpha", 3);
      h.engine.behaviours.set("rem-dream", () => result);
      const r = await manual(h, "rem");
      assert.equal(r.outcome, outcome); assert.equal(r.reason, reason);
      assert.equal(r.claimed, false, "a run that did not complete holds no key");
      assert.equal(h.store.getSchedule("alpha", "rem")!.capturesAcc, 3, "and does not consume the corpus");
    });
  }

  it("a throwing job is failed/engine_error with the error recorded, and the remaining jobs of the phase do not run", async () => {
    const h = harness(dirs); h.captures("alpha", 3);
    h.engine.behaviours.set("consolidate-daily", () => { throw Object.assign(new Error("kaputt"), { name: "EngineCrash" }); });
    const r = await manual(h, "deep");
    assert.equal(r.outcome, "failed"); assert.equal(r.reason, "engine_error"); assert.deepEqual(r.error, { message: "kaputt", name: "EngineCrash" });
    assert.equal(h.engine.callsOf("auto-accept-stale"), 0); assert.equal(h.engine.callsOf("gc-run"), 0);
  });

  it("a completed phase runs its jobs in the documented order, with the phase's jobs only", async () => {
    const h = harness(dirs); h.captures("alpha", 3);
    await manual(h, "deep"); await manual(h, "rem"); await manual(h, "light");
    assert.deepEqual(h.engine.calls.map((c) => c.job), ["consolidate-daily", "auto-accept-stale", "gc-run", "rem-dream", "discover-semantic-links", "light-dream", "embedding-drain"]);
  });

  it("jobs the engine does not register are left out; a phase with none is skipped/no_jobs", async () => {
    const h = harness(dirs); h.captures("alpha", 3);
    h.engine.available = ["light-dream", "rem-dream", "consolidate-daily"];
    const part = await manual(h, "deep");
    assert.equal(part.outcome, "completed"); assert.deepEqual(h.engine.calls.map((c) => c.job), ["consolidate-daily"]);
    h.engine.available = [];
    const none = await manual(h, "rem");
    assert.equal(none.outcome, "skipped"); assert.equal(none.reason, "no_jobs");
  });

  it("tokens are summed over the jobs of a run; a run without any token report records none", async () => {
    const h = harness(dirs); h.captures("alpha", 3);
    h.engine.behaviours.set("consolidate-daily", () => ({ cost: { inputTokens: 1000, outputTokens: 200 } }));
    h.engine.behaviours.set("auto-accept-stale", () => ({ cost: { inputTokens: 30 } }));
    h.engine.behaviours.set("gc-run", () => ({ cost: {} }));
    const r = await manual(h, "deep");
    assert.equal(r.tokensIn, 1030); assert.equal(r.tokensOut, 200); assert.equal("costMicros" in r, false, "tokens only: there is no money dimension");
    const h2 = harness(dirs); h2.captures("alpha", 3);
    h2.engine.behaviours.set("light-dream", () => ({ cost: {} })); h2.engine.behaviours.set("embedding-drain", () => ({ cost: {} }));
    const q = await manual(h2, "light");
    assert.equal(q.tokensIn, null); assert.equal(q.tokensOut, null);
  });

  it("only a completed run consumes the corpus and the importance accumulator", async () => {
    const h = harness(dirs);
    for (let i = 0; i < 4; i++) h.sched.recordCapture("alpha"); // the default weight of a stored capture is 5
    assert.equal(h.store.getSchedule("alpha", "deep")!.importanceAcc, 20);
    h.engine.behaviours.set("consolidate-daily", () => ({ outcome: "failed" }));
    await manual(h, "deep");
    assert.equal(h.store.getSchedule("alpha", "deep")!.importanceAcc, 20);
    h.engine.behaviours.delete("consolidate-daily");
    await manual(h, "deep");
    const s = h.store.getSchedule("alpha", "deep")!;
    assert.equal(s.importanceAcc, 0); assert.equal(s.capturesAcc, 0);
    assert.equal(h.store.getSchedule("alpha", "rem")!.capturesAcc, 4, "the other phases keep theirs");
    assert.equal(s.captureSeq, 4, "the capture sequence behind the digest never resets");
  });
});

describe("dreams scheduler: minimum corpus", () => {
  const needs: [string, number][] = [["light", 1], ["rem", 3], ["deep", 3]];
  for (const [phase, min] of needs) {
    it(`${phase} needs ${min} captures: ${min - 1} is skipped/min_corpus with the numbers, ${min} runs`, async () => {
      const h = harness(dirs); h.captures("alpha", min - 1);
      const short = await manual(h, phase as "light");
      assert.equal(short.outcome, "skipped"); assert.equal(short.reason, "min_corpus"); assert.deepEqual(short.counts, { corpus: min - 1, minCorpus: min });
      assert.equal(h.engine.calls.length, 0);
      h.captures("alpha", 1);
      assert.equal((await manual(h, phase as "light")).outcome, "completed");
    });
  }

  it("a per-phase override of the minimum corpus is honoured", async () => {
    const h = harness(dirs, { over: { phases: { deep: { minCorpus: 10 } } } }); h.sched = h.make(); h.captures("alpha", 9);
    assert.equal((await manual(h, "deep")).reason, "min_corpus");
    h.captures("alpha", 1);
    assert.equal((await manual(h, "deep")).outcome, "completed");
  });
});

describe("dreams scheduler: idempotency windows", () => {
  const at = (iso: string) => Date.parse(iso);
  const key = (h: ReturnType<typeof harness>, phase: "light" | "rem" | "deep") => h.sched.plan("alpha", phase).idempotencyKey;

  it("a second run over the same corpus in the same window is idempotent, and the check comes before the minimum corpus", async () => {
    const h = harness(dirs, { start: at("2026-10-13T08:00:00Z") }); h.captures("alpha", 3);
    assert.equal((await manual(h, "rem")).outcome, "completed");
    await h.clock.advance(10 * HOUR); // 18:00 the same local date
    const again = await manual(h, "rem");
    assert.equal(again.reason, "idempotent");
    assert.equal(h.engine.callsOf("rem-dream"), 1);
  });

  it("rem and deep: the window is the local date, so the key changes at local midnight and not before", async () => {
    const h = harness(dirs, { start: at("2026-10-13T08:00:00Z") }); h.captures("alpha", 3);
    const morning = key(h, "rem");
    await h.clock.advance(15 * HOUR + 59 * 60_000);
    assert.equal(key(h, "rem"), morning, "23:59 the same date");
    await h.clock.advance(60_000);
    assert.notEqual(key(h, "rem"), morning, "00:00 the next date");
  });

  it("light: the window is a 4-hour bucket of the local day (00-04, 04-08, 08-12, ...)", async () => {
    const h = harness(dirs, { start: at("2026-10-13T08:00:00Z") }); h.captures("alpha", 1);
    const bucket = key(h, "light");
    await h.clock.advance(4 * HOUR - 1); assert.equal(key(h, "light"), bucket, "11:59:59.999");
    await h.clock.advance(1); assert.notEqual(key(h, "light"), bucket, "12:00");
  });

  it("the date is the local one in the schedule's timezone: 14:00Z and 16:00Z are one day in UTC but two days in Tokyo", async () => {
    const tokyo = harness(dirs, { start: at("2026-10-13T14:00:00Z") }); tokyo.captures("alpha", 3);
    tokyo.sched.setSchedule("alpha", "rem", { timezone: "Asia/Tokyo" }); // 23:00 JST on the 13th
    const t1 = key(tokyo, "rem"); await tokyo.clock.advance(2 * HOUR); // 01:00 JST on the 14th
    assert.notEqual(key(tokyo, "rem"), t1);
    const utc = harness(dirs, { start: at("2026-10-13T14:00:00Z") }); utc.captures("alpha", 3);
    const u1 = key(utc, "rem"); await utc.clock.advance(2 * HOUR);
    assert.equal(key(utc, "rem"), u1);
  });

  it("a new capture changes the digest, so the same window runs again; other agents and other phases have their own keys", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] }); h.captures("alpha", 3); h.captures("beta", 3);
    assert.equal((await manual(h, "deep", "alpha")).outcome, "completed");
    assert.equal((await manual(h, "deep", "beta")).outcome, "completed", "another agent, same window");
    assert.equal((await manual(h, "rem", "alpha")).outcome, "completed", "another phase, same window");
    assert.equal((await manual(h, "deep", "alpha")).reason, "idempotent", "same corpus, same window: the key is held, the check comes first");
    h.captures("alpha", 3);
    assert.equal((await manual(h, "deep", "alpha")).outcome, "completed");
  });

  it("dryRun/plan writes no row and calls no engine; it names the same decision a run would reach", async () => {
    const h = harness(dirs); h.captures("alpha", 2);
    const before = h.store.listRuns().length;
    const p = h.sched.plan("alpha", "deep");
    assert.equal(p.wouldRun, false); assert.equal(p.reason, "min_corpus"); assert.deepEqual(p.counts, { corpus: 2, minCorpus: 3 });
    assert.deepEqual(p.jobs, ["consolidate-daily", "auto-accept-stale", "gc-run"]); assert.match(p.idempotencyKey, /^[0-9a-f]{64}$/);
    h.captures("alpha", 1);
    assert.equal(h.sched.plan("alpha", "deep").wouldRun, true);
    assert.equal(h.store.listRuns().length, before); assert.equal(h.engine.calls.length, 0);
    assert.throws(() => h.sched.plan("ghost", "deep"), /no dream schedule for agent ghost/);
  });

  it("the idempotency key is a function of phase, agent, partition, window and digest (and only those)", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"] }); h.captures("alpha", 3); h.captures("beta", 3);
    const k = (a: string, p: "rem" | "deep") => h.sched.plan(a, p).idempotencyKey;
    const keys = new Set([k("alpha", "rem"), k("alpha", "deep"), k("beta", "rem"), k("beta", "deep")]);
    assert.equal(keys.size, 4);
    assert.equal(k("alpha", "rem"), h.sched.plan("alpha", "rem").idempotencyKey, "stable");
    h.captures("alpha", 1);
    assert.notEqual(k("alpha", "rem"), [...keys][0]);
    await h.clock.advance(1 * HOUR);
    assert.equal(k("alpha", "rem"), h.sched.plan("alpha", "rem").idempotencyKey, "time inside a window does not change it");
  });
});

describe("dreams scheduler: circuit breaker", () => {
  const llmRun = async (h: ReturnType<typeof harness>, phase: "rem" | "deep", agent = "alpha") => { h.captures(agent, 3); return manual(h, phase, agent); };

  it("is per agent: one agent's tripped breaker does not stop another", async () => {
    const h = harness(dirs, { agents: ["alpha", "beta"], over: { breakerSessions: 1 } }); h.sched = h.make();
    assert.equal((await llmRun(h, "rem", "alpha")).outcome, "completed");
    const tripped = await llmRun(h, "deep", "alpha");
    assert.equal(tripped.outcome, "aborted"); assert.equal(tripped.reason, "breaker_sessions");
    assert.equal((await llmRun(h, "rem", "beta")).outcome, "completed");
    assert.equal(h.store.getSchedule("beta", "deep")!.breakerState, "closed");
  });

  it("opens both rem and deep, names its end at the next UTC midnight, and closes again then", async () => {
    const h = harness(dirs, { start: T0 + 20 * HOUR, over: { breakerSessions: 1 } }); h.sched = h.make();
    await llmRun(h, "rem");
    const t = await llmRun(h, "deep");
    assert.equal(t.reason, "breaker_sessions");
    for (const p of ["rem", "deep"] as const) { const s = h.store.getSchedule("alpha", p)!; assert.equal(s.breakerState, "open"); assert.equal(s.breakerUntil, T0 + DAY); assert.equal(s.breakerReason, "breaker_sessions"); }
    assert.equal(h.store.getSchedule("alpha", "light")!.breakerState, "closed", "light is outside the breaker");
    h.captures("alpha", 3);
    assert.equal((await manual(h, "rem")).reason, "breaker_open", "while open every rem/deep run is a recorded skip");
    assert.equal(h.sched.counters.breakerTrips, 1);
    await h.clock.advance(4 * HOUR + 1); // past UTC midnight
    h.captures("alpha", 3);
    const after = await manual(h, "rem");
    assert.equal(after.outcome, "completed", "a new sweep starts with zero sessions");
    assert.ok(h.events.some((e) => e.name === "breaker.closed"));
  });

  it("a session is only counted when the LLM job really ran: a skipped LLM job does not spend the budget", async () => {
    const h = harness(dirs, { over: { breakerSessions: 1 } }); h.sched = h.make(); h.captures("alpha", 3);
    h.engine.behaviours.set("rem-dream", () => ({ outcome: "skipped", reason: "no_llm_x" }));
    const r = await manual(h, "rem");
    assert.equal(r.reason, "no_llm_route"); assert.equal(r.counts.llmSessions, 0);
    h.engine.behaviours.delete("rem-dream");
    assert.equal((await manual(h, "rem")).outcome, "completed", "the budget is still whole");
  });

  it("status reports sessions used and the limit; the default limit is 3 per UTC day", async () => {
    const h = harness(dirs);
    const limit = h.sched.status("alpha").agents[0]!.phases[0]!.breaker.limit;
    assert.equal(limit, 3);
    await llmRun(h, "rem"); await llmRun(h, "deep");
    assert.equal(h.sched.status("alpha").agents[0]!.phases[1]!.breaker.sessionsUsed, 2);
  });

  it("the 4th LLM session of the day is not started (default limit 3); sessions of light do not count", async () => {
    const h = harness(dirs);
    for (const [i, phase] of (["rem", "deep", "rem"] as const).entries()) { const r = await llmRun(h, phase); assert.equal(r.outcome, "completed", `session ${i + 1}`); assert.equal(r.counts.llmSessions, 1); }
    h.captures("alpha", 1); assert.equal((await manual(h, "light")).outcome, "completed", "light still runs");
    const fourth = await llmRun(h, "deep");
    assert.equal(fourth.outcome, "aborted"); assert.equal(fourth.reason, "breaker_sessions"); assert.equal(h.engine.callsOf("consolidate-daily"), 1, "the 4th session was never started");
    assert.equal(h.sched.status("alpha").agents[0]!.phases[2]!.breaker.state, "open");
  });
});

describe("dreams scheduler: llmRoute and diary", () => {
  it("llmRoute false: skipped/no_llm_route before any engine call, and the key stays free", async () => {
    const h = harness(dirs, { over: { llmRoute: () => false } }); h.sched = h.make(); h.captures("alpha", 3);
    const r = await manual(h, "rem");
    assert.equal(r.outcome, "skipped"); assert.equal(r.reason, "no_llm_route"); assert.equal(h.engine.calls.length, 0); assert.equal(r.claimed, false);
  });

  it("llmRoute is asked with the agent id, and not at all when none of the phase's jobs needs an LLM", async () => {
    const asked: string[] = [];
    const h = harness(dirs, { over: { llmRoute: (a) => { asked.push(a); return true; } } }); h.sched = h.make(); h.captures("alpha", 3);
    await manual(h, "rem");
    assert.deepEqual(asked, ["alpha"]);
    h.engine.available = ["embedding-drain"]; // light's only registered job is model-free
    await manual(h, "light");
    assert.deepEqual(asked, ["alpha"]);
    assert.equal(h.engine.callsOf("embedding-drain"), 1);
  });

  it("an engine diary report of written=false fails the run with the reason in the error; written=true completes", async () => {
    const h = harness(dirs); h.captures("alpha", 3);
    h.engine.behaviours.set("consolidate-daily", () => ({ diary: { written: false, reason: "EACCES" } }));
    const bad = await manual(h, "deep");
    assert.equal(bad.outcome, "failed"); assert.equal(bad.reason, "diary_not_written"); assert.match(bad.error!.message, /EACCES/);
    h.engine.behaviours.set("consolidate-daily", () => ({ diary: { written: true } }));
    assert.equal((await manual(h, "deep")).outcome, "completed");
  });

  it("requireDiary demands a report: none is a failure, but only for the phases that ask", async () => {
    const h = harness(dirs, { over: { requireDiary: { deep: true } } }); h.sched = h.make(); h.captures("alpha", 3);
    const none = await manual(h, "deep");
    assert.equal(none.outcome, "failed"); assert.equal(none.reason, "diary_not_written"); assert.match(none.error!.message, /no diary entry reported/);
    assert.equal((await manual(h, "rem")).outcome, "completed", "rem does not require one");
  });

  it("status shows the diary file: its path, size and existence", async () => {
    const h = harness(dirs);
    const file = path.join(h.dir, "dreaming.md");
    h.sched = h.make({ diaryPath: () => file });
    assert.deepEqual(h.sched.status("alpha").agents[0]!.diary, { path: file, exists: false, bytes: 0 });
    writeFileSync(file, "# Diary\n");
    assert.deepEqual(h.sched.status("alpha").agents[0]!.diary, { path: file, exists: true, bytes: 8 });
    h.sched = h.make({ diaryPath: () => null });
    assert.equal(h.sched.status("alpha").agents[0]!.diary, null);
  });
});

describe("dreams scheduler: candidate guards", () => {
  const src = (items: { content: string; recalls?: number; uniqueQueries?: number; score?: number }[]) => ({
    pull: () => items.map((item) => ({ ...item, memoryId: item.content })),
    promote: async (agentId: string, ids: readonly string[]) => ({ agentId, items: ids.map((id) => ({ id, outcome: "promoted" as const, reason: "integrated" })) }),
  });

  it("a deep run completes its maintenance without promoting an unfit candidate", async () => {
    const h = harness(dirs, { over: { candidates: src([{ content: "a", recalls: 0, score: 0.99 }]) } }); h.sched = h.make(); h.captures("alpha", 3);
    const r = await manual(h, "deep");
    assert.equal(r.outcome, "completed"); assert.equal(r.reason, null);
    assert.deepEqual(h.engine.calls.map((c) => c.job), ["consolidate-daily", "auto-accept-stale", "gc-run"]);
    assert.equal(h.store.listCandidates("alpha", "promoted").length, 0);
    assert.equal(h.store.listCandidates("alpha", "shortlisted").length, 1, "a failing candidate stays shortlisted with its gate record");
    assert.equal((h.store.listCandidates("alpha")[0]!.decision as { rejectedBy: string }).rejectedBy, "utility");
  });

  it("a promotable candidate is marked promoted only after Engine completion and its explicit promotion receipt", async () => {
    const h = harness(dirs, { over: { candidates: src([{ content: "good", recalls: 3, uniqueQueries: 3, score: 0.8 }, { content: "weak", recalls: 1, uniqueQueries: 1, score: 0.8 }]) } });
    h.sched = h.make(); h.captures("alpha", 3);
    const r = await manual(h, "deep");
    assert.equal(r.outcome, "completed"); assert.equal(r.counts.promoted, 1); assert.equal(r.counts.candidates, 2);
    const cs = h.store.listCandidates("alpha");
    assert.deepEqual(cs.map((c) => c.state).sort(), ["promoted", "shortlisted"]);
    assert.equal((cs.find((c) => c.state === "promoted")!.decision as { promote: boolean }).promote, true);
  });

  it("when the engine fails, nothing is promoted", async () => {
    const h = harness(dirs, { over: { candidates: src([{ content: "good", recalls: 3, uniqueQueries: 3, score: 0.8 }]) } });
    h.sched = h.make(); h.captures("alpha", 3);
    h.engine.behaviours.set("consolidate-daily", () => ({ outcome: "failed" }));
    assert.equal((await manual(h, "deep")).outcome, "failed");
    assert.equal(h.store.listCandidates("alpha", "promoted").length, 0);
  });

  it("a candidate source that throws reports engine_error after independent deep maintenance", async () => {
    const h = harness(dirs, { over: { candidates: { pull: () => { throw new Error("source down"); } } } }); h.sched = h.make(); h.captures("alpha", 3);
    const r = await manual(h, "deep");
    assert.equal(r.outcome, "failed"); assert.equal(r.reason, "engine_error"); assert.match(r.error!.message, /source down/);
    assert.deepEqual(h.engine.calls.map((c) => c.job), ["consolidate-daily", "auto-accept-stale", "gc-run"]);
  });

  it("candidates are dedupe-counted on a repeat pull and expire after the TTL (72 h) whatever their score", async () => {
    const h = harness(dirs, { over: { candidates: src([{ content: "x", recalls: 3, uniqueQueries: 3, score: 0.9 }]) } }); h.sched = h.make();
    h.captures("alpha", 3);
    const first = await manual(h, "deep");
    assert.equal(first.counts.candidates, 1); assert.equal(first.counts.deduped, 0);
    h.captures("alpha", 3);
    const second = await manual(h, "deep");
    assert.equal(second.counts.candidates, 0); assert.equal(second.counts.deduped, 1);
    await h.clock.advance(73 * HOUR);
    h.captures("alpha", 3);
    const third = await manual(h, "deep");
    assert.equal(third.counts.deduped, 1);
    assert.equal(third.counts.expired, 0, "the promoted candidate is no longer shortlisted, so it cannot expire");
  });

  it("the light phase ingests candidates but never requires one", async () => {
    const h = harness(dirs, { over: { candidates: src([]) } }); h.sched = h.make(); h.captures("alpha", 1);
    assert.equal((await manual(h, "light")).outcome, "completed");
  });

  it("a workspace/user card is not ingested as agent-private", async () => {
    const source = createCandidateSource({
      list: () => itemsFromEngineList({
        truncated: false,
        items: [
          { text: "same text", scope: "workspace" },
          { text: "same text", scope: "user" },
          { text: "same text", scope: "agent-private" },
        ],
      }),
    });
    const h = harness(dirs, { over: { candidates: source } }); h.sched = h.make(); h.captures("alpha", 1);
    assert.equal((await manual(h, "light")).outcome, "completed");
    const cs = h.store.listCandidates("alpha");
    assert.equal(cs.length, 1);
    assert.equal(cs[0]!.partition, "agent-private");
    assert.equal(cs[0]!.recalls, 0);
  });
});

describe("dreams scheduler: the per-run log and ids", () => {
  it("each run writes <logsDir>/<agent>/<phase>/<runId>.log with start, job lines and finish, mode 0600", async () => {
    const h = harness(dirs, { over: { idFactory: () => "run-fixed-1" } }); h.sched = h.make(); h.captures("alpha", 3);
    const r = await manual(h, "deep");
    assert.equal(r.runId, "run-fixed-1");
    const file = path.join(h.dir, "logs", "alpha", "deep", "run-fixed-1.log");
    assert.equal(r.logPath, file); assert.equal(existsSync(file), true);
    const text = readFileSync(file, "utf8");
    assert.match(text, /start deep trigger=manual/); assert.match(text, /job consolidate-daily start/); assert.match(text, /job gc-run completed/); assert.match(text, /finish outcome=completed reason=- /);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  it("log({runId}) returns the row and its log text; an unknown id returns nothing; list queries filter and honour the limit", async () => {
    const h = harness(dirs); h.captures("alpha", 3);
    const r = await manual(h, "deep"); await manual(h, "rem");
    const one = h.sched.log({ runId: r.runId });
    assert.equal(one.runs[0]!.runId, r.runId); assert.match(one.log!, /finish outcome=completed/);
    assert.deepEqual(h.sched.log({ runId: "nope" }), { runs: [] });
    assert.equal(h.sched.log({ agentId: "alpha", phase: "deep" }).runs.length, 1);
    assert.equal(h.sched.log({ limit: 1 }).runs.length, 1);
    assert.equal(h.sched.log({}).runs.length, 2);
  });

  it("a run id that is not unique is refused by the ledger instead of overwriting a row", async () => {
    const h = harness(dirs, { over: { idFactory: () => "same" } }); h.sched = h.make(); h.captures("alpha", 3);
    await manual(h, "deep");
    await assert.rejects(manual(h, "rem"), /UNIQUE|constraint/i);
    assert.equal(h.store.listRuns().length, 1);
  });

  it("an unwritable log directory degrades to a warning; the run still happens and records no log path", async () => {
    const base = dirs.make(); writeFileSync(path.join(base, "blocker"), "a file, not a directory");
    const h = harness(dirs, { over: { logsDir: path.join(base, "blocker", "x") } });
    h.sched = h.make(); h.captures("alpha", 3);
    const r = await manual(h, "deep");
    assert.equal(r.outcome, "completed"); assert.equal(r.logPath, null);
    assert.ok(h.warnings.some((w) => /run log dir failed/.test(w)));
  });
});

// dreams/store: the run-state ledger (ADR-009 "Run-state persistence"): versioned migrations, the idempotency key
// (provisional until claimed, released by a run that did not complete), retention, candidate dedupe.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcError } from "../../src/rpc/errors.ts";
import { DreamStore, SCHEMA_VERSION } from "../../src/dreams/store.ts";
import type { CandidateRow, Phase } from "../../src/dreams/types.ts";
import { DAY, HOUR, T0, useTempDirs } from "./helpers.ts";

const dirs = useTempDirs();
const open = () => { const dir = dirs.make(); return { dir, file: path.join(dir, "state", "dreams.db"), store: new DreamStore(path.join(dir, "state", "dreams.db")) }; };
const run = (id: string, over: Partial<Parameters<DreamStore["insertRun"]>[0]> = {}) =>
  ({ runId: id, agentId: "alpha", phase: "deep" as Phase, jobId: "consolidate-daily", partition: "agent-private", idempotencyKey: "key-1", trigger: "manual" as const, scheduledFor: null, startedAt: T0, logPath: null, ...over });
const sched = (agentId: string, phase: Phase) => ({ agentId, phase, cron: "0 4 * * *", timezone: "UTC", enabled: true, staggerOffsetS: 0, nextRunAt: T0 + HOUR });
const cand = (id: string, over: Partial<Omit<CandidateRow, "decision" | "state">> = {}) =>
  ({ candidateId: id, agentId: "alpha", partition: "agent-private", contentHash: `h-${id}`, sourceRunId: "r", firstSeenAt: T0, expiresAt: T0 + DAY, recalls: 0, uniqueQueries: 0, score: null, ...over });

describe("dreams/store: schema and files", () => {
  it("creates the parent directory (0700), the database, and schema version 1", () => {
    const { dir, file, store } = open();
    assert.equal(SCHEMA_VERSION, 1); assert.equal(store.schemaVersion, 1);
    assert.equal(existsSync(file), true);
    if (process.platform !== "win32") assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700, dir);
    store.close();
  });

  it("an in-memory store needs no directory and starts empty", () => {
    const store = new DreamStore(":memory:");
    assert.equal(store.schemaVersion, 1); assert.deepEqual(store.listRuns(), []); assert.deepEqual(store.listSchedules(), []); assert.deepEqual(store.openRuns(), []);
    store.close();
  });

  it("reopening keeps the data and does not migrate again", () => {
    const { file, store } = open();
    store.insertScheduleIfAbsent(sched("alpha", "deep")); store.insertRun(run("r1")); store.close();
    const again = new DreamStore(file);
    assert.equal(again.schemaVersion, 1); assert.equal(again.getRun("r1")!.agentId, "alpha"); assert.equal(again.getSchedule("alpha", "deep")!.cron, "0 4 * * *");
    again.close();
  });

  it("refuses a store written by a newer build and leaves it untouched", () => {
    const { file, store } = open();
    store.close();
    const raw = new DatabaseSync(file); raw.exec("PRAGMA user_version = 99"); raw.close();
    assert.throws(() => new DreamStore(file), /schema 99 is newer than this build supports \(1\)/);
    const check = new DatabaseSync(file); assert.equal(Number((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 99); check.close();
  });

  it("calls securePath for the directory (mode 0700) and for the database file, not for :memory:", () => {
    const dir = dirs.make(); const calls: { p: string; mode?: number }[] = [];
    const securePath = (p: string, o?: { mode?: number }) => { calls.push({ p, ...(o?.mode !== undefined ? { mode: o.mode } : {}) }); };
    const file = path.join(dir, "d", "dreams.db");
    new DreamStore(file, { securePath }).close();
    assert.deepEqual(calls, [{ p: path.dirname(file), mode: 0o700 }, { p: file }]);
    calls.length = 0;
    new DreamStore(":memory:", { securePath }).close();
    assert.deepEqual(calls, []);
  });

  it("tx rolls back everything when the body throws, and returns the body's value otherwise", () => {
    const { store } = open();
    assert.throws(() => store.tx(() => { store.insertRun(run("r1")); throw new Error("boom"); }), /boom/);
    assert.equal(store.getRun("r1"), undefined);
    assert.equal(store.tx(() => { store.insertRun(run("r2")); return 7; }), 7);
    assert.ok(store.getRun("r2"));
    store.close();
  });
});

describe("dreams/store: schedules", () => {
  it("insertScheduleIfAbsent inserts once and never overwrites the owner's edits", () => {
    const { store } = open();
    assert.equal(store.insertScheduleIfAbsent(sched("alpha", "deep")), true);
    store.updateSchedule("alpha", "deep", { cron: "5 5 * * *", enabled: false });
    assert.equal(store.insertScheduleIfAbsent(sched("alpha", "deep")), false);
    const s = store.getSchedule("alpha", "deep")!;
    assert.equal(s.cron, "5 5 * * *"); assert.equal(s.enabled, false);
    store.close();
  });

  it("a new row starts with a closed breaker and empty signal columns", () => {
    const { store } = open();
    store.insertScheduleIfAbsent(sched("alpha", "rem"));
    assert.deepEqual(store.getSchedule("alpha", "rem"), {
      agentId: "alpha", phase: "rem", cron: "0 4 * * *", timezone: "UTC", enabled: true, staggerOffsetS: 0, nextRunAt: T0 + HOUR, lastRunId: null,
      breakerState: "closed", breakerUntil: null, breakerReason: null, importanceAcc: 0, capturesAcc: 0, captureSeq: 0, lastCaptureAt: null,
    });
    assert.equal(store.getSchedule("alpha", "light"), undefined);
    store.close();
  });

  it("listSchedules orders by agent, then by the phases' own order (light, rem, deep), not alphabetically", () => {
    const { store } = open();
    for (const a of ["beta", "alpha"]) for (const p of ["deep", "light", "rem"] as Phase[]) store.insertScheduleIfAbsent(sched(a, p));
    assert.deepEqual(store.listSchedules().map((s) => `${s.agentId}/${s.phase}`), ["alpha/light", "alpha/rem", "alpha/deep", "beta/light", "beta/rem", "beta/deep"]);
    assert.deepEqual(store.listSchedules("beta").map((s) => s.phase), ["light", "rem", "deep"]);
    assert.deepEqual(store.listSchedules("nobody"), []);
    store.close();
  });

  it("updateSchedule patches only the given columns; an empty patch is a no-op; an unknown row is a no-op", () => {
    const { store } = open();
    store.insertScheduleIfAbsent(sched("alpha", "deep"));
    store.updateSchedule("alpha", "deep", { timezone: "Asia/Tokyo", nextRunAt: null, breakerState: "open", breakerUntil: T0 + DAY, breakerReason: "breaker_sessions", importanceAcc: 12.5, capturesAcc: 4, lastRunId: "r9", staggerOffsetS: 77 });
    const s = store.getSchedule("alpha", "deep")!;
    assert.equal(s.cron, "0 4 * * *"); assert.equal(s.timezone, "Asia/Tokyo"); assert.equal(s.nextRunAt, null); assert.equal(s.breakerState, "open");
    assert.equal(s.breakerUntil, T0 + DAY); assert.equal(s.importanceAcc, 12.5); assert.equal(s.capturesAcc, 4); assert.equal(s.lastRunId, "r9"); assert.equal(s.staggerOffsetS, 77);
    store.updateSchedule("alpha", "deep", {});
    assert.deepEqual(store.getSchedule("alpha", "deep"), s);
    assert.doesNotThrow(() => store.updateSchedule("ghost", "deep", { cron: "1 1 * * *" }));
    assert.equal(store.getSchedule("ghost", "deep"), undefined);
    store.close();
  });

  it("recordCapture advances the accumulators on all phase rows of that agent only", () => {
    const { store } = open();
    for (const a of ["alpha", "beta"]) for (const p of ["light", "rem", "deep"] as Phase[]) store.insertScheduleIfAbsent(sched(a, p));
    store.recordCapture("alpha", 5, T0 + 10); store.recordCapture("alpha", 2.5, T0 + 20);
    for (const s of store.listSchedules("alpha")) { assert.equal(s.importanceAcc, 7.5); assert.equal(s.capturesAcc, 2); assert.equal(s.captureSeq, 2); assert.equal(s.lastCaptureAt, T0 + 20); }
    for (const s of store.listSchedules("beta")) { assert.equal(s.importanceAcc, 0); assert.equal(s.capturesAcc, 0); assert.equal(s.captureSeq, 0); assert.equal(s.lastCaptureAt, null); }
    store.close();
  });
});

describe("dreams/store: runs and the idempotency key", () => {
  it("L15: an inserted run is open (no outcome) and carries a provisional key that blocks nothing", () => {
    const { store } = open();
    store.insertRun(run("r1"));
    const r = store.getRun("r1")!;
    assert.equal(r.outcome, null); assert.equal(r.finishedAt, null); assert.equal(r.claimed, false); assert.equal(r.idempotencyKey, "key-1");
    assert.equal(store.keyHolder("key-1"), null, "the stored key is key#runId, so the plain key is free");
    store.insertRun(run("r2")); // the same computed key twice is fine while neither has claimed it
    assert.equal(store.listRuns().length, 2);
    store.close();
  });

  it("claimKey takes the key; a second claimant is refused; a run that is already closed cannot claim", () => {
    const { store } = open();
    store.insertRun(run("r1")); store.insertRun(run("r2")); store.insertRun(run("r3"));
    assert.equal(store.claimKey("r1", "key-1"), true);
    assert.equal(store.keyHolder("key-1"), "r1"); assert.equal(store.getRun("r1")!.claimed, true);
    assert.equal(store.claimKey("r2", "key-1"), false);
    store.finishRun("r3", { outcome: "skipped", reason: "min_corpus", finishedAt: T0, counts: {} });
    assert.equal(store.claimKey("r3", "other-key"), false, "only an open run can claim");
    store.close();
  });

  const fin = (outcome: "completed" | "skipped" | "failed" | "aborted") => ({ outcome, reason: outcome === "completed" ? null : "why", finishedAt: T0 + 5, counts: { jobs: 1 } });

  it("a completed run keeps its key (the corpus is consumed)", () => {
    const { store } = open();
    store.insertRun(run("r1")); store.claimKey("r1", "key-1"); store.finishRun("r1", fin("completed"));
    assert.equal(store.keyHolder("key-1"), "r1");
    store.close();
  });

  for (const outcome of ["failed", "aborted", "skipped"] as const) {
    it(`a ${outcome} run gives the key back, so a rerun can claim it`, () => {
      const { store } = open();
      store.insertRun(run("r1")); store.claimKey("r1", "key-1"); store.finishRun("r1", fin(outcome));
      assert.equal(store.keyHolder("key-1"), null);
      store.insertRun(run("r2")); assert.equal(store.claimKey("r2", "key-1"), true);
      assert.equal(store.getRun("r1")!.idempotencyKey, "key-1", "the ledger still shows the computed key");
      assert.equal(store.getRun("r1")!.claimed, false);
      store.close();
    });
  }

  it("closing an unclaimed run as completed while another completed run holds the same key is a defined E_CONFLICT, not a raw SQLite error", () => {
    const { store } = open();
    store.insertRun(run("r1")); store.claimKey("r1", "key-1"); store.finishRun("r1", fin("completed"));
    store.insertRun(run("r2"));
    assert.throws(() => store.finishRun("r2", fin("completed")), (e: unknown) => {
      assert.ok(e instanceof RpcError, "an RpcError");
      assert.equal(e.error, "E_CONFLICT");
      assert.equal(e.reason, "idempotent");
      assert.match(e.message, /dream run r2/); assert.match(e.message, /r1/);
      assert.doesNotMatch(e.message, /UNIQUE|constraint|sqlite/i, "no raw SQLite text");
      return true;
    });
    assert.equal(store.getRun("r2")!.outcome, null, "the failed close leaves the run open");
    store.close();
  });

  it("deleteSchedules removes the three schedule rows of one agent and nothing else", () => {
    const { store } = open();
    for (const a of ["alpha", "beta"]) for (const p of ["light", "rem", "deep"] as const) store.insertScheduleIfAbsent(sched(a, p));
    store.insertRun(run("r1", { agentId: "beta" }));
    assert.equal(store.deleteSchedules("beta"), 3);
    assert.equal(store.listSchedules("beta").length, 0); assert.equal(store.listSchedules("alpha").length, 3);
    assert.ok(store.getRun("r1"), "the ledger keeps its history");
    assert.equal(store.deleteSchedules("beta"), 0);
    store.close();
  });

  it("windowRuns lists the runs of one agent, phase and scheduled instant (the retry cap counts them)", () => {
    const { store } = open();
    store.insertRun(run("r1", { idempotencyKey: "a", scheduledFor: T0 })); store.insertRun(run("r2", { idempotencyKey: "b", scheduledFor: T0, trigger: "catchup" }));
    store.insertRun(run("r3", { idempotencyKey: "c", scheduledFor: T0 + 1 })); store.insertRun(run("r4", { idempotencyKey: "d", scheduledFor: T0, phase: "rem" }));
    assert.deepEqual(store.windowRuns("alpha", "deep", T0).map((r) => r.runId).sort(), ["r1", "r2"]);
    store.close();
  });

  it("finishRun records outcome, reason, counts, tokens and the error, and refuses an unknown run", () => {
    const { store } = open();
    store.insertRun(run("r1", { startedAt: T0, logPath: "/x/r1.log", scheduledFor: T0 - 1, trigger: "catchup" }));
    store.finishRun("r1", { outcome: "failed", reason: "engine_error", finishedAt: T0 + 9, counts: { jobs: 2, llmSessions: 1 }, tokensIn: 10, tokensOut: 4, error: { message: "bad", name: "Error" } });
    const r = store.getRun("r1")!;
    assert.equal(r.outcome, "failed"); assert.equal(r.reason, "engine_error"); assert.equal(r.finishedAt, T0 + 9); assert.deepEqual(r.counts, { jobs: 2, llmSessions: 1 });
    assert.equal(r.tokensIn, 10); assert.equal(r.tokensOut, 4); assert.equal("costMicros" in r, false); assert.deepEqual(r.error, { message: "bad", name: "Error" });
    assert.equal(r.trigger, "catchup"); assert.equal(r.scheduledFor, T0 - 1); assert.equal(r.logPath, "/x/r1.log");
    assert.throws(() => store.finishRun("nope", fin("failed")), /unknown dream run nope/);
    store.close();
  });

  it("the store refuses values outside the closed phase and trigger sets", () => {
    const { store } = open();
    assert.throws(() => store.insertRun(run("r1", { phase: "dawn" as Phase })));
    assert.throws(() => store.insertRun(run("r2", { trigger: "cronjob" as never })));
    assert.equal(store.listRuns().length, 0);
    store.close();
  });

  it("listRuns filters, orders newest first, and limits; lastRun is the newest of one agent and phase", () => {
    const { store } = open();
    store.insertRun(run("a", { startedAt: T0 + 1, phase: "light", agentId: "alpha" }));
    store.insertRun(run("b", { startedAt: T0 + 3, phase: "deep", agentId: "alpha" }));
    store.insertRun(run("c", { startedAt: T0 + 2, phase: "deep", agentId: "beta" }));
    store.insertRun(run("d", { startedAt: T0 + 3, phase: "deep", agentId: "alpha" })); // same start as b: the later insert comes first
    assert.deepEqual(store.listRuns().map((r) => r.runId), ["d", "b", "c", "a"]);
    assert.deepEqual(store.listRuns({ agentId: "alpha" }).map((r) => r.runId), ["d", "b", "a"]);
    assert.deepEqual(store.listRuns({ phase: "deep" }).map((r) => r.runId), ["d", "b", "c"]);
    assert.deepEqual(store.listRuns({ since: T0 + 2 }).map((r) => r.runId), ["d", "b", "c"]);
    assert.deepEqual(store.listRuns({ limit: 2 }).map((r) => r.runId), ["d", "b"]);
    assert.equal(store.lastRun("alpha", "deep")!.runId, "d"); assert.equal(store.lastRun("beta", "light"), undefined);
    store.close();
  });

  it("openRuns lists exactly the runs without an outcome", () => {
    const { store } = open();
    store.insertRun(run("a")); store.insertRun(run("b")); store.finishRun("a", fin("skipped"));
    assert.deepEqual(store.openRuns().map((r) => r.runId), ["b"]);
    store.close();
  });

  it("llmSessionsSince sums llmSessions of closed runs of the given phases since the cut, per agent", () => {
    const { store } = open();
    const close = (id: string, o: Parameters<typeof run>[1], n: number | undefined) => { store.insertRun(run(id, { idempotencyKey: `k-${id}`, ...o })); store.finishRun(id, { outcome: "completed", reason: null, finishedAt: T0, counts: n === undefined ? {} : { llmSessions: n } }); };
    close("a", { phase: "rem", startedAt: T0 + 1 }, 1);
    close("b", { phase: "deep", startedAt: T0 + 2 }, 2);
    close("c", { phase: "light", startedAt: T0 + 3 }, 5); // not a counted phase
    close("d", { phase: "deep", startedAt: T0 - 1 }, 4); // before the cut
    close("e", { phase: "deep", startedAt: T0 + 4, agentId: "beta" }, 3); // another agent
    close("f", { phase: "rem", startedAt: T0 + 5 }, undefined); // no count recorded
    store.insertRun(run("open", { phase: "deep", startedAt: T0 + 6 })); // open runs are the scheduler's business
    assert.equal(store.llmSessionsSince("alpha", ["rem", "deep"], T0), 3);
    assert.equal(store.llmSessionsSince("alpha", ["light"], T0), 5);
    assert.equal(store.llmSessionsSince("alpha", ["rem", "deep"], T0 + 100), 0);
    assert.equal(store.llmSessionsSince("nobody", ["rem", "deep"], T0), 0);
    store.close();
  });

  it("prune deletes closed rows past the ledger cut, drops log paths past the log cut, and never touches an open run", () => {
    const { store } = open();
    const mk = (id: string, startedAt: number, closed: boolean) => { store.insertRun(run(id, { idempotencyKey: `k-${id}`, startedAt, logPath: `/logs/${id}.log` })); if (closed) store.finishRun(id, { outcome: "completed", reason: null, finishedAt: startedAt, counts: {} }); };
    mk("ancient", T0 - 400 * DAY, true); mk("old", T0 - 40 * DAY, true); mk("fresh", T0 - 1 * DAY, true); mk("ancient-open", T0 - 400 * DAY, false);
    const r = store.prune(T0 - 365 * DAY, T0 - 30 * DAY);
    assert.deepEqual(r.logs.sort(), ["/logs/ancient.log", "/logs/old.log"]);
    assert.equal(r.deleted, 1);
    assert.equal(store.getRun("ancient"), undefined);
    assert.equal(store.getRun("old")!.logPath, null, "the row stays, the log path is given up");
    assert.equal(store.getRun("fresh")!.logPath, "/logs/fresh.log");
    assert.ok(store.getRun("ancient-open"), "an open run is never deleted"); assert.equal(store.getRun("ancient-open")!.logPath, "/logs/ancient-open.log");
    store.close();
  });
});

describe("dreams/store: candidates", () => {
  it("insertCandidate dedupes by (agent, partition, content hash); the partition is part of the identity", () => {
    const { store } = open();
    assert.equal(store.insertCandidate(cand("c1", { contentHash: "H" })), true);
    assert.equal(store.insertCandidate(cand("c2", { contentHash: "H" })), false);
    assert.equal(store.insertCandidate(cand("c3", { contentHash: "H", partition: "workspace" })), true);
    assert.equal(store.insertCandidate(cand("c4", { contentHash: "H", agentId: "beta" })), true);
    assert.equal(store.listCandidates("alpha").length, 2);
    store.close();
  });

  it("a new candidate is shortlisted; setCandidateState records the decision; listCandidates filters by state and orders by first seen", () => {
    const { store } = open();
    store.insertCandidate(cand("c2", { firstSeenAt: T0 + 2 })); store.insertCandidate(cand("c1", { firstSeenAt: T0 + 1 }));
    assert.deepEqual(store.listCandidates("alpha").map((c) => c.candidateId), ["c1", "c2"]);
    assert.equal(store.listCandidates("alpha")[0]!.state, "shortlisted"); assert.equal(store.listCandidates("alpha")[0]!.decision, null);
    store.setCandidateState("c1", "promoted", { why: "test" });
    assert.deepEqual(store.listCandidates("alpha", "promoted").map((c) => c.candidateId), ["c1"]);
    assert.deepEqual(store.listCandidates("alpha", "promoted")[0]!.decision, { why: "test" });
    assert.deepEqual(store.listCandidates("alpha", "shortlisted").map((c) => c.candidateId), ["c2"]);
    store.close();
  });

  it("updateCandidateSignals refreshes only a shortlisted candidate", () => {
    const { store } = open();
    store.insertCandidate(cand("c1", { contentHash: "H1" })); store.insertCandidate(cand("c2", { contentHash: "H2" }));
    store.setCandidateState("c2", "promoted", {});
    store.updateCandidateSignals("alpha", "agent-private", "H1", { recalls: 4, uniqueQueries: 3, score: 0.9 });
    store.updateCandidateSignals("alpha", "agent-private", "H2", { recalls: 9, uniqueQueries: 9, score: 1 });
    const [c1, c2] = store.listCandidates("alpha");
    assert.deepEqual([c1!.recalls, c1!.uniqueQueries, c1!.score], [4, 3, 0.9]);
    assert.deepEqual([c2!.recalls, c2!.uniqueQueries, c2!.score], [0, 0, null], "a promoted candidate's record is not rewritten");
    store.close();
  });

  it("expireCandidates expires shortlisted candidates at or past their expiry, for that agent only, and records the gate", () => {
    const { store } = open();
    store.insertCandidate(cand("due", { expiresAt: T0 })); store.insertCandidate(cand("later", { expiresAt: T0 + 1 }));
    store.insertCandidate(cand("done", { expiresAt: T0 - 5 })); store.setCandidateState("done", "promoted", {});
    store.insertCandidate(cand("other", { agentId: "beta", expiresAt: T0 - 5 }));
    assert.equal(store.expireCandidates("alpha", T0), 1);
    const by = (id: string) => store.listCandidates(id.startsWith("other") ? "beta" : "alpha").find((c) => c.candidateId === id)!;
    assert.equal(by("due").state, "expired"); assert.deepEqual(by("due").decision, { gate: "expiry", passed: false, at: T0 });
    assert.equal(by("later").state, "shortlisted"); assert.equal(by("done").state, "promoted"); assert.equal(by("other").state, "shortlisted");
    store.close();
  });
});

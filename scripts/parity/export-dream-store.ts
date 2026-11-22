import { pathToFileURL } from "node:url";
import { DreamStore } from "../../packages/core/src/dreams/store.ts";
import { exporterMain } from "./lib.mjs";

export function buildDreamStoreVectors() {
  const store = new DreamStore(":memory:");
  try {
    const version = store.schemaVersion;
    const light = { agentId: "agent-a", phase: "light" as const, cron: "0 */4 * * *", timezone: "UTC", enabled: true, staggerOffsetS: 20, nextRunAt: 5000 };
    const rem = { ...light, phase: "rem" as const, cron: "15 1 * * *" };
    const other = { ...light, agentId: "agent-b", enabled: false };
    const inserts = [store.insertScheduleIfAbsent(rem), store.insertScheduleIfAbsent(light),
      store.insertScheduleIfAbsent(other), store.insertScheduleIfAbsent({ ...light, enabled: false })];
    store.recordCapture("agent-a", 5.5, 60);
    store.recordCapture("agent-a", 3, 65);
    store.updateSchedule("agent-a", "light", { nextRunAt: null, breakerState: "open", breakerUntil: 120, breakerReason: "fixture", lastRunId: "run-1" });
    const schedules = store.listSchedules();

    const run = { agentId: "agent-a", phase: "rem" as const, jobId: "fixture-job", idempotencyKey: "fixture-key",
      partition: null, trigger: "cron" as const, scheduledFor: 0, logPath: "fixture.log" };
    store.insertRun({ ...run, runId: "run-1", startedAt: 20 });
    store.insertRun({ ...run, runId: "run-2", startedAt: 30 });
    const claims = [store.claimKey("run-1", run.idempotencyKey), store.claimKey("run-2", run.idempotencyKey)];
    store.finishRun("run-1", { outcome: "failed", reason: "fixture", finishedAt: 25, counts: { llmSessions: 1 }, error: { message: "fixture run error" } });
    claims.push(store.claimKey("run-2", run.idempotencyKey));
    store.finishRun("run-2", { outcome: "completed", reason: null, finishedAt: 40, counts: { llmSessions: 2 }, tokensIn: 8, tokensOut: 2 });
    store.insertRun({ ...run, runId: "run-3", startedAt: 40, trigger: "catchup" });
    claims.push(store.claimKey("run-3", run.idempotencyKey));
    const holder = store.keyHolder(run.idempotencyKey);
    const runs = store.listRuns({ agentId: "agent-a", phase: "rem", since: 0 });
    const window = store.windowRuns("agent-a", "rem", 0).map(row => row.runId);
    const llmSessions = store.llmSessionsSince("agent-a", ["rem", "deep"], 0);
    const prune = store.prune(25, 35);
    const openAfterPrune = store.openRuns();

    const first = { candidateId: "candidate-a", agentId: "agent-a", partition: "agent-private", contentHash: "fixture-hash",
      sourceRunId: "run-2", firstSeenAt: 10, expiresAt: 35, recalls: 0, uniqueQueries: 0, score: null };
    const candidateInserts = [
      store.insertCandidate(first),
      store.insertCandidate({ ...first, candidateId: "duplicate" }),
      store.insertCandidate({ ...first, candidateId: "other-partition", partition: "workspace", expiresAt: 36 }),
      store.insertCandidate({ ...first, candidateId: "other-agent", agentId: "agent-b" }),
    ];
    store.updateCandidateSignals("agent-a", "agent-private", "fixture-hash", { recalls: 4, uniqueQueries: 3, score: 0.9 });
    const expired = store.expireCandidates("agent-a", 35);
    store.updateCandidateSignals("agent-a", "agent-private", "fixture-hash", { recalls: 7, uniqueQueries: 7, score: 1 });
    const candidates = { owned: store.listCandidates("agent-a"), other: store.listCandidates("agent-b"), expired, inserts: candidateInserts };
    return { store: { version, schedules, inserts, claims, holder, runs, window, llmSessions, prune, openAfterPrune, candidates } };
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "dreams", build: buildDreamStoreVectors });
}

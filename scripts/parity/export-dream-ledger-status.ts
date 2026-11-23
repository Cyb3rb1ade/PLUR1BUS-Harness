import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { AgentRegistry } from "../../packages/core/src/agents.ts";
import { buildDreamsMethods } from "../../packages/core/src/dreams/methods.ts";
import { mkHarness } from "../../packages/core/test/helpers/dreams.ts";
import { exporterMain } from "./lib.mjs";

export async function recordDreamLedgerStatus() {
  let sequence = 0;
  const fixture = mkHarness({ agents: ["a1", "a2"], over: { idFactory: () => "fixture-run-" + ++sequence } });
  try {
    fixture.captures("a1", 3);
    fixture.captures("a2", 2);
    fixture.sched.setSchedule("a1", "rem", { enabled: false, cron: "15 2 * * *" });
    await fixture.sched.runPhase("a1", "light", { trigger: "manual" });
    await fixture.sched.runPhase("a1", "light", { trigger: "manual" });
    const methods = buildDreamsMethods({ dreams: () => fixture.sched, agents: {} as AgentRegistry });
    const observed = await methods["dreams.status"]!({}, {} as never) as ReturnType<typeof fixture.sched.status>;
    const agents = observed.agents.map(({ agentId, phases }) => ({
      agentId,
      phases: phases.map(({ running: _running, lastRun, breaker, importance, ...schedule }) => ({
        ...schedule, lastRun: lastRun ? { ...lastRun, logPath: null } : null,
        breaker: { state: breaker.state, until: breaker.until, reason: breaker.reason },
        importance: { accumulated: importance.accumulated, capturesSinceRun: importance.capturesSinceRun },
      })),
    }));
    const sqlite = new DatabaseSync(join(fixture.dir, "dreams.db"), { readOnly: true });
    try {
      const schedules = sqlite.prepare("SELECT * FROM dream_schedule ORDER BY rowid").all();
      const runs = sqlite.prepare("SELECT * FROM dream_run ORDER BY rowid").all()
        .map((row) => ({ ...row, log_path: null }));
      return { "ledger-status": {
        input: { schedules, runs },
        expected: { agents, schemaVersion: observed.schemaVersion },
      } };
    } finally {
      sqlite.close();
    }
  } finally {
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

export async function recordDreamLedgerCrash() {
  const fixture = mkHarness({ agents: ["a1", "a2"] });
  const { store, sched } = fixture;
  try {
    sched.syncAgents();
    const add = (runId: string, agentId: string, key: string, startedAt: number, claim: boolean) => {
      store.insertRun({ runId, agentId, phase: "deep", jobId: "consolidate-daily", partition: null,
        trigger: "cron", scheduledFor: startedAt, idempotencyKey: key, startedAt, logPath: null });
      if (claim && !store.claimKey(runId, key)) throw new Error(`fixture could not claim ${runId}`);
    };
    add("closed", "a1", "old-due", 1, true);
    store.finishRun("closed", { outcome: "completed", reason: null, finishedAt: 2, counts: {}, tokensIn: 3 });
    store.updateSchedule("a1", "deep", { lastRunId: "closed" });
    add("claimed", "a1", "next-due", 3, true);
    add("provisional", "a1", "next-due", 4, false);
    add("other-closed", "a2", "other-due", 5, true);
    store.finishRun("other-closed", { outcome: "completed", reason: null, finishedAt: 6, counts: {} });
    store.updateSchedule("a2", "deep", { lastRunId: "other-closed" });

    const sqlite = new DatabaseSync(join(fixture.dir, "dreams.db"));
    try {
      sqlite.prepare("UPDATE dream_run SET counts_json = ?, tokens_in = ? WHERE run_id = ?")
        .run('{"llmSessions":2}', 4, "claimed");
      const input = {
        runs: sqlite.prepare("SELECT * FROM dream_run ORDER BY rowid").all(),
        schedules: sqlite.prepare("SELECT * FROM dream_schedule WHERE phase = 'deep' ORDER BY rowid").all(),
      };
      const reconciled = sched.reconcile();
      const latest = sqlite.prepare("SELECT agent_id AS agentId, last_run_id AS lastRunId FROM dream_schedule WHERE phase = 'deep' ORDER BY agent_id").all();
      const methods = buildDreamsMethods({ dreams: () => sched, agents: {} as AgentRegistry });
      const log = await methods["dreams.log"]!({ phase: "deep" }, {} as never);
      return { "ledger-crash": { input, now: fixture.clock.now(), expected: { reconciled, latest, log } } };
    } finally {
      sqlite.close();
    }
  } finally {
    store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "dreams", build: async () => ({
    ...await recordDreamLedgerStatus(), ...await recordDreamLedgerCrash(),
  }) });
}

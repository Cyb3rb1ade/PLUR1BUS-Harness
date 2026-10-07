// Mock data and /rpc handlers for the Memories & Dreams page tests (test/memory*.test.ts). Shapes follow docs/rpc.md.
import type { MockHarnessServer } from "./mock-server.ts";
import { rpcError } from "./mock-rpc.ts";
import type {
  DreamPhase, DreamPhaseStatus, DreamPlan, DreamRun, DreamSchedule, MemoryCard, MemoryProposal, RecallResult,
} from "../src/pages/memory/rpc-types.ts";

export const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const HOUR = 3_600_000;

export function makeCards(n: number): MemoryCard[] {
  const scopes = ["agent-private", "workspace", "user"] as const;
  return Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(3, "0");
    return {
      id: `mem_${k}`, scope: scopes[i % 3]!, summary: `Summary of memory ${k}`, text: `Full text of memory ${k}.\nSecond line ${k}.`,
      createdAt: T0 - i * HOUR, origin: i % 2 === 0 ? "capture" : "import", epistemicStatus: i % 4 === 0 ? "confirmed" : null,
      ...(i % 3 === 1 ? { sharedBy: "ops", sourceId: `src_${k}` } : {}),
    } satisfies MemoryCard;
  });
}

export function makeRun(over: Partial<DreamRun> = {}): DreamRun {
  return {
    runId: "run_001", agentId: "main", phase: "light", jobId: "light-dream", idempotencyKey: "k1", claimed: true, trigger: "cron",
    scheduledFor: T0 - 5 * HOUR, startedAt: T0 - 5 * HOUR, finishedAt: T0 - 5 * HOUR + 42_000, durationMs: 42_000, outcome: "completed", reason: null,
    counts: { captures: 7 }, tokensIn: 1200, tokensOut: 300, costMicros: null, logPath: "state/dreams/main/light/run_001.log", error: null, ...over,
  };
}

export function makePhase(phase: DreamPhase, over: Partial<DreamPhaseStatus> = {}): DreamPhaseStatus {
  const cron = { light: "0 */4 * * *", rem: "15 1 * * *", deep: "0 4 * * *" }[phase];
  return {
    phase, enabled: true, cron, timezone: "Europe/Berlin", staggerOffsetS: 120, nextRunAt: T0 + 3 * HOUR, running: false, lastRun: null,
    breaker: { state: "closed", until: null, reason: null, sessionsUsed: 0, limit: 3 }, importance: { accumulated: 40, threshold: 150, capturesSinceRun: 8, minCorpus: 1 }, ...over,
  };
}

export const RUNS: DreamRun[] = [
  makeRun({ runId: "run_003", phase: "deep", jobId: "consolidate-daily", outcome: "failed", reason: "engine_job_failed", error: { message: "engine job consolidate-daily failed: store locked" }, startedAt: T0 - HOUR }),
  makeRun({ runId: "run_002", phase: "rem", jobId: "rem-dream", outcome: "skipped", reason: "min_corpus", trigger: "importance", startedAt: T0 - 3 * HOUR, counts: {} }),
  makeRun({ runId: "run_001" }),
];

export type Fixture = {
  cards: MemoryCard[];
  runs: DreamRun[];
  schedules: DreamSchedule[];
  proposals: MemoryProposal[];
  /** Phase rows for dreams.status of agent "main"; the default has a completed light run and a failed deep run, rem never ran. */
  phases: DreamPhaseStatus[];
  agents: string[];
  planWouldRun: boolean;
};

export function defaultFixture(over: Partial<Fixture> = {}): Fixture {
  const light = makePhase("light", { lastRun: RUNS[2]! });
  const rem = makePhase("rem", { lastRun: RUNS[1]! });
  const deep = makePhase("deep", { lastRun: RUNS[0]!, enabled: false });
  return {
    cards: makeCards(45), runs: [...RUNS], phases: [light, rem, deep], agents: ["main", "ops"], planWouldRun: true,
    schedules: [light, rem, deep].map((p) => ({ agentId: "main", phase: p.phase, cron: p.cron, timezone: p.timezone, enabled: p.enabled, staggerOffsetS: p.staggerOffsetS, nextRunAt: p.nextRunAt })),
    proposals: [{
      id: "prop_1", sharedId: "mem_002", sourceId: "src_002", target: "workspace", sharerAgentId: "main", proposerAgentId: "ops", oldText: "old wording", newText: "new wording",
      note: "typo", createdAt: T0 - 2 * HOUR, status: "pending", resolvedAt: null, resultId: null, resolutionNote: null,
    }],
    ...over,
  };
}

/** Registers every method the page uses. Reads are `write: false` (no CSRF round trip); dreams.run/enable/disable are writes. */
export function installMemoryMocks(server: MockHarnessServer, fx: Fixture = defaultFixture()): Fixture {
  const r = server.rpc;
  const read = { write: false } as const;
  r.handle("core.status", () => ({
    process: { state: "ready" }, contract: "1.5.0", rpc: "1.5.0", instanceId: "inst_1", pid: 4242, uptimeMs: 3 * HOUR,
    engine: {
      ready: true, degraded: null,
      models: { embedder: { state: "ready", warming: false, checkedAt: T0, id: "e5-small" }, reranker: { state: "disabled", warming: false, checkedAt: null, id: null } },
      sharedMemory: { supported: true, mode: "verified-path" }, storeSchema: { current: "7", expected: "7" },
    },
    agents: fx.agents.map((agentId) => ({ agentId, activity: { state: "idle", since: T0 } })),
  }), read);
  r.handle("memory.state", (p) => ({ agentId: (p as { agentId: string }).agentId, cards: { agentPrivate: 15, workspace: 15, user: 15 }, tombstones: 2, archiveDir: "/home/x/archive" }), read);
  r.handle("memory.list", (p) => {
    const { limit = 20, topic } = p as { limit?: number; topic?: string };
    const all = topic ? fx.cards.filter((c) => c.summary.includes(topic) || c.text.includes(topic)) : fx.cards;
    return { agentId: "main", items: all.slice(0, limit), truncated: all.length > limit };
  }, read);
  r.handle("memory.show", (p) => {
    const card = fx.cards.find((c) => c.id === (p as { id: string }).id);
    if (!card) throw rpcError("E_NOT_FOUND", "no such memory", "unknown-id");
    return { card };
  }, read);
  r.handle("memory.recall", (p) => {
    const q = (p as { query: string }).query;
    const hits = fx.cards.filter((c) => c.summary.toLowerCase().includes(q.toLowerCase())).slice(0, 3);
    return {
      blocks: hits.length === 0 ? [] : [{ name: "memories", text: hits.map((c) => `- ${c.summary}`).join("\n"), droppable: true, chars: 100, tokensEstimate: 25 }, { name: "profile", text: "Profile block", droppable: false, chars: 13 }],
      capChars: 4000, degraded: null, trace: { query: q, candidates: hits.length, fusion: "rank" }, timing: { totalMs: 18, phases: { embed: 4, search: 9 } },
      deferrals: [{ block: "memories", kind: "clipped", from: 900, to: 600, reason: "memories-cap" }],
    } satisfies RecallResult;
  }, read);
  r.handle("memory.proposals.list", () => ({ agentId: "main", items: fx.proposals, truncated: false, unreadable: 0 }), read);

  r.handle("dreams.status", () => ({
    agents: [{ agentId: "main", phases: fx.phases, diary: { path: "/home/x/diary/main.md", exists: true, bytes: 2048 } }],
    counters: { runs: { light: 4, rem: 1, deep: 1 }, skips: { min_corpus: 1 }, triggers: { cron: 4, importance: 1, manual: 1 }, breakerTrips: 0, reconciled: 0 }, schemaVersion: 1,
  }), read);
  r.handle("dreams.log", (p) => {
    const { runId, phase, limit = 50 } = p as { runId?: string; phase?: DreamPhase; limit?: number };
    if (runId) {
      const run = fx.runs.find((x) => x.runId === runId);
      if (!run) throw rpcError("E_NOT_FOUND", "no such run", "unknown-run");
      return run.outcome === "skipped" ? { runs: [run] } : { runs: [run], log: `log of ${runId}\nline 2 of the run log` };
    }
    return { runs: fx.runs.filter((x) => !phase || x.phase === phase).slice(0, limit) };
  }, read);
  r.handle("dreams.schedule.get", () => ({ schedules: fx.schedules }), read);
  r.handle("dreams.run", (p) => {
    const { agentId, phase, dryRun } = p as { agentId: string; phase: DreamPhase; dryRun?: boolean };
    if (dryRun) {
      return {
        dryRun: true, wouldRun: fx.planWouldRun, reason: fx.planWouldRun ? null : "min_corpus", jobs: phase === "light" ? ["light-dream", "embedding-drain"] : ["rem-dream"],
        idempotencyKey: "plan-key", counts: { captures: 9 },
      } satisfies DreamPlan;
    }
    const run = makeRun({ runId: `run_${String(fx.runs.length + 1).padStart(3, "0")}`, agentId, phase, trigger: "manual", startedAt: T0, outcome: "completed" });
    fx.runs.unshift(run);
    return run;
  });
  const flip = (enabled: boolean) => (p: unknown) => {
    const { phase } = p as { phase: DreamPhase };
    const s = fx.schedules.find((x) => x.phase === phase)!;
    s.enabled = enabled;
    const ph = fx.phases.find((x) => x.phase === phase);
    if (ph) ph.enabled = enabled;
    return { schedule: s };
  };
  r.handle("dreams.enable", flip(true));
  r.handle("dreams.disable", flip(false));
  return fx;
}

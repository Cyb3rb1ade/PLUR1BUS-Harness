// Shared vocabulary of the dreaming scheduler (ADR-009). The scheduler orchestrates; the engine owns every step.
import type { Clock } from "../discovery/ports.ts";

export type { Clock };

export type Phase = "light" | "rem" | "deep";
export const PHASES: readonly Phase[] = ["light", "rem", "deep"];
export type Trigger = "cron" | "importance" | "manual" | "catchup";
export type Outcome = "completed" | "skipped" | "failed" | "aborted";
export type BreakerState = "closed" | "open";
export type CandidateState = "shortlisted" | "promoted" | "rejected" | "expired";

/** Reason codes (L16): every skip, failure and abort carries exactly one. Engine job reasons pass through unchanged
 *  when they explain a job-level skip or failure; these are the scheduler's own. */
export const REASON = {
  idempotent: "idempotent",
  breakerOpen: "breaker_open",
  breakerSessions: "breaker_sessions",
  minCorpus: "min_corpus",
  noCandidates: "no_candidates",
  noLlmRoute: "no_llm_route",
  noJobs: "no_jobs",
  crashed: "crashed",
  shutdown: "shutdown",
  diaryNotWritten: "diary_not_written",
  engineError: "engine_error",
  incomplete: "incomplete",
} as const;

/** One schedule row (`dream_schedule`) plus the signal columns the importance trigger needs. */
export interface ScheduleRow {
  agentId: string; phase: Phase; cron: string; timezone: string; enabled: boolean; staggerOffsetS: number;
  nextRunAt: number | null; lastRunId: string | null;
  breakerState: BreakerState; breakerUntil: number | null; breakerReason: string | null;
  /** Summed importance of captures since this phase last proceeded to a run (Generative Agents style). */
  importanceAcc: number;
  /** Captures since this phase last proceeded to a run; the minimum-corpus measure. */
  capturesAcc: number;
  /** Monotonic count of captures ever seen for the agent; the transcript digest is derived from it. */
  captureSeq: number;
  lastCaptureAt: number | null;
}

export interface RunCounts { jobs?: number; llmSessions?: number; candidates?: number; promoted?: number; rejected?: number; expired?: number; [k: string]: number | undefined }

export interface DreamRun {
  runId: string; agentId: string; phase: Phase; jobId: string; partition: string | null;
  /** The key as computed (without the claim suffix); `claimed` tells whether it is the one that blocks a rerun. */
  idempotencyKey: string; claimed: boolean;
  trigger: Trigger; scheduledFor: number | null; startedAt: number; finishedAt: number | null;
  /** null while the run is open; a row that stays open after a crash is reconciled to `aborted/crashed` at start. */
  outcome: Outcome | null; reason: string | null; counts: RunCounts;
  tokensIn: number | null; tokensOut: number | null; costMicros: number | null;
  logPath: string | null; error: { message: string; name?: string } | null;
}

export interface CandidateRow {
  candidateId: string; agentId: string; partition: string; contentHash: string; sourceRunId: string;
  firstSeenAt: number; expiresAt: number; recalls: number; uniqueQueries: number; score: number | null;
  state: CandidateState; decision: unknown;
}

export interface CandidateInput { content: string; partition?: string; recalls?: number; uniqueQueries?: number; score?: number }

/** What the scheduler needs of the engine: the job registry, nothing else (ADR-009 "Delivery"). */
export interface DreamEngine {
  jobs: {
    list(): { name: string; needsLlm: boolean; singleton: boolean; phase?: Phase }[];
    run(job: string, agentId: string, opts?: { signal?: AbortSignal; trigger?: "cron" | "manual" | "harness" | "capture" | "unknown" }): Promise<DreamJobRun>;
  };
}

/** The slice of the engine's `JobRun` the scheduler reads. */
export interface DreamJobRun {
  runId: string; job: string; outcome: "completed" | "skipped" | "incomplete" | "failed" | "abandoned"; reason?: string;
  cost?: { ms?: number; inputTokens?: number; outputTokens?: number; costMicros?: number };
  counts?: Record<string, number>; diary?: { written: boolean; reason?: string };
}

/** The producer of the candidate shortlist (ADR-009 C1). The pinned engine has none yet, so this port is optional;
 *  while it is absent the candidate guards are inert and a deep run does not require candidates. */
export interface CandidateSource { pull(agentId: string): Promise<CandidateInput[]> | CandidateInput[] }

export interface DreamEvent {
  name: "run.started" | "run.finished" | "breaker.opened" | "breaker.closed" | "trigger.importance" | "reconciled";
  agentId: string; phase?: Phase; runId?: string; outcome?: Outcome | null; reason?: string | null; trigger?: Trigger;
}

export interface DreamLogger { info(m: string, f?: object): void; warn(m: string, f?: object): void; error(m: string, f?: object): void }

export interface PhaseDefaults { cron: string; minCorpus: number; importanceThreshold: number; minGapMs: number; jobs: readonly string[]; primary: string }

const HOUR = 3_600_000;
/** RULING (ADR-009 phase mapping + sweep budget): one LLM job per phase, the model-free jobs of the phase beside it.
 *  The other LLM jobs the ADR table lists (classify-recent, afterthought, emotion-refine, persona-evolve) would break the
 *  3-session sweep budget; they stay on the engine's own cadence until the budget is measured (Q1). */
export const PHASE_DEFAULTS: Record<Phase, PhaseDefaults> = {
  light: { cron: "0 */4 * * *", minCorpus: 1, importanceThreshold: 150, minGapMs: 1 * HOUR, jobs: ["light-dream", "embedding-drain"], primary: "light-dream" },
  rem: { cron: "15 1 * * *", minCorpus: 3, importanceThreshold: 300, minGapMs: 6 * HOUR, jobs: ["rem-dream", "discover-semantic-links"], primary: "rem-dream" },
  deep: { cron: "0 4 * * *", minCorpus: 3, importanceThreshold: 450, minGapMs: 12 * HOUR, jobs: ["consolidate-daily", "auto-accept-stale", "gc-run"], primary: "consolidate-daily" },
};

export const DIARY_FILE = "dreaming.md"; // D15 harness-host name (the pinned engine still writes DREAMS.md: TODO(engine) rename for harness hosts)
export const MAX_CONCURRENT_RUNS = 3;
export const BREAKER_SESSIONS = 3;
export const STAGGER_WINDOW_S = 1800;
export const CANDIDATE_TTL_MS = 72 * HOUR;
export const DAY_MS = 24 * HOUR;
/** Phases whose LLM sessions count against the sweep breaker (the engine's own breaker and the CLI count the same two). */
export const BREAKER_PHASES: ReadonlySet<Phase> = new Set<Phase>(["rem", "deep"]);

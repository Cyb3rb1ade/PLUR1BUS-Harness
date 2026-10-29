/** N-A1 per-turn observations. Numeric counts and closed reasons carry no prompt, skill name or tool output. */

/** Tool-choice outcomes observed across the turn; a later auto round does not erase an earlier forced choice. */
export const TOOL_CHOICE_STATUSES = ["auto", "required", "named", "unsupported"] as const;
/** Stable reasons why the harness considers tool use necessary (N-E3). */
export const TOOL_NEED_REASONS = ["triage", "url", "path", "time", "attachment", "skill", "mode"] as const;
/** Bounded turn termination reasons, shared by events, metrics and the doctor summary. */
export const TURN_END_REASONS = [
  "completed", "tool-error", "provider-error", "approval-required", "local-only", "budget", "aborted",
  "cancelled", "error-limit", "round-limit", "command", "failed",
] as const;
/** The aggregate keeps at most this many recent triage durations, without retaining turn identifiers. */
export const TRIAGE_SAMPLE_LIMIT = 1024;

/** An observed tool-choice status, with provider-specific parameters represented by `named`. */
export type ToolChoiceStatus = typeof TOOL_CHOICE_STATUSES[number];
/** A closed tool-need reason; user text must never enter this field. */
export type ToolNeedReason = typeof TOOL_NEED_REASONS[number];
/** A closed termination reason; error details stay in the existing error channel. */
export type TurnEndReason = typeof TURN_END_REASONS[number];

/** One final snapshot per turn. `toolCalls` excludes the three explicitly counted meta-tools. */
export interface TurnTelemetry {
  rounds: number;
  toolCalls: number;
  metaCalls: { search: number; skillLoad: number; skillRead: number };
  skills: { injected: number; loaded: number };
  toolChoice: { status: ToolChoiceStatus; forced: boolean };
  toolNeed: { detected: boolean; reasons: ToolNeedReason[] };
  errorsReturned: number;
  endReason: TurnEndReason;
  /** Null means no triage measurement exists, rather than a measured zero. */
  triageDurationMs: number | null;
}

/** Returns a fresh empty observation without enabling selection, tool forcing or any other turn behavior. */
export function createTurnTelemetry(): TurnTelemetry {
  return {
    rounds: 0,
    toolCalls: 0,
    metaCalls: { search: 0, skillLoad: 0, skillRead: 0 },
    skills: { injected: 0, loaded: 0 },
    toolChoice: { status: "auto", forced: false },
    toolNeed: { detected: false, reasons: [] },
    errorsReturned: 0,
    endReason: "completed",
    triageDurationMs: null,
  };
}

/** Lifetime counters plus nearest-rank quantiles over the most recent TRIAGE_SAMPLE_LIMIT triage samples. */
export interface TurnTelemetrySummary {
  turns: number;
  rounds: number;
  toolCalls: number;
  metaCalls: { search: number; skillLoad: number; skillRead: number };
  skills: { injected: number; loaded: number };
  errorsReturned: number;
  toolNeedTurns: number;
  forcedTurns: number;
  withoutNeededTool: number;
  toolChoiceUnsupported: number;
  endReasons: Record<TurnEndReason, number>;
  triage: { count: number; p50Ms: number | null; p95Ms: number | null };
}

/** Creates process-local, bounded, identifier-free aggregation; callers receive independent summary snapshots. */
export function createTurnTelemetryAggregate(): {
  observe(telemetry: TurnTelemetry): void;
  snapshot(): TurnTelemetrySummary;
} {
  const total: Omit<TurnTelemetrySummary, "triage"> = {
    turns: 0, rounds: 0, toolCalls: 0,
    metaCalls: { search: 0, skillLoad: 0, skillRead: 0 },
    skills: { injected: 0, loaded: 0 },
    errorsReturned: 0, toolNeedTurns: 0, forcedTurns: 0, withoutNeededTool: 0, toolChoiceUnsupported: 0,
    endReasons: Object.fromEntries(TURN_END_REASONS.map(reason => [reason, 0])) as Record<TurnEndReason, number>,
  };
  const samples: number[] = [];
  let nextSample = 0;
  const count = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    observe(t) {
      total.turns++;
      total.rounds += count(t.rounds);
      total.toolCalls += count(t.toolCalls);
      for (const key of ["search", "skillLoad", "skillRead"] as const) total.metaCalls[key] += count(t.metaCalls[key]);
      total.skills.injected += count(t.skills.injected);
      total.skills.loaded += count(t.skills.loaded);
      total.errorsReturned += count(t.errorsReturned);
      if (t.toolNeed.detected) total.toolNeedTurns++;
      if (t.toolNeed.detected && t.toolCalls === 0) total.withoutNeededTool++;
      if (t.toolChoice.forced) total.forcedTurns++;
      if (t.toolChoice.status === "unsupported") total.toolChoiceUnsupported++;
      const reason = (TURN_END_REASONS as readonly string[]).includes(t.endReason) ? t.endReason : "failed";
      total.endReasons[reason]++;
      if (t.triageDurationMs !== null && Number.isFinite(t.triageDurationMs) && t.triageDurationMs >= 0) {
        samples[nextSample] = t.triageDurationMs;
        nextSample = (nextSample + 1) % TRIAGE_SAMPLE_LIMIT;
      }
    },
    snapshot() {
      const sorted = [...samples].sort((a, b) => a - b);
      const rank = (quantile: number) => sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
      return {
        ...total,
        metaCalls: { ...total.metaCalls },
        skills: { ...total.skills },
        endReasons: { ...total.endReasons },
        triage: { count: sorted.length, p50Ms: rank(0.5), p95Ms: rank(0.95) },
      };
    },
  };
}

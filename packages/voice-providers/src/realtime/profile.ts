// LocalRealtimeProfile (AL14/AL15), logic only: what a simulated local "real-time" voice turn may spend time on.
// The profile is data (voice.localRealtime.*); the FeatureRunner enforces the per-feature time budgets. Nothing here
// is wired into the pipeline yet.
import type { FeatureLatencyRecorder } from "./latency.ts";

export const FEATURE_NAMES = ["autoRecall", "reranker", "recallMultiIdentity", "promptEnrichment", "decisionService", "postTurnRefine", "memoryWrite", "compaction"] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureMode = "on" | "deferred" | "off";
export interface FeatureSetting { mode: FeatureMode; maxMs?: number }
export type FeatureInput = FeatureMode | { mode?: FeatureMode; maxMs?: number };

export interface LocalRealtimeConfigBase {
  enabled?: boolean;
  endpointingMs?: number;
  speculativeTurnStart?: boolean;
  ackSound?: boolean;
  sentenceChunking?: { maxWords?: number };
  features?: Partial<Record<FeatureName, FeatureInput>>;
  toolSchemas?: "reduced" | "full";
  auditDetail?: "minimal" | "full";
}
/** voice.localRealtime.* ; `perAgent.<id>` takes the same keys and wins over the global values. */
export interface LocalRealtimeConfig extends LocalRealtimeConfigBase {
  perAgent?: Record<string, LocalRealtimeConfigBase>;
}

export interface LocalRealtimeProfile {
  enabled: boolean;
  endpointingMs: number;
  speculativeTurnStart: boolean;
  ackSound: boolean;
  sentenceChunking: { maxWords: number };
  features: Record<FeatureName, FeatureSetting>;
  toolSchemas: "reduced" | "full";
  auditDetail: "minimal" | "full";
}

/** Defaults and why (docs/voice-local.md): recall and a short prompt enrichment are cheap and keep answers grounded;
 * everything that adds a model call or a write goes off or after the turn so the first audio is not delayed. */
export const LOCAL_REALTIME_DEFAULTS: LocalRealtimeProfile = {
  enabled: false,
  endpointingMs: 400,
  speculativeTurnStart: false,
  ackSound: false,
  sentenceChunking: { maxWords: 24 },
  features: {
    autoRecall: { mode: "on", maxMs: 30 },
    reranker: { mode: "off" },
    recallMultiIdentity: { mode: "off" },
    promptEnrichment: { mode: "on", maxMs: 10 },
    decisionService: { mode: "off" },
    postTurnRefine: { mode: "deferred" },
    memoryWrite: { mode: "deferred" },
    compaction: { mode: "deferred" },
  },
  toolSchemas: "reduced",
  auditDetail: "minimal",
};

function normaliseFeature(featureName: FeatureName, base: FeatureSetting, input: FeatureInput | undefined): FeatureSetting {
  if (input === undefined) return base;
  const defaultMaxMs = LOCAL_REALTIME_DEFAULTS.features[featureName].maxMs;
  if (typeof input === "string") {
    const maxMs = input === "on" ? (base.maxMs ?? defaultMaxMs) : base.maxMs;
    return withoutMax(input, maxMs);
  }
  const mode = input.mode ?? base.mode;
  let maxMs = input.maxMs ?? base.maxMs;
  if (mode === "on" && maxMs === undefined) maxMs = defaultMaxMs;
  return withoutMax(mode, maxMs);
}
function withoutMax(mode: FeatureMode, maxMs: number | undefined): FeatureSetting {
  return maxMs === undefined ? { mode } : { mode, maxMs };
}


function applyLayer(p: LocalRealtimeProfile, c: LocalRealtimeConfigBase | undefined): LocalRealtimeProfile {
  if (!c) return p;
  if (c.endpointingMs !== undefined) {
    if (!Number.isInteger(c.endpointingMs) || c.endpointingMs < 50 || c.endpointingMs > 5000) {
      throw new Error(`invalid endpointingMs: must be an integer between 50 and 5000, got ${c.endpointingMs}`);
    }
  }
  if (c.sentenceChunking?.maxWords !== undefined) {
    if (!Number.isInteger(c.sentenceChunking.maxWords) || c.sentenceChunking.maxWords < 3 || c.sentenceChunking.maxWords > 200) {
      throw new Error(`invalid sentenceChunking.maxWords: must be an integer between 3 and 200, got ${c.sentenceChunking.maxWords}`);
    }
  }
  const features = { ...p.features };
  for (const name of FEATURE_NAMES) features[name] = normaliseFeature(name, p.features[name], c.features?.[name]);
  return {
    enabled: c.enabled ?? p.enabled,
    endpointingMs: c.endpointingMs ?? p.endpointingMs,
    speculativeTurnStart: c.speculativeTurnStart ?? p.speculativeTurnStart,
    ackSound: c.ackSound ?? p.ackSound,
    sentenceChunking: { maxWords: c.sentenceChunking?.maxWords ?? p.sentenceChunking.maxWords },
    features,
    toolSchemas: c.toolSchemas ?? p.toolSchemas,
    auditDetail: c.auditDetail ?? p.auditDetail,
  };
}

/** defaults < voice.localRealtime < voice.localRealtime.perAgent.<agentId> */
export function resolveProfile(config: LocalRealtimeConfig | undefined, agentId?: string): LocalRealtimeProfile {
  const { perAgent, ...global } = config ?? {};
  const base = applyLayer(structuredClone(LOCAL_REALTIME_DEFAULTS), global);
  return applyLayer(base, agentId ? perAgent?.[agentId] : undefined);
}

// ---- budgeted execution ----

export type SkipReason = "off" | "deferred";
export type BudgetResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "budget_exceeded"; maxMs: number }
  | { ok: false; reason: SkipReason }
  | { ok: false; reason: "aborted" }
  | { ok: false; reason: "error"; error: unknown };

export type FeatureEvent =
  | { type: "feature.budget_exceeded"; feature: FeatureName; maxMs: number; elapsedMs: number }
  | { type: "feature.skipped"; feature: FeatureName; reason: SkipReason }
  | { type: "feature.completed"; feature: FeatureName; durationMs: number }
  | { type: "feature.failed"; feature: FeatureName; durationMs: number }
  | { type: "feature.dropped"; feature: FeatureName };

export interface FeatureRunnerOptions {
  profile: LocalRealtimeProfile;
  emit: (event: FeatureEvent) => void;
  now?: () => number;
  recorder?: FeatureLatencyRecorder;
  turnId?: string;
}

export interface FeatureRunner {
  /**
   * Run `fn` for the feature under the profile: off or deferred features do not run inline; an `on` feature with maxMs
   * is raced against that budget (fn gets a signal that fires when the budget is spent). In a profile that is not
   * enabled the feature simply runs with no budget.
   */
  runWithBudget<T>(feature: FeatureName, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<BudgetResult<T>>;
  /** Queue work for after the turn (for features in `deferred` mode). */
  defer(feature: FeatureName, fn: (signal: AbortSignal) => Promise<unknown>): void;
  /** Run and clear the deferred queue, in order; one failure does not stop the rest. Returns how many ran. */
  drainDeferred(signal?: AbortSignal): Promise<number>;
  readonly pendingDeferred: number;
}

export function createFeatureRunner(o: FeatureRunnerOptions): FeatureRunner {
  const now = o.now ?? Date.now;
  const queue: Array<{ feature: FeatureName; fn: (signal: AbortSignal) => Promise<unknown> }> = [];

  const record = (feature: FeatureName, ms: number, exceeded: boolean) => { if (o.recorder && o.turnId !== undefined) o.recorder.recordFeature(o.turnId, feature, ms, exceeded); };

  return {
    async runWithBudget<T>(feature: FeatureName, fn: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<BudgetResult<T>> {
      if (signal?.aborted) return { ok: false, reason: "aborted" };
      const setting = o.profile.features[feature];
      if (o.profile.enabled && setting.mode !== "on") {
        o.emit({ type: "feature.skipped", feature, reason: setting.mode });
        return { ok: false, reason: setting.mode };
      }
      const maxMs = o.profile.enabled ? setting.maxMs : undefined;
      const ctl = new AbortController();
      const onOuterAbort = () => ctl.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      const t0 = now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        let workPromise: Promise<T>;
        try {
          workPromise = Promise.resolve(fn(ctl.signal));
        } catch (syncErr) {
          const elapsed = now() - t0;
          record(feature, elapsed, false);
          o.emit({ type: "feature.failed", feature, durationMs: elapsed });
          return { ok: false, reason: "error", error: syncErr };
        }
        const work = workPromise.then((value) => ({ kind: "value" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
        const racers: Array<Promise<{ kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" }>> = [work];
        if (maxMs !== undefined) racers.push(new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), maxMs); }));
        const r = await Promise.race(racers);
        const elapsed = now() - t0;
        if (r.kind === "timeout") {
          ctl.abort();
          record(feature, elapsed, true);
          o.emit({ type: "feature.budget_exceeded", feature, maxMs: maxMs!, elapsedMs: elapsed });
          return { ok: false, reason: "budget_exceeded", maxMs: maxMs! };
        }
        if (signal?.aborted) return { ok: false, reason: "aborted" };
        if (r.kind === "error") {
          record(feature, elapsed, false);
          o.emit({ type: "feature.failed", feature, durationMs: elapsed });
          return { ok: false, reason: "error", error: r.error };
        }
        record(feature, elapsed, false);
        o.emit({ type: "feature.completed", feature, durationMs: elapsed });
        return { ok: true, value: r.value };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    },
    defer(feature, fn) {
      queue.push({ feature, fn });
    },
    async drainDeferred(signal) {
      let ran = 0;
      while (queue.length > 0) {
        if (signal?.aborted) {
          while (queue.length > 0) {
            const dropped = queue.shift()!;
            o.emit({ type: "feature.dropped", feature: dropped.feature });
          }
          break;
        }
        const job = queue.shift()!;
        const ctl = new AbortController();
        const t0 = now();
        try {
          await job.fn(ctl.signal);
          o.emit({ type: "feature.completed", feature: job.feature, durationMs: now() - t0 });
        } catch {
          o.emit({ type: "feature.failed", feature: job.feature, durationMs: now() - t0 });
        }
        ran++;
      }
      return ran;
    },

    get pendingDeferred() {
      return queue.length;
    },
  };
}

// Per-turn latency aggregation: how long each optional feature took and how long the user waited between the end of
// their speech and the first audio of the answer. Pure; the clock is injected.

export interface Stats { count: number; medianMs: number; p95Ms: number; maxMs: number }
export interface FeatureStats extends Stats { budgetExceeded: number }
export interface LatencyReport {
  turns: number;
  features: Record<string, FeatureStats>;
  speechEndToFirstAudio: Stats;
}

interface TurnRecord {
  features: Array<{ name: string; durationMs: number; exceeded: boolean }>;
  speechEndAt?: number;
  firstAudioMs?: number;
}

export interface RecorderOptions {
  now: () => number;
  /** Turns kept for the report; older ones are dropped. Default 500. */
  maxTurns?: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}
export function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  return { count: s.length, medianMs: median(s), p95Ms: percentile(s, 0.95), maxMs: s.length ? s[s.length - 1]! : 0 };
}

export class FeatureLatencyRecorder {
  private readonly now: () => number;
  private readonly maxTurns: number;
  private readonly turns = new Map<string, TurnRecord>();

  constructor(o: RecorderOptions) {
    this.now = o.now;
    this.maxTurns = o.maxTurns ?? 500;
  }

  private turn(id: string): TurnRecord {
    let t = this.turns.get(id);
    if (!t) {
      t = { features: [] };
      this.turns.set(id, t);
      while (this.turns.size > this.maxTurns) this.turns.delete(this.turns.keys().next().value as string);
    }
    return t;
  }

  recordFeature(turnId: string, feature: string, durationMs: number, exceeded = false): void {
    this.turn(turnId).features.push({ name: feature, durationMs: Math.max(0, durationMs), exceeded });
  }

  /** Time an async function and record it; the result or error passes through. */
  async time<T>(turnId: string, feature: string, fn: () => Promise<T>): Promise<T> {
    const t0 = this.now();
    try {
      return await fn();
    } finally {
      this.recordFeature(turnId, feature, this.now() - t0);
    }
  }

  markSpeechEnd(turnId: string): void {
    this.turn(turnId).speechEndAt = this.now();
  }

  /** First audio of the answer; the delta from speech end is recorded once per turn. */
  markFirstAudio(turnId: string): void {
    const t = this.turn(turnId);
    if (t.speechEndAt === undefined || t.firstAudioMs !== undefined) return;
    t.firstAudioMs = Math.max(0, this.now() - t.speechEndAt);
  }

  report(): LatencyReport {
    const byFeature = new Map<string, { d: number[]; exceeded: number }>();
    const e2e: number[] = [];
    for (const t of this.turns.values()) {
      for (const f of t.features) {
        const e = byFeature.get(f.name) ?? { d: [], exceeded: 0 };
        e.d.push(f.durationMs);
        if (f.exceeded) e.exceeded++;
        byFeature.set(f.name, e);
      }
      if (t.firstAudioMs !== undefined) e2e.push(t.firstAudioMs);
    }
    const features: Record<string, FeatureStats> = {};
    for (const [name, e] of [...byFeature.entries()].sort(([a], [b]) => a.localeCompare(b))) features[name] = { ...stats(e.d), budgetExceeded: e.exceeded };
    return { turns: this.turns.size, features, speechEndToFirstAudio: stats(e2e) };
  }

  reset(): void {
    this.turns.clear();
  }
}

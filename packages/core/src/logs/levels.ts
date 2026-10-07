import { isLevel, isSourceKey, type Level, type SourceKind } from "@plur1bus/log-schema";
export interface Source { kind: SourceKind; id: string; version: string | null }
export interface LevelSettings { defaultLevel?: Level; levels?: Record<string, Level>; traceUntil?: number }
export class LevelPolicy {
  private settings: LevelSettings = { defaultLevel: "info" };
  private expiredKeys = new Set<string>();
  private now: () => number;
  private expired: (key: string) => void;
  constructor(o: { now?: () => number; expired?: (key: string) => void } = {}) { this.now = o.now ?? Date.now; this.expired = o.expired ?? (() => {}); }
  /** Replaces the snapshot atomically: removing an override restores its parent/default immediately. */
  update(next: LevelSettings): void {
    if (next.defaultLevel !== undefined && !isLevel(next.defaultLevel)) throw new RangeError("invalid default level");
    for (const [key, value] of Object.entries(next.levels ?? {})) if (!isSourceKey(key) || !isLevel(value)) throw new RangeError("invalid source level");
    if ([next.defaultLevel, ...Object.values(next.levels ?? {})].includes("trace") &&
        (!Number.isFinite(next.traceUntil) || next.traceUntil! <= this.now() || next.traceUntil! > this.now() + 86400000)) throw new RangeError("trace requires a future expiry within 24 hours");
    this.settings = { ...next, levels: { ...next.levels } }; this.expiredKeys.clear();
  }
  resolve(source: Source): Level {
    const key = `${source.kind}:${source.id}`;
    const candidates = Object.keys(this.settings.levels ?? {}).filter(k => k === source.kind || k === key || key.startsWith(`${k}/`)).sort((a, b) => b.length - a.length);
    const level = this.settings.levels?.[candidates[0]!] ?? this.settings.defaultLevel ?? "info";
    if (level === "trace" && this.now() >= this.settings.traceUntil!) {
      if (!this.expiredKeys.has(key)) { this.expiredKeys.add(key); this.expired(key); }
      return "debug";
    }
    return level;
  }
}

import type { DatabaseSync } from "node:sqlite";

export interface LimitSpec { limit: number; windowMs: number; lockMs: number }
/** Per claimant (channel identity) and over every claimant together: rotating accounts does not reset the global one. */
// RULING: 5 failures per handle and 20 overall per 15 minutes, lock 15 minutes (ADR-007: "rate-limited", no number given).
export const SOURCE_LIMIT: LimitSpec = { limit: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
export const GLOBAL_LIMIT: LimitSpec = { limit: 20, windowMs: 15 * 60_000, lockMs: 15 * 60_000 };
export const GLOBAL_KEY = "global";

/** Failed-claim counters kept in the database, so a restart of the core is not a way to reset a brute force. */
export function createLimiter(db: DatabaseSync, clock: () => number) {
  const get = db.prepare("SELECT failures, window_start, locked_until FROM attempts WHERE key = ?");
  const put = db.prepare(
    "INSERT INTO attempts(key, failures, window_start, locked_until) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until");
  const del = db.prepare("DELETE FROM attempts WHERE key = ?");
  type Row = { failures: number; window_start: number; locked_until: number } | undefined;
  return {
    /** Milliseconds until every one of `keys` accepts a claim again; 0 when none is locked. */
    lockedFor(keys: string[]): number {
      const now = clock(); let wait = 0;
      for (const k of keys) { const r = get.get(k) as Row; if (r && r.locked_until > now) wait = Math.max(wait, r.locked_until - now); }
      return wait;
    },
    failure(key: string, spec: LimitSpec): void {
      const now = clock(); const r = get.get(key) as Row;
      let failures = r && now - r.window_start <= spec.windowMs ? r.failures : 0; let start = r && now - r.window_start <= spec.windowMs ? r.window_start : now;
      failures += 1; let lockedUntil = r?.locked_until ?? 0;
      if (failures >= spec.limit) { lockedUntil = now + spec.lockMs; failures = 0; start = now; }
      put.run(key, failures, start, lockedUntil);
    },
    success(key: string): void { del.run(key); },
    prune(): void { db.prepare("DELETE FROM attempts WHERE locked_until < ? AND window_start < ?").run(clock(), clock() - 24 * 3_600_000); },
  };
}

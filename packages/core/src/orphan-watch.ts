/**
 * Watches the core's one lifeline (S4): a spawned core's stdin pipe, or the authenticated connection on which
 * `core.adopt` last succeeded. Losing the current source orphans the core; a grace timer then asks it to stop,
 * unless a new source (a successful adoption) arrives first. Only the current source counts: replacing it makes
 * the previous one's loss irrelevant.
 */
export interface OrphanWatch {
  /** Makes `s` the lifeline. Its 'end', 'close' or 'error' (or an already ended stream) is a loss. */
  watchStream(s: NodeJS.ReadableStream): void;
  /** Makes the connection the lifeline, replacing the current source and cancelling a running grace timer. */
  watchConnection(connectionId: string): void;
  /** A loss only when `connectionId` is the current source. */
  connectionClosed(connectionId: string): void;
  readonly orphanedSince: number | null;
  /** Cancels the grace timer and ignores every later event. */
  dispose(): void;
}

export interface OrphanWatchOptions {
  graceMs: number; clock?: () => number;
  onOrphaned(since: number): void; onReattached(): void; onGraceExpired(): void;
}

type Source = { kind: "stream" } | { kind: "connection"; id: string };

export function createOrphanWatch(o: OrphanWatchOptions): OrphanWatch {
  const clock = o.clock ?? Date.now;
  let source: Source | null = null;
  let orphanedSince: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;

  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  function lost(from: Source): void {
    if (disposed || source !== from) return;
    source = null;
    if (orphanedSince !== null) return;
    orphanedSince = clock();
    // Not unref'ed: the grace expiry is what ends an orphan, so it must keep the process alive until then.
    timer = setTimeout(() => { timer = null; if (!disposed) o.onGraceExpired(); }, o.graceMs);
    o.onOrphaned(orphanedSince);
  }

  function attach(next: Source): void {
    if (disposed) return;
    source = next;
    clearTimer();
    if (orphanedSince !== null) { orphanedSince = null; o.onReattached(); }
  }

  return {
    watchStream(s) {
      const me: Source = { kind: "stream" };
      attach(me);
      const onLost = () => lost(me);
      s.once("end", onLost); s.once("close", onLost); s.once("error", onLost);
      const r = s as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
      if (r.readableEnded || r.destroyed) { onLost(); return; }
      s.resume(); // 'end' fires only once the data is consumed; a lifeline carries none worth reading
    },
    watchConnection(connectionId) { attach({ kind: "connection", id: connectionId }); },
    connectionClosed(connectionId) {
      if (source?.kind === "connection" && source.id === connectionId) lost(source);
    },
    get orphanedSince() { return orphanedSince; },
    dispose() { disposed = true; source = null; clearTimer(); },
  };
}

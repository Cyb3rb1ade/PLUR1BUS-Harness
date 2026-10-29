/** Startup admission owned by the authenticated import job; service construction remains available for status. */
export interface CompositionMaintenance {
  held(): boolean;
  onRelease(start: () => void | Promise<void>): () => void;
}

/** Register one cancellable start. Undefined means the caller should start immediately using its normal await path. */
export function deferMaintenanceStart(maintenance: CompositionMaintenance | undefined,
  start: () => void | Promise<void>): (() => void) | undefined {
  if (!maintenance?.held()) return undefined;
  let closed = false;
  let finished = false;
  let running: Promise<void> | undefined;
  const unwatch = maintenance.onRelease(async () => {
    if (closed || finished) return;
    try {
      running ??= Promise.resolve().then(() => { if (!closed) return start(); });
      await running;
      finished = true;
    } finally { running = undefined; }
  });
  return () => { closed = true; unwatch(); };
}

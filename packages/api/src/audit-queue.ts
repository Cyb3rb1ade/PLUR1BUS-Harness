import type { AuditEvent, AuditSink } from "./rbac-bridge.ts";

export interface BufferedSink extends AuditSink {
  /** Writes what is queued (retrying), then returns. For shutdown and tests. */
  flush(): Promise<void>;
  readonly pending: number;
  /** Events that could not be recorded: queue full, or the inner sink kept failing. */
  readonly dropped: number;
}

export interface BufferedSinkOptions {
  log: { error(msg: string, f?: Record<string, unknown>): void };
  maxQueue?: number; maxAttempts?: number; retryMs?: number;
}

interface Item { e: AuditEvent; attempts: number }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The core's audit chain is written synchronously under an OS lock the core shares: a contended append waits in a
 *  `sleepSync` loop. Called from a request that would stop the API's event loop for as long as the core holds the lock,
 *  and an attacker who can cause audit events (failed logins) could cause that. So auth events are queued and written
 *  from the event loop's check phase, in order, a few retries each; the request never waits for the chain.
 *  `append` therefore never throws. An event that cannot be recorded in the end is counted and logged by action name
 *  only. (Break-glass does not use this: it must not act unrecorded, so it writes the chain directly and fails closed.) */
export function createBufferedSink(inner: AuditSink, o: BufferedSinkOptions): BufferedSink {
  const maxQueue = o.maxQueue ?? 2000; const maxAttempts = o.maxAttempts ?? 5; const retryMs = o.retryMs ?? 250;
  const queue: Item[] = []; let dropped = 0; let scheduled: NodeJS.Immediate | NodeJS.Timeout | undefined; let draining = false; let fullLogged = false;

  const drop = (it: Item, why: string): void => { dropped++; o.log.error("audit event dropped", { action: it.e.action, reason: why }); };

  /** One pass: writes from the head until the queue is empty or the head fails; returns whether the head must be retried. */
  function pass(): boolean {
    while (queue.length > 0) {
      const it = queue[0]!;
      try { inner.append(it.e); queue.shift(); fullLogged = false; }
      catch { it.attempts++; if (it.attempts >= maxAttempts) { queue.shift(); drop(it, "sink-failed"); continue; } return true; }
    }
    return false;
  }

  function schedule(delay?: number): void {
    if (scheduled || draining) return;
    const run = () => { scheduled = undefined; if (pass()) schedule(retryMs * (queue[0]?.attempts ?? 1)); };
    if (delay === undefined) scheduled = setImmediate(run);
    else { const t = setTimeout(run, delay); t.unref(); scheduled = t; }
  }

  return {
    append(e) {
      if (queue.length >= maxQueue) {
        dropped++;
        if (!fullLogged) { fullLogged = true; o.log.error("audit queue full", { action: e.action, limit: maxQueue }); }
        return;
      }
      queue.push({ e: structuredClone(e), attempts: 0 });
      schedule();
    },
    async flush() {
      draining = true;
      try {
        if (scheduled !== undefined) { clearImmediate(scheduled as NodeJS.Immediate); clearTimeout(scheduled as NodeJS.Timeout); scheduled = undefined; }
        while (queue.length > 0) { if (pass()) await sleep(retryMs); }
      } finally { draining = false; }
    },
    get pending() { return queue.length; },
    get dropped() { return dropped; },
  };
}

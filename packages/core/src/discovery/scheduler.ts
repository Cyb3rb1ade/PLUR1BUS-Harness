// Scheduler for periodic and catch-up model discovery scans (spec §2.8, R12; plan Task 8).
import type { Clock, Rng, TimerHandle } from "./ports.ts";
import type { CatalogStore } from "./catalog-store.ts";
import type { DiscoveryService, ScanSettings } from "./service.ts";
import type { RunTrigger } from "./types.ts";
import { nextRegularAt } from "./schedule.ts";

export interface ScanScheduler {
  /** Call once, after core.process.ready. */
  start(): void;
  /** Recompute timers when settings (enabled, intervalHours) changed. */
  replan(): void;
  /** Cancel timers and abort in-flight scans. */
  stop(): void;
  /** Currently armed timer targets. */
  armed(): { provider: string; at: number }[];
}

export function createScanScheduler(o: {
  service: DiscoveryService;
  store: CatalogStore;
  systemRun: (provider: string, trigger: RunTrigger, signal: AbortSignal) => Promise<unknown>;
  clock: Clock;
  rng: Rng;
  settings: () => ScanSettings;
  logger: { debug(m: string, f?: object): void };
}): ScanScheduler {
  let started = false;
  let stopped = false;
  const armedTimers = new Map<string, { at: number; handle: TimerHandle }>();
  const runningScans = new Set<string>();
  const abortController = new AbortController();

  let activeScans = 0;
  const queue: (() => void)[] = [];

  async function runWithLimit<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (activeScans >= 4) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    activeScans++;
    try {
      return await fn(abortController.signal);
    } finally {
      activeScans--;
      const next = queue.shift();
      if (next) next();
    }
  }

  function arm(provider: string, atMs: number, trigger: RunTrigger) {
    const existing = armedTimers.get(provider);
    if (existing) {
      existing.handle.cancel();
      armedTimers.delete(provider);
    }

    const delayMs = Math.max(0, atMs - o.clock.now());
    const handle = o.clock.setTimer(async () => {
      armedTimers.delete(provider);
      if (stopped) return;
      if (!o.settings().enabled) return;
      if (runningScans.has(provider)) return;

      runningScans.add(provider);
      try {
        await runWithLimit(async (signal) => {
          await o.systemRun(provider, trigger, signal);
        });
      } catch (err) {
        o.logger.debug("scan run error in scheduler", { provider, error: String(err) });
      } finally {
        runningScans.delete(provider);
      }

      if (stopped) return;
      if (!o.settings().enabled) return;

      const st = o.store.read().providers[provider];
      if (st?.nextScanAt) {
        const nextMs = Date.parse(st.nextScanAt);
        if (Number.isFinite(nextMs)) {
          arm(provider, nextMs, "cron");
        }
      }
    }, delayMs);

    armedTimers.set(provider, { at: atMs, handle });
  }

  function scheduleAll() {
    if (!o.settings().enabled) return;
    const scannable = o.service.scannable().map((s) => s.id);
    const cat = o.store.read();
    const now = o.clock.now();
    const intervalMs = o.settings().intervalHours * 3600_000;

    const due: { provider: string; rawDelay: number }[] = [];
    const notDue: { provider: string; at: number }[] = [];

    for (const pid of scannable) {
      const st = cat.providers[pid];
      const lastScanAt = st?.lastScanAt ? Date.parse(st.lastScanAt) : undefined;
      const nextScanAt = st?.nextScanAt ? Date.parse(st.nextScanAt) : undefined;

      const isDue = (lastScanAt === undefined || now - lastScanAt >= intervalMs) && (nextScanAt === undefined || nextScanAt <= now);
      if (isDue) {
        const u = o.rng();
        const rawDelay = Math.round(u * 60_000);
        due.push({ provider: pid, rawDelay });
      } else {
        const maxAllowed = now + Math.round(1.1 * intervalMs);
        let targetAt = nextScanAt ?? (now + intervalMs);
        if (targetAt > maxAllowed) targetAt = maxAllowed;
        notDue.push({ provider: pid, at: targetAt });
      }
    }

    due.sort((a, b) => a.rawDelay - b.rawDelay);
    let lastDueAt = -Infinity;
    for (const item of due) {
      let at = now + item.rawDelay;
      if (at < lastDueAt + 2000) {
        at = lastDueAt + 2000;
      }
      lastDueAt = at;
      arm(item.provider, at, "harness");
    }

    for (const item of notDue) {
      arm(item.provider, item.at, "cron");
    }
  }

  function start() {
    if (started || stopped) return;
    started = true;
    scheduleAll();
  }

  function replan() {
    if (!started || stopped) return;

    for (const [_, t] of armedTimers) {
      t.handle.cancel();
    }
    armedTimers.clear();

    const s = o.settings();
    if (!s.enabled) return;

    const now = o.clock.now();
    const scannable = o.service.scannable().map((x) => x.id);
    const cat = o.store.read();

    const overdue: { provider: string; rawDelay: number }[] = [];
    const future: { provider: string; at: number }[] = [];
    const updates: Record<string, string> = {};

    for (const pid of scannable) {
      const st = cat.providers[pid];
      const lastScanAt = st?.lastScanAt ? Date.parse(st.lastScanAt) : undefined;
      if (lastScanAt !== undefined) {
        const newNextAt = nextRegularAt(lastScanAt, s.intervalHours, o.rng);
        updates[pid] = new Date(newNextAt).toISOString();
        if (newNextAt <= now) {
          const u = o.rng();
          const rawDelay = Math.max(1, Math.round(u * 60_000));
          overdue.push({ provider: pid, rawDelay });
        } else {
          future.push({ provider: pid, at: newNextAt });
        }
      } else {
        const u = o.rng();
        const rawDelay = Math.max(1, Math.round(u * 60_000));
        overdue.push({ provider: pid, rawDelay });
      }
    }

    if (Object.keys(updates).length > 0) {
      void o.store.mutate((c) => {
        const nextProviders = { ...c.providers };
        for (const [pid, nextIso] of Object.entries(updates)) {
          if (nextProviders[pid]) {
            nextProviders[pid] = { ...nextProviders[pid], nextScanAt: nextIso };
          }
        }
        return { next: { ...c, providers: nextProviders }, result: null };
      });
    }

    overdue.sort((a, b) => a.rawDelay - b.rawDelay);
    let lastDueAt = -Infinity;
    for (const item of overdue) {
      let at = now + item.rawDelay;
      if (at < lastDueAt + 2000) {
        at = lastDueAt + 2000;
      }
      lastDueAt = at;
      arm(item.provider, at, "harness");
    }

    for (const item of future) {
      arm(item.provider, item.at, "cron");
    }
  }

  function stop() {
    stopped = true;
    abortController.abort();
    for (const [_, t] of armedTimers) {
      t.handle.cancel();
    }
    armedTimers.clear();
    queue.length = 0;
  }

  function armed() {
    return Array.from(armedTimers.entries())
      .map(([provider, { at }]) => ({ provider, at }))
      .sort((a, b) => a.at - b.at);
  }

  return {
    start,
    replan,
    stop,
    armed,
  };
}

import { availabilityOf } from "./availability.ts";
import type { ProviderAvailability } from "./availability.ts";
import { DEFAULT_CANDIDATES, discoverLocalEndpoints } from "./discover.ts";
import type { DiscoverOptions } from "./discover.ts";

export const DEFAULT_STATUS_TTL_MS = 15_000;

export interface LocalEndpointStatus {
  label: string;
  origin: string;
  status: "unknown" | "available" | "unavailable";
  availability?: ProviderAvailability;
  /** `now()` at the check that produced this status. */
  checkedAt?: number;
  baseUrl?: string;
}

export interface LocalEndpointMonitorOptions extends DiscoverOptions {
  /** How long a status counts as fresh (default 15000 ms). */
  ttlMs?: number;
  /** Test seam (default `Date.now`). */
  now?: () => number;
}

/**
 * A nonblocking cache of local endpoint health. `snapshot()` and `status()` never touch the network; only
 * `refresh()` / `refreshInBackground()` do, and they turn every service problem into a status.
 */
export class LocalEndpointMonitor {
  readonly #opts: DiscoverOptions;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #map = new Map<string, LocalEndpointStatus>();
  #inflight: Promise<readonly LocalEndpointStatus[]> | undefined;

  constructor(o: LocalEndpointMonitorOptions = {}) {
    const { ttlMs, now, ...discover } = o;
    this.#opts = discover;
    this.#ttl = ttlMs ?? DEFAULT_STATUS_TTL_MS;
    this.#now = now ?? Date.now;
    for (const c of discover.candidates ?? DEFAULT_CANDIDATES) {
      const label = c.label ?? c.origin;
      this.#map.set(label, { label, origin: c.origin, status: "unknown" });
    }
  }

  snapshot(): readonly LocalEndpointStatus[] { return [...this.#map.values()]; }

  status(label: string): LocalEndpointStatus | undefined { return this.#map.get(label); }

  /** True when the status was checked less than `ttlMs` ago. An unknown status is never fresh. */
  isFresh(label: string): boolean {
    const at = this.#map.get(label)?.checkedAt;
    return at !== undefined && this.#now() - at < this.#ttl;
  }

  /**
   * Re-probes all candidates. Concurrent calls share one discovery. RULING: a caller abort rejects only that caller
   * (with the signal's reason); the shared discovery runs on, so one impatient caller cannot starve the others.
   */
  refresh(opts: { signal?: AbortSignal } = {}): Promise<readonly LocalEndpointStatus[]> {
    const signal = opts.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.#inflight ??= this.#discover().finally(() => { this.#inflight = undefined; });
    const shared = this.#inflight;
    if (!signal) return shared;
    return new Promise((ok, fail) => {
      const onAbort = () => fail(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      shared.then(ok, fail).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** Fire and forget: errors are swallowed. */
  refreshInBackground(): void {
    // Without a signal `refresh()` never rejects (service problems become statuses), so there is nothing to swallow.
    void this.refresh();
  }

  /** A connection error during a chat: the endpoint is unavailable right now, without waiting for a probe. */
  reportFailure(label: string): void {
    const cur = this.#map.get(label);
    if (!cur) return;
    this.#map.set(label, {
      ...cur, status: "unavailable", checkedAt: this.#now(),
      availability: { status: "unavailable", reason: "unreachable", detail: "connection failed during a chat", models: [] },
    });
  }

  async #discover(): Promise<readonly LocalEndpointStatus[]> {
    try {
      const found = await discoverLocalEndpoints(this.#opts);
      const at = this.#now();
      for (const f of found) {
        const availability = availabilityOf(f);
        this.#map.set(f.label, { label: f.label, origin: f.origin, status: availability.status, availability, checkedAt: at, baseUrl: f.baseUrl });
      }
    } catch { /* RULING: even a rejected discovery (e.g. an aborted monitor-level signal) is not a service status; keep the old one */ }
    return this.snapshot();
  }
}

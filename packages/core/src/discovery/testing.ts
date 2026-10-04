// In-memory adapters for the discovery ports (plan Task 1). Used by tests and by CoreOptions.discovery.
import { CredentialUnavailableError } from "./ports.ts";
import type { Clock, CredentialLease, CredentialResolver, DiscoveryEvents, ProfileInfo, ProfileSource, Rng, TimerHandle } from "./ports.ts";

export class InMemoryProfileSource implements ProfileSource {
  #profiles: ProfileInfo[];
  constructor(profiles: ProfileInfo[]) { this.#profiles = [...profiles]; }
  set(profiles: ProfileInfo[]): void { this.#profiles = [...profiles]; }
  list(): readonly ProfileInfo[] { return this.#profiles; }
}

type Registered = { origin: string; headerName: string; headerValue: string } | "renew_sign_in" | null;
export class StaticCredentialResolver implements CredentialResolver {
  #byProfile: Record<string, Registered>;
  constructor(byProfile: Record<string, Registered>) { this.#byProfile = byProfile; }
  async resolve(profileId: string, origin: string): Promise<CredentialLease | null> {
    const r = this.#byProfile[profileId];
    if (r === undefined || r === null) return null;
    if (r === "renew_sign_in") throw new CredentialUnavailableError("renew_sign_in");
    if (r.origin !== origin) throw new Error("credential refused: origin is not the profile's own");
    return { origin: r.origin, headerName: r.headerName, headerValue: r.headerValue };
  }
}

export class RecordingEvents implements DiscoveryEvents {
  readonly log: { name: string; e: unknown }[] = [];
  discovered(e: Parameters<DiscoveryEvents["discovered"]>[0]): void { this.log.push({ name: "discovered", e }); }
  unavailable(e: Parameters<DiscoveryEvents["unavailable"]>[0]): void { this.log.push({ name: "unavailable", e }); }
  scanFailed(e: Parameters<DiscoveryEvents["scanFailed"]>[0]): void { this.log.push({ name: "failed", e }); }
  scanCompleted(e: Parameters<DiscoveryEvents["scanCompleted"]>[0]): void { this.log.push({ name: "completed", e }); }
}

interface Timer { at: number; seq: number; fn: () => void | Promise<void>; live: boolean }
export class FakeClock implements Clock {
  #now: number; #seq = 0; #timers: Timer[] = [];
  constructor(start: number) { this.#now = start; }
  now(): number { return this.#now; }
  setTimer(fn: () => void | Promise<void>, ms: number): TimerHandle {
    const t: Timer = { at: this.#now + ms, seq: this.#seq++, fn, live: true };
    this.#timers.push(t);
    return { cancel: () => { t.live = false; this.#timers = this.#timers.filter((x) => x !== t); } };
  }
  pending(): number { return this.#timers.length; }
  /** Moves time forward, firing every timer that falls due, in order, awaiting each. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      const due = this.#timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.#timers = this.#timers.filter((t) => t !== due);
      this.#now = Math.max(this.#now, due.at);
      if (due.live) await due.fn();
    }
    this.#now = target;
  }
  /** Moves time (a sleep, a stepped clock) and fires each overdue timer exactly once, in order. */
  async jump(ms: number): Promise<void> {
    this.#now += ms;
    const due = this.#timers.filter((t) => t.at <= this.#now).sort((a, b) => a.at - b.at || a.seq - b.seq);
    this.#timers = this.#timers.filter((t) => !due.includes(t));
    for (const t of due) if (t.live) await t.fn();
  }
}

/** A deterministic Rng that cycles through the given values. */
export function sequenceRng(values: number[]): Rng {
  let i = 0;
  return () => { const v = values[i % values.length]!; i += 1; return v; };
}

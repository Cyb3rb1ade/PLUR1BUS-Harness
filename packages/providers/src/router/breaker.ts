import type { BreakerPolicy, BreakerState, Clock } from "./types.ts";

/** Circuit breaker for one provider+model. Time comes from the injected clock; no timers. */
export class CircuitBreaker {
  #state: BreakerState = "closed";
  #failures = 0;
  #openedAt = 0;
  #probing = false;
  readonly #policy: BreakerPolicy;
  readonly #clock: Clock;
  readonly #onChange: (from: BreakerState, to: BreakerState) => void;

  constructor(policy: BreakerPolicy, clock: Clock, onChange: (from: BreakerState, to: BreakerState) => void = () => {}) {
    this.#policy = policy;
    this.#clock = clock;
    this.#onChange = onChange;
  }

  get state(): BreakerState {
    this.#tick();
    return this.#state;
  }

  /**
   * Asks to send a request. `allowed` false with `reason`: open, or half-open with a probe already in flight.
   * An allowed half-open admission is THE probe and must be reported with `success()` or `failure()`.
   */
  admit(): { allowed: true } | { allowed: false; reason: "breaker_open" | "half_open_busy" } {
    this.#tick();
    if (this.#state === "closed") return { allowed: true };
    if (this.#state === "open") return { allowed: false, reason: "breaker_open" };
    if (this.#probing) return { allowed: false, reason: "half_open_busy" };
    this.#probing = true;
    return { allowed: true };
  }

  success(): void {
    this.#failures = 0;
    this.#probing = false;
    this.#to("closed");
  }

  failure(): void {
    this.#probing = false;
    if (this.#state === "half_open") { this.#open(); return; }
    this.#failures += 1;
    if (this.#state === "closed" && this.#failures >= this.#policy.failureThreshold) this.#open();
  }

  /** A probe ended without telling anything about provider health (caller abort, non-breaker error). */
  release(): void {
    this.#probing = false;
  }

  #tick(): void {
    if (this.#state === "open" && this.#clock.now() - this.#openedAt >= this.#policy.openMs) this.#to("half_open");
  }

  #open(): void {
    this.#openedAt = this.#clock.now();
    this.#to("open");
  }

  #to(next: BreakerState): void {
    if (next === this.#state) return;
    const from = this.#state;
    this.#state = next;
    this.#onChange(from, next);
  }
}

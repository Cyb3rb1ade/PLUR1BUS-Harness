import { protocolError, ProviderError } from "../errors.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Usage } from "../types.ts";
import { CircuitBreaker } from "./breaker.ts";
import { classifyFailure } from "./classify.ts";
import { systemClock } from "./clock.ts";
import { DEFAULT_BREAKER, DEFAULT_RETRY } from "./types.ts";
import type {
  BreakerPolicy, BreakerState, BudgetDecision, BudgetTicket, Candidate, Clock, RetryPolicy, RouterConfig, RouterEvent, Served,
} from "./types.ts";

export type RouterErrorCode = "unknown_profile" | "unsupported_strategy" | "no_candidate_available" | "budget_denied" | "attempts_exhausted";

/** The router itself could not place a request (as opposed to a provider failing it: that is a `ProviderError`). */
export class RouterError extends Error {
  readonly code: RouterErrorCode;
  constructor(code: RouterErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RouterError";
    this.code = code;
  }
}

/** Yielded once, immediately before the first adapter event: who is answering. */
export type RoutedEvent = ChatStreamEvent | ({ type: "served" } & Served);

const DEFAULT_MAX_ATTEMPTS = 6;

function abortError(signal: AbortSignal): ProviderError {
  return new ProviderError("aborted", "call aborted by the caller", { cause: signal.reason });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

export class ProviderRouter {
  readonly #cfg: RouterConfig;
  readonly #clock: Clock;
  readonly #breakers = new Map<string, CircuitBreaker>();
  readonly #breakerPolicy: BreakerPolicy;
  readonly #retry: RetryPolicy;
  readonly #random: () => number;

  constructor(cfg: RouterConfig) {
    this.#cfg = cfg;
    this.#clock = cfg.clock ?? systemClock;
    this.#breakerPolicy = { ...DEFAULT_BREAKER, ...cfg.breaker };
    this.#retry = { ...DEFAULT_RETRY, ...cfg.retry };
    this.#random = cfg.random ?? Math.random;
  }

  /** Whether a profile name is known to this router (executable or not). */
  hasProfile(profile: string): boolean {
    return this.#cfg.profiles[profile] !== undefined;
  }

  breakerState(provider: string, model: string): BreakerState {
    return this.#breakers.get(key(provider, model))?.state ?? "closed";
  }

  async complete(profile: string, request: ChatRequest, options?: CallOptions): Promise<{ result: ChatResult; served: Served }> {
    let served: Served | undefined;
    for await (const ev of this.stream(profile, request, options)) {
      if (ev.type === "served") served = { provider: ev.provider, model: ev.model };
      else if (ev.type === "done" && served !== undefined) return { result: ev.result, served };
    }
    throw protocolError("stream ended without a result");
  }

  /**
   * Streams from the first usable candidate. Retry and fallback happen only while nothing has been yielded to the
   * caller; once the first adapter event is out, any failure is rethrown as is. Every error that leaves this method is
   * a `ProviderError` or a `RouterError`: a foreign exception from an adapter is wrapped (its `cause` kept), and a
   * caller abort at any point (before an attempt, while waiting to retry, mid-stream) is a `ProviderError` of kind `aborted`.
   */
  async *stream(profile: string, request: ChatRequest, options: CallOptions = {}): AsyncGenerator<RoutedEvent, void, void> {
    const unsupported = this.#cfg.unsupportedProfiles?.[profile];
    if (unsupported !== undefined) throw new RouterError("unsupported_strategy", `profile "${profile}" cannot be executed: ${unsupported}`);
    const candidates = this.#cfg.profiles[profile];
    if (candidates === undefined || candidates.length === 0) throw new RouterError("unknown_profile", `no candidates for profile "${profile}"`);
    const effective = this.#withDefaults(profile, request);
    const maxAttempts = this.#cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const signal = options.signal;
    let attempts = 0;
    let lastError: unknown;
    let budgetDenied: string | undefined;
    let left: { served: Served; reason: Extract<RouterEvent, { type: "provider.fallback" }>["reason"] } | undefined;

    for (const cand of candidates) {
      const target: Served = { provider: cand.provider, model: cand.model };
      const breaker = this.#breaker(cand);
      let retries = 0;
      for (;;) {
        throwIfAborted(signal);
        const adm = breaker.admit();
        if (!adm.allowed) {
          this.#emit({ type: "provider.skipped", profile, target, reason: adm.reason });
          left = { served: target, reason: adm.reason };
          break;
        }
        if (attempts >= maxAttempts) {
          breaker.release();
          throw new RouterError("attempts_exhausted", `gave up after ${attempts} attempts`, lastError);
        }
        const info = { ...target, profile, attempt: attempts + 1 };
        let decision: BudgetDecision;
        try {
          decision = this.#cfg.budget === undefined ? { ok: true, ticket: NO_TICKET } : await this.#cfg.budget.authorize(info, effective, signal === undefined ? {} : { signal });
        } catch {
          // Fail closed: a guard that throws denies the attempt, and the half-open probe it was admitted as is given back.
          breaker.release();
          throwIfAborted(signal);
          decision = { ok: false, reason: "the budget guard failed" };
        }
        if (!decision.ok) {
          breaker.release();
          budgetDenied = decision.reason;
          this.#emit({ type: "provider.skipped", profile, target, reason: "budget_denied", detail: decision.reason });
          left = { served: target, reason: "budget_denied" };
          break;
        }
        attempts += 1;
        if (left !== undefined) {
          this.#emit({ type: "provider.fallback", profile, from: left.served, to: target, reason: left.reason });
          left = undefined;
        }

        let committed = false;
        let usage: Usage | undefined;
        let ended = false;
        try {
          for await (const ev of cand.adapter.stream({ ...effective, model: cand.model }, options)) {
            if (!committed) { committed = true; yield { type: "served", ...target }; }
            if (ev.type === "usage") usage = ev.usage;
            if (ev.type === "done" && ev.result.usage !== undefined) usage = ev.result.usage;
            if (ev.type === "done") {
              // Settle before handing `done` over: a consumer may stop right after it without exhausting us.
              ended = true;
              breaker.success();
              await settle(decision.ticket, usage);
              yield ev;
              return;
            }
            yield ev;
          }
          ended = true;
          breaker.success();
          await settle(decision.ticket, usage);
          return;
        } catch (thrown) {
          ended = true;
          const err = toProviderError(thrown, signal);
          const c = classifyFailure(err);
          if (c.breaker && !signal?.aborted) breaker.failure(); else breaker.release();
          await settle(decision.ticket, err.partial?.usage ?? usage);
          if (committed || signal?.aborted) throw err;
          lastError = err;
          if (c.retryable && retries < this.#retry.maxRetries) {
            const retryAfter = err.retryAfterMs;
            if (retryAfter === undefined || retryAfter <= this.#retry.maxRetryAfterMs) {
              const delayMs = this.#delay(retries, retryAfter);
              retries += 1;
              this.#emit({ type: "provider.retry", profile, target, attempt: retries, delayMs, reason: c.kind });
              try { await this.#clock.sleep(delayMs, signal); }
              catch (e) { if (signal?.aborted) throw abortError(signal); throw e; }
              continue;
            }
          }
          if (!c.fallback) throw err;
          left = { served: target, reason: c.kind };
          break;
        } finally {
          if (!ended) {
            // The consumer stopped iterating (or the generator was closed) mid-stream: not a health signal.
            breaker.release();
            await settle(decision.ticket, usage);
          }
        }
      }
    }

    if (budgetDenied !== undefined) throw new RouterError("budget_denied", `budget guard denied the call: ${budgetDenied}`, lastError);
    if (lastError !== undefined) throw lastError;
    throw new RouterError("no_candidate_available", `every candidate of "${profile}" is unavailable`);
  }

  #withDefaults(profile: string, request: ChatRequest): ChatRequest {
    const d = this.#cfg.profileDefaults?.[profile];
    if (d === undefined) return request;
    const out: ChatRequest = { ...request };
    if (out.temperature === undefined && d.temperature !== undefined) out.temperature = d.temperature;
    if (out.topP === undefined && d.topP !== undefined) out.topP = d.topP;
    if (out.maxTokens === undefined && d.maxTokens !== undefined) out.maxTokens = d.maxTokens;
    return out;
  }

  #breaker(c: Candidate): CircuitBreaker {
    const k = key(c.provider, c.model);
    let b = this.#breakers.get(k);
    if (b === undefined) {
      const target: Served = { provider: c.provider, model: c.model };
      b = new CircuitBreaker(this.#breakerPolicy, this.#clock, (from, to) => this.#emit({ type: "provider.breaker", target, from, to }));
      this.#breakers.set(k, b);
    }
    return b;
  }

  /** Full jitter over an exponential ceiling; a provider's Retry-After is a floor. */
  #delay(retry: number, retryAfterMs: number | undefined): number {
    const ceiling = Math.min(this.#retry.maxMs, this.#retry.baseMs * 2 ** retry);
    const jittered = Math.floor(this.#random() * ceiling);
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  #emit(ev: RouterEvent): void {
    try { this.#cfg.onEvent?.(ev); } catch { /* a faulty sink never changes routing */ }
  }
}

const NO_TICKET: BudgetTicket = { settle() {} };

/** Whatever an adapter threw, as a `ProviderError`: a caller abort wins, a foreign exception is wrapped with its cause kept. */
function toProviderError(thrown: unknown, signal: AbortSignal | undefined): ProviderError {
  if (signal?.aborted && !(thrown instanceof ProviderError && thrown.kind === "aborted")) return abortError(signal);
  if (thrown instanceof ProviderError) return thrown;
  return new ProviderError("unknown", "the provider adapter failed unexpectedly", { cause: thrown });
}

async function settle(t: BudgetTicket, usage: Usage | undefined): Promise<void> {
  try { await t.settle(usage); } catch { /* accounting failure must not mask the provider outcome */ }
}

function key(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

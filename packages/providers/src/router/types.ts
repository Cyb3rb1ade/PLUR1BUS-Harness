import type { CallOptions, ChatRequest, ChatStreamEvent, Usage } from "../types.ts";
import type { ProviderErrorKind } from "../errors.ts";

/** The slice of a chat adapter the router needs. */
export interface StreamingAdapter {
  stream(request: ChatRequest, options?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void>;
}

export interface Candidate {
  /** Provider id as the operator named it (e.g. "openai", "openrouter"); part of the breaker key. */
  provider: string;
  /** Model id sent to this provider; replaces `request.model`. */
  model: string;
  adapter: StreamingAdapter;
}

/** Profile name (e.g. "default", "cheap") -> candidates in order of preference. */
export type ProfileTable = Readonly<Record<string, readonly Candidate[]>>;

export interface Clock {
  now(): number;
  /** Resolves after `ms`; rejects with the signal's reason when aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface BreakerPolicy {
  /** Consecutive breaker-relevant failures that open the circuit. */
  failureThreshold: number;
  /** How long it stays open before one probe is allowed. */
  openMs: number;
}

export interface RetryPolicy {
  /** Retries on the same candidate after the first attempt. */
  maxRetries: number;
  baseMs: number;
  maxMs: number;
  /** A provider Retry-After above this skips the wait and falls back instead. */
  maxRetryAfterMs: number;
}

export type BreakerState = "closed" | "open" | "half_open";

export interface Served { provider: string; model: string }

export interface AttemptInfo extends Served {
  profile: string;
  /** 1-based over the whole call (retries and fallbacks both count). */
  attempt: number;
}

export interface BudgetTicket {
  /** Called once with whatever usage is known (success, or a failed attempt that still produced usage). */
  settle(usage?: Usage): void | Promise<void>;
}

export type BudgetDecision = { ok: true; ticket: BudgetTicket } | { ok: false; reason: string };

/**
 * Port to the cost limiter. Asked before EVERY attempt, including retries and fallbacks, so a fallback can never
 * route around a soft/hard limit. An implementation prices the attempt from `request`, provider and model.
 */
export interface BudgetGuard {
  authorize(info: AttemptInfo, request: ChatRequest): BudgetDecision | Promise<BudgetDecision>;
}

export type RouterEvent =
  | { type: "provider.fallback"; profile: string; from: Served; to: Served; reason: ProviderErrorKind | "breaker_open" | "budget_denied" | "half_open_busy" }
  | { type: "provider.retry"; profile: string; target: Served; attempt: number; delayMs: number; reason: ProviderErrorKind }
  | { type: "provider.breaker"; target: Served; from: BreakerState; to: BreakerState }
  | { type: "provider.skipped"; profile: string; target: Served; reason: "breaker_open" | "half_open_busy" | "budget_denied"; detail?: string };

export interface RouterConfig {
  profiles: ProfileTable;
  clock: Clock;
  /** In [0,1); injected so tests are deterministic. */
  random?: () => number;
  breaker?: Partial<BreakerPolicy>;
  retry?: Partial<RetryPolicy>;
  budget?: BudgetGuard;
  /** Hard cap on attempts per call (retries + fallbacks). Default 6. */
  maxAttempts?: number;
  /** Sink for router events; it must not throw (a throw is swallowed). */
  onEvent?: (event: RouterEvent) => void;
}

export const DEFAULT_BREAKER: BreakerPolicy = { failureThreshold: 3, openMs: 30_000 };
export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseMs: 250, maxMs: 8_000, maxRetryAfterMs: 15_000 };

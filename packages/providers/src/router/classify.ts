import { ProviderError } from "../errors.ts";
import type { ProviderErrorKind } from "../errors.ts";

export interface Classification {
  kind: ProviderErrorKind;
  /** The same candidate may be asked again. */
  retryable: boolean;
  /** The next candidate may be tried (only before the first streamed event). */
  fallback: boolean;
  /** The failure counts against the candidate's circuit breaker. */
  breaker: boolean;
}

/** The classes that say something about the provider's capacity or the path to it, and nothing about the request. */
const TRANSIENT: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "overloaded", "timeout", "network"]);

/**
 * RULING: fail closed. Only the transient classes (`rate_limit`, `overloaded`, `timeout`, `network`) may fall back to
 * the next candidate, and only those count against a circuit breaker. `auth` is NOT one of them: a credential problem
 * is the operator's to fix, and silently answering from another vendor would hide it (and spend that vendor's quota
 * on a profile the operator believes is served by the first). `invalid_request` (which includes content-filter
 * refusals), `context_length`, `unknown` and `aborted` go back to the caller as they are: another vendor would repeat
 * the refusal or dodge a policy decision, and a caller abort is never a provider failure.
 * Whether the SAME candidate is asked again is the error's own `retryable` hint (a quota-exhausted 429 or an
 * unavailable local endpoint say no) and applies to transient classes only.
 */
export function classifyFailure(err: unknown): Classification {
  if (!(err instanceof ProviderError)) return { kind: "unknown", retryable: false, fallback: false, breaker: false };
  if (err.code === 'subscription_sharing_usage_limit_exceeded') return { kind: err.kind, retryable: false, fallback: false, breaker: false };
  if (TRANSIENT.has(err.kind)) return { kind: err.kind, retryable: err.retryable, fallback: true, breaker: true };
  return { kind: err.kind, retryable: false, fallback: false, breaker: false };
}

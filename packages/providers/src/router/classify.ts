import { ProviderError } from "../errors.ts";
import type { ProviderErrorKind } from "../errors.ts";

export interface Classification {
  kind: ProviderErrorKind | "unknown";
  /** The same candidate may be asked again. */
  retryable: boolean;
  /** The next candidate may be tried (only before the first streamed event). */
  fallback: boolean;
  /** The failure counts against the candidate's circuit breaker. */
  breaker: boolean;
}

/**
 * RULING: fail closed. Only transport/capacity failures (429 non-quota, 5xx, timeout, network) are retried, and
 * `auth` (a credential problem of THIS provider) may fall back. A content-filter, context-length, bad-request,
 * protocol or unknown error is returned to the caller: another vendor would either repeat it or dodge a policy
 * decision. A caller abort is never a provider failure.
 */
export function classifyFailure(err: unknown): Classification {
  if (!(err instanceof ProviderError)) return { kind: "unknown", retryable: false, fallback: false, breaker: false };
  switch (err.kind) {
    case "rate_limit":
    case "server":
    case "timeout":
    case "network":
      // A quota-exhausted 429 is marked non-retryable by the adapter: the same key will keep failing, another may not.
      return { kind: err.kind, retryable: err.retryable, fallback: true, breaker: true };
    case "auth":
      return { kind: "auth", retryable: false, fallback: true, breaker: true };
    case "aborted":
      return { kind: "aborted", retryable: false, fallback: false, breaker: false };
    default:
      return { kind: err.kind, retryable: false, fallback: false, breaker: false };
  }
}

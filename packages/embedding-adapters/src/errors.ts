// The one error taxonomy every adapter speaks (G1). Callers branch on `kind`, never on provider-specific text.
import { redactSecrets } from "./redact.ts";

export const ADAPTER_ERROR_KINDS = [
  "auth", // 401/403, or the injected secret is missing: retrying cannot help
  "rate_limit", // 429; carries retryAfterMs when the server said how long
  "overloaded", // 5xx / 529: the provider is struggling, transient
  "invalid_request", // 4xx the caller caused (bad model, bad parameter)
  "too_large", // 413, or an input/batch over the provider's limit: split or shorten, do not retry as is
  "network", // the request never produced a response
  "timeout", // the per-attempt deadline expired
  "aborted", // the caller's AbortSignal fired
  "bad_response", // a response we refuse to interpret: wrong shape/dimension/count, NaN/Inf, redirect, oversized
] as const;
export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

/** Retrying the identical request can succeed for these and only these. */
export const RETRYABLE_KINDS: ReadonlySet<AdapterErrorKind> = new Set<AdapterErrorKind>(["rate_limit", "overloaded", "network", "timeout"]);

export interface AdapterErrorInit {
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  /** Secret values to scrub from the message. Never stored on the error. */
  secrets?: readonly string[];
  /** Accepted for call-site symmetry and deliberately dropped: a raw cause can carry credentials. */
  cause?: unknown;
}

const MAX_MESSAGE = 500;

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  readonly kind: AdapterErrorKind;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: AdapterErrorKind, message: string, init: AdapterErrorInit = {}) {
    // Redact before super(): the stack string is built from the message at construction time.
    const clean = redactSecrets(message, init.secrets);
    super(clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE)}…` : clean);
    this.kind = kind;
    this.provider = init.provider;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, kind: this.kind, message: this.message, provider: this.provider, status: this.status, retryAfterMs: this.retryAfterMs };
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}

const MAX_SUMMARY = 200;

/** `Name: message` for any thrown value, bounded and scrubbed. Raw non-error values are never echoed. */
export function errorSummary(e: unknown, secrets: readonly string[] = []): string {
  let text: string;
  if (e instanceof Error) text = `${e.name}: ${e.message}`;
  else if (typeof e === "string") text = e;
  else return "non-error value thrown";
  return redactSecrets(text.length > MAX_SUMMARY ? text.slice(0, MAX_SUMMARY) : text, secrets);
}

// One error taxonomy for every voice provider (cloud and local). Callers branch on `code`, never on vendor text.
// Messages are scrubbed of every secret handed to the constructor before `super()` so stacks stay clean too.

export const VOICE_ERROR_CODES = [
  "auth", // 401/403, or the secret reference resolves to nothing: retrying cannot help
  "rate_limited", // 429; carries retryAfterMs when the server said how long
  "overloaded", // 5xx / 529: transient
  "invalid_request", // 4xx the caller caused (bad voice, bad model, bad format)
  "unsupported", // the provider does not offer this capability or option
  "network", // no response at all
  "timeout", // a deadline expired
  "aborted", // the caller's AbortSignal fired
  "bad_response", // a response we refuse to interpret
  "upstream_protocol", // a socket frame or close code that violates the protocol or the vendor's own schema; the session is closed
  "closed", // the session is already closed
  "unavailable", // local engine or platform cannot run (capability "unavailable")
  "licence_required", // a non-commercial or unconfirmed licence needs explicit confirmation first
  "download_failed", // model download failed (network, short read)
  "checksum_mismatch", // downloaded bytes do not match the catalog sha256
  "catalog", // catalog entry missing or malformed
  "config", // provider configuration is invalid
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

export const RETRYABLE_CODES: ReadonlySet<VoiceErrorCode> = new Set<VoiceErrorCode>(["rate_limited", "overloaded", "network", "timeout"]);

export interface VoiceErrorInit {
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  /** Secret values to scrub from the message. Never stored on the error. */
  secrets?: readonly string[];
  /** Accepted and dropped: a raw cause can carry credentials. */
  cause?: unknown;
}

const MAX_MESSAGE = 500;

export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  // Query-string credentials, bearer tokens and header-style keys that slip into vendor error text.
  out = out.replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&\s"']+/gi, "$1[redacted]");
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[redacted]");
  out = out.replace(/((?:xi-api-key|x-goog-api-key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]");
  return out;
}

export class VoiceProviderError extends Error {
  override readonly name = "VoiceProviderError";
  readonly code: VoiceErrorCode;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(code: VoiceErrorCode, message: string, init: VoiceErrorInit = {}) {
    const clean = redact(message, init.secrets);
    super(clean.length > MAX_MESSAGE ? `${clean.slice(0, MAX_MESSAGE)}...` : clean);
    this.code = code;
    this.provider = init.provider;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, provider: this.provider, status: this.status, retryAfterMs: this.retryAfterMs };
  }
}

export function isVoiceProviderError(e: unknown): e is VoiceProviderError {
  return e instanceof VoiceProviderError;
}

/** Map an HTTP status (and optional Retry-After header value) to the unified error. */
export function errorFromStatus(status: number, provider: string, detail: string, retryAfter: string | null | undefined, secrets: readonly string[] = [], now: () => number = Date.now): VoiceProviderError {
  const init: VoiceErrorInit = { provider, status, secrets };
  const retryAfterMs = parseRetryAfter(retryAfter, now);
  if (status === 401 || status === 403) return new VoiceProviderError("auth", `${provider}: authentication failed (${status})`, init);
  if (status === 429) return new VoiceProviderError("rate_limited", `${provider}: rate limited${detail ? `: ${detail}` : ""}`, retryAfterMs === undefined ? init : { ...init, retryAfterMs });
  if (status === 408 || status === 504) return new VoiceProviderError("timeout", `${provider}: upstream timeout (${status})`, init);
  if (status >= 500) return new VoiceProviderError("overloaded", `${provider}: upstream error (${status})`, retryAfterMs === undefined ? init : { ...init, retryAfterMs });
  if (status === 404 || status === 400 || status === 422 || status === 413) return new VoiceProviderError("invalid_request", `${provider}: request refused (${status})${detail ? `: ${detail}` : ""}`, init);
  return new VoiceProviderError("bad_response", `${provider}: unexpected status ${status}`, init);
}

/** Retry-After: delta-seconds or an HTTP date. Returns milliseconds, clamped to one hour; undefined when absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: () => number = Date.now): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(Math.round(Number(v) * 1000), 3_600_000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now(), 0), 3_600_000);
}

export function abortedError(provider: string): VoiceProviderError {
  return new VoiceProviderError("aborted", `${provider}: aborted`, { provider });
}

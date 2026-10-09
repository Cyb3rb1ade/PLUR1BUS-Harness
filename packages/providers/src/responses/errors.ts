import { classifyHttpError, classifyStreamError, errorFromValue, isRecord, ProviderError } from "../errors.ts";
import type { ProviderErrorInit } from "../errors.ts";

const MAX_MESSAGE_CHARS = 500;
const MAX_CODE_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY_RE = /usage policy|content policy|flagged|violat/i;
const DURATION_RE = /^(?:\d+(?:\.\d+)?(?:ms|h|m|s))+$/;

/**
 * A Go-style duration as OpenAI sends it in `x-ratelimit-reset-*` ("1s", "20ms", "6m0s", "1h2m3.5s") in milliseconds, capped at
 * 24 h; anything else is `undefined`, never guessed at.
 */
export function parseRateLimitReset(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !DURATION_RE.test(value)) return undefined;
  let ms = 0;
  for (const [, n, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) ms += Number(n) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
  return Math.min(Math.round(ms), DAY_MS);
}

/**
 * RULING: with no `retry-after`, a 429 waits for the limit that is exhausted: the requests reset when no requests remain,
 * the tokens reset when no tokens remain; when neither header says so, the sooner of the two resets (the call that
 * failed hit one of them). Only a 429 reads these headers.
 */
function limitHeaderReset(h: Headers): number | undefined {
  const requests = parseRateLimitReset(h.get("x-ratelimit-reset-requests")), tokens = parseRateLimitReset(h.get("x-ratelimit-reset-tokens"));
  if (h.get("x-ratelimit-remaining-requests")?.trim() === "0" && requests !== undefined) return requests;
  if (h.get("x-ratelimit-remaining-tokens")?.trim() === "0" && tokens !== undefined) return tokens;
  const known = [requests, tokens].filter((x): x is number => x !== undefined);
  return known.length === 0 ? undefined : Math.min(...known);
}

/** The ChatGPT-plan backend reports when a plan's usage limit resets in the error body (`resets_in_seconds`). */
function bodyResetMs(bodyText: string): number | undefined {
  let v: unknown;
  try { v = JSON.parse(bodyText); } catch { return undefined; }
  const e = isRecord(v) && isRecord(v["error"]) ? v["error"] : v;
  const s = isRecord(e) ? e["resets_in_seconds"] : undefined;
  return typeof s === "number" && Number.isFinite(s) && s >= 0 ? Math.min(Math.round(s * 1000), DAY_MS) : undefined;
}

function patch(base: ProviderError, p: { retryAfterMs?: number; retryable?: boolean; contentFiltered?: boolean }): ProviderError {
  const init: ProviderErrorInit = { retryable: p.retryable ?? base.retryable, contentFiltered: p.contentFiltered ?? base.contentFiltered };
  if (base.status !== undefined) init.status = base.status;
  if (base.code !== undefined) init.code = base.code;
  if (base.providerType !== undefined) init.providerType = base.providerType;
  if (base.providerMessage !== undefined) init.providerMessage = base.providerMessage;
  if (base.timeoutPhase !== undefined) init.timeoutPhase = base.timeoutPhase;
  const retryAfterMs = p.retryAfterMs ?? base.retryAfterMs;
  if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs;
  return new ProviderError(base.kind, base.message, init);
}

/**
 * An HTTP error response of the Responses API (`{"error":{"message","type","param","code"}}`, or the ChatGPT backend's
 * `{"detail"}`) → the taxonomy. The shared classifier does the statuses, `context_length_exceeded`, `insufficient_quota`
 * (not retryable) and Retry-After; this adds the rate-limit reset headers, the plan usage limit (a rate limit that
 * retrying will not fix, with the reset the body reports) and the usage-policy refusal (`invalid_prompt`).
 */
export function classifyResponsesHttp(status: number, headers: Headers, bodyText: string, nowMs: number, redact: (s: string) => string): ProviderError {
  const base = classifyHttpError(status, headers, bodyText, nowMs, redact);
  if (base.kind === "rate_limit") {
    const usageLimit = base.code === 'subscription_sharing_usage_limit_exceeded' || base.providerType === "usage_limit_reached" || base.code === "usage_limit_reached";
    const p: { retryAfterMs?: number; retryable?: boolean } = {};
    const wait = base.retryAfterMs ?? limitHeaderReset(headers) ?? (usageLimit ? bodyResetMs(bodyText) : undefined);
    if (wait !== undefined && base.retryAfterMs === undefined) p.retryAfterMs = wait;
    if (usageLimit) p.retryable = false;
    return Object.keys(p).length === 0 ? base : patch(base, p);
  }
  if (base.kind === "invalid_request" && !base.contentFiltered && base.code === "invalid_prompt" && POLICY_RE.test(base.providerMessage ?? "")) return patch(base, { contentFiltered: true });
  return base;
}

/**
 * An `error` event or a `response.failed` inside a 200 stream: there is no HTTP status, so `code` (and `type`) decide.
 * The shared classifier is asked first (rate limit, context length, auth, server error); what it leaves `unknown` and
 * this adapter can name (plan usage limit, an empty quota, a refused prompt, other `invalid_*` / `unsupported_*` codes)
 * is named here; the rest stays `unknown` and is never retried.
 */
export function classifyResponsesStreamError(v: unknown, redact: (s: string) => string): ProviderError {
  // A flat `{"type":"error","code":…}` event: its `type` is the EVENT type, not a provider error type.
  const flat = isRecord(v) && v["type"] === "error" && !("error" in v);
  const raw = errorFromValue(flat ? { error: { code: v["code"], message: v["message"] } } : v);
  const code = (raw.code ?? "").toLowerCase(), type = (raw.type ?? "").toLowerCase();
  const text = raw.message ?? "";
  const providerMessage = raw.message === undefined ? undefined : redact(raw.message).slice(0, MAX_MESSAGE_CHARS);
  const safeCode = raw.code === undefined ? undefined : redact(raw.code).slice(0, MAX_CODE_CHARS);
  const safeType = raw.type === undefined ? undefined : redact(raw.type).slice(0, MAX_CODE_CHARS);
  const build = (kind: ProviderError["kind"], what: string, extra: ProviderErrorInit = {}): ProviderError => {
    const init: ProviderErrorInit = { ...extra };
    if (safeCode !== undefined) init.code = safeCode;
    if (safeType !== undefined) init.providerType = safeType;
    if (providerMessage !== undefined) init.providerMessage = providerMessage;
    return new ProviderError(kind, `${what} in stream${safeCode ? ` (${safeCode})` : ""}${providerMessage ? `: ${providerMessage}` : ""}`, init);
  };
  if (code === "insufficient_quota" || type === "insufficient_quota") return build("rate_limit", "quota exhausted", { retryable: false });
  if (code === "usage_limit_reached" || type === "usage_limit_reached") return build("rate_limit", "plan usage limit reached", { retryable: false });
  const shared = classifyStreamError(flat ? { error: { code: v["code"], message: v["message"] } } : v, redact);
  if (shared.kind !== "unknown") return shared;
  if (code === "invalid_prompt") return build("invalid_request", "prompt refused", POLICY_RE.test(text) ? { contentFiltered: true } : {});
  if (code.startsWith("invalid_") || code.startsWith("unsupported_") || code === "model_not_found" || type === "invalid_request_error") return build("invalid_request", "request rejected");
  return shared;
}

import { classifyHttpError, classifyStreamError, errorFromValue, ProviderError } from "../errors.ts";
import type { ProviderErrorInit, ProviderErrorKind } from "../errors.ts";

const MAX_MESSAGE_CHARS = 500;
const MAX_CODE_CHARS = 200;

// Anthropic words these differently from the shared patterns: "prompt is too long: N tokens > M maximum" (the shared
// pattern knows that one) and "input length and `max_tokens` exceed context limit: A + B > C".
const CONTEXT_RE = /prompt is too long|input is too long|exceed(s|ed)? (the )?context (limit|window)|context (limit|window) exceeded|maximum context/i;
// Anthropic answers an exhausted credit balance with HTTP 400 `invalid_request_error`; resending never helps and the
// operator has to act, which is what `auth` means in the taxonomy.
const BILLING_RE = /credit balance is too low|purchase credits|billing/i;

function reclassify(base: ProviderError, kind: ProviderErrorKind, what: string): ProviderError {
  const init: ProviderErrorInit = {};
  if (base.status !== undefined) init.status = base.status;
  if (base.code !== undefined) init.code = base.code;
  if (base.providerType !== undefined) init.providerType = base.providerType;
  if (base.providerMessage !== undefined) init.providerMessage = base.providerMessage;
  if (base.retryAfterMs !== undefined) init.retryAfterMs = base.retryAfterMs;
  const where = base.status === undefined ? " in stream" : ` (HTTP ${base.status})`;
  return new ProviderError(kind, `${what}${where}${base.providerMessage ? `: ${base.providerMessage}` : ""}`, init);
}

/**
 * An HTTP error response of the Messages API (`{"type":"error","error":{"type":…,"message":…}}`) → the taxonomy.
 * The shared classifier already handles the statuses (401/403/402 auth, 429 rate_limit with Retry-After, every 5xx
 * incl. 529 overloaded, other 4xx invalid_request) and the error-body shape; this adds Anthropic's own wording for a
 * prompt that does not fit and for an empty credit balance.
 */
export function classifyAnthropicHttp(status: number, headers: Headers, bodyText: string, nowMs: number, redact: (s: string) => string): ProviderError {
  const base = classifyHttpError(status, headers, bodyText, nowMs, redact);
  if (base.kind !== "invalid_request" || base.contentFiltered) return base;
  const text = base.providerMessage ?? "";
  if (BILLING_RE.test(text)) return reclassify(base, "auth", "payment or credit problem");
  if (CONTEXT_RE.test(text)) return reclassify(base, "context_length", "context length exceeded");
  return base;
}

const BY_TYPE: Readonly<Record<string, ProviderErrorKind>> = {
  overloaded_error: "overloaded",
  api_error: "overloaded",
  rate_limit_error: "rate_limit",
  authentication_error: "auth",
  permission_error: "auth",
  billing_error: "auth",
  invalid_request_error: "invalid_request",
  not_found_error: "invalid_request",
  request_too_large: "invalid_request",
};

/**
 * An `event: error` inside a 200 stream (`{"type":"error","error":{"type":"overloaded_error","message":…}}`): there is
 * no HTTP status, so the error `type` decides. An unrecognised type goes to the shared classifier, which says
 * `unknown` (never retried) unless the text itself says overload, rate limit or auth.
 */
export function classifyAnthropicStreamError(v: unknown, redact: (s: string) => string): ProviderError {
  const raw = errorFromValue(v);
  const type = raw.type === undefined ? undefined : redact(raw.type).slice(0, MAX_CODE_CHARS);
  const code = raw.code === undefined ? undefined : redact(raw.code).slice(0, MAX_CODE_CHARS);
  const providerMessage = raw.message === undefined ? undefined : redact(raw.message).slice(0, MAX_MESSAGE_CHARS);
  let kind = raw.type === undefined ? undefined : BY_TYPE[raw.type];
  if (kind === undefined) return classifyStreamError(v, redact);
  const text = raw.message ?? "";
  if (kind === "invalid_request" && BILLING_RE.test(text)) kind = "auth";
  else if (kind === "invalid_request" && CONTEXT_RE.test(text)) kind = "context_length";
  const init: ProviderErrorInit = {};
  if (type !== undefined) init.providerType = type;
  if (code !== undefined) init.code = code;
  if (providerMessage !== undefined) init.providerMessage = providerMessage;
  return new ProviderError(kind, `provider error in stream${type ? ` (${type})` : ""}${providerMessage ? `: ${providerMessage}` : ""}`, init);
}

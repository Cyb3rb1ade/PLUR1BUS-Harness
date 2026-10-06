import type { PartialChatResult } from "./types.ts";

export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "context_length"
  | "content_filter"
  | "bad_request"
  | "server"
  | "timeout"
  | "network"
  | "protocol"
  | "aborted";

export interface ProviderErrorInit {
  status?: number;
  retryAfterMs?: number;
  code?: string;
  providerType?: string;
  providerMessage?: string;
  timeoutPhase?: "headers" | "idle" | "total";
  retryable?: boolean;
  partial?: PartialChatResult;
  cause?: unknown;
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limit", "server", "timeout", "network"]);

/** The one error type the adapter throws. It never carries a request body or a credential. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly code: string | undefined;
  readonly providerType: string | undefined;
  readonly providerMessage: string | undefined;
  readonly timeoutPhase: "headers" | "idle" | "total" | undefined;
  /** A retry of the same request could succeed (a hint for the retry budget, not a promise). */
  readonly retryable: boolean;
  partial: PartialChatResult | undefined;

  constructor(kind: ProviderErrorKind, message: string, init: ProviderErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.code = init.code;
    this.providerType = init.providerType;
    this.providerMessage = init.providerMessage;
    this.timeoutPhase = init.timeoutPhase;
    this.retryable = init.retryable ?? RETRYABLE.has(kind);
    this.partial = init.partial;
  }
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 500;

const DAY = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const LONG_DAY = "(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)";
const TIME = "\\d{2}:\\d{2}:\\d{2}";
const IMF_FIXDATE = new RegExp(`^${DAY}, \\d{2} ${MON} \\d{4} ${TIME} GMT$`);
const RFC850_DATE = new RegExp(`^${LONG_DAY}, \\d{2}-${MON}-\\d{2} ${TIME} GMT$`);
const ASCTIME_DATE = new RegExp(`^${DAY} ${MON} [ \\d]\\d ${TIME} \\d{4}$`);

/**
 * `retry-after-ms` (OpenAI: non-negative integer) or `retry-after` per RFC 9110 §10.2.3: delta-seconds, or an
 * HTTP-date in one of its three forms (IMF-fixdate, RFC 850, asctime; all UTC). Anything else is ignored, never
 * guessed at. A valid value is capped at 24 h.
 */
export function parseRetryAfter(headers: Headers, nowMs: number): number | undefined {
  const ms = headers.get("retry-after-ms")?.trim();
  if (ms !== undefined && /^\d+$/.test(ms)) return Math.min(Number(ms), MAX_RETRY_AFTER_MS);
  const v = headers.get("retry-after")?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Math.min(Number(v) * 1000, MAX_RETRY_AFTER_MS);
  let at = Number.NaN;
  if (IMF_FIXDATE.test(v) || RFC850_DATE.test(v)) at = Date.parse(v);
  else if (ASCTIME_DATE.test(v)) at = Date.parse(`${v} GMT`);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, at - nowMs), MAX_RETRY_AFTER_MS);
}

export interface ErrorBody {
  message?: string;
  code?: string;
  type?: string;
}

/** Pulls `{error:{message,code,type}}`, `{error:"…"}`, `{message}` or `{detail}` out of a provider body; tolerant, never throws. */
export function readErrorBody(text: string): ErrorBody {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return text.trim() ? { message: text.trim() } : {}; }
  return errorFromValue(v);
}

export function errorFromValue(v: unknown): ErrorBody {
  if (typeof v === "string") return { message: v };
  if (!isRecord(v)) return {};
  const e = isRecord(v["error"]) || typeof v["error"] === "string" ? v["error"] : v;
  if (typeof e === "string") return { message: e };
  if (!isRecord(e)) return {};
  const out: ErrorBody = {};
  const message = typeof e["message"] === "string" ? e["message"] : typeof e["detail"] === "string" ? e["detail"] : undefined;
  if (message !== undefined) out.message = message;
  const code = typeof e["code"] === "string" ? e["code"] : typeof e["code"] === "number" ? String(e["code"]) : undefined;
  if (code !== undefined) out.code = code;
  if (typeof e["type"] === "string") out.type = e["type"];
  return out;
}

const CONTEXT_CODES = new Set(["context_length_exceeded", "model_context_window_exceeded"]);
const CONTEXT_RE = /context (length|window)|maximum context|too many tokens|prompt is too long|reduce the length of the messages|exceeds the (model's )?(maximum )?(context|token)/i;
const FILTER_CODES = new Set(["content_filter", "content_policy_violation", "responsibleaipolicyviolation"]);
const FILTER_RE = /content (management )?policy|content[ _-]filter/i;

function lc(s: string | undefined): string { return (s ?? "").toLowerCase(); }

/**
 * Maps an HTTP error response to the taxonomy. `redact` removes secrets from provider text before it is stored.
 * RULING: 402 is `auth` (a billing/credential problem, not retryable); 413 is `context_length` only when the body
 * says so; a 3xx is never followed (the credential would travel) and is a `protocol` error.
 */
export function classifyHttpError(status: number, headers: Headers, bodyText: string, nowMs: number, redact: (s: string) => string): ProviderError {
  const body = readErrorBody(bodyText);
  const code = body.code, type = body.type;
  const providerMessage = body.message === undefined ? undefined : redact(body.message).slice(0, MAX_MESSAGE_CHARS);
  const retryAfterMs = parseRetryAfter(headers, nowMs);
  const base: ProviderErrorInit = { status };
  if (code !== undefined) base.code = code;
  if (type !== undefined) base.providerType = type;
  if (providerMessage !== undefined) base.providerMessage = providerMessage;
  if (retryAfterMs !== undefined) base.retryAfterMs = retryAfterMs;
  const text = (kind: ProviderErrorKind, what: string, extra: ProviderErrorInit = {}): ProviderError =>
    new ProviderError(kind, `${what} (HTTP ${status}${code ? `, ${code}` : ""})${providerMessage ? `: ${providerMessage}` : ""}`, { ...base, ...extra });

  if (status >= 300 && status < 400) return text("protocol", "unexpected redirect, not followed");
  if (status === 401 || status === 403) return text("auth", "authentication or permission failure");
  if (status === 402) return text("auth", "payment or credit problem");
  if (status === 408) return text("timeout", "the server timed out the request", { timeoutPhase: "headers" });
  if (status === 429 || lc(code) === "rate_limit_exceeded") {
    const quota = lc(code) === "insufficient_quota" || lc(type) === "insufficient_quota";
    return text("rate_limit", quota ? "quota exhausted" : "rate limited", quota ? { retryable: false } : {});
  }
  if (status >= 500) return text("server", "provider server error");
  if (status >= 400) {
    if (CONTEXT_CODES.has(lc(code)) || CONTEXT_RE.test(body.message ?? "")) return text("context_length", "context length exceeded");
    if (FILTER_CODES.has(lc(code)) || lc(type) === "content_filter" || FILTER_RE.test(body.message ?? "")) return text("content_filter", "blocked by a content filter");
    return text("bad_request", "request rejected");
  }
  return text("protocol", "unexpected HTTP status");
}

/** An error object delivered inside a 200 stream (`data: {"error":{…}}`): there is no status, so code and type decide. */
export function classifyStreamError(v: unknown, redact: (s: string) => string): ProviderError {
  const body = errorFromValue(v);
  const code = lc(body.code), type = lc(body.type);
  const providerMessage = body.message === undefined ? undefined : redact(body.message).slice(0, MAX_MESSAGE_CHARS);
  const init: ProviderErrorInit = {};
  if (body.code !== undefined) init.code = body.code;
  if (body.type !== undefined) init.providerType = body.type;
  if (providerMessage !== undefined) init.providerMessage = providerMessage;
  const msg = (what: string) => `${what} in stream${body.code ? ` (${body.code})` : ""}${providerMessage ? `: ${providerMessage}` : ""}`;
  if (code.includes("rate_limit") || type.includes("rate_limit")) return new ProviderError("rate_limit", msg("rate limited"), init);
  if (CONTEXT_CODES.has(code) || CONTEXT_RE.test(body.message ?? "")) return new ProviderError("context_length", msg("context length exceeded"), init);
  if (FILTER_CODES.has(code) || type === "content_filter") return new ProviderError("content_filter", msg("blocked by a content filter"), init);
  if (code.includes("auth") || type.includes("auth") || code === "invalid_api_key") return new ProviderError("auth", msg("authentication failure"), init);
  if (type === "server_error" || code === "server_error" || type === "overloaded_error" || code.includes("overload")) return new ProviderError("server", msg("provider server error"), init);
  // RULING: an unrecognised in-stream error is a server-side failure, retryable only by the caller's own judgement.
  return new ProviderError("server", msg("provider error"), { ...init, retryable: false });
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

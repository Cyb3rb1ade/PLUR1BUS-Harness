import { classifyHttpError, isRecord, ProviderError } from "../errors.ts";
import type { ProviderErrorInit, ProviderErrorKind } from "../errors.ts";

const MAX_MESSAGE_CHARS = 500;
const KEY_SHAPE_RE = /AIza[0-9A-Za-z_-]{20,}/g;
const KEY_INVALID_RE = /API key not valid|API_KEY_INVALID|API key expired|API key not found/i;
const CONTEXT_RE = /input token count.*exceed|exceeds the maximum number of tokens|token count of .* exceeds|request payload size exceeds/i;

/** Removes the key actually in use and anything shaped like a Google API key from provider text before it is stored. */
export function makeRedactor(key: () => string): (s: string) => string {
  return (s) => {
    const k = key();
    const t = k.length >= 6 ? s.split(k).join("[redacted]") : s;
    return t.replace(KEY_SHAPE_RE, "[redacted]");
  };
}

interface GoogleError { code?: number; message?: string; status?: string; retryDelayMs?: number }

function readGoogleError(v: unknown): GoogleError {
  const e = isRecord(v) && isRecord(v["error"]) ? v["error"] : undefined;
  if (!e) return {};
  const out: GoogleError = {};
  if (typeof e["code"] === "number") out.code = e["code"];
  if (typeof e["message"] === "string") out.message = e["message"];
  if (typeof e["status"] === "string") out.status = e["status"];
  if (Array.isArray(e["details"])) {
    for (const d of e["details"]) {
      const delay = isRecord(d) && typeof d["retryDelay"] === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(d["retryDelay"]) : null;
      if (delay) out.retryDelayMs = Math.min(Math.round(Number(delay[1]) * 1000), 24 * 60 * 60 * 1000);
    }
  }
  return out;
}

function rebuild(e: ProviderError, kind: ProviderErrorKind, init: ProviderErrorInit): ProviderError {
  const base: ProviderErrorInit = {};
  if (e.status !== undefined) base.status = e.status;
  if (e.code !== undefined) base.code = e.code;
  if (e.providerType !== undefined) base.providerType = e.providerType;
  if (e.providerMessage !== undefined) base.providerMessage = e.providerMessage;
  if (e.retryAfterMs !== undefined) base.retryAfterMs = e.retryAfterMs;
  return new ProviderError(kind, e.message, { ...base, ...init });
}

/**
 * An HTTP error from the Generative Language API. The generic taxonomy does most of it (429 → `rate_limit`, 401/403 →
 * `auth`, 5xx → `server`); Gemini adds what it hides inside a 400: an invalid key is `auth`, an oversized prompt is
 * `context_length`, and a 429's `RetryInfo.retryDelay` stands in for a missing `Retry-After`.
 */
export function classifyGeminiHttpError(status: number, headers: Headers, bodyText: string, nowMs: number, redact: (s: string) => string): ProviderError {
  let parsed: unknown;
  try { parsed = JSON.parse(bodyText); } catch { parsed = undefined; }
  const g = readGoogleError(parsed);
  let err = classifyHttpError(status, headers, bodyText, nowMs, redact);
  if (g.status !== undefined && err.providerType === undefined) err = rebuild(err, err.kind, { providerType: g.status });
  if (err.kind === "bad_request") {
    const msg = g.message ?? "";
    if (KEY_INVALID_RE.test(msg) || bodyText.includes("API_KEY_INVALID")) err = rebuild(err, "auth", { retryable: false });
    else if (CONTEXT_RE.test(msg)) err = rebuild(err, "context_length", { retryable: false });
  }
  if (err.kind === "rate_limit" && err.retryAfterMs === undefined && g.retryDelayMs !== undefined) err = rebuild(err, "rate_limit", { retryAfterMs: g.retryDelayMs });
  return err;
}

const STATUS_KIND: Record<string, ProviderErrorKind> = {
  RESOURCE_EXHAUSTED: "rate_limit", UNAUTHENTICATED: "auth", PERMISSION_DENIED: "auth",
  INVALID_ARGUMENT: "bad_request", FAILED_PRECONDITION: "bad_request", NOT_FOUND: "bad_request", OUT_OF_RANGE: "bad_request",
  UNAVAILABLE: "server", INTERNAL: "server", DEADLINE_EXCEEDED: "server",
};

/** An `{error:{code,message,status}}` object delivered inside a 200 response or stream. */
export function classifyGeminiBodyError(v: unknown, redact: (s: string) => string): ProviderError {
  const g = readGoogleError(v);
  const msg = g.message === undefined ? undefined : redact(g.message).slice(0, MAX_MESSAGE_CHARS);
  const init: ProviderErrorInit = {};
  if (g.code !== undefined) { init.code = String(g.code); init.status = g.code; }
  if (g.status !== undefined) init.providerType = g.status;
  if (msg !== undefined) init.providerMessage = msg;
  if (g.retryDelayMs !== undefined) init.retryAfterMs = g.retryDelayMs;
  const text = (what: string) => `${what} in response${g.status ? ` (${g.status})` : ""}${msg ? `: ${msg}` : ""}`;
  const known = g.status === undefined ? undefined : STATUS_KIND[g.status];
  if (known === "bad_request" && KEY_INVALID_RE.test(g.message ?? "")) return new ProviderError("auth", text("authentication failure"), init);
  if (known === "bad_request" && CONTEXT_RE.test(g.message ?? "")) return new ProviderError("context_length", text("context length exceeded"), init);
  if (known) return new ProviderError(known, text(known === "rate_limit" ? "rate limited" : known === "auth" ? "authentication failure" : known === "server" ? "provider server error" : "request rejected"), init);
  // RULING: an unrecognised in-body error is a server-side failure, not retried by the adapter's own hint.
  return new ProviderError("server", text("provider error"), { ...init, retryable: false });
}

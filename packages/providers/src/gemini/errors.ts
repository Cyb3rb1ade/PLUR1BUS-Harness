import { classifyHttpError, isRecord, ProviderError } from "../errors.ts";
import type { ProviderErrorInit } from "../errors.ts";
import type { GeminiBlockSource, GeminiSafetyInit, GeminiSafetyRating } from "./types.ts";

const MAX_MESSAGE_CHARS = 500;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Gemini refused to produce (all of) the answer for safety or policy reasons: the prompt was blocked
 * (`promptFeedback.blockReason`) or the candidate stopped with `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`, ….
 * It is a `content_filter` `ProviderError` (never retryable: the same input is blocked again) that also says which
 * side was blocked and carries the verbatim reason and the per-category ratings. Whatever text had arrived before a
 * candidate block is in `partial`.
 * RULING: unlike the chat_completions adapter (where finish `content_filter` is a result with a refusal text), a
 * Gemini block is an error, as the task asks: the response carries no usable answer, only a verdict.
 */
export class GeminiSafetyBlockError extends ProviderError {
  readonly source: GeminiBlockSource;
  readonly reason: string;
  readonly ratings: GeminiSafetyRating[];

  constructor(message: string, init: GeminiSafetyInit) {
    const { source, reason, ratings, ...rest } = init;
    super("content_filter", message, { ...rest, code: rest.code ?? reason, retryable: false });
    this.name = "GeminiSafetyBlockError";
    this.source = source;
    this.reason = reason;
    this.ratings = ratings;
  }
}

const CANDIDATE_BLOCKS: ReadonlySet<string> = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
]);

export function isCandidateBlock(finishReason: string): boolean {
  return CANDIDATE_BLOCKS.has(finishReason);
}

/** `safetyRatings` → the typed list; anything malformed is dropped, never thrown on (the block verdict stands). */
export function readRatings(v: unknown): GeminiSafetyRating[] {
  if (!Array.isArray(v)) return [];
  const out: GeminiSafetyRating[] = [];
  for (const r of v) {
    if (!isRecord(r) || typeof r["category"] !== "string") continue;
    const item: GeminiSafetyRating = { category: r["category"], probability: typeof r["probability"] === "string" ? r["probability"] : "UNKNOWN" };
    if (typeof r["blocked"] === "boolean") item.blocked = r["blocked"];
    out.push(item);
  }
  return out;
}

export function promptBlock(promptFeedback: Record<string, unknown>, redact: (s: string) => string): GeminiSafetyBlockError {
  const reason = typeof promptFeedback["blockReason"] === "string" ? promptFeedback["blockReason"] : "BLOCK_REASON_UNSPECIFIED";
  const m = promptFeedback["blockReasonMessage"];
  const detail = typeof m === "string" && m !== "" ? `: ${redact(m).slice(0, MAX_MESSAGE_CHARS)}` : "";
  return new GeminiSafetyBlockError(`prompt blocked by Gemini (${reason})${detail}`, { source: "prompt", reason, ratings: readRatings(promptFeedback["safetyRatings"]) });
}

export function candidateBlock(finishReason: string, safetyRatings: unknown, finishMessage: unknown, redact: (s: string) => string): GeminiSafetyBlockError {
  const detail = typeof finishMessage === "string" && finishMessage !== "" ? `: ${redact(finishMessage).slice(0, MAX_MESSAGE_CHARS)}` : "";
  return new GeminiSafetyBlockError(`response blocked by Gemini (${finishReason})${detail}`, { source: "candidate", reason: finishReason, ratings: readRatings(safetyRatings) });
}

/** `google.rpc.RetryInfo.retryDelay` ("34s", "0.5s", "34.5s") out of `error.details`, in ms; absent or odd → undefined. */
function retryDelayMs(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (!isRecord(d)) continue;
    const t = d["@type"];
    if (typeof t !== "string" || !t.endsWith("google.rpc.RetryInfo")) continue;
    const delay = d["retryDelay"];
    const m = typeof delay === "string" ? /^(\d{1,9})(?:\.(\d{1,9}))?s$/.exec(delay) : null;
    if (m) return Math.min(Math.round(Number(`${m[1]}.${m[2] ?? "0"}`) * 1000), MAX_RETRY_DELAY_MS);
  }
  return undefined;
}

function errorObject(text: string): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(text);
    if (isRecord(v) && isRecord(v["error"])) return v["error"];
  } catch { /* not JSON: the generic classifier copes */ }
  return undefined;
}

function detailReasons(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((d) => (isRecord(d) && typeof d["reason"] === "string" ? [d["reason"]] : []));
}

const KEY_INVALID_RE = /api key (not valid|expired|invalid)|invalid api key|api[_ ]key.*(expired|revoked)/i;
const TOKENS_RE = /input token count.*exceeds|token count.*exceeds the maximum|exceeds the maximum number of tokens|request payload size exceeds/i;

/**
 * An HTTP error response. Delegates to the shared classifier, after three Gemini specifics:
 * - a 400 whose reason is `API_KEY_INVALID` / message says the key is not valid is an `auth` error, not `bad_request`
 *   (Gemini answers a wrong key with `400 INVALID_ARGUMENT`);
 * - a 400 about the token count is `context_length`;
 * - `RetryInfo.retryDelay` in the error details becomes `retryAfterMs` when no Retry-After header says otherwise.
 */
export function classifyGeminiHttp(status: number, headers: Headers, bodyText: string, nowMs: number, redact: (s: string) => string): ProviderError {
  const err = errorObject(bodyText);
  const message = typeof err?.["message"] === "string" ? err["message"] : "";
  const reasons = detailReasons(err?.["details"]);
  const providerMessage = message === "" ? undefined : redact(message).slice(0, MAX_MESSAGE_CHARS);
  const gstatus = typeof err?.["status"] === "string" ? err["status"] : undefined;
  const base: ProviderErrorInit = { status };
  if (gstatus !== undefined) base.providerType = gstatus;
  if (providerMessage !== undefined) base.providerMessage = providerMessage;
  const tail = `${providerMessage ? `: ${providerMessage}` : ""}`;
  if (status === 400 || status === 404) {
    if (reasons.includes("API_KEY_INVALID") || KEY_INVALID_RE.test(message)) {
      return new ProviderError("auth", `API key rejected (HTTP ${status}, API_KEY_INVALID)${tail}`, { ...base, code: "API_KEY_INVALID", retryable: false });
    }
    if (status === 400 && TOKENS_RE.test(message)) {
      return new ProviderError("context_length", `context length exceeded (HTTP 400)${tail}`, base);
    }
  }
  const h = new Headers(headers);
  if (!h.has("retry-after") && !h.has("retry-after-ms")) {
    const ms = retryDelayMs(err?.["details"]);
    if (ms !== undefined) h.set("retry-after-ms", String(ms));
  }
  const e = classifyHttpError(status, h, bodyText, nowMs, redact);
  if (e.providerType === undefined && gstatus !== undefined) {
    // The shared classifier reads `error.type`; Gemini names the gRPC status `error.status`. Same error, with the status kept.
    const init: ProviderErrorInit = { providerType: gstatus, retryable: e.retryable, ...(e.cause === undefined ? {} : { cause: e.cause }) };
    if (e.status !== undefined) init.status = e.status;
    if (e.retryAfterMs !== undefined) init.retryAfterMs = e.retryAfterMs;
    if (e.code !== undefined) init.code = e.code;
    if (e.providerMessage !== undefined) init.providerMessage = e.providerMessage;
    if (e.timeoutPhase !== undefined) init.timeoutPhase = e.timeoutPhase;
    return new ProviderError(e.kind, e.message, init);
  }
  // RULING: Gemini's 429 `RESOURCE_EXHAUSTED` covers both the per-minute limit and an exhausted daily quota/billing cap and
  // the body does not tell them apart reliably; it stays `rate_limit` + retryable, and the retry budget (C1) bounds it.
  return e;
}

const GRPC_KIND: Record<string, ProviderError["kind"]> = {
  RESOURCE_EXHAUSTED: "rate_limit",
  UNAUTHENTICATED: "auth",
  PERMISSION_DENIED: "auth",
  INVALID_ARGUMENT: "bad_request",
  FAILED_PRECONDITION: "bad_request",
  NOT_FOUND: "bad_request",
  UNAVAILABLE: "server",
  INTERNAL: "server",
  DEADLINE_EXCEEDED: "server",
};

/** An `{error:{code,message,status}}` object inside a 200 body or stream event. */
export function classifyGeminiStreamError(v: unknown, redact: (s: string) => string): ProviderError {
  const e = isRecord(v) && isRecord(v["error"]) ? v["error"] : isRecord(v) ? v : {};
  const gstatus = typeof e["status"] === "string" ? e["status"] : undefined;
  const code = typeof e["code"] === "number" ? e["code"] : undefined;
  const message = typeof e["message"] === "string" ? redact(e["message"]).slice(0, MAX_MESSAGE_CHARS) : undefined;
  const init: ProviderErrorInit = {};
  if (code !== undefined) { init.status = code; init.code = String(code); }
  if (gstatus !== undefined) init.providerType = gstatus;
  if (message !== undefined) init.providerMessage = message;
  const retry = retryDelayMs(e["details"]);
  if (retry !== undefined) init.retryAfterMs = retry;
  const where = `${gstatus ?? code ?? "error"}`;
  const text = (what: string) => `${what} in stream (${where})${message ? `: ${message}` : ""}`;
  let kind: ProviderError["kind"] | undefined = gstatus === undefined ? undefined : GRPC_KIND[gstatus];
  if (kind === undefined && code !== undefined) {
    kind = code === 429 ? "rate_limit" : code === 401 || code === 403 ? "auth" : code >= 500 ? "server" : code >= 400 ? "bad_request" : undefined;
  }
  switch (kind) {
    case "rate_limit": return new ProviderError("rate_limit", text("rate limited"), init);
    case "auth": return new ProviderError("auth", text("authentication failure"), init);
    case "bad_request": return new ProviderError("bad_request", text("request rejected"), init);
    case "server": return new ProviderError("server", text("provider server error"), init);
    // RULING: an unrecognised in-stream error is a server-side failure, not retryable by default (as in chat_completions).
    default: return new ProviderError("server", text("provider error"), { ...init, retryable: false });
  }
}

import { ERROR_CODES, type ErrorCode } from "@plur1bus/rpc-schema";

/** The HTTP status each member of the closed `ErrorCode` enum answers with when nothing more specific is known. The
 *  enum is closed (ADR-016 §2), so conditions without a code of their own (a missing CSRF token, a rate limit, an
 *  oversized body) use the nearest code and a `reason`, never a new code. */
const STATUS_OF_CODE: Record<string, number> = {
  E_UNAUTHORIZED: 401, E_DENIED: 403, E_NOT_FOUND: 404, E_AGENT_UNKNOWN: 404, E_MODULE_UNKNOWN: 404,
  E_INVALID_PARAMS: 400, E_CONFIG_INVALID: 400, E_CONFLICT: 409, E_LOCKED: 423, E_APPROVAL_REQUIRED: 403,
  E_CORE_UNAVAILABLE: 503, E_NOT_AVAILABLE: 503, E_RPC_VERSION: 502, E_STORAGE: 500, E_INTERNAL: 500,
};

export function statusOfCode(code: ErrorCode): number {
  return STATUS_OF_CODE[code] ?? 500;
}

export interface ApiErrorOptions { reason?: string; headers?: Record<string, string> }

export class ApiError extends Error {
  readonly status: number; readonly error: ErrorCode; readonly reason: string | undefined; readonly headers: Record<string, string>;
  constructor(status: number, error: ErrorCode, message: string, opts: ApiErrorOptions = {}) {
    if (!ERROR_CODES.includes(error)) throw new Error(`unknown error code ${error}`);
    super(message); this.name = "ApiError"; this.status = status; this.error = error; this.reason = opts.reason; this.headers = opts.headers ?? {};
  }
}

/** Constructors for the conditions the HTTP layer itself raises. */
export const errors = {
  unauthenticated: (reason = "no-session") => new ApiError(401, "E_UNAUTHORIZED", "authentication required", { reason }),
  forbidden: (reason: string, message = "request refused") => new ApiError(403, "E_DENIED", message, { reason }),
  notFound: () => new ApiError(404, "E_NOT_FOUND", "no such route", { reason: "route" }),
  methodNotAllowed: (allow: string[]) => new ApiError(405, "E_INVALID_PARAMS", "method not allowed", { reason: "method-not-allowed", headers: { Allow: allow.join(", ") } }),
  badRequest: (reason: string, message: string) => new ApiError(400, "E_INVALID_PARAMS", message, { reason }),
  unsupportedMedia: () => new ApiError(415, "E_INVALID_PARAMS", "content type must be application/json", { reason: "unsupported-media-type" }),
  tooLarge: (limit: number) => new ApiError(413, "E_INVALID_PARAMS", `request body exceeds ${limit} bytes`, { reason: "body-too-large", headers: { Connection: "close" } }),
  rateLimited: (retryAfterSec: number) => new ApiError(429, "E_DENIED", "rate limit exceeded", { reason: "rate-limited", headers: { "Retry-After": String(retryAfterSec) } }),
  timeout: (reason = "handler-timeout") => new ApiError(504, "E_NOT_AVAILABLE", "the request timed out", { reason }),
  misdirected: () => new ApiError(421, "E_DENIED", "unexpected Host header", { reason: "host" }),
  internal: () => new ApiError(500, "E_INTERNAL", "internal error"),
};

/** The failure document of every endpoint: the CLI's `error/1` (ADR-016 §8, ruling G15), same keys. */
export function errorBody(e: ApiError): { schema: "error/1"; error: ErrorCode; message: string; reason?: string } {
  return { schema: "error/1", error: e.error, message: e.message, ...(e.reason ? { reason: e.reason } : {}) };
}

const REASON_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CORE_MESSAGES: Partial<Record<ErrorCode, string>> = {
  E_AGENT_UNKNOWN: "unknown agent", E_MODULE_UNKNOWN: "unknown module", E_NOT_FOUND: "not found", E_INVALID_PARAMS: "invalid parameters",
  E_CONFIG_INVALID: "the configuration is invalid", E_CONFLICT: "conflict", E_LOCKED: "locked", E_DENIED: "denied", E_APPROVAL_REQUIRED: "approval required",
  E_CORE_UNAVAILABLE: "the core is not reachable", E_NOT_AVAILABLE: "not available",
};

/** Maps what a core RPC call threw (a `RpcCallError` from module-api, or a connection failure) to an `ApiError`. */
export function fromCoreError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  const code = (e as { error?: unknown } | null)?.error;
  if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) {
    const c = code as ErrorCode;
    if (c === "E_INTERNAL" || c === "E_STORAGE") return new ApiError(502, "E_CORE_UNAVAILABLE", "the core failed to answer", { reason: "core-error" });
    // A core that refuses *our* credentials is a bad gateway, not the caller's 401.
    if (c === "E_UNAUTHORIZED" || c === "E_RPC_VERSION") return new ApiError(502, "E_CORE_UNAVAILABLE", "the core refused the API's connection", { reason: "core-handshake" });
    // The core's free text can name host paths or internals (review F2): the caller gets a fixed message per code and only a
    // short machine-style reason; the full text stays in the core's own log.
    const reason = (e as { reason?: unknown }).reason;
    return new ApiError(statusOfCode(c), c, CORE_MESSAGES[c] ?? "the core refused the request", typeof reason === "string" && REASON_SHAPE.test(reason) ? { reason } : {});
  }
  return new ApiError(503, "E_CORE_UNAVAILABLE", "the core is not reachable", { reason: "core-unreachable" });
}

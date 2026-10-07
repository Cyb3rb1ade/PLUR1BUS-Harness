// Failures of the typed API client. Every call rejects with exactly one of these (discriminate on `kind`); nothing
// else leaks out (no raw TypeError from fetch, no AbortError). Messages never contain tokens, cookies or CSRF values.

/** The closed ErrorCode enum of docs/rpc.md. @plur1bus/rpc-schema pulls in Node-only code (ajv), so the browser bundle
 *  keeps its own copy; a code outside the list is tolerated (`errorCode` null). */
export const ERROR_CODES = [
  "E_UNAUTHORIZED", "E_RPC_VERSION", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_INVALID_PARAMS", "E_AGENT_UNKNOWN", "E_CONFIG_INVALID",
  "E_MODULE_UNKNOWN", "E_INTERNAL", "E_LOCKED", "E_NOT_FOUND", "E_DENIED", "E_APPROVAL_REQUIRED", "E_CONFLICT", "E_STORAGE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export function asErrorCode(v: unknown): ErrorCode | null {
  return typeof v === "string" && (ERROR_CODES as readonly string[]).includes(v) ? (v as ErrorCode) : null;
}

/** 401 on a read (or an RPC E_UNAUTHORIZED): there is no valid session. */
export class UnauthenticatedError extends Error {
  readonly kind = "unauthenticated" as const;
  constructor(message = "not signed in") { super(message); this.name = "UnauthenticatedError"; }
}
/** 401 on a write (or while fetching its CSRF token): the session ended while the user was working. */
export class SessionExpiredError extends Error {
  readonly kind = "session-expired" as const;
  constructor(message = "the session has expired") { super(message); this.name = "SessionExpiredError"; }
}
/** 403 without the csrf reason, or RPC E_DENIED: the principal may not do this. */
export class ForbiddenError extends Error {
  readonly kind = "forbidden" as const;
  readonly reason: string | undefined;
  readonly errorCode: ErrorCode | null;
  constructor(message: string, reason?: string, errorCode: ErrorCode | null = "E_DENIED") { super(message); this.name = "ForbiddenError"; this.reason = reason; this.errorCode = errorCode; }
}
/** The server refused the CSRF token twice (a fresh one on the retry): a write failed, the session is still fine. */
export class CsrfError extends Error {
  readonly kind = "csrf" as const;
  constructor(message = "the CSRF token was refused") { super(message); this.name = "CsrfError"; }
}
/** The backend (or the route) is not there: 404/405/501/502/503/504, no network, E_NOT_AVAILABLE / E_CORE_UNAVAILABLE,
 *  or an answer that is not the documented wire format (an HTML fallback page). `reason` is the machine reason. */
export class UnavailableError extends Error {
  readonly kind = "unavailable" as const;
  readonly reason: string;
  readonly status: number | undefined;
  readonly errorCode: ErrorCode | null;
  constructor(message: string, reason: string, opts: { status?: number; errorCode?: ErrorCode | null } = {}) {
    super(message); this.name = "UnavailableError"; this.reason = reason; this.status = opts.status; this.errorCode = opts.errorCode ?? null;
  }
}
/** A JSON-RPC error object: `code` is the JSON-RPC number (-32601 method not found, -32000 application error, ...),
 *  `data` the raw `error.data`, `errorCode`/`reason` the harness ErrorCode and reason taken out of it. */
export class RpcError extends Error {
  readonly kind = "rpc-error" as const;
  readonly code: number;
  readonly data: unknown;
  readonly errorCode: ErrorCode | null;
  readonly reason: string | undefined;
  constructor(code: number, message: string, data: unknown, errorCode: ErrorCode | null, reason: string | undefined) {
    super(message); this.name = "RpcError"; this.code = code; this.data = data; this.errorCode = errorCode; this.reason = reason;
  }
}
/** Any other non-2xx answer (400, 409, 429, 500, ...). */
export class HttpError extends Error {
  readonly kind = "http" as const;
  readonly status: number;
  readonly reason: string | undefined;
  readonly errorCode: ErrorCode | null;
  readonly retryAfterSeconds: number | null;
  constructor(status: number, message: string, opts: { reason?: string | undefined; errorCode?: ErrorCode | null; retryAfterSeconds?: number | null } = {}) {
    super(message); this.name = "HttpError"; this.status = status; this.reason = opts.reason; this.errorCode = opts.errorCode ?? null; this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }
}
/** The caller's AbortSignal fired. */
export class AbortedError extends Error {
  readonly kind = "aborted" as const;
  constructor(message = "the request was aborted") { super(message); this.name = "AbortedError"; }
}

export type ApiError = UnauthenticatedError | SessionExpiredError | ForbiddenError | CsrfError | UnavailableError | RpcError | HttpError | AbortedError;
export type ApiErrorKind = ApiError["kind"];

export function isApiError(e: unknown): e is ApiError {
  return e instanceof UnauthenticatedError || e instanceof SessionExpiredError || e instanceof ForbiddenError || e instanceof CsrfError
    || e instanceof UnavailableError || e instanceof RpcError || e instanceof HttpError || e instanceof AbortedError;
}

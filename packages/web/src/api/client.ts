// The typed API client: JSON-RPC 2.0 on /rpc, REST under /api/v1, SSE on /events, all with the session cookie and the
// one-time CSRF token the Harness API expects (docs/api-surface.md; the token logic mirrors HttpSessionApi.write in
// ../session.ts). UI pages depend on the `Api` interface, never on fetch, so tests and page agents can swap it out.
import { API_ROUTES } from "./routes.ts";
import {
  AbortedError, asErrorCode, CsrfError, ForbiddenError, HttpError, isApiError, RpcError, SessionExpiredError, UnauthenticatedError, UnavailableError,
  type ApiError, type ErrorCode,
} from "./errors.ts";
import { defaultSleep, openEventStream, type EventsHandle, type EventsOptions, type Sleep } from "./sse.ts";
import { CSRF_HEADER, SESSION_ROUTES } from "../session.ts";

/** Typed RPC methods. Declare the ones a page uses by merging into this interface:
 *  `declare module "../api/index.ts" { interface RpcMethods { "dreams.status": { params: void; result: DreamStatus } } }` */
export interface RpcMethods { [method: string]: { params: unknown; result: unknown } }

export interface RequestOptions { signal?: AbortSignal }
export interface RpcOptions extends RequestOptions {
  /** Whether the call needs a one-time CSRF token (default true: a token is fetched before the call). Pass false for
   *  pure reads to save the round trip; if the server wants a token anyway the call is retried once with one. */
  write?: boolean;
}

export interface Api {
  rpc<M extends string>(method: M, params?: RpcMethods[M]["params"], opts?: RpcOptions): Promise<RpcMethods[M]["result"]>;
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T>;
  /** Opens the SSE stream; see EventsHandle. */
  events(opts: EventsOptions): EventsHandle;
}

/** Fetches a one-time CSRF token; throws an ApiError (or anything: it is wrapped) on failure. */
export type CsrfProvider = (signal?: AbortSignal) => Promise<string>;

export interface CreateApiOptions {
  fetch?: typeof fetch;
  /** Origin prefix, "" for same-origin. */
  baseUrl?: string;
  sleep?: Sleep;
  /** 0..1, for the reconnect jitter. */
  random?: () => number;
  /** Defaults to GET /api/v1/csrf through `fetch`. */
  csrf?: CsrfProvider;
  /** Called when a call or the stream found the session gone (e.g. to show the sign-in page with a notice). */
  onUnauthenticated?: (kind: "unauthenticated" | "session-expired") => void;
}

type Raw = { status: number; headers: Headers; body: unknown; malformed: boolean };
type ErrInfo = { error: ErrorCode | null; reason: string | undefined; message: string | undefined };

function errInfo(body: unknown): ErrInfo {
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return { error: asErrorCode(o.error), reason: typeof o.reason === "string" ? o.reason : undefined, message: typeof o.message === "string" ? o.message : undefined };
}

function retryAfter(h: Headers): number | null {
  const n = Number(h.get("retry-after"));
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/** The failure for a non-2xx answer that is not a CSRF refusal or a 401. */
function httpFailure(raw: Raw): ApiError {
  const info = errInfo(raw.body);
  const { status } = raw;
  if (status === 403) return new ForbiddenError(`forbidden${info.reason ? ` (${info.reason})` : ""}`, info.reason, info.error ?? "E_DENIED");
  if ([404, 405, 501, 502, 503, 504].includes(status)) {
    return new UnavailableError(`unavailable (${status})`, info.reason ?? `http-${status}`, { status, errorCode: info.error });
  }
  return new HttpError(status, `request failed (${status}${info.reason ? ` ${info.reason}` : ""})`, { reason: info.reason, errorCode: info.error, retryAfterSeconds: retryAfter(raw.headers) });
}

function toFailure(e: unknown, signal: AbortSignal | undefined): ApiError {
  if (isApiError(e)) return e;
  if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) return new AbortedError();
  return new UnavailableError("the server cannot be reached", "network");
}

async function readBody(res: Response): Promise<{ body: unknown; malformed: boolean }> {
  const text = await res.text();
  if (text === "") return { body: null, malformed: false };
  try { return { body: JSON.parse(text) as unknown, malformed: false }; } catch { return { body: null, malformed: true }; }
}

function csrfFromFetch(fetchImpl: typeof fetch, baseUrl: string): CsrfProvider {
  return async (signal) => {
    const res = await fetchImpl(baseUrl + SESSION_ROUTES.csrf, { credentials: "same-origin", headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
    if (res.status === 401) throw new SessionExpiredError();
    const { body, malformed } = await readBody(res);
    if (!res.ok) throw httpFailure({ status: res.status, headers: res.headers, body, malformed });
    const t = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
    if (typeof t === "string" && t !== "") return t;
    throw new UnavailableError("unexpected CSRF answer", "bad-response", { status: res.status });
  };
}

type Envelope = { jsonrpc?: unknown; result?: unknown; error?: unknown };
function asEnvelope(body: unknown): Envelope | null {
  return typeof body === "object" && body !== null && (body as Envelope).jsonrpc === "2.0" ? (body as Envelope) : null;
}

export class HttpApi implements Api {
  readonly #fetch: typeof fetch;
  readonly #base: string;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #csrf: CsrfProvider;
  readonly #onUnauth: ((kind: "unauthenticated" | "session-expired") => void) | undefined;
  #id = 0;

  constructor(opts: CreateApiOptions = {}) {
    this.#fetch = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.#base = opts.baseUrl ?? "";
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
    this.#csrf = opts.csrf ?? csrfFromFetch(this.#fetch, this.#base);
    this.#onUnauth = opts.onUnauthenticated;
  }

  #notify(e: ApiError): void {
    if ((e.kind === "unauthenticated" || e.kind === "session-expired") && this.#onUnauth) { try { this.#onUnauth(e.kind); } catch { /* a listener's bug is not the call's */ } }
  }

  /** One HTTP exchange with the CSRF protocol: token before a write, one retry on 403 csrf, 401 on a write = session-expired. */
  async #exchange(path: string, init: { method: string; body?: string; write: boolean; signal?: AbortSignal }): Promise<Raw> {
    const { signal } = init;
    try {
      if (signal?.aborted) throw new AbortedError();
      let write = init.write;
      for (let attempt = 0; attempt < 2; attempt++) {
        const token = write ? await this.#csrf(signal) : null;
        const res = await this.#fetch(this.#base + path, {
          method: init.method, credentials: "same-origin",
          headers: {
            accept: "application/json",
            ...(init.body === undefined ? {} : { "content-type": "application/json" }),
            ...(token === null ? {} : { [CSRF_HEADER]: token }),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          ...(signal ? { signal } : {}),
        });
        const { body, malformed } = await readBody(res);
        const raw: Raw = { status: res.status, headers: res.headers, body, malformed };
        if (res.status === 401) throw write ? new SessionExpiredError() : new UnauthenticatedError();
        if (res.status === 403 && errInfo(body).reason === "csrf") {
          if (attempt === 0) { write = true; continue; }
          throw new CsrfError();
        }
        return raw;
      }
      throw new CsrfError();
    } catch (e) {
      const f = toFailure(e, signal);
      this.#notify(f);
      throw f;
    }
  }

  async rpc<M extends string>(method: M, params?: RpcMethods[M]["params"], opts: RpcOptions = {}): Promise<RpcMethods[M]["result"]> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.#id, method, ...(params === undefined ? {} : { params }) });
    const raw = await this.#exchange(API_ROUTES.rpc, { method: "POST", body, write: opts.write ?? true, ...(opts.signal ? { signal: opts.signal } : {}) });
    const env = asEnvelope(raw.body);
    const ok = raw.status >= 200 && raw.status < 300;
    if (env && env.error !== undefined && env.error !== null) throw this.#rpcFailure(env.error);
    if (env && ok && "result" in env) return env.result as RpcMethods[M]["result"];
    if (!ok) throw httpFailure(raw);
    throw new UnavailableError("the server did not answer with JSON-RPC", "bad-response", { status: raw.status });
  }

  #rpcFailure(err: unknown): ApiError {
    const o = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const code = typeof o.code === "number" ? o.code : -32603;
    const message = typeof o.message === "string" ? o.message : "rpc error";
    const info = errInfo(o.data);
    const f: ApiError =
      info.error === "E_UNAUTHORIZED" ? new UnauthenticatedError()
      : info.error === "E_DENIED" ? new ForbiddenError(message, info.reason)
      : info.error === "E_NOT_AVAILABLE" || info.error === "E_CORE_UNAVAILABLE" ? new UnavailableError(message, info.reason ?? "core-unavailable", { errorCode: info.error })
      : new RpcError(code, message, o.data, info.error, info.reason);
    this.#notify(f);
    return f;
  }

  async #rest<T>(method: string, path: string, body: unknown, write: boolean, opts: RequestOptions | undefined): Promise<T> {
    const raw = await this.#exchange(path, { method, write, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(opts?.signal ? { signal: opts.signal } : {}) });
    if (raw.status < 200 || raw.status >= 300) throw httpFailure(raw);
    if (raw.malformed) throw new UnavailableError("the server did not answer with JSON", "bad-response", { status: raw.status });
    return raw.body as T;
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> { return this.#rest<T>("GET", path, undefined, false, opts); }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> { return this.#rest<T>("POST", path, body, true, opts); }
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> { return this.#rest<T>("PUT", path, body, true, opts); }
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> { return this.#rest<T>("PATCH", path, body, true, opts); }
  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> { return this.#rest<T>("DELETE", path, undefined, true, opts); }

  events(opts: EventsOptions): EventsHandle {
    return openEventStream({ fetch: this.#fetch, baseUrl: this.#base, sleep: this.#sleep, random: this.#random, notify: (e) => { this.#notify(e); } }, opts);
  }
}

export function createApi(opts: CreateApiOptions = {}): Api { return new HttpApi(opts); }

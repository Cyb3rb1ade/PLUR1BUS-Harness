import { redactString } from "./redact.ts";
import type { SyncResponse } from "./events.ts";

export type MatrixErrorKind =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "protocol"
  | "too-large";

/** Built from fixed text plus a Matrix `errcode` (validated shape only); never carries a URL, token or server error text. */
export class MatrixApiError extends Error {
  readonly kind: MatrixErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly errcode?: string;
  constructor(
    kind: MatrixErrorKind,
    message: string,
    extra: { status?: number; retryAfterMs?: number; errcode?: string } = {},
  ) {
    super(message);
    this.name = "MatrixApiError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.errcode !== undefined) this.errcode = extra.errcode;
  }
}

// Server-dictated retry intervals are clamped to [1 s, 5 min]: 0 must not hot-loop, a huge value must not park the channel.
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 300_000;
const DEFAULT_RETRY_AFTER_MS = 1_000;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https everywhere; plain http only for loopback (tests and a homeserver on the same host). No credentials, query or fragment. */
export function validateHomeserverUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new RangeError("homeserverUrl must be an absolute URL");
  }
  const loopbackHttp = u.protocol === "http:" && LOOPBACK.has(u.hostname);
  if ((u.protocol !== "https:" && !loopbackHttp) || u.username || u.password || u.search || u.hash)
    throw new RangeError("homeserverUrl must be https (http only for loopback) without credentials, query or fragment");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

export function clampRetryAfter(ms: number | undefined): number {
  const v = Number.isFinite(ms) ? Math.round(ms!) : DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, v));
}

/** `mxc://<server>/<mediaId>`; both parts are validated so they can be placed in a path segment safely. */
export function parseMxc(uri: unknown): { server: string; mediaId: string } | undefined {
  if (typeof uri !== "string") return undefined;
  const m = /^mxc:\/\/([A-Za-z0-9.\-:[\]]{1,255})\/([A-Za-z0-9_-]{1,255})$/.exec(uri);
  return m ? { server: m[1]!, mediaId: m[2]! } : undefined;
}

export interface MatrixApiOptions {
  homeserverUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
}

export interface SyncArgs {
  since?: string;
  timeoutMs: number;
  filter: string;
}

export interface WhoAmI {
  user_id: string;
  device_id?: string;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;

export class MatrixApi {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  constructor(opts: MatrixApiOptions) {
    this.#token = opts.accessToken;
    this.#base = validateHomeserverUrl(opts.homeserverUrl);
    this.#fetch = opts.fetch ?? fetch;
  }

  whoami(signal: AbortSignal): Promise<WhoAmI> {
    return this.#json<WhoAmI>("GET", "/_matrix/client/v3/account/whoami", undefined, signal, 30_000, "whoami");
  }

  /** Long poll. The client timeout is the server's `timeout` plus a margin; the server answers early on new events. */
  sync(args: SyncArgs, signal: AbortSignal): Promise<SyncResponse> {
    const q = new URLSearchParams({ timeout: String(args.timeoutMs), filter: args.filter });
    if (args.since !== undefined) q.set("since", args.since);
    return this.#json<SyncResponse>(
      "GET",
      `/_matrix/client/v3/sync?${q.toString()}`,
      undefined,
      signal,
      args.timeoutMs + 15_000,
      "sync",
    );
  }

  async joinRoom(roomId: string, signal: AbortSignal): Promise<void> {
    await this.#json("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/join`, {}, signal, 30_000, "join");
  }

  async leaveRoom(roomId: string, signal: AbortSignal): Promise<void> {
    await this.#json("POST", `/_matrix/client/v3/rooms/${enc(roomId)}/leave`, {}, signal, 30_000, "leave");
  }

  /** PUT with a transaction id: the homeserver de-duplicates a retried request, so retries are safe. */
  async sendEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>,
    txnId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const r = await this.#json<{ event_id?: unknown }>(
      "PUT",
      `/_matrix/client/v3/rooms/${enc(roomId)}/send/${enc(type)}/${enc(txnId)}`,
      content,
      signal,
      30_000,
      "send",
    );
    if (typeof r?.event_id !== "string" || !/^\$[^\s]{1,255}$/.test(r.event_id))
      throw new MatrixApiError("protocol", "send result lacks event_id");
    return r.event_id;
  }

  async redactEvent(roomId: string, eventId: string, txnId: string, signal: AbortSignal): Promise<void> {
    await this.#json(
      "PUT",
      `/_matrix/client/v3/rooms/${enc(roomId)}/redact/${enc(eventId)}/${enc(txnId)}`,
      {},
      signal,
      30_000,
      "redact",
    );
  }

  async setTyping(roomId: string, userId: string, typing: boolean, timeoutMs: number, signal: AbortSignal): Promise<void> {
    await this.#json(
      "PUT",
      `/_matrix/client/v3/rooms/${enc(roomId)}/typing/${enc(userId)}`,
      typing ? { typing: true, timeout: timeoutMs } : { typing: false },
      signal,
      30_000,
      "typing",
    );
  }

  async displayName(userId: string, signal: AbortSignal): Promise<string | undefined> {
    const r = await this.#json<{ displayname?: unknown }>(
      "GET",
      `/_matrix/client/v3/profile/${enc(userId)}`,
      undefined,
      signal,
      30_000,
      "profile",
    );
    return typeof r?.displayname === "string" && r.displayname.length <= 256 ? r.displayname : undefined;
  }

  /** Uploads with the unauthenticated v3 media endpoint (the only upload path the spec defines). Returns the mxc URI. */
  async uploadMedia(data: Uint8Array, mimeType: string, filename: string, signal: AbortSignal): Promise<string> {
    const r = await this.#request(
      "POST",
      `/_matrix/media/v3/upload?filename=${encodeURIComponent(filename)}`,
      { body: data, contentType: mimeType },
      signal,
      60_000,
      "upload",
    );
    const json = (await readJson(r)) as { content_uri?: unknown };
    if (!parseMxc(json.content_uri)) throw new MatrixApiError("protocol", "upload result lacks a valid content_uri");
    return json.content_uri as string;
  }

  /**
   * Downloads an `mxc://` URI from the configured homeserver only. Tries the authenticated media endpoint (v1, a
   * multipart/mixed response) first and falls back to the deprecated v3 endpoint when the server does not know v1.
   * Declared and streamed sizes are both bounded by `maxBytes`. Redirects are refused.
   */
  async downloadMedia(
    mxc: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<{ data: Uint8Array; mimeType: string }> {
    const parsed = parseMxc(mxc);
    if (!parsed) throw new MatrixApiError("protocol", "unsafe media reference");
    const seg = `${enc(parsed.server)}/${enc(parsed.mediaId)}`;
    let res: Response;
    try {
      res = await this.#download(`/_matrix/client/v1/media/download/${seg}`, maxBytes, signal);
    } catch (e) {
      if (!(e instanceof MatrixApiError) || (e.kind !== "not-found" && e.kind !== "bad-request")) throw e;
      res = await this.#download(`/_matrix/media/v3/download/${seg}`, maxBytes, signal);
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const boundary = /multipart\/mixed;.*boundary="?([^";]+)"?/i.exec(contentType)?.[1];
    if (boundary) {
      const body = await readBounded(res, maxBytes);
      // Part 0 is JSON metadata: a redirect (location) is refused, never followed. Part 1 is the media.
      const meta = multipartPart(body, boundary, 0);
      if (meta && meta.contentType === "application/json" && /"location"\s*:/.test(Buffer.from(meta.body).toString("utf8")))
        throw new MatrixApiError("protocol", "media redirect refused");
      const part = multipartPart(body, boundary, 1);
      if (!part) throw new MatrixApiError("protocol", "media response is malformed");
      if (part.body.length > maxBytes) throw new MatrixApiError("too-large", "media exceeds size limit");
      return { data: part.body, mimeType: mimeOf(part.contentType) };
    }
    return { data: await readBounded(res, maxBytes), mimeType: mimeOf(contentType) };
  }

  async #download(path: string, maxBytes: number, outer: AbortSignal): Promise<Response> {
    const r = await this.#request("GET", path, undefined, outer, 60_000, "download");
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes + 4096 && !r.headers.get("content-type")?.includes("multipart")) {
      await r.body?.cancel().catch(() => {});
      throw new MatrixApiError("too-large", "media exceeds size limit");
    }
    return r;
  }

  async #json<T>(
    method: string,
    path: string,
    body: unknown,
    outer: AbortSignal,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const r = await this.#request(
      method,
      path,
      body === undefined ? undefined : { json: body },
      outer,
      timeoutMs,
      label,
    );
    return (await readJson(r)) as T;
  }

  async #request(
    method: string,
    path: string,
    payload: { json: unknown } | { body: Uint8Array; contentType: string } | undefined,
    outer: AbortSignal,
    timeoutMs: number,
    label: string,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}` };
    let init: RequestInit = {};
    if (payload && "json" in payload) {
      headers["content-type"] = "application/json";
      init = { body: JSON.stringify(payload.json) };
    } else if (payload) {
      headers["content-type"] = payload.contentType;
      init = { body: payload.body as BodyInit };
    }
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.any([outer, timeout]),
      });
    } catch (err) {
      if (outer.aborted) throw new MatrixApiError("aborted", `${label} aborted`);
      if (timeout.aborted) throw new MatrixApiError("timeout", `${label} timed out`);
      const code = (err as { cause?: { code?: unknown } })?.cause?.code;
      throw new MatrixApiError(
        "network",
        `${label} network error${typeof code === "string" && /^[A-Z_]{2,40}$/.test(code) ? ` (${code})` : ""}`,
      );
    }
    if (res.ok) return res;
    throw await failure(res, label, this.#token);
  }
}

async function failure(res: Response, label: string, token: string): Promise<MatrixApiError> {
  let errcode: string | undefined;
  let retryAfterMs: number | undefined;
  try {
    const j = (await res.json()) as { errcode?: unknown; retry_after_ms?: unknown };
    if (typeof j.errcode === "string" && /^M_[A-Z_]{1,40}$/.test(j.errcode)) errcode = j.errcode;
    if (typeof j.retry_after_ms === "number") retryAfterMs = j.retry_after_ms;
  } catch {
    /* Body is not JSON: fixed text below. */
  }
  void token;
  const status = res.status;
  const header = Number(res.headers.get("retry-after"));
  if (status === 429 || errcode === "M_LIMIT_EXCEEDED") {
    const ms = retryAfterMs ?? (Number.isFinite(header) ? header * 1000 : undefined);
    return new MatrixApiError("rate-limited", `${label} rate limited`, {
      status,
      retryAfterMs: clampRetryAfter(ms),
      ...(errcode ? { errcode } : {}),
    });
  }
  const kind: MatrixErrorKind =
    status === 401
      ? "unauthorized"
      : status === 403
        ? "forbidden"
        : status === 404
          ? "not-found"
          : status === 400
            ? "bad-request"
            : status === 413
              ? "too-large"
              : "http";
  return new MatrixApiError(kind, `${label} failed with HTTP ${status}`, {
    status,
    ...(errcode ? { errcode } : {}),
  });
}

async function readJson(res: Response): Promise<unknown> {
  const bytes = await readBounded(res, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new MatrixApiError("protocol", "homeserver returned invalid JSON");
  }
}

/** Reads a body, refusing anything over `max` bytes as it streams. */
export async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.length;
      if (size > max) throw new MatrixApiError("too-large", "response exceeds size limit");
      parts.push(r.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** The n-th (0-based) part of a multipart/mixed body, with its content type. */
export function multipartPart(
  body: Uint8Array,
  boundary: string,
  index: number,
): { contentType: string; body: Uint8Array } | undefined {
  const text = Buffer.from(body);
  const delim = Buffer.from(`--${boundary}`);
  const starts: number[] = [];
  let at = text.indexOf(delim);
  while (at >= 0) {
    starts.push(at);
    at = text.indexOf(delim, at + delim.length);
  }
  const start = starts[index];
  const next = starts[index + 1];
  if (start === undefined || next === undefined) return undefined;
  let p = start + delim.length;
  if (text[p] === 0x0d) p += 2; // CRLF after the delimiter
  const headerEnd = text.indexOf("\r\n\r\n", p);
  if (headerEnd < 0 || headerEnd > next) return undefined;
  const headers = text.subarray(p, headerEnd).toString("utf8");
  const ct = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim().toLowerCase() ?? "application/octet-stream";
  let end = next;
  if (text[end - 2] === 0x0d && text[end - 1] === 0x0a) end -= 2;
  return { contentType: ct, body: new Uint8Array(text.subarray(headerEnd + 4, end)) };
}

function mimeOf(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase() || "application/octet-stream";
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Exported for the channel's log lines: strips anything token-shaped from a free-form string. */
export const scrub = redactString;

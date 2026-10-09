import { redactString } from "./redact.ts";
import { RestLimiter, routeKey, type Sleep } from "./rate-limit.ts";

export type DiscordErrorKind =
  | "bad-request"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "unauthorized"
  | "http"
  | "network"
  | "timeout"
  | "aborted"
  | "protocol";

/** Built from fixed text plus a redacted Discord `message`; never carries the request URL or headers. */
export class DiscordApiError extends Error {
  readonly kind: DiscordErrorKind;
  readonly status?: number;
  readonly code?: number;
  readonly retryAfterMs?: number;
  constructor(kind: DiscordErrorKind, message: string, extra: { status?: number; code?: number; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "DiscordApiError";
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
  }
}

export const DEFAULT_BASE_URL = "https://discord.com/api/v10";
export const DEFAULT_CDN_HOSTS: readonly string[] = ["cdn.discordapp.com", "media.discordapp.net"];
export const MIN_RETRY_MS = 1000;
export const MAX_RETRY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

export interface ApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep: Sleep;
  random?: () => number;
  now: () => number;
  maxRetries?: number;
  cdnHosts?: readonly string[];
}
export interface RequestSpec {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  json?: unknown;
  form?: FormData;
  signal: AbortSignal;
  /** Interaction and webhook routes carry their own token in the URL, take no bot auth and are exempt from the global limit. */
  tokenRoute?: boolean;
}

export function clampRetryMs(seconds: unknown): number {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  const ms = Number.isFinite(n) ? n * 1000 : MIN_RETRY_MS;
  return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, Math.ceil(ms)));
}

export class DiscordApi {
  readonly #o: ApiOptions;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly limiter: RestLimiter;
  constructor(o: ApiOptions) {
    this.#o = o;
    this.#base = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#fetch = o.fetch ?? fetch;
    this.limiter = new RestLimiter(o.now, o.sleep);
  }

  async request<T = unknown>(spec: RequestSpec): Promise<T> {
    const route = routeKey(spec.method, spec.path);
    const max = this.#o.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      if (spec.signal.aborted) throw new DiscordApiError("aborted", "discord request aborted");
      try {
        await this.limiter.acquire(route, spec.signal, !spec.tokenRoute);
      } catch {
        throw new DiscordApiError("aborted", "discord request aborted");
      }
      let res: Response;
      try {
        res = await this.#send(spec);
      } catch (e) {
        this.limiter.release(route);
        if (spec.signal.aborted) throw new DiscordApiError("aborted", "discord request aborted");
        const err = e instanceof DiscordApiError ? e : new DiscordApiError("network", "discord network failure");
        if (attempt >= max) throw err;
        await this.#backoff(attempt, spec.signal);
        continue;
      }
      this.limiter.update(route, res.headers);
      if (res.ok) return (await this.#parse(res)) as T;
      const body = await this.#errorBody(res);
      if (res.status === 429) {
        const retryMs = clampRetryMs(body.retry_after ?? res.headers.get("retry-after"));
        const global = body.global === true || res.headers.get("x-ratelimit-global") === "true";
        this.limiter.penalize(route, retryMs, global);
        if (attempt >= max) throw new DiscordApiError("rate-limited", "discord rate limit", { status: 429, retryAfterMs: retryMs });
        await this.#o.sleep(retryMs, spec.signal);
        continue;
      }
      if ([502, 503, 504].includes(res.status) && attempt < max) {
        await this.#backoff(attempt, spec.signal);
        continue;
      }
      throw this.#error(res.status, body);
    }
  }

  /** Download from the Discord CDN only: https, no credentials, default port, allow-listed host, no redirects, bounded size. */
  async download(rawUrl: string, maxBytes: number, signal: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new DiscordApiError("protocol", "invalid attachment url");
    }
    const hosts = this.#o.cdnHosts ?? DEFAULT_CDN_HOSTS;
    if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname))
      throw new DiscordApiError("protocol", "attachment host is not allowed");
    let res: Response;
    try {
      res = await this.#fetch(url, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) });
    } catch {
      throw new DiscordApiError(signal.aborted ? "aborted" : "network", "attachment download failed");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new DiscordApiError("http", "attachment download failed", { status: res.status });
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await res.body?.cancel().catch(() => {});
      throw new DiscordApiError("protocol", "attachment exceeds size limit");
    }
    const reader = res.body?.getReader();
    if (!reader) throw new DiscordApiError("protocol", "attachment has no body");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        size += r.value.length;
        if (size > maxBytes) throw new DiscordApiError("protocol", "attachment exceeds size limit");
        parts.push(r.value);
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e instanceof DiscordApiError ? e : new DiscordApiError(signal.aborted ? "aborted" : "network", "attachment download failed");
    }
    const mimeType = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
    return { data: Buffer.concat(parts), mimeType };
  }

  async #send(spec: RequestSpec): Promise<Response> {
    const headers: Record<string, string> = {};
    if (!spec.tokenRoute) headers.authorization = `Bot ${this.#o.token}`;
    let body: BodyInit | undefined;
    if (spec.form) body = spec.form;
    else if (spec.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(spec.json);
    }
    try {
      return await this.#fetch(`${this.#base}${spec.path}`, {
        method: spec.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "manual",
        signal: AbortSignal.any([spec.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (e) {
      if (spec.signal.aborted) throw new DiscordApiError("aborted", "discord request aborted");
      if (e instanceof Error && e.name === "TimeoutError") throw new DiscordApiError("timeout", "discord request timed out");
      throw new DiscordApiError("network", "discord network failure");
    }
  }
  async #parse(res: Response): Promise<unknown> {
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new DiscordApiError("protocol", "discord returned invalid json", { status: res.status });
    }
  }
  async #errorBody(res: Response): Promise<{ message?: string; code?: number; retry_after?: unknown; global?: boolean }> {
    try {
      const v: unknown = JSON.parse(await res.text());
      return v && typeof v === "object" ? (v as Record<string, never>) : {};
    } catch {
      return {};
    }
  }
  #error(status: number, body: { message?: string; code?: number }): DiscordApiError {
    const kind: DiscordErrorKind =
      status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not-found" : status === 400 ? "bad-request" : "http";
    const detail = typeof body.message === "string" ? redactString(body.message, this.#o.token).slice(0, 200) : "";
    return new DiscordApiError(kind, `discord ${kind} (${status})${detail ? `: ${detail}` : ""}`, {
      status,
      ...(typeof body.code === "number" ? { code: body.code } : {}),
    });
  }
  async #backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const wait = Math.round(Math.min(60_000, 1000 * 2 ** attempt) * (0.75 + (this.#o.random ?? Math.random)() * 0.5));
    await this.#o.sleep(wait, signal);
  }
}

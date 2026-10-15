// HTTP helper: one place that maps statuses to the unified errors, honours Retry-After and AbortSignal, and never
// lets a credential into an error message. `sleep` is injected so retry tests run on fake timers.
import { VoiceProviderError, abortedError, errorFromStatus } from "./errors.ts";
import type { Logger } from "./types.ts";
import { assertSecureTransport } from "./util.ts";
import { realTimers, type WsTimers } from "./ws.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export interface HttpClientOptions {
  provider: string;
  fetch?: FetchLike;
  /** Secret values scrubbed from every error. */
  secrets?: readonly string[];
  /** Extra attempts after a 429 / 5xx / network failure. Default 2. */
  retries?: number;
  /** Cap on a server-supplied Retry-After wait. Default 30000. */
  maxRetryWaitMs?: number;
  sleep?: Sleep;
  now?: () => number;
  /** How long the server may take to answer with headers before the attempt fails with `timeout` (retryable). The body is not covered, so a long audio stream is not cut. 0 turns it off. Default 30000. */
  headersTimeoutMs?: number;
  /** Test seam for the headers deadline. */
  timers?: WsTimers;
  /** Receives host, path (never the query string) and status; nothing else about the request. */
  logger?: Logger;
}

export class HttpClient {
  readonly provider: string;
  private readonly fetchFn: FetchLike;
  private readonly secrets: readonly string[];
  private readonly retries: number;
  private readonly maxWait: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly logger: Logger | undefined;
  private readonly headersTimeoutMs: number;
  private readonly timers: WsTimers;

  constructor(o: HttpClientOptions) {
    this.provider = o.provider;
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
    this.secrets = o.secrets ?? [];
    this.retries = o.retries ?? 2;
    this.maxWait = o.maxRetryWaitMs ?? 30_000;
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? Date.now;
    this.logger = o.logger;
    this.headersTimeoutMs = o.headersTimeoutMs ?? 30_000;
    this.timers = o.timers ?? realTimers;
  }

  /** Returns an ok Response (body unread) or throws VoiceProviderError. */
  async request(url: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
    assertSecureTransport(url, this.provider);
    const signal = init.signal ?? undefined;
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw abortedError(this.provider);
      let res: Response;
      // The deadline covers the time until the response headers; it aborts a private controller, never the caller's signal.
      const deadline = new AbortController();
      let timedOut = false;
      const timer = this.headersTimeoutMs > 0 ? this.timers.setTimeout(() => { timedOut = true; deadline.abort(); }, this.headersTimeoutMs) : undefined;
      try {
        res = await this.fetchFn(url, { ...init, signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal, redirect: "error" });
      } catch (e) {
        if (signal?.aborted) throw abortedError(this.provider);
        const err = timedOut
          ? new VoiceProviderError("timeout", `${this.provider}: no response within ${this.headersTimeoutMs} ms`, { provider: this.provider })
          : new VoiceProviderError("network", `${this.provider}: request failed (${e instanceof Error ? e.name : "error"})`, { provider: this.provider, secrets: this.secrets });
        if (attempt < this.retries) { attempt++; await this.wait(Math.min(250 * 2 ** attempt, this.maxWait), signal); continue; }
        throw err;
      } finally {
        if (timer !== undefined) this.timers.clearTimeout(timer);
      }
      this.logger?.debug("voice http", { provider: this.provider, host: new URL(url).host, path: new URL(url).pathname, status: res.status, attempt });
      if (res.ok) return res;
      // The body is never read into the error: vendor text stays out of messages (docs/errors.md).
      await res.body?.cancel().catch(() => {});
      const err = errorFromStatus(res.status, this.provider, "", res.headers.get("retry-after"), this.secrets, this.now);
      if (err.retryable && attempt < this.retries) {
        attempt++;
        await this.wait(Math.min(err.retryAfterMs ?? 250 * 2 ** attempt, this.maxWait), signal);
        continue;
      }
      throw err;
    }
  }

  async json<T = unknown>(url: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<T> {
    const res = await this.request(url, init);
    try {
      return (await res.json()) as T;
    } catch {
      throw new VoiceProviderError("bad_response", `${this.provider}: response is not JSON`, { provider: this.provider });
    }
  }

  private async wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
    try {
      await this.sleep(ms, signal);
    } catch {
      throw abortedError(this.provider);
    }
  }
}

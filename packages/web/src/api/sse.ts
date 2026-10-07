// SSE over fetch: EventSource cannot be aborted cleanly, cannot send headers and hides the HTTP status, so the stream is
// read by hand. The parser follows the WHATWG "Server-sent events" processing rules.
import { signal, type ReadonlySignal } from "@preact/signals";
import { API_ROUTES } from "./routes.ts";
import { ForbiddenError, UnauthenticatedError, UnavailableError, type ApiError } from "./errors.ts";

export type SseEvent = { event: string; data: string; id?: string };

export class SseParser {
  /** The last `id:` seen (it persists across events and, via the constructor, across reconnects). */
  lastEventId: string | undefined;
  /** The last `retry:` hint in milliseconds. */
  retry: number | undefined;
  #buf = "";
  #started = false;
  #data: string[] = [];
  #type = "";

  constructor(lastEventId?: string) { this.lastEventId = lastEventId; }

  push(chunk: string): SseEvent[] {
    if (!this.#started && chunk !== "") { this.#started = true; if (chunk.startsWith("﻿")) chunk = chunk.slice(1); }
    this.#buf += chunk;
    const out: SseEvent[] = [];
    let i = 0;
    for (;;) {
      const cr = this.#buf.indexOf("\r", i);
      const lf = this.#buf.indexOf("\n", i);
      const end = cr === -1 ? lf : lf === -1 ? cr : Math.min(cr, lf);
      if (end === -1) break;
      // A CR at the very end may be the first half of CRLF: wait for the next chunk.
      if (this.#buf[end] === "\r" && end === this.#buf.length - 1) break;
      const line = this.#buf.slice(i, end);
      i = this.#buf[end] === "\r" && this.#buf[end + 1] === "\n" ? end + 2 : end + 1;
      this.#line(line, out);
    }
    this.#buf = this.#buf.slice(i);
    return out;
  }

  #line(line: string, out: SseEvent[]): void {
    if (line === "") {
      if (this.#data.length > 0) {
        out.push({ event: this.#type === "" ? "message" : this.#type, data: this.#data.join("\n"), ...(this.lastEventId === undefined ? {} : { id: this.lastEventId }) });
      }
      this.#data = []; this.#type = "";
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event": this.#type = value; break;
      case "data": this.#data.push(value); break;
      case "id": if (!value.includes("\u0000")) this.lastEventId = value; break;
      case "retry": if (/^\d+$/.test(value)) this.retry = Number(value); break;
      default: break;
    }
  }
}

export type Backoff = { baseMs: number; maxMs: number };
export const DEFAULT_BACKOFF: Backoff = { baseMs: 500, maxMs: 30_000 };

/** Exponential backoff for retry number `attempt` (0-based), capped, with jitter between half and the full delay. */
export function backoffDelay(attempt: number, b: Backoff, random: () => number): number {
  return Math.floor(Math.min(b.maxMs, b.baseMs * 2 ** attempt) * (0.5 + 0.5 * random()));
}

export type EventsStatus = "connecting" | "open" | "retrying" | "closed" | "unavailable";

export interface EventsOptions {
  /** Called for every event; an exception thrown here is swallowed so one bad handler cannot end the stream. */
  onEvent: (event: SseEvent) => void;
  /** Aborting ends the stream for good (no reconnect). */
  signal?: AbortSignal;
  /** Resume point for the first connection (sent as Last-Event-ID). */
  lastEventId?: string;
  backoff?: Backoff;
}

export interface EventsHandle {
  /** connecting -> open -> retrying -> open ...; `closed` after close()/abort or a 401/403; `unavailable` when the route is absent. */
  readonly status: ReadonlySignal<EventsStatus>;
  /** Settles (never rejects) when the stream ended for good: null after close()/abort, else the reason. */
  readonly done: Promise<ApiError | null>;
  close(): void;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export const defaultSleep: Sleep = (ms, signal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

export type EventsDeps = { fetch: typeof fetch; baseUrl: string; sleep: Sleep; random: () => number; notify: (e: ApiError) => void };

export function openEventStream(deps: EventsDeps, opts: EventsOptions): EventsHandle {
  const ctl = new AbortController();
  const status = signal<EventsStatus>("connecting");
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  if (opts.signal?.aborted) ctl.abort();
  else opts.signal?.addEventListener("abort", () => { ctl.abort(); }, { once: true });

  const run = async (): Promise<ApiError | null> => {
    let attempt = 0;
    let lastId = opts.lastEventId;
    const terminal = (e: ApiError, s: EventsStatus): ApiError => { status.value = s; deps.notify(e); return e; };
    while (!ctl.signal.aborted) {
      let res: Response | undefined;
      try {
        res = await deps.fetch(deps.baseUrl + API_ROUTES.events, {
          credentials: "same-origin", signal: ctl.signal,
          headers: { accept: "text/event-stream", "cache-control": "no-cache", ...(lastId === undefined ? {} : { "last-event-id": lastId }) },
        });
      } catch { res = undefined; }
      if (ctl.signal.aborted) break;
      if (res) {
        if (res.status === 401) return terminal(new UnauthenticatedError(), "closed");
        if (res.status === 403) return terminal(new ForbiddenError("the event stream is forbidden"), "closed");
        if (res.status === 404 || res.status === 405 || res.status === 501) {
          return terminal(new UnavailableError(`no event stream (${res.status})`, `http-${res.status}`, { status: res.status }), "unavailable");
        }
        if (res.ok && !/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
          return terminal(new UnavailableError("the event stream answered with another content type", "bad-content-type", { status: res.status }), "unavailable");
        }
        if (res.ok && res.body) {
          status.value = "open";
          attempt = 0;
          const parser = new SseParser(lastId);
          const decoder = new TextDecoder();
          const reader = res.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
                lastId = parser.lastEventId;
                try { opts.onEvent(ev); } catch { /* a handler's bug must not end the stream */ }
              }
            }
          } catch { /* a cut connection and an abort both end here */ }
          void reader.cancel().catch(() => {});
          if (ctl.signal.aborted) break;
        } else {
          void res.body?.cancel().catch(() => {});
        }
      }
      status.value = "retrying";
      await deps.sleep(backoffDelay(attempt++, backoff, deps.random), ctl.signal);
    }
    status.value = "closed";
    return null;
  };

  const done = run().catch((): ApiError | null => { status.value = "closed"; return null; });
  return { status, done, close: () => { ctl.abort(); } };
}

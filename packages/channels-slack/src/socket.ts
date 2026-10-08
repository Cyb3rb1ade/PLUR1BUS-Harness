import { SlackApiError } from "./api.ts";

/** The part of a WebSocket client we use. Node's global WebSocket satisfies it; tests inject an in-process fake. */
export interface SocketLike {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: { data?: unknown }) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string) => SocketLike;
export type SocketEnvelope = {
  type?: unknown;
  envelope_id?: unknown;
  reason?: unknown;
  payload?: unknown;
  retry_attempt?: unknown;
  [k: string]: unknown;
};

export interface SocketModeOptions {
  /** apps.connections.open, with the app-level token. Returns the wss URL (it carries a ticket: never log it). */
  openUrl: (signal: AbortSignal) => Promise<string>;
  socketFactory: SocketFactory;
  /** Called after the envelope was acknowledged. Must enqueue synchronously and never throw. */
  onEnvelope: (env: SocketEnvelope) => void;
  onFatal: (err: SocketFatalError) => void;
  onState: (connected: boolean) => void;
  log: (level: "debug" | "info" | "warn" | "error", event: string, attrs: Record<string, string | number | boolean>) => void;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
  now: () => number;
  helloTimeoutMs?: number;
}

/** Credentials or app configuration are wrong; retrying cannot help. */
export class SocketFatalError extends Error {
  readonly code: string;
  constructor(code: string) {
    super("slack socket authentication failed");
    this.name = "SocketFatalError";
    this.code = code;
  }
}

export const FATAL_CODES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
  "token_expired",
  "invalid_token",
  "not_allowed_token_type",
  "missing_scope",
  "link_disabled",
]);

const ENVELOPE_MEMORY = 2048;
const ENVELOPE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const LONG_LIVED_MS = 30_000;

type Outcome = { kind: "closed" } | { kind: "refresh" } | { kind: "fatal"; code: string };
interface Conn {
  readonly ws: SocketLike;
  readonly closed: Promise<Outcome>;
  up: number;
  close(): void;
}
type Attempt = Conn | { retryMs: number };

/** Socket Mode client: hello, envelope ack (before processing), disconnect/refresh, dedupe by envelope_id, backoff with jitter. */
export class SocketMode {
  readonly #o: SocketModeOptions;
  readonly #seen = new Set<string>();
  readonly #order: string[] = [];
  #conn: Conn | undefined;
  #loop: Promise<void> | undefined;
  #connected = false;

  constructor(o: SocketModeOptions) {
    this.#o = o;
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Resolves after the first attempt. Fatal errors reject; retryable failures keep retrying in the background. */
  async start(signal: AbortSignal): Promise<void> {
    const first = await this.#attempt(signal);
    if ("retryMs" in first) {
      this.#loop = this.#supervise(signal, undefined, 1, first.retryMs);
      return;
    }
    this.#conn = first;
    this.#loop = this.#supervise(signal, first, 0, 0);
  }

  async stop(): Promise<void> {
    this.#conn?.close();
    this.#conn = undefined;
    if (this.#connected) {
      this.#connected = false;
      this.#o.onState(false);
    }
    await this.#loop?.catch(() => {});
    this.#loop = undefined;
  }

  async #supervise(signal: AbortSignal, first: Conn | undefined, start: number, hint0: number): Promise<void> {
    let conn = first;
    let attempt = start;
    let hint = hint0;
    for (;;) {
      if (signal.aborted) return;
      if (!conn) {
        await this.#wait(attempt, hint, signal);
        if (signal.aborted) return;
        let r: Attempt;
        try {
          r = await this.#attempt(signal);
        } catch (e) {
          if (e instanceof SocketFatalError) return this.#fatal(e);
          throw e;
        }
        if ("retryMs" in r) {
          attempt++;
          hint = r.retryMs;
          continue;
        }
        conn = r;
        this.#conn = r;
        hint = 0;
      }
      const out = await conn.closed;
      if (signal.aborted) return;
      if (out.kind === "fatal") return this.#fatal(new SocketFatalError(out.code));
      if (out.kind === "refresh") {
        // Overlap: the replacement is established (and adopted on hello) before the old socket is closed.
        let r: Attempt;
        try {
          r = await this.#attempt(signal);
        } catch (e) {
          if (e instanceof SocketFatalError) return this.#fatal(e);
          throw e;
        }
        if ("retryMs" in r) {
          conn.close();
          conn = undefined;
          this.#conn = undefined;
          attempt++;
          hint = r.retryMs;
          continue;
        }
        const old = conn;
        conn = r;
        this.#conn = r;
        old.close();
        continue;
      }
      conn.close();
      this.#connected = false;
      this.#o.onState(false);
      attempt = this.#o.now() - conn.up >= LONG_LIVED_MS ? 1 : attempt + 1;
      hint = 0;
      conn = undefined;
      this.#conn = undefined;
    }
  }

  async #attempt(signal: AbortSignal): Promise<Attempt> {
    let url: string;
    try {
      url = await this.#o.openUrl(signal);
    } catch (e) {
      if (signal.aborted) return { retryMs: 0 };
      if (e instanceof SlackApiError) {
        if (e.kind === "unauthorized" || (e.code !== undefined && FATAL_CODES.has(e.code)))
          throw new SocketFatalError(e.code ?? e.kind);
        if (e.kind === "rate-limited") return { retryMs: e.retryAfterMs ?? 0 };
      }
      this.#o.log("warn", "channel.slack.connect-failed", { kind: e instanceof SlackApiError ? e.kind : "unknown" });
      return { retryMs: 0 };
    }
    return this.#open(url, signal);
  }

  #open(url: string, signal: AbortSignal): Promise<Attempt> {
    return new Promise<Attempt>((resolve) => {
      const ws = this.#o.socketFactory(url);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let resolveClosed!: (o: Outcome) => void;
      const closed = new Promise<Outcome>((r) => (resolveClosed = r));
      const conn: Conn = {
        ws,
        closed,
        up: 0,
        close: () => {
          try {
            ws.close(1000, "closing");
          } catch {
            /* already closed */
          }
        },
      };
      const giveUp = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.close();
        resolve({ retryMs: 0 });
      };
      timer = setTimeout(giveUp, this.#o.helloTimeoutMs ?? 10_000);
      signal.addEventListener(
        "abort",
        () => {
          resolveClosed({ kind: "closed" });
          giveUp();
          conn.close();
        },
        { once: true },
      );
      ws.addEventListener("message", (ev) => {
        const env = parseEnvelope(ev.data);
        if (!env) {
          this.#o.log("debug", "channel.slack.frame-ignored", {});
          return;
        }
        if (env.type === "hello") {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          conn.up = this.#o.now();
          this.#connected = true;
          this.#o.onState(true);
          this.#o.log("info", "channel.slack.connected", {});
          resolve(conn);
          return;
        }
        if (env.type === "disconnect") {
          const reason = typeof env.reason === "string" ? env.reason : "";
          this.#o.log("info", "channel.slack.disconnect-received", { reason: reason.slice(0, 40) });
          resolveClosed(
            reason === "refresh_requested" || reason === "warning"
              ? { kind: "refresh" }
              : reason === "link_disabled"
                ? { kind: "fatal", code: "link_disabled" }
                : { kind: "closed" },
          );
          return;
        }
        if (!settled) return;
        this.#envelope(env, ws);
      });
      ws.addEventListener("close", () => {
        resolveClosed({ kind: "closed" });
        giveUp();
      });
      ws.addEventListener("error", () => {
        resolveClosed({ kind: "closed" });
        giveUp();
      });
    });
  }

  #envelope(env: SocketEnvelope, ws: SocketLike): void {
    const id = env.envelope_id;
    if (typeof id !== "string" || !ENVELOPE_ID.test(id)) {
      this.#o.log("debug", "channel.slack.envelope-ignored", {});
      return;
    }
    // Acknowledge first: Slack redelivers any envelope whose ack is late.
    try {
      ws.send(JSON.stringify({ envelope_id: id }));
    } catch {
      this.#o.log("warn", "channel.slack.ack-failed", {});
    }
    if (this.#seen.has(id)) {
      this.#o.log("debug", "channel.slack.envelope-duplicate", {});
      return;
    }
    this.#seen.add(id);
    this.#order.push(id);
    if (this.#order.length > ENVELOPE_MEMORY) this.#seen.delete(this.#order.shift()!);
    this.#o.onEnvelope(env);
  }

  #fatal(err: SocketFatalError): void {
    this.#connected = false;
    this.#o.onState(false);
    this.#conn?.close();
    this.#conn = undefined;
    this.#o.onFatal(err);
  }

  async #wait(attempt: number, hint: number, signal: AbortSignal): Promise<void> {
    const base = Math.min(60_000, 1000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 16));
    const delay = Math.round(Math.max(hint, base * (0.75 + this.#o.random() * 0.5)));
    await this.#o.sleep(delay, signal);
  }
}

function parseEnvelope(data: unknown): SocketEnvelope | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const v = JSON.parse(data) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SocketEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

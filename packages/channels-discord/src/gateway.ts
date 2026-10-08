import { isGatewayUrl } from "./state.ts";
import type { GatewaySession, LogLevel, WebSocketFactory, WebSocketLike } from "./port.ts";
import type { Sleep } from "./rate-limit.ts";

export const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg";
/** 4004 auth failed, 4010 invalid shard, 4011 sharding required, 4012 invalid API version, 4013 invalid intents, 4014 disallowed intents. */
export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** 4007 invalid seq, 4009 session timed out: the session is gone, identify afresh. */
const SESSION_LOST_CLOSE_CODES: ReadonlySet<number> = new Set([4007, 4009]);
const MAX_FRAME_CHARS = 4 * 1024 * 1024;
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, ACK: 11 } as const;

export interface ReadyInfo {
  botId: string;
  applicationId?: string;
  sessionId: string;
  resumeGatewayUrl?: string;
}
export interface GatewayOptions {
  token: string;
  intents: number;
  /** Where to dial for a fresh identify. */
  url: string;
  webSocket: WebSocketFactory;
  signal: AbortSignal;
  sleep: Sleep;
  random: () => number;
  now: () => number;
  /** Session to resume (in-process or restored from the state store). */
  session?: GatewaySession | undefined;
  botId: string;
  onReady(info: ReadyInfo, resumed: boolean): void;
  onDispatch(name: string, data: unknown): void;
  onConnection(up: boolean): void;
  /** Persist/forget resume state. `undefined` = the session is gone. */
  onSession(session: GatewaySession | undefined): void;
  onFatal(closeCode: number): void;
  /** A connection attempt ended and a retry is about to be scheduled. */
  onRetry?(): void;
  log(level: LogLevel, event: string, attrs: Record<string, string | number | boolean>): void;
  helloTimeoutMs?: number;
  maxBackoffMs?: number;
}

interface Outcome {
  code: number;
  reachedReady: boolean;
  reason: "close" | "reconnect" | "invalid-session" | "zombie" | "hello-timeout" | "connect-failed";
  durationMs: number;
}

/** A lean gateway v10 client (JSON encoding, no compression, single shard): Hello -> Identify/Resume, heartbeats with jitter and
 *  ACK tracking, Reconnect/Invalid Session handling and close-code policy. `run()` returns when stopped or after a fatal close. */
export class Gateway {
  readonly #o: GatewayOptions;
  #session: GatewaySession | undefined;
  #seq: number | null = null;
  constructor(o: GatewayOptions) {
    this.#o = o;
    this.#session = o.session;
    this.#seq = o.session ? o.session.seq : null;
  }
  get session(): GatewaySession | undefined {
    return this.#session ? { ...this.#session, seq: this.#seq ?? this.#session.seq } : undefined;
  }

  async run(): Promise<void> {
    const o = this.#o;
    let failures = 0;
    try {
      while (!o.signal.aborted) {
        const outcome = await this.#connect();
        if (o.signal.aborted) break;
        if (FATAL_CLOSE_CODES.has(outcome.code)) {
          o.log("error", "channel.discord.gateway-fatal", { closeCode: outcome.code });
          this.#forget();
          o.onFatal(outcome.code);
          return;
        }
        if (SESSION_LOST_CLOSE_CODES.has(outcome.code)) this.#forget();
        const stable = outcome.reachedReady && outcome.durationMs >= 5000;
        if (stable) failures = 0;
        else failures += 1;
        let wait: number;
        if (outcome.reason === "invalid-session") wait = 1000 + Math.floor(o.random() * 4000);
        else if (stable && (outcome.reason === "reconnect" || outcome.reason === "zombie")) wait = 0;
        else {
          const base = Math.min(o.maxBackoffMs ?? 60_000, 1000 * 2 ** Math.min(failures - 1, 10));
          wait = Math.round(base * (0.75 + o.random() * 0.5));
          if (outcome.code === 4008) wait = Math.max(wait, 5000);
        }
        o.log("warn", "channel.discord.gateway-reconnect", { closeCode: outcome.code, reason: outcome.reason, waitMs: wait, resume: this.#session !== undefined });
        o.onRetry?.();
        if (wait > 0) await o.sleep(wait, o.signal);
      }
    } finally {
      o.onConnection(false);
      const s = this.session;
      if (s) o.onSession(s);
    }
  }

  #forget(): void {
    this.#session = undefined;
    this.#seq = null;
    this.#o.onSession(undefined);
  }

  #connect(): Promise<Outcome> {
    const o = this.#o;
    const startedAt = o.now();
    const resumeUrl = this.#session && isGatewayUrl(this.#session.resumeGatewayUrl) ? this.#session.resumeGatewayUrl : undefined;
    const url = `${(resumeUrl ?? o.url).replace(/\/+$/, "")}/?v=10&encoding=json`;
    return new Promise<Outcome>((resolve) => {
      const conn = new AbortController();
      // Stopping closes the socket so the close event settles this attempt; the loop then sees the abort and exits.
      // 4000 (not 1000/1001, which invalidate the session on Discord) keeps the session resumable for a restart.
      let socket: WebSocketLike | undefined;
      const onStop = () => {
        if (finished) return;
        try {
          socket?.close(4000, "stop");
        } catch {
          /* already closed */
        }
        finish(4000);
      };
      o.signal.addEventListener("abort", onStop, { once: true });
      let reachedReady = false;
      let reason: Outcome["reason"] = "close";
      let acked = true;
      let finished = false;
      const finish = (code: number) => {
        if (finished) return;
        finished = true;
        conn.abort();
        o.signal.removeEventListener("abort", onStop);
        if (reachedReady) o.onConnection(false);
        resolve({ code, reachedReady, reason, durationMs: o.now() - startedAt });
      };
      const closeSocket = (code: number, why: Outcome["reason"]) => {
        if (reason === "close" || why === "invalid-session") reason = why;
        try {
          ws.close(code, why);
        } catch {
          finish(code);
        }
      };
      let ws: WebSocketLike;
      try {
        ws = o.webSocket(url);
      } catch {
        reason = "connect-failed";
        finish(1006);
        return;
      }
      socket = ws;
      const send = (frame: unknown) => {
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          /* The close event follows. */
        }
      };
      const heartbeat = () => send({ op: OP.HEARTBEAT, d: this.#seq });
      const beat = async (interval: number) => {
        await o.sleep(Math.floor(interval * o.random()), conn.signal);
        while (!conn.signal.aborted) {
          if (!acked) {
            closeSocket(4000, "zombie");
            return;
          }
          acked = false;
          heartbeat();
          await o.sleep(interval, conn.signal);
        }
      };
      ws.onopen = () => {
        void o.sleep(o.helloTimeoutMs ?? 20_000, conn.signal).then(() => {
          if (!conn.signal.aborted && !gotHello) closeSocket(4000, "hello-timeout");
        });
      };
      let gotHello = false;
      ws.onerror = () => {
        /* Details can carry the URL; the close event decides what happens next. */
      };
      ws.onclose = (ev) => {
        if (!gotHello && reason === "close") reason = "connect-failed";
        finish(typeof ev?.code === "number" ? ev.code : 1006);
      };
      ws.onmessage = (ev) => {
        const raw = ev.data;
        if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) return;
        let f: { op?: unknown; d?: unknown; s?: unknown; t?: unknown };
        try {
          f = JSON.parse(raw) as typeof f;
        } catch {
          return;
        }
        if (typeof f.s === "number") this.#seq = f.s;
        switch (f.op) {
          case OP.HELLO: {
            const interval = (f.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval;
            if (gotHello || typeof interval !== "number" || !(interval >= 1000 && interval <= 600_000)) {
              closeSocket(4000, "close");
              return;
            }
            gotHello = true;
            void beat(interval);
            if (this.#session)
              send({ op: OP.RESUME, d: { token: o.token, session_id: this.#session.sessionId, seq: this.#seq ?? this.#session.seq } });
            else
              send({
                op: OP.IDENTIFY,
                d: { token: o.token, intents: o.intents, properties: { os: process.platform, browser: "plur1bus", device: "plur1bus" } },
              });
            return;
          }
          case OP.ACK:
            acked = true;
            return;
          case OP.HEARTBEAT:
            heartbeat();
            return;
          case OP.RECONNECT:
            closeSocket(4000, "reconnect");
            return;
          case OP.INVALID_SESSION:
            if (f.d !== true) this.#forget();
            closeSocket(4000, "invalid-session");
            return;
          case OP.DISPATCH:
            this.#dispatch(f.t, f.d, () => {
              reachedReady = true;
              o.onConnection(true);
            });
            return;
        }
      };
    });
  }

  #dispatch(t: unknown, d: unknown, ready: () => void): void {
    const o = this.#o;
    if (typeof t !== "string") return;
    if (t === "READY") {
      const r = d as { user?: { id?: unknown }; application?: { id?: unknown }; session_id?: unknown; resume_gateway_url?: unknown } | null;
      const botId = r?.user?.id;
      if (typeof botId !== "string" || typeof r?.session_id !== "string") return;
      const resumeUrl = isGatewayUrl(r.resume_gateway_url) ? r.resume_gateway_url : o.url;
      this.#session = { sessionId: r.session_id, seq: this.#seq ?? 0, resumeGatewayUrl: resumeUrl, botId };
      o.onSession(this.session);
      ready();
      o.onReady(
        {
          botId,
          sessionId: r.session_id,
          resumeGatewayUrl: resumeUrl,
          ...(typeof r.application?.id === "string" ? { applicationId: r.application.id } : {}),
        },
        false,
      );
      return;
    }
    if (t === "RESUMED") {
      ready();
      o.onReady({ botId: this.#session?.botId ?? o.botId, sessionId: this.#session?.sessionId ?? "" }, true);
      const s = this.session;
      if (s) o.onSession(s);
      return;
    }
    if (this.#session && this.#seq !== null && this.#seq % 50 === 0) o.onSession(this.session);
    o.onDispatch(t, d);
  }
}

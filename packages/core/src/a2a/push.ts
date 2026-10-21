// Push notifications (A2A 0.3 `tasks/pushNotificationConfig/*`). Delivery is HTTP POST of the Task object.
// URL admission (`decide`) and the POST itself both go through the egress service (`egress.request`, the POST-capable
// variant): this file opens no socket. Each redirect hop is re-checked with `decide` and sent with `egress.request`.
import { randomUUID } from "node:crypto";
import type { DryRun, Egress } from "../egress/service.ts";
import type { A2aPushConfig, A2aTask, A2aTaskPushConfig } from "./types.ts";

export interface PushScheduler { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface PushClock { now(): number }
export interface PushPostResult { status: number; location?: string }

export interface PushTransport {
  decide(url: string): Promise<DryRun>;
  /** POST `body` to `url`. Does not follow redirects. `address` / `family` are what `decide` vetted for this hop; the egress transport re-vets and pins on its own. */
  post(a: { url: string; address?: string; family?: 4 | 6; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<PushPostResult>;
}

const realTimers: PushScheduler = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export class PushError extends Error {
  readonly code: "not-supported" | "denied" | "not-found" | "invalid";
  constructor(code: PushError["code"], message: string) { super(message); this.name = "PushError"; this.code = code; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const REDIRECT = new Set([301, 302, 303, 307, 308]);
const PUSH_USER_AGENT = "PLUR1BUS-a2a-push";
/** The egress client's own bound on one POST; the dispatcher's `postTimeoutMs` (15 s by default) is the one that normally ends a delivery, so a larger value there is capped here. */
const PUSH_MAX_MS = 60_000;

export function parsePushConfig(raw: unknown): A2aPushConfig {
  if (!isObj(raw) || typeof raw.url !== "string" || raw.url.trim() === "") throw new PushError("invalid", "pushNotificationConfig.url is required");
  let url: URL;
  try { url = new URL(raw.url); } catch { throw new PushError("invalid", "pushNotificationConfig.url is not a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new PushError("invalid", "pushNotificationConfig.url must be http(s)");
  if (url.username !== "" || url.password !== "") throw new PushError("denied", "push URL must not embed credentials");
  const cfg: A2aPushConfig = { url: url.href };
  if (typeof raw.id === "string" && raw.id.length > 0) cfg.id = raw.id.slice(0, 128);
  if (typeof raw.token === "string" && raw.token.length > 0) cfg.token = raw.token.slice(0, 512);
  if (isObj(raw.authentication)) {
    const schemes = Array.isArray(raw.authentication.schemes) ? raw.authentication.schemes.filter((s): s is string => typeof s === "string") : [];
    if (schemes.length === 0) throw new PushError("invalid", "authentication.schemes is required");
    const auth: A2aPushConfig["authentication"] = { schemes };
    if (typeof raw.authentication.credentials === "string") auth.credentials = raw.authentication.credentials.slice(0, 2048);
    cfg.authentication = auth;
  }
  return cfg;
}

/** The one place the POST leaves the process: `egress.request` gates the URL, re-vets and pins the connect, caps the
 *  request and response, enforces the deadline and never follows a redirect that carries a body or caller headers (the 3xx
 *  comes back; `PushDispatcher` decides whether to follow it, hop by hop). Only status and `Location` are read: a
 *  receiver's response body is never downloaded, so a large answer cannot turn an accepted delivery into a retry. */
export function createEgressPushTransport(egress: Egress): PushTransport {
  return {
    decide: (url) => egress.decide(url),
    // `address` / `family` are what `decide` vetted for this hop. `egress.request` resolves and pins again inside the one
    // guarded client, so they are not used to connect.
    async post({ url, headers, body, signal }) {
      try { new URL(url); } catch { throw new PushError("invalid", "invalid push URL"); }
      try {
        const r = await egress.request(url, { userAgent: PUSH_USER_AGENT, method: "POST", headers, body, discardBody: true, timeoutMs: PUSH_MAX_MS, ...(signal ? { signal } : {}) });
        const location = typeof r.headers.location === "string" && r.headers.location !== "" ? r.headers.location : undefined;
        return { status: r.status, ...(location ? { location } : {}) };
      } catch (err) {
        // The dispatcher aborts a delivery that outlives its time limit; that is the cause, whatever the client reports.
        if (signal?.aborted) throw new Error("aborted");
        throw err;
      }
    },
  };
}

export interface PushDispatcherOptions {
  transport: PushTransport;
  scheduler: PushScheduler;
  clock: PushClock;
  maxAttempts: number;
  backoffMs: number;
  maxRedirects?: number;
  /** Per POST; a receiver that accepts the connection and never answers is abandoned after this. Default 15 s. */
  postTimeoutMs?: number;
  /** Timer for `postTimeoutMs`; separate from the backoff scheduler. Default: unref'd real timers. */
  timeoutScheduler?: PushScheduler;
}

export class PushDispatcher {
  readonly #o: PushDispatcherOptions;
  readonly #pending = new Set<Promise<void>>();
  constructor(o: PushDispatcherOptions) { this.#o = o; }

  /** Resolves once every in-flight delivery (including retries) has settled. */
  async idle(): Promise<void> { await Promise.allSettled([...this.#pending]); }

  async admit(url: string): Promise<DryRun> {
    const d = await this.#o.transport.decide(url);
    if (!d.allowed) throw new PushError("denied", `push URL refused (${d.reason})`);
    return d;
  }

  /** Fire-and-forget delivery with retry/backoff. Failures never fail the task. */
  deliver(cfg: A2aPushConfig, task: A2aTask): void {
    const p = this.#deliver(cfg, task).catch(() => {}).finally(() => { this.#pending.delete(p); });
    this.#pending.add(p);
  }

  async #deliver(cfg: A2aPushConfig, task: A2aTask): Promise<void> {
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    if (cfg.token) headers["x-a2a-notification-token"] = cfg.token;
    const schemes = cfg.authentication?.schemes ?? [];
    if (schemes.some((s) => s.toLowerCase() === "bearer") && cfg.authentication?.credentials) {
      headers.authorization = `Bearer ${cfg.authentication.credentials}`;
    }
    const body = JSON.stringify(task);
    const maxRedirects = this.#o.maxRedirects ?? 3;
    for (let attempt = 0; attempt < this.#o.maxAttempts; attempt++) {
      try {
        const outcome = await this.#postFollow(cfg.url, headers, body, maxRedirects);
        if (outcome === "done" || outcome === "final") return;
      } catch { /* retry */ }
      if (attempt + 1 >= this.#o.maxAttempts) return;
      const delay = this.#o.backoffMs * (2 ** attempt);
      await new Promise<void>((resolve) => { this.#o.scheduler.set(() => resolve(), delay); });
    }
  }

  /** "done": delivered. "final": a caller error (4xx other than 408/429), retrying cannot help. "retry": try again. */
  async #postFollow(url: string, headers: Record<string, string>, body: string, maxRedirects: number): Promise<"done" | "final" | "retry"> {
    let current = url;
    let sent = headers;
    for (let hops = 0; hops <= maxRedirects; hops++) {
      const d = await this.#o.transport.decide(current);
      if (!d.allowed) return "retry";
      const ac = new AbortController();
      const timeouts = this.#o.timeoutScheduler ?? realTimers;
      const timer = timeouts.set(() => ac.abort(new Error("push delivery timed out")), this.#o.postTimeoutMs ?? 15_000);
      let r: PushPostResult;
      try {
        r = await this.#o.transport.post({
          url: current, address: d.address, family: d.family, headers: sent, body, signal: ac.signal,
        });
      } finally { timeouts.clear(timer); }
      if (r.status >= 200 && r.status < 300) return "done";
      if (REDIRECT.has(r.status) && r.location) {
        let next: URL;
        try { next = new URL(r.location, current); } catch { return "retry"; }
        // The token and bearer credentials belong to the configured receiver, not to wherever it redirects to.
        if (next.origin !== new URL(current).origin) {
          sent = Object.fromEntries(Object.entries(sent).filter(([k]) => k !== "authorization" && k !== "x-a2a-notification-token"));
        }
        current = next.href;
        continue;
      }
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return "final"; // no retry on caller error
      return "retry";
    }
    return "retry";
  }
}

export function assignPushId(cfg: A2aPushConfig): A2aPushConfig {
  return { ...cfg, id: cfg.id ?? randomUUID() };
}

export function toTaskPush(taskId: string, cfg: A2aPushConfig): A2aTaskPushConfig {
  return { taskId, pushNotificationConfig: cfg };
}

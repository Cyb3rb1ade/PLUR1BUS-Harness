// Push notifications (A2A 0.3 `tasks/pushNotificationConfig/*`). Delivery is HTTP POST of the Task object.
// URL admission goes through egress (`decide`); the POST itself is in this file because `egress.request` is GET-only
// (web.fetch). Each redirect hop is re-checked with `decide` (SSRF, also after redirect).
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { DryRun, Egress } from "../egress/service.ts";
import type { A2aPushConfig, A2aTask, A2aTaskPushConfig } from "./types.ts";

export interface PushScheduler { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export interface PushClock { now(): number }
export interface PushPostResult { status: number; location?: string }

export interface PushTransport {
  decide(url: string): Promise<DryRun>;
  /** POST `body` to `url` (pinned to `address` when provided). Does not follow redirects. */
  post(a: { url: string; address?: string; family?: 4 | 6; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<PushPostResult>;
}

export class PushError extends Error {
  readonly code: "not-supported" | "denied" | "not-found" | "invalid";
  constructor(code: PushError["code"], message: string) { super(message); this.name = "PushError"; this.code = code; }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const REDIRECT = new Set([301, 302, 303, 307, 308]);

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

export function createEgressPushTransport(egress: Egress): PushTransport {
  return {
    decide: (url) => egress.decide(url),
    post({ url, address, family, headers, body, signal }) {
      return new Promise((resolve, reject) => {
        let target: URL;
        try { target = new URL(url); } catch { reject(new PushError("invalid", "invalid push URL")); return; }
        const secure = target.protocol === "https:";
        const hostname = target.hostname.startsWith("[") ? target.hostname.slice(1, -1) : target.hostname;
        const req = (secure ? https : http).request({
          host: address ?? hostname,
          port: target.port === "" ? (secure ? 443 : 80) : Number(target.port),
          path: `${target.pathname}${target.search}`,
          method: "POST",
          agent: false,
          servername: secure ? hostname : undefined,
          headers: { host: target.host, "content-length": Buffer.byteLength(body), ...headers },
          lookup: address
            ? ((_h: string, opts: { all?: boolean } | undefined, cb: (...args: unknown[]) => void) => {
              const fam = family ?? (address.includes(":") ? 6 : 4);
              if (typeof opts === "object" && opts?.all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family: fam }]);
              else (cb as (e: null, a: string, f: number) => void)(null, address, fam);
            }) as never
            : undefined,
        }, (res) => {
          const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
          res.resume();
          resolve({ status: res.statusCode ?? 0, ...(location ? { location } : {}) });
        });
        const onAbort = (): void => { req.destroy(); reject(new Error("aborted")); };
        if (signal?.aborted) { onAbort(); return; }
        signal?.addEventListener("abort", onAbort, { once: true });
        req.on("error", reject);
        req.on("close", () => signal?.removeEventListener("abort", onAbort));
        req.end(body);
      });
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
        const ok = await this.#postFollow(cfg.url, headers, body, maxRedirects);
        if (ok) return;
      } catch { /* retry */ }
      if (attempt + 1 >= this.#o.maxAttempts) return;
      const delay = this.#o.backoffMs * (2 ** attempt);
      await new Promise<void>((resolve) => { this.#o.scheduler.set(() => resolve(), delay); });
    }
  }

  async #postFollow(url: string, headers: Record<string, string>, body: string, maxRedirects: number): Promise<boolean> {
    let current = url;
    for (let hops = 0; hops <= maxRedirects; hops++) {
      const d = await this.#o.transport.decide(current);
      if (!d.allowed) return false;
      const r = await this.#o.transport.post({
        url: current, address: d.address, family: d.family, headers, body,
      });
      if (r.status >= 200 && r.status < 300) return true;
      if (REDIRECT.has(r.status) && r.location) {
        try { current = new URL(r.location, current).href; } catch { return false; }
        continue;
      }
      if (r.status >= 400 && r.status < 500) return false; // no retry on caller error
      return false;
    }
    return false;
  }
}

export function assignPushId(cfg: A2aPushConfig): A2aPushConfig {
  return { ...cfg, id: cfg.id ?? randomUUID() };
}

export function toTaskPush(taskId: string, cfg: A2aPushConfig): A2aTaskPushConfig {
  return { taskId, pushNotificationConfig: cfg };
}

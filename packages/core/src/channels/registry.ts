import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from "./backoff.ts";
import { withTimeout, type Clock, type Timer } from "./clock.ts";
import { validateChannelManifest, type ChannelManifest } from "./manifest.ts";
import type { ChannelRouter } from "./router.ts";
import type { Channel, ChannelFactory, ChannelHealth, ChannelHost, ChannelLogger, InboundMessage, OutboundMessage } from "./types.ts";

/** `misconfigured`: enabled, but it cannot start until the operator fixes the configuration (a missing secret, an invalid value). Nothing is retried. */
export type ChannelState = "stopped" | "waiting" | "starting" | "running" | "backoff" | "failed" | "misconfigured";

export interface ChannelStatus {
  name: string;
  version: string;
  state: ChannelState;
  /** Consecutive failed (re)starts since the last stable run. */
  attempts: number;
  lastError?: string;
  startedAt?: number;
  /** The adapter's last health answer while it runs (start, then every watch). */
  health?: ChannelHealth;
}

export interface RegistryOptions {
  clock: Clock;
  router: ChannelRouter;
  log: ChannelLogger;
  backoff?: BackoffPolicy;
  /** Deadline for one `start`/`stop`/`health`/`send` call of a channel. */
  callTimeoutMs?: number;
  healthIntervalMs?: number;
  /** A run this long counts as stable and resets the backoff. */
  stableAfterMs?: number;
  /** Applied to every error text before it is kept as `lastError` or logged (the host masks secret values here). */
  redact?: (text: string) => string;
}

interface Entry {
  manifest: ChannelManifest;
  factory: ChannelFactory;
  state: ChannelState;
  channel?: Channel;
  /** Bumped on every start/stop: callbacks and messages from an older generation are ignored. */
  gen: number;
  attempts: number;
  lastError?: string;
  startedAt?: number;
  health?: ChannelHealth;
  timers: Set<Timer>;
}

export class ChannelRegistry {
  readonly #o: Required<Omit<RegistryOptions, "router" | "clock" | "log" | "redact">> & Pick<RegistryOptions, "router" | "clock" | "log" | "redact">;
  readonly #entries = new Map<string, Entry>();

  constructor(o: RegistryOptions) {
    this.#o = { backoff: DEFAULT_BACKOFF, callTimeoutMs: 10_000, healthIntervalMs: 30_000, stableAfterMs: 60_000, ...o };
  }

  register(spec: { manifest: unknown; factory: ChannelFactory }): { ok: true } | { ok: false; errors: string[] } {
    const v = validateChannelManifest(spec.manifest);
    if (!v.ok) return v;
    if (this.#entries.has(v.manifest.name)) return { ok: false, errors: [`channel "${v.manifest.name}" is already registered`] };
    this.#entries.set(v.manifest.name, { manifest: v.manifest, factory: spec.factory, state: "stopped", gen: 0, attempts: 0, timers: new Set() });
    return { ok: true };
  }

  status(name: string): ChannelStatus | undefined {
    const e = this.#entries.get(name);
    return e && snapshot(e);
  }

  list(): ChannelStatus[] { return [...this.#entries.values()].map(snapshot); }

  #err(e: unknown): string { const t = errText(e); return this.#o.redact ? this.#o.redact(t) : t; }

  /** The validated manifest of a registered channel (read-only accessor for `channel.*`). */
  manifestOf(name: string): ChannelManifest | undefined { return this.#entries.get(name)?.manifest; }

  /**
   * One health probe of the running channel, bounded by the call timeout. A channel that is not up answers
   * `{ ok: false, detail: "not running" }`; an unknown name answers `undefined`. A failed probe never changes the
   * channel's state (the periodic watch owns restarts).
   */
  async probe(name: string): Promise<ChannelHealth | undefined> {
    const e = this.#entries.get(name);
    if (!e) return undefined;
    const ch = e.channel;
    if (!ch || e.state !== "running") return { ok: false, detail: "not running" };
    try {
      const h = await withTimeout(this.#o.clock, () => ch.health(), this.#o.callTimeoutMs, `${name}.health`);
      return h && typeof h.ok === "boolean" ? { ok: h.ok, ...(h.detail !== undefined ? { detail: String(h.detail) } : {}) } : { ok: false, detail: "malformed health answer" };
    } catch (err) {
      return { ok: false, detail: this.#err(err) };
    }
  }

  /** Deliver one outbound message through a running channel. `false` when the channel is unknown or not running; a send failure rejects. */
  async sendTo(name: string, msg: OutboundMessage): Promise<boolean> {
    const e = this.#entries.get(name);
    const ch = e?.channel;
    if (!e || !ch || e.state !== "running") return false;
    await withTimeout(this.#o.clock, () => ch.send(msg), this.#o.callTimeoutMs, `${name}.send`);
    return true;
  }

  /** Schedule a start (after the manifest's `startDelayMs`). Returns at once; never throws. */
  start(name: string): void {
    const e = this.#entries.get(name);
    if (!e || e.state !== "stopped" && e.state !== "failed" && e.state !== "misconfigured") return;
    e.gen++;
    e.attempts = 0;
    delete e.lastError;
    e.state = "waiting";
    this.#later(e, e.gen, e.manifest.startDelayMs, () => this.#attempt(e, e.gen));
  }

  /** Parks a channel that must not start (`reason` is shown as its last error). Only a stopped, failed or misconfigured channel can be parked. */
  markMisconfigured(name: string, reason: string): void {
    const e = this.#entries.get(name);
    if (!e || e.state !== "stopped" && e.state !== "failed" && e.state !== "misconfigured") return;
    e.gen++;
    this.#clearTimers(e);
    e.attempts = 0;
    e.state = "misconfigured";
    e.lastError = reason;
    delete e.startedAt;
    delete e.health;
  }

  startAll(): void { for (const n of this.#entries.keys()) this.start(n); }

  async stop(name: string): Promise<void> {
    const e = this.#entries.get(name);
    if (!e) return;
    e.gen++;
    this.#clearTimers(e);
    const ch = e.channel;
    delete e.channel;
    delete e.startedAt;
    delete e.health;
    if (e.state === "misconfigured") delete e.lastError; // a parked channel has nothing to report once it is switched off
    e.state = "stopped";
    if (ch) await this.#stopQuietly(ch, e.manifest.name);
  }

  async stopAll(): Promise<void> { await Promise.all([...this.#entries.keys()].map((n) => this.stop(n))); }

  // --- internals ---

  #later(e: Entry, gen: number, ms: number, fn: () => void): void {
    const t = this.#o.clock.setTimer(() => {
      e.timers.delete(t);
      if (e.gen === gen) fn();
    }, ms);
    e.timers.add(t);
  }

  #clearTimers(e: Entry): void {
    for (const t of e.timers) t.cancel();
    e.timers.clear();
  }

  async #attempt(e: Entry, gen: number): Promise<void> {
    const name = e.manifest.name;
    let ch: Channel;
    try {
      ch = e.factory(e.manifest);
      if (ch.name !== name) throw new Error(`channel reports name "${ch.name}", manifest says "${name}"`);
    } catch (err) {
      // A factory that cannot build its channel, or builds the wrong one, will not get better by retrying.
      this.#o.log.error("channel.factory.failed", { channel: name, error: this.#err(err) });
      e.lastError = this.#err(err);
      e.state = "failed";
      return;
    }
    e.channel = ch;
    e.state = "starting";
    try {
      await withTimeout(this.#o.clock, () => ch.start(this.#host(e, gen, ch)), this.#o.callTimeoutMs, `${name}.start`);
    } catch (err) {
      return this.#crashed(e, gen, err);
    }
    if (e.gen !== gen) return;
    e.state = "running";
    e.startedAt = this.#o.clock.now();
    e.health = { ok: true };
    this.#o.log.info("channel.started", { channel: name });
    this.#later(e, gen, this.#o.stableAfterMs, () => { e.attempts = 0; });
    this.#watchHealth(e, gen, ch);
  }

  #watchHealth(e: Entry, gen: number, ch: Channel): void {
    this.#later(e, gen, this.#o.healthIntervalMs, async () => {
      try {
        const h = await withTimeout(this.#o.clock, () => ch.health(), this.#o.callTimeoutMs, `${e.manifest.name}.health`);
        if (!h || !h.ok) throw new Error(`unhealthy${h?.detail ? `: ${h.detail}` : ""}`);
        if (e.gen === gen) e.health = { ok: true, ...(h.detail !== undefined ? { detail: String(h.detail) } : {}) };
      } catch (err) {
        return this.#crashed(e, gen, err);
      }
      if (e.gen === gen) this.#watchHealth(e, gen, ch);
    });
  }

  async #crashed(e: Entry, gen: number, err: unknown): Promise<void> {
    if (e.gen !== gen) return; // already stopped or restarted: nothing to do
    const name = e.manifest.name;
    e.gen++; // everything of the failed run (timers, host callbacks, late messages) is now stale
    gen = e.gen;
    this.#clearTimers(e);
    e.lastError = this.#err(err);
    delete e.startedAt;
    const ch = e.channel;
    delete e.channel;
    this.#o.log.warn("channel.crashed", { channel: name, error: e.lastError, attempts: e.attempts });
    if (e.attempts >= e.manifest.maxRestarts) {
      e.state = "failed";
      this.#o.log.error("channel.gave-up", { channel: name, attempts: e.attempts });
    } else {
      e.state = "backoff";
      const delay = backoffDelay(this.#o.backoff, e.attempts);
      e.attempts++;
      this.#later(e, gen, delay, () => this.#attempt(e, gen));
    }
    if (ch) await this.#stopQuietly(ch, name);
  }

  async #stopQuietly(ch: Channel, name: string): Promise<void> {
    try {
      await withTimeout(this.#o.clock, () => ch.stop(), this.#o.callTimeoutMs, `${name}.stop`);
    } catch (err) {
      this.#o.log.warn("channel.stop.failed", { channel: name, error: this.#err(err) });
    }
  }

  #host(e: Entry, gen: number, ch: Channel): ChannelHost {
    const name = e.manifest.name;
    const live = () => e.gen === gen && (e.state === "starting" || e.state === "running");
    return {
      log: this.#o.log,
      fail: (err) => { if (live()) void this.#crashed(e, gen, err); },
      receive: async (msg: InboundMessage) => {
        if (!live()) { this.#o.log.warn("channel.inbound.dropped", { channel: name, reason: "not-running" }); return; }
        // A channel speaks only for itself, and only for the chat kinds its manifest declares.
        if (msg?.channel !== name) { this.#o.log.warn("channel.inbound.dropped", { channel: name, reason: "channel-mismatch" }); return; }
        if (!e.manifest.chatKinds.includes(msg.chatKind)) { this.#o.log.warn("channel.inbound.dropped", { channel: name, reason: "chat-kind" }); return; }
        await this.#o.router.handle(msg, (out) => withTimeout(this.#o.clock, () => ch.send(out), this.#o.callTimeoutMs, `${name}.send`));
      },
    };
  }
}

function snapshot(e: Entry): ChannelStatus {
  return {
    name: e.manifest.name, version: e.manifest.version, state: e.state, attempts: e.attempts,
    ...(e.lastError !== undefined ? { lastError: e.lastError } : {}),
    ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
    ...(e.health !== undefined ? { health: { ...e.health } } : {}),
  };
}

function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

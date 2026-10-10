// The switchboard host: the one place that starts, stops and watches the channel adapters inside the core process.
//
// How channels run (R3 step 0): the adapters are libraries behind the core `Channel` contract. The core process hosts them with
// the `ChannelRegistry` (lifecycle, backoff, health watch) and the `ChannelRouter` (identity, D21 session, reply). This module
// is the glue that was missing:
//
//  - `channels.<id>.enabled` and every other key under `channels.<id>` (restart class `module:<id>`) is applied from the config
//    source's change feed: the channel is stopped and, if still enabled, started again. The rest of the core keeps running.
//  - A channel that cannot start for a reason that retrying will not fix (a missing secret, a configuration the adapter refuses)
//    is parked as `misconfigured` with the reason. Nothing is retried until the configuration (or the secret) changes.
//  - Inbound text goes through the existing router. Identity comes from the identity service, sessions from the session store
//    (one active session per chat, D21), the turn from the turn runner. Nothing here decides who may talk to an agent.
//  - Approval requests (D109) of a channel session are shown with the adapter's own prompt UI; a press becomes
//    `ApprovalService.decide`, which stays the only place that decides.
//  - Images a turn produced (media store) go back to the chat they were asked in.
//
// Nothing here is a second session model: every rule that matters is in the router, the stores and the approval service.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessConfig } from "@plur1bus/config-schema";
import type { restartPlan } from "@plur1bus/config-schema";
import { deriveUserPrincipal } from "../identity/principals.ts";
import type { IdentityService, Link } from "../identity/service.ts";
import type { ApprovalEvents, ApprovalView, ServiceDecideInput, ServiceDecideResult } from "../approvals/service.ts";
import type { SessionStore } from "../session/store.ts";
import type { TurnRunner } from "../session/turn-loop.ts";
import type { EventRecord } from "../session/types.ts";
import type { ChannelRegistryView } from "../rpc/channel-surface.ts";
import { type Clock, type Timer } from "./clock.ts";
import { ChannelRegistry, type ChannelStatus, type RegistryOptions } from "./registry.ts";
import { ChannelRouter } from "./router.ts";
import type {
  Channel, ChannelHealth, ChannelHost, ChannelLogger, ChatKey, ChatKind, IdentityPort, IdentityResolution, InboundMessage,
  OutboundMessage, PairingResult, SenderRef, SessionPort,
} from "./types.ts";

// --- the shapes the adapters share (every channels-* package carries its own identical copy; see their `port.ts`) ---------

export interface ApprovalChoiceLike { id: string; label: string }
export interface ApprovalPromptLike { chatId: string; text: string; choices: readonly ApprovalChoiceLike[]; approverIds: readonly string[]; ttlMs?: number; threadId?: string }
export interface ApprovalDecisionLike { promptId: string; chatId: string; senderId: string; choiceId: string; at: number }

/** A core `Channel` plus the optional adapter ports the host uses when the adapter has them. */
export interface HostedChannel extends Channel {
  prompt?(req: ApprovalPromptLike): Promise<{ promptId: string; refs: readonly unknown[] }>;
  onDecision?(handler: (d: ApprovalDecisionLike) => void | Promise<void>): () => void;
  /** Sends a media-store image to a chat (bytes are read and verified by the adapter through the `outputs` port). */
  sendOutput?(chatId: string, outputId: string, index?: number): Promise<readonly unknown[]>;
  /** The chat id in which a message to the person behind `who` reaches them directly. Absent: the channel user id is the chat id. */
  resolveOwnerTarget?(who: { userId: string; accountId?: string }): Promise<string>;
}

/** The adapter's logger shape (`log(level, event, attrs)`), as in every channels-* `port.ts`. */
export interface AdapterLogger { log(level: "debug" | "info" | "warn" | "error", event: string, attrs: Readonly<Record<string, string | number | boolean>>): void }

/** What the host hands an adapter besides its JSON configuration. */
export interface AdapterDeps {
  secrets: { reveal(name: string): Promise<string | null> };
  pairing: { claim(p: { code: string; identity: { channel: string; accountId: string; userId: string } }): unknown } | undefined;
  outputs: { store: unknown; authorize(outputId: string, chatId: string): Promise<boolean> } | undefined;
  logger: AdapterLogger;
  now: () => number;
  /** Where this channel keeps its durable cursors (`<state>/channels/<id>`); created before the channel is built. */
  stateDir: string;
  /** Test seams (`fetch`, `webSocket`, `baseUrl`, `sleep`, …) from `SwitchboardOptions.adapterDeps`; never set in production. */
  [seam: string]: unknown;
}

/** One hostable channel: its manifest and a lazy loader, so a disabled channel costs no module load. */
export interface ChannelBinding {
  id: string;
  manifest: unknown;
  load(): Promise<(cfg: Record<string, unknown>, deps: AdapterDeps) => HostedChannel>;
}

type Plan = ReturnType<typeof restartPlan>;
export interface ConfigPort {
  current(): HarnessConfig;
  onChange(fn: (prev: HarnessConfig, next: HarnessConfig, plan: Plan) => void): () => void;
}
export interface SecretsPort {
  has(name: string): Promise<boolean>;
  /** The secret's value, or null when it does not exist. */
  read(name: string): Promise<string | null>;
}
export interface TurnPort { store: SessionStore; runner: TurnRunner; agentId(): string }
export interface ApprovalDecider { decide(input: ServiceDecideInput): ServiceDecideResult }
export interface OutputsPort { store(): unknown | null }

export interface SwitchboardOptions {
  config: ConfigPort;
  secrets: SecretsPort;
  identity: () => IdentityService | null;
  turns: () => TurnPort | null;
  approvals: () => ApprovalDecider | null;
  /** The media output store (read-only use through the adapters' `outputs` port); absent: images are not sent. */
  outputs?: OutputsPort;
  clock: Clock;
  log: ChannelLogger;
  bindings: readonly ChannelBinding[];
  /** Per-channel adapter seams for tests (a fake `fetch`, a fake `webSocket`, a base URL). */
  adapterDeps?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  registry?: Partial<Omit<RegistryOptions, "clock" | "router" | "log">>;
  /** How often a `misconfigured` channel looks for its secrets again (default 30 s). */
  recheckMs?: number;
  /** The directory under which each channel gets its own state directory (`<dir>/<id>`). */
  stateDir: string;
}

export interface OwnerTarget { userId: string; accountId?: string }

export interface Switchboard {
  /** What `channel.*` reads: statuses, probes, sends. */
  readonly view: ChannelRegistryView;
  /** Hand this to the approval service's `events` (next to the RPC notifier). */
  readonly approvalEvents: ApprovalEvents;
  /** Registers every channel, applies the configuration and follows its changes. */
  start(): Promise<void>;
  /** Stops following the configuration and stops every channel. */
  stop(): Promise<void>;
  /** Resolves when every pending start/stop/reconcile has settled (tests, shutdown). */
  idle(): Promise<void>;
}

const REDACTED = "[redacted]";
const MAX_REMEMBERED_CHATS = 5000;
const MAX_ALLOWED_CHATS = 1000;
const MAX_PROMPTS = 1000;
const MAX_OUTPUTS_PER_TURN = 4;
const MIN_REDACTED_SECRET = 6;
const OUTPUT_ID = /^[a-f0-9-]{36}$/;
const MEDIA_FILE = /^\d+\.(png|jpeg|webp)$/;
const DEFAULT_RECHECK_MS = 30_000;
const MAX_RECHECK_MS = 10 * 60_000;
const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;
const MAX_APPROVAL_TTL_MS = 24 * 60 * 60_000;
const APPROVE = "approve";
const DENY = "deny";

/** Where the bot's own account id sits in a channel's configuration, for adapters that do not name it on inbound messages. */
const ACCOUNT_KEY: Readonly<Record<string, string>> = { matrix: "userId", signal: "account", email: "address" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const chatKeyOf = (channel: string, chatId: string): string => `${channel}:${chatId}`;
function parseChatKey(key: string): { channel: string; chatId: string } | null {
  const i = key.indexOf(":");
  return i > 0 && i < key.length - 1 ? { channel: key.slice(0, i), chatId: key.slice(i + 1) } : null;
}

/** Every `*Secret` leaf of a channel's configuration: the secret names the adapter will read. */
export function secretNamesOf(cfg: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (o: Record<string, unknown>): void => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && /Secret$/.test(k) && v !== "") out.push(v);
      else if (isObj(v)) walk(v);
    }
  };
  walk(cfg);
  return [...new Set(out)];
}

function channelConfigOf(cfg: HarnessConfig, id: string): Record<string, unknown> {
  const all = (cfg as unknown as { channels?: Record<string, unknown> }).channels;
  const v = all && Object.hasOwn(all, id) ? all[id] : undefined;
  return isObj(v) ? v : {};
}

export function createSwitchboard(o: SwitchboardOptions): Switchboard {
  return new Host(o);
}

class Host implements Switchboard {
  readonly #o: SwitchboardOptions;
  readonly #registry: ChannelRegistry;
  readonly #bindings = new Map<string, ChannelBinding>();
  readonly #creators = new Map<string, (cfg: Record<string, unknown>, deps: AdapterDeps) => HostedChannel>();
  /** The adapter instance currently built for a channel (the registry builds a fresh one per start attempt). */
  readonly #live = new Map<string, HostedChannel>();
  readonly #chain = new Map<string, Promise<void>>();
  readonly #secretValues = new Set<string>();
  readonly #kinds = new Map<string, ChatKind>();
  /** Outputs a chat may be sent: only what a turn of that very chat produced. */
  readonly #allowed = new Map<string, Set<string>>();
  readonly #pendingMedia = new Map<string, string[]>();
  readonly #prompts = new Map<string, { channel: string; requestId: string; nonce: string; person: string; chatId: string; chatKind: ChatKind; approverIds: ReadonlySet<string> }>();
  #unwatch: (() => void) | null = null;
  #recheck: Timer | null = null;
  #recheckDelay = 0;
  #stopped = false;
  readonly view: ChannelRegistryView & { ownerTarget(name: string, who: OwnerTarget): Promise<string> };
  readonly approvalEvents: ApprovalEvents;

  constructor(o: SwitchboardOptions) {
    this.#o = o;
    const router = new ChannelRouter({ identity: this.#identityPort(), sessions: this.#sessionPort(), clock: o.clock, log: o.log });
    this.#registry = new ChannelRegistry({ clock: o.clock, router, log: o.log, redact: (t) => this.#redact(t), ...o.registry });
    for (const b of o.bindings) this.#bindings.set(b.id, b);
    const r = this.#registry;
    this.view = {
      list: () => r.list().map((s) => this.#redactedStatus(s)),
      status: (n) => { const s = r.status(n); return s && this.#redactedStatus(s); },
      manifestOf: (n) => r.manifestOf(n),
      probe: async (n) => { const h = await r.probe(n); return h && { ...h, ...(h.detail !== undefined ? { detail: this.#redact(h.detail) } : {}) }; },
      sendTo: (n, m) => r.sendTo(n, m),
      ownerTarget: (n, who) => this.#ownerTarget(n, who),
    };
    this.approvalEvents = {
      emit: (name, payload) => {
        if (name === "approval.requested") void this.#relayApproval(payload as { approval: ApprovalView; nonce: string; foregroundUntil: number });
        else if (name === "approval.resolved") this.#forgetPrompts((payload as { approval: ApprovalView }).approval.id);
      },
    };
  }

  // --- lifecycle ------------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    this.#stopped = false;
    for (const b of this.#bindings.values()) {
      const ok = this.#registry.register({ manifest: b.manifest, factory: () => this.#build(b.id) });
      if (!ok.ok) this.#o.log.error("switchboard.register.failed", { channel: b.id, errors: ok.errors.join("; ") });
    }
    this.#unwatch = this.#o.config.onChange((prev, next) => {
      for (const id of this.#bindings.keys()) {
        if (JSON.stringify(channelConfigOf(prev, id)) !== JSON.stringify(channelConfigOf(next, id))) { this.#recheckDelay = 0; this.#queue(id); }
      }
    });
    for (const id of this.#bindings.keys()) this.#queue(id);
    await this.idle();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unwatch?.(); this.#unwatch = null;
    this.#recheck?.cancel(); this.#recheck = null;
    await this.idle();
    await this.#registry.stopAll();
    this.#live.clear();
  }

  async idle(): Promise<void> {
    while (this.#chain.size > 0) await Promise.allSettled([...this.#chain.values()]);
  }

  /** One reconcile at a time per channel, in the order the changes arrived. */
  #queue(id: string): void {
    const prev = this.#chain.get(id) ?? Promise.resolve();
    const next = prev.then(() => (this.#stopped ? undefined : this.#reconcile(id))).catch((e) => {
      this.#o.log.error("switchboard.reconcile.failed", { channel: id, error: this.#redact(errText(e)) });
    });
    this.#chain.set(id, next);
    void next.finally(() => { if (this.#chain.get(id) === next) this.#chain.delete(id); });
  }

  async #reconcile(id: string): Promise<void> {
    const reg = this.#registry;
    await reg.stop(id);
    this.#live.delete(id);
    this.#forgetChannelPrompts(id);
    const cfg = channelConfigOf(this.#o.config.current(), id);
    if (cfg.enabled !== true) { this.#scheduleRecheck(); return; }

    const binding = this.#bindings.get(id)!;
    let create = this.#creators.get(id);
    if (!create) {
      try { create = await binding.load(); this.#creators.set(id, create); }
      catch (e) { reg.markMisconfigured(id, `the ${id} adapter could not be loaded: ${this.#redact(errText(e))}`); this.#scheduleRecheck(); return; }
    }
    try { await mkdir(this.#stateDirOf(id), { recursive: true, mode: 0o700 }); }
    catch (e) { reg.markMisconfigured(id, `the state directory cannot be created: ${this.#redact(errText(e))}`); this.#scheduleRecheck(); return; }
    // A channel reads only its own secrets: a configuration cannot point an adapter (and so a remote server) at another credential.
    const foreign = secretNamesOf(cfg).filter((n) => !n.startsWith(`channels.${id}.`));
    if (foreign.length > 0) {
      reg.markMisconfigured(id, `secret names must start with channels.${id}. (not allowed: ${foreign.join(", ")})`);
      this.#o.log.warn("channel.misconfigured", { channel: id, reason: "secret-namespace" });
      this.#scheduleRecheck();
      return;
    }
    const missing: string[] = [];
    let storeError: string | undefined;
    for (const name of secretNamesOf(cfg)) {
      let present = false;
      try { present = await this.#o.secrets.has(name); } catch (e) { storeError = this.#redact(errText(e)); }
      if (!present) missing.push(name);
    }
    if (missing.length > 0) {
      reg.markMisconfigured(id, storeError !== undefined
        ? `secret not readable: ${missing.join(", ")} (secret store: ${storeError})`
        : `secret not found: ${missing.join(", ")} (store it with \`plur1bus secret set\`)`);
      this.#o.log.warn("channel.misconfigured", { channel: id, reason: "secret-missing", secrets: missing.join(",") });
      this.#scheduleRecheck();
      return;
    }
    try { create(cfg, this.#depsFor(id)); } // a trial build: adapters validate their configuration in the constructor and connect in `start`
    catch (e) {
      reg.markMisconfigured(id, `invalid configuration: ${this.#redact(errText(e))}`);
      this.#o.log.warn("channel.misconfigured", { channel: id, reason: "invalid-config" });
      this.#scheduleRecheck();
      return;
    }
    reg.start(id);
  }

  /** A secret can be stored after the channel was enabled; a parked channel looks again now and then (no start before it is complete). */
  #scheduleRecheck(): void {
    if (this.#stopped || this.#recheck) return;
    if (!this.#registry.list().some((s) => s.state === "misconfigured")) return;
    const base = this.#o.recheckMs ?? DEFAULT_RECHECK_MS;
    this.#recheckDelay = this.#recheckDelay === 0 ? base : Math.min(this.#recheckDelay * 2, MAX_RECHECK_MS); // every look is an audited secret read: back off
    this.#recheck = this.#o.clock.setTimer(() => {
      this.#recheck = null;
      for (const s of this.#registry.list()) if (s.state === "misconfigured") this.#queue(s.name);
      // `#queue` runs `reconcile`, which parks again (and re-arms this timer) when the secret is still missing.
    }, this.#recheckDelay);
  }

  /** The registry's factory: a fresh adapter from the current configuration, wrapped. Throws when the configuration no longer builds. */
  #build(id: string): Channel {
    const create = this.#creators.get(id);
    if (!create) throw new Error(`channel ${id} was not loaded`);
    const adapter = create(channelConfigOf(this.#o.config.current(), id), this.#depsFor(id));
    this.#live.set(id, adapter);
    return new Guarded(id, adapter, this);
  }

  #stateDirOf(id: string): string { return join(this.#o.stateDir, id); }

  #depsFor(id: string): AdapterDeps {
    const o = this.#o;
    const identity = o.identity();
    const logger: AdapterLogger = {
      log: (level, event, attrs) => {
        const fields: Record<string, unknown> = { channel: id, event, ...attrs };
        const line = event.startsWith("channel.") ? event : `channel.${id}.${event}`;
        (level === "error" ? o.log.error : level === "warn" ? o.log.warn : o.log.info).call(o.log, line, fields);
      },
    };
    const store = o.outputs?.store() ?? null;
    return {
      secrets: {
        reveal: async (name) => {
          if (!name.startsWith(`channels.${id}.`)) throw new Error("a channel may only read its own secrets");
          const v = await o.secrets.read(name);
          if (v !== null && v.length >= MIN_REDACTED_SECRET) this.#secretValues.add(v);
          return v;
        },
      },
      // Pairing claims need the identity service at call time, not at build time; a late identity service is looked up per claim.
      pairing: { claim: (p) => { const svc = o.identity() ?? identity; if (!svc) throw new Error("identity unavailable"); return svc.claim(p); } },
      outputs: store ? { store, authorize: async (outputId, chatId) => this.#allowed.get(chatKeyOf(id, chatId))?.has(outputId) === true } : undefined,
      logger,
      now: () => o.clock.now(),
      stateDir: this.#stateDirOf(id),
      ...(o.adapterDeps?.[id] ?? {}),
    };
  }

  #redact(text: string): string {
    let out = text;
    for (const v of this.#secretValues) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }
  #redactedStatus(s: ChannelStatus): ChannelStatus {
    return s.lastError === undefined ? s : { ...s, lastError: this.#redact(s.lastError) };
  }

  // --- what Guarded calls ---------------------------------------------------------------------------------------------

  /** Errors that leave an adapter never carry a secret value. */
  scrubError(e: unknown): Error {
    const text = this.#redact(errText(e));
    return text === errText(e) && e instanceof Error ? e : new Error(text);
  }

  noteInbound(msg: InboundMessage): void {
    if (typeof msg?.channel !== "string" || typeof msg.chatId !== "string") return;
    const key = chatKeyOf(msg.channel, msg.chatId);
    if (this.#kinds.size >= MAX_REMEMBERED_CHATS && !this.#kinds.has(key)) this.#kinds.delete(this.#kinds.keys().next().value as string);
    this.#kinds.set(key, msg.chatKind);
  }

  /** After a turn's text reply went out, the images that turn produced follow into the same chat. */
  async flushMedia(channel: string, adapter: HostedChannel, chatId: string): Promise<void> {
    const key = chatKeyOf(channel, chatId);
    const ids = this.#pendingMedia.get(key);
    if (!ids || ids.length === 0 || !adapter.sendOutput) return;
    this.#pendingMedia.delete(key);
    for (const id of ids) {
      try { await adapter.sendOutput(chatId, id); }
      catch (e) { this.#o.log.warn("channel.media.failed", { channel, error: this.#redact(errText(e)) }); }
    }
  }

  onDecision(channel: string, d: ApprovalDecisionLike): void {
    void this.#decide(channel, d).catch((e) => this.#o.log.error("channel.approval.failed", { channel, error: this.#redact(errText(e)) }));
  }

  // --- identity and sessions for the router ---------------------------------------------------------------------------

  #identityPort(): IdentityPort {
    const find = (s: SenderRef): { humanId: string } | null => {
      const svc = this.#o.identity();
      if (!svc) return null;
      const key = ACCOUNT_KEY[s.channel];
      const configured = key ? channelConfigOf(this.#o.config.current(), s.channel)[key] : undefined;
      const accountId = s.accountId ?? (typeof configured === "string" ? configured : undefined);
      if (accountId !== undefined) {
        const r = svc.resolve({ channel: s.channel, accountId, userId: s.senderId });
        return r ? { humanId: r.humanId } : null;
      }
      // An adapter that does not name its account (Slack learns its bot id at runtime): the sender's handle alone must pick exactly one human.
      const humans = new Set<string>();
      for (const h of svc.list({}).humans) {
        for (const l of h.identities) if (l.channel === s.channel && l.userId === s.senderId && l.revokedAt === null) humans.add(h.id);
      }
      return humans.size === 1 ? { humanId: [...humans][0]! } : null;
    };
    return {
      resolve: async (sender): Promise<IdentityResolution> => {
        const hit = find(sender);
        return hit ? { linked: true, userId: hit.humanId } : { linked: false };
      },
      // Pairing happens in the adapters (`/link <code>` through `IdentityService.claim`, which the owner then confirms): a bare
      // code sent as a normal message is never a claim here.
      claimPairing: async (): Promise<PairingResult> => ({ ok: false }),
    };
  }

  #linkOf(humanId: string, channel: string): Link | null {
    const svc = this.#o.identity();
    if (!svc) return null;
    const human = svc.list({}).humans.find((h) => h.id === humanId);
    return human?.identities.find((l) => l.channel === channel && l.revokedAt === null) ?? null;
  }

  #sessionPort(): SessionPort {
    const turns = (): TurnPort => {
      const t = this.#o.turns();
      if (!t) throw new Error("sessions unavailable");
      return t;
    };
    return {
      findActive: async (chat: ChatKey) => turns().store.activeForChat(chatKeyOf(chat.channel, chat.chatId))?.id ?? null,
      create: async (chat, owner) => {
        const t = turns();
        const chatKey = chatKeyOf(chat.channel, chat.chatId);
        try {
          return t.store.createSession({ kind: "channel", agentId: t.agentId(), owner: deriveUserPrincipal(owner.userId), chatKey, title: `${chat.channel} chat` }).id;
        } catch (e) {
          const existing = t.store.activeForChat(chatKey); // a racing first message made it already
          if (existing) return existing.id;
          throw e;
        }
      },
      archive: async (sessionId) => { turns().store.archiveSession(sessionId); },
      submit: async (sessionId, input) => {
        const t = turns();
        const session = t.store.getSession(sessionId);
        if (!session || session.kind !== "channel" || !session.chatKey) throw new Error("not a channel session");
        const chat = parseChatKey(session.chatKey);
        if (!chat) throw new Error("malformed chat key");
        const kind = this.#kinds.get(session.chatKey);
        // D109 §5: a private chat with a linked person is surface T2; anything else (a group, an unknown chat) is the lower T1.
        const surface = kind === "direct" ? 2 : 1;
        const handle = t.runner.submit({
          session, text: input.text,
          caller: { channel: "cli", accountId: `channel-${chat.channel}`, userId: input.userId },
          // The person is the human id, exactly what the RPC surfaces use (the RBAC principal id), so grants and approvals line up across surfaces.
          approver: { person: input.userId, surface },
        });
        const outcome = await handle.done;
        if (outcome.state !== "completed") throw new Error(outcome.error ?? "the turn failed");
        this.#collectMedia(t.store.listEvents(sessionId), handle.turnId, session.chatKey);
        return { text: outcome.reply && outcome.reply.length > 0 ? outcome.reply : "…" };
      },
    };
  }

  /** The media-store images of one turn (found in its tool results) are queued for the chat and become sendable to that chat only. */
  #collectMedia(events: readonly EventRecord[], turnId: string, chatKey: string): void {
    const ids: string[] = [];
    for (const e of events) {
      if (e.turnId !== turnId || e.type !== "tool.result" || e.data.isError === true || typeof e.data.output !== "string") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(e.data.output); } catch { continue; }
      findOutputIds(parsed, 0, ids);
    }
    const unique = [...new Set(ids)].slice(0, MAX_OUTPUTS_PER_TURN);
    if (unique.length === 0) { this.#pendingMedia.delete(chatKey); return; }
    const allowed = this.#allowed.get(chatKey) ?? new Set<string>();
    for (const id of unique) allowed.add(id);
    while (allowed.size > MAX_ALLOWED_CHATS) allowed.delete(allowed.values().next().value as string);
    this.#allowed.delete(chatKey); // re-insert: the least recently used chat is first
    this.#allowed.set(chatKey, allowed);
    while (this.#allowed.size > MAX_ALLOWED_CHATS) this.#allowed.delete(this.#allowed.keys().next().value as string);
    while (this.#pendingMedia.size > MAX_ALLOWED_CHATS) this.#pendingMedia.delete(this.#pendingMedia.keys().next().value as string);
    this.#pendingMedia.set(chatKey, unique);
  }

  // --- D109 relay -------------------------------------------------------------------------------------------------------

  async #relayApproval(p: { approval: ApprovalView; nonce: string; foregroundUntil: number }): Promise<void> {
    try {
      const { approval, nonce } = p;
      const t = this.#o.turns(), svc = this.#o.identity();
      if (!t || !svc) return;
      const session = t.store.getSession(approval.sessionId);
      if (!session || session.kind !== "channel" || !session.chatKey) return; // not asked in a channel: another surface answers it
      const chat = parseChatKey(session.chatKey);
      if (!chat) return;
      const adapter = this.#live.get(chat.channel);
      if (!adapter?.prompt || this.#registry.status(chat.channel)?.state !== "running") return;
      // Only the person the request belongs to may answer, and only from a handle linked to them on this channel.
      const human = svc.list({}).humans.find((h) => h.id === approval.principal);
      if (!human) return;
      const approverIds = human.identities.filter((l) => l.channel === chat.channel && l.revokedAt === null).map((l) => l.userId);
      if (approverIds.length === 0) return;
      // A prompt shows what is being asked, so it goes to a private chat only; in a group the request waits for another surface.
      if (this.#kinds.get(session.chatKey) !== "direct") return;
      const kind: ChatKind = "direct";
      const ttl = Math.min(Math.max(approval.expiresAt - this.#o.clock.now(), 1_000), MAX_APPROVAL_TTL_MS);
      const sent = await adapter.prompt({
        chatId: chat.chatId,
        text: approvalText(approval),
        choices: [{ id: APPROVE, label: "Approve" }, { id: DENY, label: "Deny" }],
        approverIds,
        ttlMs: Number.isFinite(ttl) ? ttl : DEFAULT_APPROVAL_TTL_MS,
      });
      while (this.#prompts.size >= MAX_PROMPTS) this.#prompts.delete(this.#prompts.keys().next().value as string);
      this.#prompts.set(`${chat.channel}\0${sent.promptId}`, {
        channel: chat.channel, requestId: approval.id, nonce, person: approval.principal, chatId: chat.chatId, chatKind: kind, approverIds: new Set(approverIds),
      });
    } catch (e) {
      this.#o.log.warn("channel.approval.prompt-failed", { error: this.#redact(errText(e)) });
    }
  }

  async #decide(channel: string, d: ApprovalDecisionLike): Promise<void> {
    const key = `${channel}\0${d.promptId}`;
    const p = this.#prompts.get(key);
    if (!p) return;
    // The adapter already checked the approver list; the host checks again against the person's links as they are now.
    if (d.chatId !== p.chatId || !p.approverIds.has(d.senderId)) { this.#o.log.warn("channel.approval.refused", { channel, reason: "approver" }); return; }
    const decision = d.choiceId === APPROVE ? "approve" : d.choiceId === DENY ? "deny" : null;
    if (!decision) return;
    const approvals = this.#o.approvals();
    if (!approvals) return;
    this.#prompts.delete(key);
    const surface = 2; // D109 §5: a private chat with a linked person
    const res = approvals.decide({ requestId: p.requestId, nonce: p.nonce, decision, person: p.person, surface });
    if (!res.ok) this.#o.log.warn("channel.approval.refused", { channel, reason: res.reason });
  }

  #forgetPrompts(requestId: string): void {
    for (const [k, v] of this.#prompts) if (v.requestId === requestId) this.#prompts.delete(k);
  }
  #forgetChannelPrompts(channel: string): void {
    for (const [k, v] of this.#prompts) if (v.channel === channel) this.#prompts.delete(k);
  }

  // --- owner target ---------------------------------------------------------------------------------------------------

  async #ownerTarget(name: string, who: OwnerTarget): Promise<string> {
    const adapter = this.#live.get(name);
    if (adapter?.resolveOwnerTarget) return adapter.resolveOwnerTarget(who);
    return who.userId;
  }
}

/** The text of an approval prompt: what is asked, never the raw arguments (the view's summary is already redacted). */
function approvalText(a: ApprovalView): string {
  const what = a.tool ? `${a.tool} (${a.capability})` : a.capability;
  const lines = [`Approval needed: ${what}`];
  if (a.summary) lines.push(a.summary);
  if (a.risk) lines.push(`Risk: ${a.risk}`);
  return lines.join("\n");
}

function findOutputIds(v: unknown, depth: number, out: string[]): void {
  if (depth > 5 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v.slice(0, 20)) findOutputIds(x, depth + 1, out); return; }
  const o = v as Record<string, unknown>;
  if (typeof o.id === "string" && OUTPUT_ID.test(o.id) && Array.isArray(o.files) && o.files.length > 0
    && o.files.every((f) => isObj(f) && typeof f.path === "string" && MEDIA_FILE.test(f.path))) out.push(o.id);
  for (const x of Object.values(o)) findOutputIds(x, depth + 1, out);
}

/** The channel the registry runs: the adapter, with secrets kept out of errors, inbound chat kinds noted, and approval/media hooks wired. */
class Guarded implements HostedChannel {
  readonly name: string;
  readonly #inner: HostedChannel;
  readonly #sb: Host;
  #unsubscribe: (() => void) | undefined;

  constructor(name: string, inner: HostedChannel, sb: Host) { this.name = name; this.#inner = inner; this.#sb = sb; }

  async start(host: ChannelHost): Promise<void> {
    const sb = this.#sb;
    const wrapped: ChannelHost = {
      log: host.log,
      fail: (err) => host.fail(sb.scrubError(err)),
      receive: (msg) => { sb.noteInbound(msg); return host.receive(msg); },
    };
    try {
      await this.#inner.start(wrapped);
    } catch (e) { throw sb.scrubError(e); }
    this.#unsubscribe = this.#inner.onDecision?.((d) => sb.onDecision(this.name, d));
  }
  async stop(): Promise<void> {
    this.#unsubscribe?.(); this.#unsubscribe = undefined;
    try { await this.#inner.stop(); } catch (e) { throw this.#sb.scrubError(e); }
  }
  async health(): Promise<ChannelHealth> {
    try { return await this.#inner.health(); } catch (e) { throw this.#sb.scrubError(e); }
  }
  async send(msg: OutboundMessage): Promise<void> {
    try { await this.#inner.send(msg); } catch (e) { throw this.#sb.scrubError(e); }
    await this.#sb.flushMedia(this.name, this.#inner, msg.chatId);
  }
}

import { resolveBehaviour, permitsMessage, type ResolvedBehaviour } from "./behaviour.ts";
import { BehaviourRateGate, channelBehaviour, channelOrigin } from "./behaviour-context.ts";
import type { Clock } from "./clock.ts";
import type { ChannelLogger, IdentityPort, InboundMessage, OutboundMessage, SenderRef, SessionPort } from "./types.ts";

export const MAX_TEXT = 65_536;
/** Messages of one chat waiting behind a running turn; the next ones are dropped (a flood must not queue without bound). */
export const MAX_PENDING_PER_CHAT = 20;
const MAX_ID = 256;
/** 8 characters from the 32-character unambiguous alphabet (ADR-007 pairing: no 0/1/I/O). */
const PAIRING_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
// RULING: one "not paired" reply per sender per minute. Replying to every message would let any stranger make the bot
// talk (amplification, and a probe for which accounts the bot answers); more than one a minute adds nothing.
const REJECT_REPLY_EVERY_MS = 60_000;
const REJECT_MAP_MAX = 2000;
// RULING: an adapter that re-delivers a message (restart, reconnect, replayed offset) must not cost a second turn. Remember
// the ids of recent messages; the map is bounded in size and age.
const SEEN_TTL_MS = 600_000;
const SEEN_MAX = 5000;

export const NOT_PAIRED_TEXT = "This account is not paired yet. Ask the owner for a pairing code and send it here.";
export const PAIRED_TEXT = (pairingId: string) =>
  `Pairing claimed. Pairing ID: ${pairingId}. Confirm this link in My identities. Run: plur1bus identity approve ${pairingId}`;
export const NEW_SESSION_TEXT = "Started a new session.";
export const FAILED_TEXT = "Sorry, that did not work. Please try again.";

export interface RouterDeps {
  identity: IdentityPort; sessions: SessionPort; clock: Clock; log: ChannelLogger;
  /** Applied to every error text before it is logged (the host masks secret values here). */
  redact?: (text: string) => string;
  command?: (msg: InboundMessage, person: string, send: Send) => Promise<boolean>;
  observed?: (msg: InboundMessage, person: string, sessionId: string) => void;
  personActive?: (person: string) => boolean;
  behaviour?: (msg: InboundMessage) => ResolvedBehaviour;
}
export type Send = (msg: OutboundMessage) => Promise<void>;

/**
 * Inbound pipeline of every channel: validate → who is this → (unknown: pairing only) → the chat's one active session
 * (D21) → `session.submit` → reply. `handle` never throws and never lets one chat's failure wedge another.
 */
export class ChannelRouter {
  readonly #d: RouterDeps;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #lastReject = new Map<string, number>();
  readonly #pending = new Map<string, number>();
  readonly #seen = new Map<string, number>();
  readonly #rates = new BehaviourRateGate();

  constructor(deps: RouterDeps) { this.#d = deps; }

  async handle(msg: InboundMessage, send: Send): Promise<void> {
    try {
      if (!valid(msg)) { this.#d.log.warn("channel.inbound.dropped", { reason: "malformed" }); return; }
      const chat = `${msg.channel}\0${msg.chatId}`;
      const waiting = this.#pending.get(chat) ?? 0;
      if (waiting >= MAX_PENDING_PER_CHAT) { this.#d.log.warn("channel.inbound.dropped", { channel: msg.channel, reason: "queue-full" }); return; }
      if (this.#duplicate(msg)) { this.#d.log.warn("channel.inbound.dropped", { channel: msg.channel, reason: "duplicate" }); return; }
      this.#pending.set(chat, waiting + 1);
      try { await this.#serial(chat, () => this.#process(msg, send)); }
      finally { const n = (this.#pending.get(chat) ?? 1) - 1; if (n > 0) this.#pending.set(chat, n); else this.#pending.delete(chat); }
    } catch (e) {
      this.#d.log.error("channel.inbound.failed", { channel: msg?.channel, error: this.#err(e) });
    }
  }

  /** True when this exact message (same chat, sender and id) was accepted lately. Messages without an id are never merged. */
  #duplicate(msg: InboundMessage): boolean {
    if (msg.messageId === undefined || msg.messageId === "") return false;
    const key = `${msg.channel}\0${msg.chatId}\0${msg.senderId}\0${msg.messageId}`;
    const now = this.#d.clock.now();
    const at = this.#seen.get(key);
    if (at !== undefined && now - at < SEEN_TTL_MS) return true;
    this.#seen.delete(key);
    if (this.#seen.size >= SEEN_MAX) {
      for (const [k, t] of this.#seen) { if (now - t >= SEEN_TTL_MS) this.#seen.delete(k); else break; } // insertion order = age order
      while (this.#seen.size >= SEEN_MAX) this.#seen.delete(this.#seen.keys().next().value as string);
    }
    this.#seen.set(key, now);
    return false;
  }

  #err(e: unknown): string { const t = errText(e); return this.#d.redact ? this.#d.redact(t) : t; }

  /** Per-chat FIFO: the first message of a chat finishes creating its session before the second one looks for it (D21). */
  #serial(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    void tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return run;
  }

  async #process(msg: InboundMessage, send: Send): Promise<void> {
    const sender: SenderRef = { channel: msg.channel, senderId: msg.senderId, ...(msg.accountId !== undefined ? { accountId: msg.accountId } : {}) };
    let userId: string;
    try {
      const r = await this.#d.identity.resolve(sender);
      if (!r.linked) return await this.#unknown(msg, sender, send);
      // A disabled person is neither a stranger (no pairing, no "not paired" reply) nor a user: nothing reaches a session.
      if (r.disabled === true) { this.#d.log.warn("channel.inbound.dropped", { channel: msg.channel, reason: "person-disabled" }); return; }
      userId = r.userId;
    } catch (e) {
      // Fail closed: if we cannot tell who this is, they are nobody.
      this.#d.log.error("channel.identity.failed", { channel: msg.channel, error: this.#err(e) });
      return;
    }

    if (this.#d.personActive && !this.#d.personActive(userId)) return;
    const { profile } = this.#d.behaviour?.(msg) ?? resolveBehaviour({}, msg);
    if (!permitsMessage(profile, { ...msg, addressed: msg.chatKind === "direct" || msg.addressed === true })) {
      this.#d.log.warn("channel.inbound.dropped", { channel: msg.channel, reason: "behaviour" }); return;
    }
    if (!this.#rates.take(`${msg.channel}\0${userId}`, profile.rateLimits.repliesPerHour, this.#d.clock.now())) {
      this.#d.log.warn("channel.inbound.dropped", { channel: msg.channel, reason: "behaviour-rate" }); return;
    }
    const chat = { channel: msg.channel, chatId: msg.chatId };
    try {
      if (await this.#d.command?.(msg, userId, send)) return;
      if (msg.text.trim() === "/new") {
        const active = await this.#d.sessions.findActive(chat);
        if (active) await this.#d.sessions.archive(active);
        await this.#reply(send, msg, NEW_SESSION_TEXT);
        return;
      }
      // A private chat belongs to one person: if the handle was relinked, the previous person's session is not carried over.
      // A group is one shared conversation (anyone in the room continues it), so there the owner is not compared.
      const forOwner = msg.chatKind === "direct" ? { userId } : undefined;
      const sessionId = (await this.#d.sessions.findActive(chat, forOwner)) ?? (await this.#d.sessions.create(chat, { userId }));
      this.#d.observed?.(msg, userId, sessionId);
      const out = await channelOrigin.run({ ...chat, ...(msg.accountId ? { accountId: msg.accountId } : {}), senderId: msg.senderId, humanId: userId, chatKind: msg.chatKind }, () => channelBehaviour.run(profile, () => this.#d.sessions.submit(sessionId, { userId, text: msg.text })));
      await this.#reply(send, msg, clipReply(out.text, profile.rateLimits.maxReplyChars));
    } catch (e) {
      this.#d.log.error("channel.session.failed", { channel: msg.channel, error: this.#err(e) });
      await this.#reply(send, msg, FAILED_TEXT);
    }
  }

  async #unknown(msg: InboundMessage, sender: SenderRef, send: Send): Promise<void> {
    // Nothing reaches a session. Groups get silence: no reply, no pairing attempt (a code posted in a group is burnt anyway).
    if (msg.chatKind !== "direct") return;
    const code = msg.text.trim().toUpperCase();
    if (PAIRING_CODE.test(code)) {
      try {
        const r = await this.#d.identity.claimPairing(sender, code);
        if (r.ok) { await this.#reply(send, msg, PAIRED_TEXT(r.pairingId)); return; }
      } catch (e) {
        this.#d.log.error("channel.pairing.failed", { channel: msg.channel, error: this.#err(e) });
      }
    }
    const key = `${msg.channel}\0${msg.senderId}`;
    const now = this.#d.clock.now();
    const last = this.#lastReject.get(key);
    if (last !== undefined && now - last < REJECT_REPLY_EVERY_MS) return;
    if (this.#lastReject.size >= REJECT_MAP_MAX) {
      for (const [k, t] of this.#lastReject) if (now - t >= REJECT_REPLY_EVERY_MS) this.#lastReject.delete(k);
      if (this.#lastReject.size >= REJECT_MAP_MAX) this.#lastReject.clear();
    }
    this.#lastReject.set(key, now);
    await this.#reply(send, msg, NOT_PAIRED_TEXT);
  }

  async #reply(send: Send, msg: InboundMessage, text: string): Promise<void> {
    try {
      await send({ chatId: msg.chatId, text, ...(msg.messageId !== undefined ? { replyTo: msg.messageId } : {}) });
    } catch (e) {
      this.#d.log.warn("channel.send.failed", { channel: msg.channel, error: this.#err(e) });
    }
  }
}

function valid(m: InboundMessage): boolean {
  const id = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= MAX_ID;
  return !!m && id(m.channel) && id(m.chatId) && id(m.senderId)
    && (m.chatKind === "direct" || m.chatKind === "group" || m.chatKind === "broadcast")
    && typeof m.text === "string" && m.text.trim().length > 0 && m.text.length <= MAX_TEXT;
}

function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function clipReply(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!) && end < text.length) end--;
  return text.slice(0, end);
}

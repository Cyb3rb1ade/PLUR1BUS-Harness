import type { Clock } from "./clock.ts";
import type { ChannelLogger, IdentityPort, InboundMessage, OutboundMessage, SenderRef, SessionPort } from "./types.ts";

export const MAX_TEXT = 65_536;
const MAX_ID = 256;
/** 8 characters from the 32-character unambiguous alphabet (ADR-007 pairing: no 0/1/I/O). */
const PAIRING_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
// RULING: one "not paired" reply per sender per minute. Replying to every message would let any stranger make the bot
// talk (amplification, and a probe for which accounts the bot answers); more than one a minute adds nothing.
const REJECT_REPLY_EVERY_MS = 60_000;
const REJECT_MAP_MAX = 2000;

export const NOT_PAIRED_TEXT = "This account is not paired yet. Ask the owner for a pairing code and send it here.";
export const PAIRED_TEXT = (pairingId: string) =>
  `Pairing claimed. Pairing ID: ${pairingId}. Confirm this link in My identities. Run: plur1bus identity approve ${pairingId}`;
export const NEW_SESSION_TEXT = "Started a new session.";
export const FAILED_TEXT = "Sorry, that did not work. Please try again.";

export interface RouterDeps { identity: IdentityPort; sessions: SessionPort; clock: Clock; log: ChannelLogger }
export type Send = (msg: OutboundMessage) => Promise<void>;

/**
 * Inbound pipeline of every channel: validate → who is this → (unknown: pairing only) → the chat's one active session
 * (D21) → `session.submit` → reply. `handle` never throws and never lets one chat's failure wedge another.
 */
export class ChannelRouter {
  readonly #d: RouterDeps;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #lastReject = new Map<string, number>();

  constructor(deps: RouterDeps) { this.#d = deps; }

  async handle(msg: InboundMessage, send: Send): Promise<void> {
    try {
      if (!valid(msg)) { this.#d.log.warn("channel.inbound.dropped", { reason: "malformed" }); return; }
      await this.#serial(`${msg.channel}\0${msg.chatId}`, () => this.#process(msg, send));
    } catch (e) {
      this.#d.log.error("channel.inbound.failed", { channel: msg?.channel, error: errText(e) });
    }
  }

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
      userId = r.userId;
    } catch (e) {
      // Fail closed: if we cannot tell who this is, they are nobody.
      this.#d.log.error("channel.identity.failed", { channel: msg.channel, error: errText(e) });
      return;
    }

    const chat = { channel: msg.channel, chatId: msg.chatId };
    try {
      if (msg.text.trim() === "/new") {
        const active = await this.#d.sessions.findActive(chat);
        if (active) await this.#d.sessions.archive(active);
        await this.#reply(send, msg, NEW_SESSION_TEXT);
        return;
      }
      const sessionId = (await this.#d.sessions.findActive(chat)) ?? (await this.#d.sessions.create(chat, { userId }));
      const out = await this.#d.sessions.submit(sessionId, { userId, text: msg.text });
      await this.#reply(send, msg, out.text);
    } catch (e) {
      this.#d.log.error("channel.session.failed", { channel: msg.channel, error: errText(e) });
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
        this.#d.log.error("channel.pairing.failed", { channel: msg.channel, error: errText(e) });
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
      this.#d.log.warn("channel.send.failed", { channel: msg.channel, error: errText(e) });
    }
  }
}

function valid(m: InboundMessage): boolean {
  const id = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= MAX_ID;
  return !!m && id(m.channel) && id(m.chatId) && id(m.senderId)
    && (m.chatKind === "direct" || m.chatKind === "group" || m.chatKind === "broadcast")
    && typeof m.text === "string" && m.text.length > 0 && m.text.length <= MAX_TEXT;
}

function errText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

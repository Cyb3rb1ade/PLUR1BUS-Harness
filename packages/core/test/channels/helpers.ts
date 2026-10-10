// Test doubles for the channel framework: a fake clock (no sleeps), a fake identity layer and a fake session store.
import type { Clock, IdentityPort, IdentityResolution, PairingResult, SessionPort, SenderRef, ChatKey, ChannelLogger } from "../../src/channels/index.ts";

const tick = () => new Promise<void>((r) => setImmediate(r));
export async function flush(n = 5): Promise<void> { for (let i = 0; i < n; i++) await tick(); }

export class FakeClock implements Clock {
  t = 0;
  #timers: { at: number; seq: number; fn: () => void }[] = [];
  #seq = 0;
  now(): number { return this.t; }
  setTimer(fn: () => void, ms: number) {
    const e = { at: this.t + ms, seq: this.#seq++, fn };
    this.#timers.push(e);
    return { cancel: () => { this.#timers = this.#timers.filter((x) => x !== e); } };
  }
  pending(): number { return this.#timers.length; }
  /** Advance time, firing due timers in order and letting promises settle after each one. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await flush();
      const next = this.#timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

export class FakeIdentity implements IdentityPort {
  links = new Map<string, string>(); // `${channel}\0${senderId}` -> userId
  codes = new Map<string, string>(); // code -> userId
  claims: string[] = [];
  resolves = 0;
  async resolve(s: SenderRef): Promise<IdentityResolution> {
    this.resolves++;
    const u = this.links.get(`${s.channel}\0${s.senderId}`);
    return u ? { linked: true, userId: u } : { linked: false };
  }
  async claimPairing(s: SenderRef, code: string): Promise<PairingResult> {
    this.claims.push(code);
    const u = this.codes.get(code);
    if (!u) return { ok: false };
    this.codes.delete(code);
    this.links.set(`${s.channel}\0${s.senderId}`, u);
    return { ok: true, userId: u, pairingId: "pair-1" };
  }
  link(channel: string, senderId: string, userId: string) { this.links.set(`${channel}\0${senderId}`, userId); }
}

export class FakeSessions implements SessionPort {
  #n = 0;
  active = new Map<string, string>(); // chat key -> session id
  all: { id: string; chat: string; owner: string; archived: boolean }[] = [];
  submits: { sessionId: string; userId: string; text: string }[] = [];
  createDelayMs = 0;
  #key(k: ChatKey) { return `${k.channel}\0${k.chatId}`; }
  async findActive(k: ChatKey): Promise<string | null> { return this.active.get(this.#key(k)) ?? null; }
  async create(k: ChatKey, owner: { userId: string }): Promise<string> {
    await flush(2); // a window in which a racing second message could also create one
    const id = `s${++this.#n}`;
    if (this.active.has(this.#key(k))) throw new Error("D21 violated: second active session for one chat");
    this.active.set(this.#key(k), id);
    this.all.push({ id, chat: this.#key(k), owner: owner.userId, archived: false });
    return id;
  }
  async archive(id: string): Promise<void> {
    for (const [k, v] of this.active) if (v === id) this.active.delete(k);
    const s = this.all.find((x) => x.id === id); if (s) s.archived = true;
  }
  async submit(sessionId: string, input: { userId: string; text: string }) {
    this.submits.push({ sessionId, ...input });
    return { text: `echo:${input.text}` };
  }
  activeCount(chat: ChatKey): number { return this.all.filter((s) => s.chat === this.#key(chat) && !s.archived).length; }
}

export const silentLog: ChannelLogger = { info() {}, warn() {}, error() {} };

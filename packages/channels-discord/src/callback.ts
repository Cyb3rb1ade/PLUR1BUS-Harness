import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

interface Pending {
  chatId: string;
  senders: ReadonlySet<string>;
  data: string;
  expires: number;
}
export type ConsumeResult = { ok: true; data: string } | { ok: false; reason: "invalid" | "expired" | "forbidden" };

/** Opaque, signed, single-use handles for `custom_id` (<= 100 chars; this one is 39). No approval data or identity goes on the
 *  wire. A press by a sender that is not bound to the handle is refused WITHOUT consuming it, so a bystander cannot burn it. */
export class CallbackSigner {
  readonly #key: string;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  constructor(key: string, now: () => number = Date.now) {
    this.#key = key;
    this.#now = now;
  }
  issue(input: { chatId: string; senders: readonly string[]; data: string; ttlMs: number }): string {
    if (!input.data || Buffer.byteLength(input.data) > 1024) throw new RangeError("callback data must be 1..1024 bytes");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 86_400_000)
      throw new RangeError("callback TTL must be 1 ms..24 h");
    if (input.senders.length === 0) throw new RangeError("callback needs at least one permitted sender");
    for (const [id, p] of this.#pending) if (p.expires <= this.#now()) this.#pending.delete(id);
    if (this.#pending.size >= 4000) throw new Error("too many pending callbacks");
    const id = randomBytes(12).toString("base64url");
    this.#pending.set(id, {
      chatId: input.chatId,
      senders: new Set(input.senders),
      data: input.data,
      expires: this.#now() + input.ttlMs,
    });
    return `${id}.${this.#mac(id)}`;
  }
  consume(wire: string, chatId: string, senderId: string): ConsumeResult {
    if (!/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/.test(wire)) return { ok: false, reason: "invalid" };
    const [id, mac] = wire.split(".") as [string, string];
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(this.#mac(id)))) return { ok: false, reason: "invalid" };
    const p = this.#pending.get(id);
    if (!p || p.chatId !== chatId) return { ok: false, reason: "invalid" };
    if (p.expires <= this.#now()) {
      this.#pending.delete(id);
      return { ok: false, reason: "expired" };
    }
    if (!p.senders.has(senderId)) return { ok: false, reason: "forbidden" };
    this.#pending.delete(id);
    return { ok: true, data: p.data };
  }
  revokeWhere(match: (data: string) => boolean): void {
    for (const [id, p] of this.#pending) if (match(p.data)) this.#pending.delete(id);
  }
  clear(): void {
    this.#pending.clear();
  }
  #mac(id: string): string {
    return createHmac("sha256", this.#key).update(id).digest("base64url").slice(0, 22);
  }
}

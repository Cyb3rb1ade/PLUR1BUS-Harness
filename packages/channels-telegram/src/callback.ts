import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
interface Pending {
  chatId: string;
  senderId?: string;
  data: string;
  expires: number;
}
/** Opaque, signed, single-use handles. No approval data or user identity goes onto Telegram's 64-byte wire field. */
export class CallbackSigner {
  readonly #key: string;
  readonly #now: () => number;
  readonly #pending = new Map<string, Pending>();
  constructor(key: string, now: () => number = Date.now) {
    this.#key = key;
    this.#now = now;
  }
  issue(input: { chatId: string; senderId?: string; data: string; ttlMs: number }): string {
    if (!input.data || Buffer.byteLength(input.data) > 1024)
      throw new RangeError("callback data must be 1..1024 bytes");
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > 86_400_000)
      throw new RangeError("callback TTL must be 1 ms..24 h");
    for (const [id, p] of this.#pending) if (p.expires <= this.#now()) this.#pending.delete(id);
    if (this.#pending.size >= 2000) throw new Error("too many pending callbacks");
    const id = randomBytes(12).toString("base64url");
    this.#pending.set(id, {
      chatId: input.chatId,
      data: input.data,
      expires: this.#now() + input.ttlMs,
      ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
    });
    return `${id}.${this.#mac(id)}`;
  }
  consume(wire: string, chatId: string, senderId: string): { data: string } | undefined {
    if (!/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/.test(wire)) return;
    const [id, mac] = wire.split(".") as [string, string];
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(this.#mac(id)))) return;
    const p = this.#pending.get(id);
    if (!p || p.expires <= this.#now() || p.chatId !== chatId || (p.senderId !== undefined && p.senderId !== senderId))
      return;
    this.#pending.delete(id);
    return { data: p.data };
  }
  clear(): void {
    this.#pending.clear();
  }
  #mac(id: string): string {
    return createHmac("sha256", this.#key).update(id).digest("base64url").slice(0, 22);
  }
}

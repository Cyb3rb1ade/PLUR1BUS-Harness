import { createHash, randomBytes } from 'node:crypto';
import { OpenAIError, Sensitive, type AuditPort, type ErrorCode } from '../openai-auth/ports.ts';
export interface LiveBinding { person: string; session: string; model: string; surface: string }
export interface MediaChannel { send(frame: Uint8Array): Promise<void>; close(): Promise<void> }
interface Entry { binding: LiveBinding; expiresAt: number; state: 'issued' | 'opening' | 'used' | 'revoked'; open: () => Promise<MediaChannel>; channel?: MediaChannel }
/** Random handles are unrelated to provider tokens; only their SHA-256 digest is retained. */
export class LiveHandles {
  readonly #o: { clock: () => number; ttlSeconds: number; audit: AuditPort }; readonly #entries = new Map<string, Entry>();
  constructor(options: { clock: () => number; ttlSeconds: number; audit: AuditPort }) { if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 600) throw new OpenAIError('invalid-request'); this.#o = options; }
  #key(handle: Sensitive) { return createHash('sha256').update(handle.value()).digest('hex'); }
  #deny(code: ErrorCode): never { this.#o.audit({ kind: 'handle-denied', code }); throw new OpenAIError(code); }
  issue(binding: LiveBinding, open: () => Promise<MediaChannel>) {
    if (Object.values(binding).some(v => typeof v !== 'string' || !v || v.length > 256) || binding.model !== 'gpt-live-1' || this.#entries.size >= 1024) throw new OpenAIError('invalid-request');
    const handle = new Sensitive(randomBytes(32).toString('base64url')), expiresAt = this.#o.clock() + this.#o.ttlSeconds * 1000;
    this.#o.audit({ kind: 'handle-issued' }); this.#entries.set(this.#key(handle), { binding: { ...binding }, expiresAt, state: 'issued', open });
    return { handle, expiresAt };
  }
  async redeem(handle: Sensitive, binding: LiveBinding): Promise<MediaChannel> {
    const entry = this.#entries.get(this.#key(handle)); if (!entry) return this.#deny('handle-unknown');
    if (Object.keys(entry.binding).some(k => entry.binding[k as keyof LiveBinding] !== binding[k as keyof LiveBinding])) return this.#deny('handle-binding');
    if (entry.state === 'revoked') return this.#deny('handle-revoked');
    if (entry.state !== 'issued') return this.#deny('handle-replay');
    if (entry.expiresAt <= this.#o.clock()) return this.#deny('handle-expired');
    entry.state = 'opening'; // claim synchronously before opening or budget admission
    this.#o.audit({ kind: 'handle-redeemed' });
    try {
      const channel = await entry.open();
      if (entry.state as string === 'revoked') { await channel.close(); return this.#deny('handle-revoked'); }
      entry.channel = channel; entry.state = 'used';
      return { send: frame => { if (entry.state === 'revoked') return Promise.reject(new OpenAIError('handle-revoked')); return channel.send(frame); }, close: () => this.#revoke(entry) };
    } catch (e) { entry.state = 'revoked'; throw e instanceof OpenAIError ? e : new OpenAIError('transport-failed'); }
  }
  async #revoke(entry: Entry) { entry.state = 'revoked'; await entry.channel?.close(); this.#o.audit({ kind: 'handle-revoked' }); }
  async revokeSession(session: string, person: string) { for (const entry of this.#entries.values()) if (entry.binding.session === session && entry.binding.person === person) await this.#revoke(entry); }
  async sweep() { for (const [key, entry] of this.#entries) if (entry.expiresAt <= this.#o.clock() && entry.state !== 'used' && entry.state !== 'opening') { await this.#revoke(entry); this.#entries.delete(key); } }
  async close() { for (const entry of this.#entries.values()) await this.#revoke(entry); this.#entries.clear(); }
}

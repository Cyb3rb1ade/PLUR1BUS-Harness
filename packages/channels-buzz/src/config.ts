import { decode } from './nostr.ts';
export interface BuzzConfig { enabled?: boolean; relays?: string[]; privateKeySecret?: string; senderAllowlist?: string[]; locale?: 'de' | 'en' }
export function publicKey(value: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  try { const decoded = decode(value); if (decoded.type === 'npub') return decoded.data; } catch {}
  throw new Error('invalid Buzz public key');
}
export function relayUrl(value: string): string {
  let u: URL; try { u = new URL(value); } catch { throw new Error('invalid Buzz relay'); }
  if (u.username || u.password || u.search || u.hash || !(u.protocol === 'wss:' || u.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(u.hostname))) throw new Error('invalid Buzz relay');
  return u.href;
}
export function resolveConfig(c: BuzzConfig) {
  if (Object.keys(c).some(k => !['enabled','relays','privateKeySecret','senderAllowlist','locale'].includes(k))) throw new Error('invalid Buzz configuration');
  if (!Array.isArray(c.relays) || c.relays.length < 1 || c.relays.length > 16 || !Array.isArray(c.senderAllowlist) || c.senderAllowlist.length > 256) throw new Error('invalid Buzz configuration');
  const secret = c.privateKeySecret ?? 'channels.buzz.private-key';
  if (!/^channels\.buzz\.[a-zA-Z0-9._-]+$/.test(secret)) throw new Error('invalid Buzz secret reference');
  return { relays: [...new Set(c.relays.map(relayUrl))], allow: new Set(c.senderAllowlist.map(publicKey)), secret, locale: c.locale ?? 'en' };
}

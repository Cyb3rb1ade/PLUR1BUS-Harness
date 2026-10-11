import { isIP } from 'node:net';
import { MediaError, failure } from './types.ts';
import type { ImageFormat } from './types.ts';
export function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (isIP(h) === 4) { const p = h.split('.').map(Number); return p[0] === 127 || p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31); }
  return isIP(h) === 6 && /^(fc|fd)/i.test(h);
}
export function checkedUrl(value: string): URL {
  let url: URL; try { url = new URL(value); } catch { throw new MediaError('unsupported_parameter'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new MediaError('unsupported_parameter');
  return url;
}
export function classify(status: number, body: unknown): MediaError {
  const text = JSON.stringify(body).toLowerCase();
  if (/content.policy|safety|moderation|nsfw|blocked|responsible.ai/.test(text)) return new MediaError('content_policy');
  if (status === 429 || status === 402) return new MediaError('quota');
  if (status === 413) return new MediaError('too_large');
  if (status === 400 || status === 422) return new MediaError('unsupported_parameter');
  return new MediaError('backend_unavailable');
}
export async function boundedBytes(response: Response, limit = 64 * 1024 * 1024): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new MediaError('too_large'); }
  if (!response.body) throw new MediaError('invalid_response');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  try { while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > limit) throw new MediaError('too_large'); parts.push(item.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(parts);
}
export class HttpTransport {
  readonly base: URL; readonly #key?: string; readonly timeoutMs: number; readonly downloadHosts: string[]; readonly authKind: 'Bearer' | 'Key' | 'google';
  constructor(base: string, key: string | undefined, timeoutMs = 120000, downloadHosts: string[] = [], authKind: HttpTransport['authKind'] = 'Bearer') {
    this.base = checkedUrl(base); if (key && privateHost(this.base.hostname)) throw new MediaError('unsupported_parameter');
    if (!privateHost(this.base.hostname) && this.base.protocol !== 'https:') throw new MediaError('unsupported_parameter');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new MediaError('unsupported_parameter');
    if (key) this.#key = key; this.timeoutMs = timeoutMs; this.downloadHosts = downloadHosts; this.authKind = authKind;
  }
  async json(path: string, body: unknown, signal: AbortSignal, method = body === undefined ? 'GET' : 'POST'): Promise<Record<string, unknown>> {
    const url = new URL(this.base.toString().replace(/\/$/, '') + '/' + path.replace(/^\//, ''));
    if (url.origin !== this.base.origin) throw new MediaError('unsupported_parameter');
    const headers: Record<string, string> = {};
    if (this.#key) { if (this.authKind === 'google') headers['x-goog-api-key'] = this.#key; else headers.authorization = `${this.authKind} ${this.#key}`; }
    const multipart = body instanceof FormData;
    if (body !== undefined && !multipart) headers['content-type'] = 'application/json';
    try {
      const response = await fetch(url, { method, headers, redirect: 'error', signal, ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }) });
      let json: unknown;
      try { json = JSON.parse(Buffer.from(await boundedBytes(response)).toString('utf8')); } catch (e) { if (e instanceof MediaError) throw e; if (!response.ok) throw classify(response.status, {}); throw new MediaError('invalid_response'); }
      if (!response.ok || (json as Record<string, unknown>)?.error) throw classify(response.status, json);
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new MediaError('invalid_response');
      return json as Record<string, unknown>;
    } catch (e) { throw failure(e, signal.aborted && signal.reason?.name !== 'TimeoutError' ? signal : undefined); }
  }
  /** Single-use lazy stream. Authenticated content is permitted only on the provider origin. */
  async *stream(value: string, signal: AbortSignal, authenticated = false): AsyncIterable<Uint8Array> {
    let url: URL; try { url = new URL(value); } catch { throw new MediaError('invalid_response'); }
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new MediaError('invalid_response');
    if (url.origin !== this.base.origin && (authenticated || !this.downloadHosts.includes(url.hostname) || privateHost(url.hostname) || url.protocol !== 'https:')) throw new MediaError('backend_unavailable');
    const headers: Record<string,string> = {};
    if (authenticated && this.#key) { if (this.authKind === 'google') headers['x-goog-api-key'] = this.#key; else headers.authorization = `${this.authKind} ${this.#key}`; }
    const response = await fetch(url, { signal, headers, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw classify(response.status, {}); }
    if (!response.body) throw new MediaError('invalid_response');
    const reader = response.body.getReader();
    try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; yield part.value; } }
    finally { await reader.cancel(); }
  }
  async image(value: string, format: ImageFormat, signal: AbortSignal): Promise<{ bytes: Uint8Array; format: ImageFormat }> {
    if (value.startsWith('data:')) {
      const m = /^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/.exec(value);
      if (!m) throw new MediaError('invalid_response');
      if (m[2]!.length > 90 * 1024 * 1024) throw new MediaError('too_large');
      return { bytes: Buffer.from(m[2]!, 'base64'), format: m[1] as ImageFormat };
    }
    if (!/^https?:/.test(value)) {
      if (!/^[A-Za-z0-9+/=]+$/.test(value)) throw new MediaError('invalid_response');
      if (value.length > 90 * 1024 * 1024) throw new MediaError('too_large');
      return { bytes: Buffer.from(value, 'base64'), format };
    }
    const url = new URL(value);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new MediaError('invalid_response');
    if (url.origin !== this.base.origin && (!this.downloadHosts.includes(url.hostname) || privateHost(url.hostname) || url.protocol !== 'https:')) throw new MediaError('backend_unavailable');
    try {
      // Never forward provider authorization to output URLs, even on the same host.
      const response = await fetch(url, { signal, redirect: 'error' }); if (!response.ok) throw classify(response.status, {});
      const mime = response.headers.get('content-type')?.split(';')[0];
      const actual = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/webp' ? 'webp' : format;
      return { bytes: await boundedBytes(response), format: actual };
    } catch (e) { throw failure(e, signal.aborted && signal.reason?.name !== 'TimeoutError' ? signal : undefined); }
  }
}

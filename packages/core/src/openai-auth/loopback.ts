import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Sensitive, OpenAIError, type PkcePort } from './ports.ts';
/** Forged callbacks answered with 400 per window before further ones get a bare 429; a valid callback is never throttled. */
const FORGED_PER_WINDOW = 10, FORGED_WINDOW_MS = 1000;
const digest = (value: string) => createHash('sha256').update(value).digest();
/**
 * Standalone port implementation for wiring later into auth/. Never binds wildcard, localhost or IPv6.
 * The one-shot listener is ended only by a callback that carries the exact `state` of the authorize URL it was given
 * (constant-time compare); any other request to the callback path gets a constant 400 and the listener stays open until a
 * valid callback, cancellation or the caller's deadline. The service still re-checks state, nonce and PKCE.
 */
export class LoopbackPkce implements PkcePort {
  readonly #open: (url: Sensitive) => Promise<void>;
  readonly #create: () => Server;
  readonly #now: () => number;
  #server: Server | undefined; #redirect = '';
  constructor(open: (url: Sensitive) => Promise<void>, create: () => Server = () => createServer(), now: () => number = Date.now) { this.#open = open; this.#create = create; this.#now = now; }
  async redirect(): Promise<string> {
    if (this.#server) throw new OpenAIError('invalid-request');
    const server = this.#create(); this.#server = server;
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); } catch { await this.close(); throw new OpenAIError('port-in-use'); }
    this.#redirect = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/auth/callback'; return this.#redirect;
  }
  async authorize(request: { url: Sensitive; redirectUri: string; signal: AbortSignal }): Promise<string> {
    const server = this.#server; if (!server || request.redirectUri !== this.#redirect) throw new OpenAIError('invalid-request');
    try {
      // The listener can only be bound to a login whose authorize URL carries exactly one non-empty state; otherwise fail closed.
      let states: string[]; try { states = new URL(request.url.value()).searchParams.getAll('state'); } catch { throw new OpenAIError('invalid-request'); }
      if (states.length !== 1 || !states[0]) throw new OpenAIError('invalid-request');
      const expected = digest(states[0]);
      return await new Promise<string>((resolve, reject) => {
        const fail = () => reject(new OpenAIError(request.signal.reason?.name === 'TimeoutError' ? 'login-timeout' : 'login-cancelled'));
        if (request.signal.aborted) { fail(); return; }
        request.signal.addEventListener('abort', fail, { once: true });
        let consumed = false, windowStart = 0, forged = 0;
        server.on('request', (req, res) => {
          res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('content-security-policy', "default-src 'none'");
          if (req.method !== 'GET' || req.headers.host !== new URL(this.#redirect).host || (req.headers.origin !== undefined && req.headers.origin !== new URL(this.#redirect).origin) || (req.headers['sec-fetch-site'] !== undefined && !['none','same-origin','cross-site'].includes(String(req.headers['sec-fetch-site']))) || new URL(req.url ?? '/', this.#redirect).pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
          if (consumed) { res.writeHead(410).end(); return; }
          const url = new URL(req.url!, this.#redirect), supplied = url.searchParams.getAll('state');
          // Hash both sides so the compare is constant-time regardless of length; always evaluated, never short-circuited.
          const sameState = timingSafeEqual(digest(supplied[0] ?? ''), expected);
          if (supplied.length !== 1 || !sameState || url.origin !== new URL(this.#redirect).origin) {
            const t = this.#now(); if (t - windowStart >= FORGED_WINDOW_MS) { windowStart = t; forged = 0; }
            if (++forged > FORGED_PER_WINDOW) { res.setHeader('retry-after', '1'); res.writeHead(429).end(); return; }
            res.writeHead(400).end('Invalid sign-in callback.'); return; // constant text: nothing from the request is echoed
          }
          consumed = true; const callback = url.href;
          res.writeHead(200).end('You may close this window.');
          request.signal.removeEventListener('abort', fail); resolve(callback);
        });
        void this.#open(request.url).catch(fail);
      });
    } finally { await this.close(); }
  }
  async close() { const server = this.#server; this.#server = undefined; if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
}

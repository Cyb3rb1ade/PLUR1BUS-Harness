import { createServer, type Server } from 'node:http';
import { Sensitive, OpenAIError, type PkcePort } from './ports.ts';
/** Standalone port implementation for wiring later into auth/. Never binds wildcard, localhost or IPv6. */
export class LoopbackPkce implements PkcePort {
  readonly #open: (url: Sensitive) => Promise<void>;
  readonly #create: () => Server;
  #server: Server | undefined; #redirect = '';
  constructor(open: (url: Sensitive) => Promise<void>, create: () => Server = () => createServer()) { this.#open = open; this.#create = create; }
  async redirect(): Promise<string> {
    if (this.#server) throw new OpenAIError('invalid-request');
    const server = this.#create(); this.#server = server;
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); } catch { await this.close(); throw new OpenAIError('transport-failed'); }
    this.#redirect = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/auth/callback'; return this.#redirect;
  }
  async authorize(request: { url: Sensitive; redirectUri: string; signal: AbortSignal }): Promise<string> {
    const server = this.#server; if (!server || request.redirectUri !== this.#redirect) throw new OpenAIError('invalid-request');
    try {
      return await new Promise<string>((resolve, reject) => {
        const fail = () => reject(new OpenAIError('auth-required'));
        if (request.signal.aborted) { fail(); return; }
        request.signal.addEventListener('abort', fail, { once: true });
        let consumed = false;
        server.on('request', (req, res) => {
          res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('content-security-policy', "default-src 'none'");
          if (req.method !== 'GET' || req.headers.host !== new URL(this.#redirect).host || new URL(req.url ?? '/', this.#redirect).pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
          if (consumed) { res.writeHead(410).end(); return; }
          consumed = true; const callback = new URL(req.url!, this.#redirect).href;
          res.writeHead(200).end('You may close this window.');
          request.signal.removeEventListener('abort', fail); resolve(callback);
        });
        void this.#open(request.url).catch(fail);
      });
    } finally { await this.close(); }
  }
  async close() { const server = this.#server; this.#server = undefined; if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
}

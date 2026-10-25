import { createServer } from 'node:http';
import { FakeOpenAI } from '../fixtures/openai/server.ts';
import { Sensitive } from '../../src/openai-auth/ports.ts';
import { wireFixture } from '../integration/wire-fixture.ts';
/** Real loopback HTTP endpoints behind canonical URL remapping; no request can reach OpenAI or DNS. */
export async function localOpenAI() {
  const fake = new FakeOpenAI(), wire = wireFixture('codex_responses', [{ text: 'plan answer' }]);
  let responses = 0; const bodies: Record<string, unknown>[] = [];
  // Diagnostics for a failed run: every exchange as time, method, path and outcome. No headers, bodies or query strings,
  // so no token or code can end up in an assertion message (openai-auth/system turned `transport-failed` once on Windows).
  const started = performance.now(), trace: string[] = [];
  const note = (line: string) => { if (trace.length < 200) trace.push(`+${Math.round(performance.now() - started)}ms ${line}`); };
  const server = createServer((req, res) => { void (async () => {
    const parts: Buffer[] = []; for await (const c of req) parts.push(Buffer.from(c)); const payload = Buffer.concat(parts).toString();
    const url = new URL(req.url!, fake.issuer);
    if (url.pathname === '/authorize') {
      const callback = await fake.authorize({ url: new Sensitive(url.href), redirectUri: url.searchParams.get('redirect_uri')!, signal: new AbortController().signal });
      res.writeHead(302, { location: callback }).end(); return;
    }
    if (url.pathname === '/v1/responses') {
      responses++; bodies.push(JSON.parse(payload));
      if (fake.errorCode) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '12' }).end(JSON.stringify({ error: { code: fake.errorCode, message: 'Bearer should-never-escape' } })); return; }
      const response = await wire.fetch(url, { body: payload }); res.writeHead(200, { 'content-type': 'text/event-stream' }).end(await response.text()); return;
    }
    const json = req.headers['content-type'] === 'application/json' && payload ? JSON.parse(payload) : undefined;
    const form = req.headers['content-type'] === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(payload)) : undefined;
    const result = await fake.request({ method: req.method as 'GET' | 'POST', url: url.href, ...(json ? { json } : {}), ...(form ? { form } : {}) });
    res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body));
  })().catch((e: unknown) => { note(`server ${req.method} ${new URL(req.url!, fake.issuer).pathname} threw ${failure(e)}`); res.writeHead(500).end('{}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(input instanceof Request ? input.url : String(input)); if (!['auth.openai.com','api.openai.com'].includes(u.hostname)) throw Error('external network refused');
    const what = `${init?.method ?? 'GET'} ${u.hostname}${u.pathname}`;
    try { const response = await fetch(origin + u.pathname + u.search, { ...init, redirect: 'manual' }); note(`${what} -> ${response.status}`); return response; }
    catch (e) { note(`${what} failed: ${failure(e)}`); throw e; }
  }) as typeof fetch;
  return { fake, transport, bodies, responses: () => responses, diagnostics: () => trace.join('\n'), async authorize(url: Sensitive, modify?: (callback: URL) => void) { const response = await transport(url.value()); assertLocation(response); const callback = new URL(response.headers.get('location')!); modify?.(callback); await fetch(callback); }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
/** The class of a failure, never its message: name, `code` and the same for each `cause` (undici puts the socket error there). */
function failure(e: unknown): string {
  const parts: string[] = [];
  for (let c: unknown = e, depth = 0; c instanceof Error && depth < 4; c = c.cause, depth++) {
    const code = (c as { code?: unknown }).code;
    parts.push(c.name + (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? ' ' + code : ''));
  }
  return parts.join(' <- ') || typeof e;
}
function assertLocation(response: Response) { if (response.status !== 302 || !response.headers.get('location')?.startsWith('http://127.0.0.1:')) throw Error('invalid fake callback'); }

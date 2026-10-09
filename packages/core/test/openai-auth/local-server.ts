import { createServer } from 'node:http';
import { FakeOpenAI } from '../fixtures/openai/server.ts';
import { Sensitive } from '../../src/openai-auth/ports.ts';
import { wireFixture } from '../integration/wire-fixture.ts';
/** Real loopback HTTP endpoints behind canonical URL remapping; no request can reach OpenAI or DNS. */
export async function localOpenAI() {
  const fake = new FakeOpenAI(), wire = wireFixture('codex_responses', [{ text: 'plan answer' }]);
  let responses = 0; const bodies: Record<string, unknown>[] = [];
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
  })().catch(() => res.writeHead(500).end('{}')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const transport = (async (input: string | URL | Request, init?: RequestInit) => { const u = new URL(input instanceof Request ? input.url : String(input)); if (!['auth.openai.com','api.openai.com'].includes(u.hostname)) throw Error('external network refused'); return fetch(origin + u.pathname + u.search, { ...init, redirect: 'manual' }); }) as typeof fetch;
  return { fake, transport, bodies, responses: () => responses, async authorize(url: Sensitive, modify?: (callback: URL) => void) { const response = await transport(url.value()); assertLocation(response); const callback = new URL(response.headers.get('location')!); modify?.(callback); await fetch(callback); }, async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
function assertLocation(response: Response) { if (response.status !== 302 || !response.headers.get('location')?.startsWith('http://127.0.0.1:')) throw Error('invalid fake callback'); }

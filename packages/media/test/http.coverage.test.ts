import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MediaError } from '../src/index.ts';
import { HttpTransport, checkedUrl, classify, boundedBytes, privateHost } from '../src/http.ts';

const code = (c: string) => (e: unknown) => e instanceof MediaError && e.code === c;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const OVER_64MB = 64 * 1024 * 1024 + 1;
const OVER_90MB_BASE64 = 90 * 1024 * 1024 + 1;
const signal = () => new AbortController().signal;

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
/** Loopback provider on an ephemeral port; every accepted socket gets setNoDelay(true). */
async function server(handler: Handler): Promise<{ base: string; close(): Promise<void> }> {
  const s = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    handler(req, res, body);
  });
  s.on('connection', socket => socket.setNoDelay(true));
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = (s.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }) };
}
function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, ...extra }); res.end(body);
}
type Call = { url: string; init: RequestInit | undefined };
/** Replaces fetch for one callback, so nothing leaves the process; the original is restored in finally. */
async function withFetch<T>(impl: (url: string) => Response | Promise<Response>, fn: (calls: Call[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch; const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => { const url = String(input); calls.push({ url, init }); return impl(url); }) as typeof fetch;
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('classify maps provider content to content_policy, then HTTP statuses to stable codes', () => {
  for (const text of ['content policy', 'safety system', 'moderation', 'NSFW content', 'blocked by filter', 'Responsible AI']) {
    assert.equal(classify(500, { message: text }).code, 'content_policy', text);
  }
  const statuses: [number, string][] = [[429, 'quota'], [402, 'quota'], [413, 'too_large'], [400, 'unsupported_parameter'], [422, 'unsupported_parameter'], [404, 'backend_unavailable'], [500, 'backend_unavailable'], [0, 'backend_unavailable']];
  for (const [status, expected] of statuses) assert.equal(classify(status, {}).code, expected, String(status));
  assert.equal(classify(429, { message: 'safety' }).code, 'content_policy'); // body text wins over status
});

test('checkedUrl returns a parsed http(s) URL and refuses credentials, query strings and fragments', () => {
  assert.equal(checkedUrl('HTTPS://Api.Example.com/v1/').href, 'https://api.example.com/v1/');
  assert.equal(checkedUrl('http://127.0.0.1:8080').port, '8080');
  for (const value of ['', 'example.com', 'mailto:a@b.c', 'https://user@example.com', 'https://:pw@example.com', 'https://example.com/?k=v', 'https://example.com/#f']) {
    assert.throws(() => checkedUrl(value), code('unsupported_parameter'), value);
  }
});

test('privateHost treats bracketed and mixed-case IPv6 unique-local as private, and public addresses as not', () => {
  assert.equal(privateHost('[fd12:3456::1]'), true);
  assert.equal(privateHost('FC00::9'), true);
  assert.equal(privateHost('2606:4700::1111'), false);
  assert.equal(privateHost('[::1]'), true);
  assert.equal(privateHost('example.localhost'), false);
});

test('boundedBytes accepts a body exactly at the limit and refuses one byte more, with or without a length header', async () => {
  assert.equal((await boundedBytes(new Response('abcd', { headers: { 'content-length': '4' } }), 4)).length, 4);
  await assert.rejects(boundedBytes(new Response('abcde'), 4), code('too_large'));
  await assert.rejects(boundedBytes(new Response('abcde', { headers: { 'content-length': '5' } }), 4), code('too_large'));
  assert.equal((await boundedBytes(new Response(new Uint8Array(0)))).length, 0);
});

test('the constructor sets defaults, accepts a public https base without a key, and refuses a timeout that is not a positive finite number', () => {
  const t = new HttpTransport('https://api.example.com', undefined);
  assert.equal(t.timeoutMs, 120000); assert.deepEqual(t.downloadHosts, []); assert.equal(t.authKind, 'Bearer');
  assert.equal(t.base.href, 'https://api.example.com/');
  assert.doesNotThrow(() => new HttpTransport('http://localhost:9', undefined));
  for (const timeout of [Number.POSITIVE_INFINITY, Number.NaN, -1, 0]) assert.throws(() => new HttpTransport('https://api.example.com', undefined, timeout), code('unsupported_parameter'), String(timeout));
  assert.throws(() => new HttpTransport('http://[fd00::1]', 'key'), code('unsupported_parameter'));
  assert.throws(() => new HttpTransport('http://api.example.com', undefined), code('unsupported_parameter')); // plain http only on private hosts
});

test('json() returns a 200 object, uses GET without a body and POST with one, and joins paths onto a base with a path', async () => {
  const seen: { method: string | undefined; url: string | undefined; type: string | undefined; body: string }[] = [];
  const srv = await server((req, res, body) => { seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body }); send(res, 200, '{"ok":true}'); });
  try {
    const t = new HttpTransport(`${srv.base}/v1/`, undefined);
    assert.deepEqual(await t.json('/models', undefined, signal()), { ok: true });
    assert.deepEqual(await t.json('images', { prompt: 'p' }, signal()), { ok: true });
    assert.deepEqual(await t.json('models', { prompt: 'p' }, signal(), 'PUT'), { ok: true });
    assert.deepEqual(seen.map(s => [s.method, s.url]), [['GET', '/v1/models'], ['POST', '/v1/images'], ['PUT', '/v1/models']]);
    assert.equal(seen[0]!.type, undefined);
    assert.equal(seen[1]!.type, 'application/json');
    assert.equal(JSON.parse(seen[1]!.body).prompt, 'p');
  } finally { await srv.close(); }
});

test('json() maps every failing HTTP status through classify, including a policy refusal sent with a 5xx', async () => {
  const srv = await server((req, res) => {
    const m = /^\/status\/(\d+)(\/policy)?$/.exec(req.url ?? '');
    if (!m) return send(res, 404, '{}');
    send(res, Number(m[1]), m[2] ? '{"error":{"message":"nsfw"}}' : '{}');
  });
  const cases: [number, boolean, string][] = [
    [400, false, 'unsupported_parameter'], [402, false, 'quota'], [404, false, 'backend_unavailable'], [413, false, 'too_large'],
    [422, false, 'unsupported_parameter'], [429, false, 'quota'], [500, false, 'backend_unavailable'], [503, true, 'content_policy'],
  ];
  try {
    const t = new HttpTransport(srv.base, undefined);
    for (const [status, policy, expected] of cases) {
      await assert.rejects(t.json(`status/${status}${policy ? '/policy' : ''}`, undefined, signal()), code(expected), `status ${status}`);
    }
  } finally { await srv.close(); }
});

test('json() treats a non-JSON error body as its status only, and never as a response', async () => {
  const srv = await server((_req, res) => send(res, 418, 'I am a teapot: secret-token-123', 'text/plain'));
  try {
    const error = await new HttpTransport(srv.base, undefined).json('x', undefined, signal()).then(() => undefined, (e: unknown) => e);
    assert.ok(error instanceof MediaError); assert.equal((error as MediaError).code, 'backend_unavailable');
    assert.equal(String(error).includes('secret-token-123'), false);
  } finally { await srv.close(); }
});

test('json() refuses 200 responses that are not a JSON object, and treats an error field as a failure', async () => {
  const bodies: Record<string, [string, string]> = {
    array: ['[1,2]', 'invalid_response'], null: ['null', 'invalid_response'], number: ['42', 'invalid_response'],
    text: ['not json', 'invalid_response'], errorField: ['{"error":"upstream"}', 'backend_unavailable'],
    policyError: ['{"error":{"message":"blocked by safety"}}', 'content_policy'],
  };
  const srv = await server((req, res) => { const entry = bodies[req.url!.slice(1)]; if (!entry) return send(res, 404, '{}'); send(res, 200, entry[0]); });
  try {
    const t = new HttpTransport(srv.base, undefined);
    for (const [name, [, expected]] of Object.entries(bodies)) await assert.rejects(t.json(name, undefined, signal()), code(expected), name);
  } finally { await srv.close(); }
});

test('json() maps a signal aborted by the caller to cancelled, and one aborted by a TimeoutError reason to timeout', async () => {
  const srv = await server((_req, res) => send(res, 200, '{}'));
  try {
    const t = new HttpTransport(srv.base, undefined);
    const caller = new AbortController(); caller.abort();
    await assert.rejects(t.json('x', undefined, caller.signal), code('cancelled'));
    const late = new AbortController(); late.abort(new DOMException('deadline', 'TimeoutError'));
    await assert.rejects(t.json('x', undefined, late.signal), code('timeout'));
  } finally { await srv.close(); }
});

test('json() sends the credential in the header the auth kind names, and never in the URL', async () => {
  const cases: [HttpTransport['authKind'], Record<string, string>][] = [
    ['Bearer', { authorization: 'Bearer key-value' }], ['Key', { authorization: 'Key key-value' }], ['google', { 'x-goog-api-key': 'key-value' }],
  ];
  for (const [kind, expected] of cases) {
    await withFetch(() => jsonResponse({}), async calls => {
      await new HttpTransport('https://api.example.com/v1', 'key-value', 120000, [], kind).json('models', undefined, signal());
      const headers = calls[0]!.init!.headers as Record<string, string>;
      for (const [name, value] of Object.entries(expected)) assert.equal(headers[name], value, `${kind} ${name}`);
      assert.equal(calls[0]!.url, 'https://api.example.com/v1/models');
      assert.equal(calls[0]!.url.includes('key-value'), false);
      assert.equal(calls[0]!.init!.redirect, 'error');
    });
  }
});

test('json() sends no auth header without a key, a JSON content type only with a body, and FormData untouched', async () => {
  await withFetch(() => jsonResponse({}), async calls => {
    const t = new HttpTransport('https://api.example.com', undefined);
    await t.json('a', undefined, signal());
    assert.deepEqual(calls[0]!.init!.headers, {});
    await t.json('b', { n: 1 }, signal());
    assert.deepEqual(calls[1]!.init!.headers, { 'content-type': 'application/json' });
    assert.equal(calls[1]!.init!.body, '{"n":1}');
    const form = new FormData(); form.set('file', 'x');
    await t.json('c', form, signal());
    assert.deepEqual(calls[2]!.init!.headers, {});
    assert.equal(calls[2]!.init!.body, form);
  });
});

test('json() turns a network failure from fetch into backend_unavailable', async () => {
  await withFetch(() => { throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443'); }, async () => {
    const error = await new HttpTransport('https://api.example.com', 'k').json('x', undefined, signal()).then(() => undefined, (e: unknown) => e);
    assert.equal((error as MediaError).code, 'backend_unavailable');
    assert.equal(String(error).includes('10.0.0.1'), false);
  });
});

test('image() decodes a data URL for each supported format and reports the declared format', async () => {
  const t = new HttpTransport('https://api.example.com', undefined);
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const out = await t.image(`data:image/${format};base64,${PNG.toString('base64')}`, 'png', signal());
    assert.equal(out.format, format); assert.deepEqual(Buffer.from(out.bytes), PNG);
  }
});

test('image() refuses malformed data URLs: other types, missing payload, illegal characters, and a missing base64 marker', async () => {
  const t = new HttpTransport('https://api.example.com', undefined);
  for (const value of ['data:image/gif;base64,AAAA', 'data:image/png;base64,', 'data:image/png;base64,AA AA', 'data:text/plain;base64,AAAA', 'data:image/png,AAAA', 'data:image/PNG;base64,AAAA']) {
    await assert.rejects(t.image(value, 'png', signal()), code('invalid_response'), value);
  }
});

test('image() refuses a data URL whose payload exceeds 90 MiB before decoding it', async () => {
  const t = new HttpTransport('https://api.example.com', undefined);
  await assert.rejects(t.image(`data:image/png;base64,${'A'.repeat(OVER_90MB_BASE64)}`, 'png', signal()), code('too_large'));
});

test('image() accepts raw base64 with the caller format, treats a value that merely starts with "http" as base64, and refuses junk', async () => {
  const t = new HttpTransport('https://api.example.com', undefined);
  const raw = await t.image(PNG.toString('base64'), 'webp', signal());
  assert.equal(raw.format, 'webp'); assert.deepEqual(Buffer.from(raw.bytes), PNG);
  assert.deepEqual(Buffer.from((await t.image('httpAAAA', 'png', signal())).bytes), Buffer.from('httpAAAA', 'base64'));
  for (const value of ['not base64!', '-_-', 'AA AA']) await assert.rejects(t.image(value, 'png', signal()), code('invalid_response'), value);
  await assert.rejects(t.image('A'.repeat(OVER_90MB_BASE64), 'png', signal()), code('too_large'));
});

test('image() downloads a same-origin URL and takes the format from a JPEG or WebP content type, else from the caller', async () => {
  const srv = await server((req, res) => {
    if (req.url === '/webp') return send(res, 200, PNG, 'image/webp');
    if (req.url === '/jpeg') return send(res, 200, PNG, 'image/jpeg; charset=binary');
    if (req.url === '/gif') return send(res, 200, PNG, 'image/gif');
    if (req.url === '/429') return send(res, 429, '{}');
    if (req.url === '/404') return send(res, 404, '{}');
    if (req.url === '/huge') return send(res, 200, '', 'image/png', { 'content-length': String(OVER_64MB) });
    send(res, 500, '{}');
  });
  try {
    const t = new HttpTransport(srv.base, undefined);
    const webp = await t.image(`${srv.base}/webp`, 'png', signal());
    assert.equal(webp.format, 'webp'); assert.deepEqual(Buffer.from(webp.bytes), PNG);
    assert.equal((await t.image(`${srv.base}/jpeg`, 'png', signal())).format, 'jpeg');
    assert.equal((await t.image(`${srv.base}/gif`, 'png', signal())).format, 'png');
    await assert.rejects(t.image(`${srv.base}/429`, 'png', signal()), code('quota'));
    await assert.rejects(t.image(`${srv.base}/404`, 'png', signal()), code('backend_unavailable'));
    await assert.rejects(t.image(`${srv.base}/huge`, 'png', signal()), code('too_large'));
  } finally { await srv.close(); }
});

test('image() refuses a URL with embedded credentials or a non-http scheme before any request', async () => {
  await withFetch(() => new Response(PNG), async calls => {
    const t = new HttpTransport('https://api.example.com', undefined);
    await assert.rejects(t.image('https://user@api.example.com/a.png', 'png', signal()), code('invalid_response'));
    await assert.rejects(t.image('https://user:pw@api.example.com/a.png', 'png', signal()), code('invalid_response'));
    assert.equal(calls.length, 0);
  });
});

test('image() refuses an output host that is not on the download allowlist, an allowed host over plain http, and an allowed private address', async () => {
  await withFetch(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }), async calls => {
    const t = new HttpTransport('https://api.example.com', 'k', 120000, ['cdn.example.com', '127.0.0.1']);
    await assert.rejects(t.image('https://other.example.net/a.png', 'png', signal()), code('backend_unavailable'));
    await assert.rejects(t.image('http://cdn.example.com/a.png', 'png', signal()), code('backend_unavailable'));
    await assert.rejects(t.image('https://127.0.0.1/a.png', 'png', signal()), code('backend_unavailable'));
    assert.equal(calls.length, 0);
  });
});

test('image() downloads an allowlisted https host without forwarding the provider credential, and maps fetch failures', async () => {
  await withFetch(() => new Response(PNG, { headers: { 'content-type': 'image/png' } }), async calls => {
    const t = new HttpTransport('https://api.example.com', 'secret-key', 120000, ['cdn.example.com']);
    const out = await t.image('https://cdn.example.com/a.png', 'png', signal());
    assert.deepEqual(Buffer.from(out.bytes), PNG);
    assert.equal(calls[0]!.url, 'https://cdn.example.com/a.png');
    assert.equal(calls[0]!.init!.headers, undefined);
    assert.equal(calls[0]!.init!.redirect, 'error');
  });
  await withFetch(() => { throw new TypeError('socket hang up'); }, async () => {
    const t = new HttpTransport('https://api.example.com', undefined, 120000, ['cdn.example.com']);
    await assert.rejects(t.image('https://cdn.example.com/a.png', 'png', signal()), code('backend_unavailable'));
  });
});

test('image() reports a caller abort as cancelled and a TimeoutError reason as timeout, without leaking the URL', async () => {
  const srv = await server((_req, res) => send(res, 200, PNG, 'image/png'));
  try {
    const t = new HttpTransport(srv.base, undefined);
    await assert.rejects(t.image(`${srv.base}/a.png`, 'png', AbortSignal.abort()), code('cancelled'));
    const late = AbortSignal.abort(new DOMException('deadline', 'TimeoutError'));
    const error = await t.image(`${srv.base}/a.png`, 'png', late).then(() => undefined, (e: unknown) => e);
    assert.equal((error as MediaError).code, 'timeout');
    assert.equal(String(error).includes(srv.base), false);
  } finally { await srv.close(); }
});

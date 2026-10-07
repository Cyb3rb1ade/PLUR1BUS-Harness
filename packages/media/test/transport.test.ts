import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport, privateHost, checkedUrl, boundedBytes, classify } from '../src/http.ts';
import { MediaError } from '../src/index.ts';
test('local address boundary and credential refusal', () => {
  for (const host of ['localhost', '127.0.0.1', '10.2.3.4', '192.168.1.1', '172.16.0.1', '172.31.1.1', '::1', '[::1]', 'fd00::1', 'fc00::2']) assert.equal(privateHost(host), true);
  for (const host of ['example.com', '172.15.1.1', '172.32.1.1', '192.169.1.1', '8.8.8.8', '2001:4860::1']) assert.equal(privateHost(host), false);
  for (const url of ['not a URL', 'ftp://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com#secret']) assert.throws(() => checkedUrl(url), MediaError);
  assert.throws(() => new HttpTransport('http://example.com', undefined));
  assert.throws(() => new HttpTransport('http://127.0.0.1', 'secret'));
  assert.throws(() => new HttpTransport('https://example.com', undefined, 0));
  for (const kind of ['Bearer', 'Key', 'google'] as const) assert.equal(new HttpTransport('https://example.com', 'dummy-test-value', 100, ['cdn.example.com'], kind).authKind, kind);
});
test('bounded streaming refuses advertised and streamed oversize', async () => {
  await assert.rejects(boundedBytes(new Response('large', { headers: { 'content-length': '100' } }), 2), (e: unknown) => e instanceof MediaError && e.code === 'too_large');
  await assert.rejects(boundedBytes(new Response('large'), 2));
  await assert.rejects(boundedBytes(new Response(null)));
  assert.equal(Buffer.from(await boundedBytes(new Response('ok'), 2)).toString(), 'ok');
  assert.equal(classify(402, {}).code, 'quota'); assert.equal(classify(422, {}).code, 'unsupported_parameter');
});
test('image decoding and format boundaries without network', async () => {
  const transport = new HttpTransport('http://127.0.0.1', undefined); const signal = new AbortController().signal;
  for (const value of ['data:image/svg+xml;base64,AAAA', '%%%', 'data:image/png;base64,', 'http://user:secret@127.0.0.1/image', 'https://127.0.0.2/image']) await assert.rejects(transport.image(value, 'png', signal));
  const image = await transport.image('data:image/webp;base64,aW1hZ2U=', 'png', signal); assert.equal(image.format, 'webp');
});
test('non-JSON service failures keep transport taxonomy and sanitized errors', async () => {
  const { createServer } = await import('node:http');
  const s = createServer((_req, res) => { res.writeHead(503); res.end('<html>upstream unavailable secret-123</html>'); });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  const address = s.address() as import('node:net').AddressInfo;
  try { await assert.rejects(new HttpTransport(`http://127.0.0.1:${address.port}`, undefined).json('test', {}, new AbortController().signal), (e: unknown) => e instanceof MediaError && e.code === 'backend_unavailable' && !String(e).includes('secret')); }
  finally { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); }
});

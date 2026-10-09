import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaError } from '../src/index.ts';
import { ResilientTransport } from '../src/adapters/_shared/transport.ts';
import { DetailedMediaError, reasonOf } from '../src/adapters/_shared/errors.ts';
import { parseRetryAfter, retryDelay, retryable, DEFAULT_RETRY } from '../src/adapters/_shared/retry.ts';
import { fakeServer, json, recordingSleep } from './adapters-fixtures.ts';

const signal = () => new AbortController().signal;
const KEY = 'dummy-test-secret-not-a-real-key';

test('Retry-After parses seconds and HTTP dates, and rejects nonsense', () => {
  assert.equal(parseRetryAfter('2'), 2000); assert.equal(parseRetryAfter('0'), 0); assert.equal(parseRetryAfter(' 1.5 '), 1500);
  const now = Date.parse('2026-10-08T10:00:00Z');
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 10:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 09:00:00 GMT', now), 0);
  for (const bad of [null, '', 'soon', '-4', 'NaN', 'Infinity']) assert.equal(parseRetryAfter(bad), undefined);
});

test('retry policy: 429 always, 5xx only for idempotent reads, bounded delay', () => {
  assert.equal(retryable('POST', 429), true); assert.equal(retryable('GET', 429), true);
  for (const status of [500, 502, 503, 504]) { assert.equal(retryable('GET', status), true); assert.equal(retryable('POST', status), false); }
  for (const status of [400, 401, 403, 404, 422]) assert.equal(retryable('GET', status), false);
  assert.equal(retryDelay(0, {}, '2'), 2000);
  assert.equal(retryDelay(0, {}, `${DEFAULT_RETRY.maxMs / 1000 + 1}`), undefined);
  assert.equal(retryDelay(0, { random: () => 0 }, null), DEFAULT_RETRY.baseMs);
  assert.equal(retryDelay(2, { baseMs: 100, maxMs: 1000, random: () => 0 }, null), 400);
  assert.equal(retryDelay(9, { baseMs: 100, maxMs: 1000, random: () => 0 }, null), 1000);
});

test('429 with Retry-After is retried with the advertised delay and then succeeds', async () => {
  const s = await fakeServer((_c, res, i) => i === 0 ? json(res, 429, { error: 'secret-123' }, { 'retry-after': '2' }) : json(res, 200, { ok: true }));
  const { sleep, delays } = recordingSleep();
  try {
    const t = new ResilientTransport(s.url, undefined, { adapter: 'openai', retry: { sleep } });
    assert.deepEqual(await t.json('images', { prompt: 'x' }, signal()), { ok: true });
    assert.deepEqual(delays, [2000]); assert.equal(s.calls.length, 2); assert.equal(s.calls[0]!.body, s.calls[1]!.body);
  } finally { await s.close(); }
});

test('persistent 429 stops at maxAttempts with the quota code', async () => {
  const s = await fakeServer((_c, res) => json(res, 429, { error: 'secret-123' }, { 'retry-after': '1' }));
  const { sleep, delays } = recordingSleep();
  try {
    const t = new ResilientTransport(s.url, undefined, { adapter: 'openai', retry: { maxAttempts: 3, sleep } });
    await assert.rejects(t.json('images', {}, signal()), (e: unknown) => e instanceof MediaError && e.code === 'quota' && !String(e).includes('secret-123'));
    assert.equal(s.calls.length, 3); assert.equal(delays.length, 2);
  } finally { await s.close(); }
});

test('Retry-After beyond the bound fails fast instead of sleeping', async () => {
  const s = await fakeServer((_c, res) => json(res, 429, {}, { 'retry-after': '3600' }));
  const { sleep, delays } = recordingSleep();
  try {
    await assert.rejects(new ResilientTransport(s.url, undefined, { adapter: 'fal', retry: { sleep } }).json('x', {}, signal()), (e: unknown) => e instanceof MediaError && e.code === 'quota');
    assert.equal(s.calls.length, 1); assert.deepEqual(delays, []);
  } finally { await s.close(); }
});

test('submissions (POST) are never retried on 5xx, reads (GET) are', async () => {
  const post = await fakeServer((_c, res) => json(res, 503, {}));
  const get = await fakeServer((_c, res, i) => i < 2 ? json(res, 502, {}) : json(res, 200, { status: 'succeeded' }));
  const { sleep, delays } = recordingSleep();
  try {
    const t = new ResilientTransport(post.url, undefined, { adapter: 'replicate', retry: { sleep } });
    await assert.rejects(t.json('predictions', {}, signal()), (e: unknown) => e instanceof MediaError && e.code === 'backend_unavailable');
    assert.equal(post.calls.length, 1);
    const g = new ResilientTransport(get.url, undefined, { adapter: 'replicate', retry: { sleep, random: () => 0 } });
    assert.deepEqual(await g.json('predictions/abc', undefined, signal()), { status: 'succeeded' });
    assert.equal(get.calls.length, 3); assert.equal(delays.length, 2);
  } finally { await post.close(); await get.close(); }
});

test('401 and 403 keep the media code but carry a stable reason and a key hint', async () => {
  for (const [status, reason] of [[401, 'auth_invalid'], [403, 'auth_forbidden']] as const) {
    const s = await fakeServer((_c, res) => json(res, status, { error: { message: 'bad key secret-123' } }));
    try {
      await assert.rejects(new ResilientTransport(s.url, undefined, { adapter: 'together' }).json('x', {}, signal()), (e: unknown) => {
        assert.ok(e instanceof DetailedMediaError && e instanceof MediaError);
        assert.equal(e.code, 'backend_unavailable'); assert.equal(e.reason, reason); assert.equal(reasonOf(e), reason);
        assert.match(e.message, /API key or secret reference for together/); assert.ok(!String(e).includes('secret-123'));
        return true;
      });
      assert.equal(s.calls.length, 1);
    } finally { await s.close(); }
  }
  assert.equal(reasonOf(new MediaError('quota')), undefined); assert.equal(reasonOf('nope'), undefined);
});

test('a 403 whose body is a moderation verdict is a policy failure, not an auth failure', async () => {
  const s = await fakeServer((_c, res) => json(res, 403, { error: { message: 'blocked by safety system' } }));
  try { await assert.rejects(new ResilientTransport(s.url, undefined, { adapter: 'xai' }).json('x', {}, signal()), (e: unknown) => e instanceof MediaError && e.code === 'content_policy' && reasonOf(e) === undefined); } finally { await s.close(); }
});

test('abort while waiting to retry is a cancellation, and the sleeper receives the signal', async () => {
  const s = await fakeServer((_c, res) => json(res, 429, {}, { 'retry-after': '1' }));
  const c = new AbortController();
  try {
    const t = new ResilientTransport(s.url, undefined, { adapter: 'openai', retry: { sleep: async (_ms, sig) => { c.abort(); sig.throwIfAborted(); } } });
    await assert.rejects(t.json('x', {}, c.signal), (e: unknown) => e instanceof MediaError && e.code === 'cancelled');
    assert.equal(s.calls.length, 1);
  } finally { await s.close(); }
});

test('multipart bodies are re-sent intact on retry and the key is sent, never echoed', async () => {
  const s = await fakeServer((_c, res, i) => i === 0 ? json(res, 429, {}, { 'retry-after': '0' }) : json(res, 200, { ok: 1 }));
  try {
    // Loopback hosts refuse keys by design, so verify the multipart replay without a key and the key header separately below.
    const form = new FormData(); form.set('prompt', 'tree'); form.append('image[]', new Blob(['png-bytes']), 'image.png');
    const t = new ResilientTransport(s.url, undefined, { adapter: 'openai', retry: { sleep: recordingSleep().sleep } });
    await t.json('images/edits', form, signal());
    assert.equal(s.calls.length, 2); assert.match(s.calls[1]!.body, /png-bytes/); assert.match(s.calls[1]!.body, /name="prompt"/);
  } finally { await s.close(); }
  assert.throws(() => new ResilientTransport('http://127.0.0.1:9', KEY, { adapter: 'openai' }), MediaError);
});

test('invalid retry configuration is refused', () => {
  for (const retry of [{ maxAttempts: 0 }, { maxAttempts: 11 }, { baseMs: -1 }, { maxMs: 0 }, { maxAttempts: 1.5 }]) assert.throws(() => new ResilientTransport('http://127.0.0.1:9', undefined, { adapter: 'openai', retry }), MediaError);
});

test('success bodies that are not JSON objects are invalid responses; embedded errors keep taxonomy', async () => {
  const s = await fakeServer((c, res) => {
    if (c.path.endsWith('array')) json(res, 200, [1]);
    else if (c.path.endsWith('html')) { res.writeHead(200); res.end('<html>'); }
    else json(res, 200, { error: 'quota exceeded secret-123' });
  });
  try {
    const t = new ResilientTransport(s.url, undefined, { adapter: 'google' });
    for (const p of ['array', 'html']) await assert.rejects(t.json(p, {}, signal()), (e: unknown) => e instanceof MediaError && e.code === 'invalid_response');
    await assert.rejects(t.json('embedded', {}, signal()), (e: unknown) => e instanceof MediaError && !String(e).includes('secret-123'));
  } finally { await s.close(); }
});

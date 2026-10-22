import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { LoopbackPkce, Sensitive } from '../../src/openai-auth/index.ts';
/** Fake native listener: verifies bind and lifecycle without creating a socket. */
class Listener extends EventEmitter {
  bound: unknown[] = []; closed = false;
  listen(port: number, host: string, cb: () => void) { this.bound = [port,host]; cb(); }
  address() { return { port: 54321 }; }
  closeAllConnections() {}
  close(cb: () => void) { this.closed = true; cb(); }
}
test('loopback binds only 127.0.0.1 and closes after callback; no network', async () => {
  const native = new Listener(); const l = new LoopbackPkce(async () => { const res = { setHeader() {}, writeHead() { return this; }, end() {} }; native.emit('request', { method: 'GET', headers: { host: '127.0.0.1:54321' }, url: '/auth/callback?state=test&code=test' }, res); }, () => native as unknown as Server);
  const redirect = await l.redirect(); assert.deepEqual(native.bound, [0,'127.0.0.1']); assert.equal(redirect, 'http://127.0.0.1:54321/auth/callback');
  assert.match(await l.authorize({ url: new Sensitive('https://auth.openai.com/authorize?state=test'), redirectUri: redirect, signal: new AbortController().signal }), /code=test/); assert.ok(native.closed);
});
test('loopback abort closes listener, rejects hung browser port', async () => { const native = new Listener(), abort = new AbortController(); const l = new LoopbackPkce(async () => { abort.abort(); }, () => native as unknown as Server); const redirect = await l.redirect(); await assert.rejects(l.authorize({ url: new Sensitive('https://auth.openai.com/authorize?state=test'), redirectUri: redirect, signal: abort.signal }), { code: 'login-cancelled' }); assert.ok(native.closed); });

/** Drives the listener through its request handler: records the status and body each caller would have seen. */
function drive(native: Listener, url: string, host = '127.0.0.1:54321') {
  const seen: { status?: number; body: string; headers: Record<string, string> } = { body: '', headers: {} };
  const res = { setHeader(k: string, v: string) { seen.headers[k] = v; }, writeHead(status: number) { seen.status = status; return this; }, end(body?: string) { seen.body = body ?? ''; } };
  native.emit('request', { method: 'GET', headers: { host }, url }, res);
  return seen;
}
const STATE = 'issued-state-0123456789';
const authorizeUrl = () => new Sensitive('https://auth.openai.com/authorize?state=' + STATE);
async function listening(now?: () => number) {
  const native = new Listener(); const abort = new AbortController();
  const l = new LoopbackPkce(async () => {}, () => native as unknown as Server, now);
  const redirect = await l.redirect();
  const outcome = l.authorize({ url: authorizeUrl(), redirectUri: redirect, signal: abort.signal }).then(value => ({ value }), (error: unknown) => ({ error }));
  return { native, abort, outcome, settled: () => Promise.race([outcome.then(() => true), new Promise<boolean>(r => setImmediate(() => r(false)))]) };
}

test('loopback: a valid callback after three forged ones still completes the login', async () => {
  const { native, outcome, settled } = await listening();
  const forged = ['/auth/callback?state=wrong&code=forged-code', '/auth/callback?code=forged-code', '/auth/callback?state=' + STATE + '&state=' + STATE + '&code=forged-code'];
  for (const url of forged) {
    const seen = drive(native, url);
    assert.equal(seen.status, 400); assert.equal(await settled(), false); assert.equal(native.closed, false);
    assert.doesNotMatch(seen.body, /forged|wrong|state|issued/i); // constant refusal text, nothing echoed
  }
  const ok = drive(native, '/auth/callback?state=' + STATE + '&code=real-code');
  assert.equal(ok.status, 200);
  const result = await outcome as { value?: string }; assert.match(result.value ?? '', /code=real-code/); assert.ok(native.closed);
});

test('loopback: same length but different state and a foreign request-target authority are refused too', async () => {
  const { native, outcome, settled } = await listening();
  assert.equal(drive(native, '/auth/callback?state=' + 'x'.repeat(STATE.length) + '&code=c').status, 400);
  assert.equal(drive(native, '/auth/callback?state=' + STATE.slice(0, -1) + '&code=c').status, 400);
  assert.equal(drive(native, '//evil.invalid/auth/callback?state=' + STATE + '&code=c').status, 400);
  assert.equal(await settled(), false);
  assert.equal(drive(native, '/auth/callback?state=' + STATE + '&code=c').status, 200); await outcome;
});

test('loopback: forged requests never end the listener early; the existing timeout still does', async () => {
  const { native, abort, outcome, settled } = await listening();
  for (let i = 0; i < 3; i++) assert.equal(drive(native, '/auth/callback?state=wrong&code=forged').status, 400);
  assert.equal(await settled(), false); assert.equal(native.closed, false);
  abort.abort(new DOMException('deadline', 'TimeoutError'));
  const result = await outcome as { error?: { code?: string } }; assert.equal(result.error?.code, 'login-timeout'); assert.ok(native.closed);
});

test('loopback: forged requests are rate limited (429) without closing the listener; a valid callback is never throttled', async () => {
  let t = 1_000; const { native, outcome, settled } = await listening(() => t);
  const statuses = Array.from({ length: 15 }, () => drive(native, '/auth/callback?state=wrong&code=forged'));
  assert.deepEqual(statuses.map(s => s.status), [...Array(10).fill(400), ...Array(5).fill(429)]);
  assert.equal(statuses[14]!.headers['retry-after'], '1'); assert.equal(statuses[14]!.body, '');
  assert.equal(await settled(), false);
  t += 1_000; assert.equal(drive(native, '/auth/callback?state=wrong').status, 400); // budget refills each window
  for (let i = 0; i < 20; i++) drive(native, '/auth/callback?state=wrong');
  assert.equal(drive(native, '/auth/callback?state=' + STATE + '&code=real').status, 200); // valid even with the budget spent
  await outcome; assert.ok(native.closed);
});

test('loopback: an authorize URL without exactly one state cannot be bound and fails closed', async () => {
  for (const url of ['https://auth.openai.com/authorize', 'https://auth.openai.com/authorize?state=', 'https://auth.openai.com/authorize?state=a&state=b']) {
    const native = new Listener(); const l = new LoopbackPkce(async () => {}, () => native as unknown as Server); const redirect = await l.redirect();
    await assert.rejects(l.authorize({ url: new Sensitive(url), redirectUri: redirect, signal: new AbortController().signal }), { code: 'invalid-request' }); assert.ok(native.closed);
  }
});

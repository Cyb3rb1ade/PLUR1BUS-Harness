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
  assert.match(await l.authorize({ url: new Sensitive('https://auth.openai.com/authorize'), redirectUri: redirect, signal: new AbortController().signal }), /code=test/); assert.ok(native.closed);
});
test('loopback abort closes listener, rejects hung browser port', async () => { const native = new Listener(), abort = new AbortController(); const l = new LoopbackPkce(async () => { abort.abort(); }, () => native as unknown as Server); const redirect = await l.redirect(); await assert.rejects(l.authorize({ url: new Sensitive('https://auth.openai.com/authorize'), redirectUri: redirect, signal: abort.signal })); assert.ok(native.closed); });

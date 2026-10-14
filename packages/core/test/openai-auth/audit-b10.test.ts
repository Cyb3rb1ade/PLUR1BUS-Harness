import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatGPTPlan, HostIdentity, JwksVerifier, AuthService, createOpenAIHttp, FederatedCredential, call } from '../../src/openai-auth/index.ts';
import { FakeOpenAI, FakeRefreshOwner, MemorySecrets } from '../fixtures/openai/server.ts';
import { localOpenAI } from './local-server.ts';
const principal = { owner: 'owner', user: 'owner', agentOwner: 'owner', deployment: 'local' as const };
const noEgress = { decide: async () => { throw Error('DNS forbidden'); } };

test('call(): re-using or freezing a request object does not leak a raw TypeError', async () => {
  const http = { request: async () => ({ status: 200, body: { ok: true } }) };
  const request = { method: 'GET' as const, url: 'https://api.openai.com/v1/models' };
  await call(http, request); await call(http, request);
  await assert.doesNotReject(call(http, Object.freeze({ method: 'GET' as const, url: 'https://api.openai.com/v1/models' })));
});

test('login closes the PKCE listener when the redirect is rejected before authorize()', async () => {
  const server = new FakeOpenAI(), store = new MemorySecrets(), owner = new FakeRefreshOwner(); let closed = 0;
  const pkce = { redirect: async () => 'http://localhost:49152/auth/callback', close: async () => { closed++; }, authorize: server.authorize.bind(server) };
  const plan = new ChatGPTPlan({ http: server, pkce, store, owner, clock: { now: () => server.now }, host: new HostIdentity(store, owner), verifier: new JwksVerifier(server, { now: () => server.now }), audit: () => {} });
  await assert.rejects(plan.login('a', principal), { code: 'invalid-request' });
  assert.equal(closed, 1);
});

test('HTTP timeouts surface as transport-failed, not as a login timeout', async () => {
  const http = createOpenAIHttp({ egress: noEgress, timeoutMs: 20, fetch: (() => new Promise(() => {})) as unknown as typeof fetch });
  await assert.rejects(http.request({ method: 'GET', url: 'https://api.openai.com/v1/models' }), { code: 'transport-failed' });
});

// Binding the listener to the issued state would stop a stray local/cross-site GET from burning the single-use callback,
// but the existing contract (store-and-errors: wrong state surfaces as state-mismatch) needs the first request consumed.
test.todo('KNOWN GAP: a forged callback request consumes the one-shot loopback listener (login DoS, no credential exposure)');

test('service: completed but never-awaited logins do not exhaust the pending-login cap', async () => {
  const local = await localOpenAI(); const auth = new AuthService({ store: new MemorySecrets(), http: createOpenAIHttp({ egress: noEgress, fetch: local.transport }), clock: { now: () => local.fake.now }, audit: () => {} });
  try {
    for (let i = 0; i < 20; i++) {
      local.fake.account = 'account-' + i;
      const login = await auth.startLogin({ principal }); await local.authorize(login.authorizeUrl);
      await new Promise(r => setTimeout(r, 30));
    }
  } finally { await auth.close(); await local.close(); }
});

test('federated: close() during an in-flight lease is not undone by that lease', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'b10-fed-'));
  try {
    const file = join(dir, 't.json'); await writeFile(file, JSON.stringify({ access_token: 'synthetic-b10-token', expires_at: 5000 }));
    const credential = new FederatedCredential({ file }, () => 1_000_000);
    const pending = credential.lease(); credential.close(); await assert.rejects(pending, { code: 'auth-required' });
    await rm(file); await assert.rejects(credential.lease(), { code: 'auth-required' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

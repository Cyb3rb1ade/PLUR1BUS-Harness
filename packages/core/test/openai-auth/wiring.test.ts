import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthService, SerialOwner } from '../../src/openai-auth/service.ts';
import { FakeOpenAI, MemorySecrets } from '../fixtures/openai/server.ts';
const principal = { owner: 'owner', user: 'owner', agentOwner: 'owner', deployment: 'local' as const };
test('AuthService login persists metadata, ten leases refresh once, restart and logout', async () => {
  const fake = new FakeOpenAI(), store = new MemorySecrets(), owner = new SerialOwner(), events: unknown[] = [];
  const options = { store, owner, http: fake, clock: { now: () => fake.now }, audit: (e: unknown) => { events.push(e); }, pkce: () => fake };
  const auth = new AuthService(options);
  const start = await auth.startLogin({ principal });
  assert.ok(start.authorizeUrl); const credential = await auth.awaitLogin(start.loginId, principal);
  assert.equal(credential.person, 'owner'); assert.equal(credential.workspace, 'workspace-test');
  fake.now += 3500000;
  await Promise.all(Array.from({ length: 10 }, () => auth.lease(credential.id, principal)));
  assert.equal(fake.refreshCount, 1);
  const restarted = new AuthService(options);
  assert.equal((await restarted.listCredentials(principal)).length, 1);
  await restarted.logout(credential.id, principal);
  assert.deepEqual(await auth.listCredentials(principal), []);
  for (const value of fake.secrets) assert.equal(JSON.stringify(events).includes(value), false);
  await auth.close(); await restarted.close();
});
test('logout deletes local credential even if discovery/revocation is unreachable', async () => {
  const fake = new FakeOpenAI(), store = new MemorySecrets(); const auth = new AuthService({store,http:fake,pkce:()=>fake,clock:{now:()=>fake.now},audit:()=>{}});
  const login = await auth.startLogin({principal}); const info = await auth.awaitLogin(login.loginId,principal);
  fake.failPath = '/.well-known/openid-configuration'; await assert.rejects(auth.logout(info.id,principal)); assert.equal([...store.data.keys()].some(k=>k==='openai.plan.'+info.id),false); await auth.close();
});

test('superseded OpenAI credential route is not loadable even under a different auth kind', async () => {
  const { validateProfile } = await import('../../src/auth/profile.ts');
  assert.throws(() => validateProfile({ id: 'openai:chatgpt-oauth-restricted', display_name: 'Retired', kind: 'api_key', capabilities: ['chat'], auth_header_scheme: 'Authorization: Bearer {token}', policy_status: 'restricted', policy_source: 'D110', policy_checked: '2026-10-08' }), { code: 'invalid_profile' });
});

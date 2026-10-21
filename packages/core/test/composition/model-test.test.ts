import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testModel } from '../../src/composition/model-test.ts';
import { RpcError } from '../../src/rpc/errors.ts';
import { scriptedAdapter, turnFixture, useTempDirs, TURN_PRINCIPAL } from './helpers.ts';
const tmp = useTempDirs('p1b-model-probe-');
test('model probe selects only the requested candidate, caps output and charges the real budget', async () => {
  const s = scriptedAdapter([{ text: 'OK' }]);
  const profiles = { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: s.adapter }] };
  let fixture: ReturnType<typeof turnFixture> | undefined;
  let admissions = 0;
  try {
    const result = await testModel('fixture/gpt-4.1', profiles, selected => {
      assert.deepEqual(Object.keys(selected), ['probe']);
      fixture = turnFixture(s.adapter, { profiles: selected, profile: 'probe', maxRounds: 1 }, tmp.make());
      const before = fixture.budget.checkBeforeCall.bind(fixture.budget);
      fixture.budget.checkBeforeCall = request => { admissions++; assert.equal(request.principal, TURN_PRINCIPAL); assert.equal(request.maxOutputTokens, 16); return before(request); };
      return fixture.provider;
    }, TURN_PRINCIPAL, 'a1', new AbortController().signal);
    assert.equal(result.ok, true);
    assert.equal(s.requests.length, 1);
    assert.equal(admissions, 1);
    assert.equal(s.requests[0]!.maxTokens, 16);
    assert.deepEqual(s.requests[0]!.tools, []);
    assert.equal(fixture!.stored.length, 0);
  } finally { fixture?.close(); }
});
test('an unconfigured model never constructs a provider or falls back', async () => {
  await assert.rejects(() => testModel('missing/model', {}, () => { throw new Error('must not run'); }, TURN_PRINCIPAL, 'a1', new AbortController().signal), (e: unknown) => e instanceof RpcError && e.reason === 'model-not-configured');
});
test('provider error text never leaves the probe boundary', async () => {
  const s = scriptedAdapter([{ text: 'unused' }]);
  await assert.rejects(() => testModel('p/m', { p: [{ provider: 'p', model: 'm', adapter: s.adapter }] }, () => ({ id: 'fake', async *stream() { throw new Error('private-provider-response'); } }), TURN_PRINCIPAL, 'a1', new AbortController().signal), (e: unknown) => e instanceof RpcError && e.reason === 'model-test-failed' && !e.message.includes('private-provider-response'));
});
test('privacy.localOnly: probing a cloud model is refused with E_DENIED local-only before a provider exists or a request leaves', async () => {
  const s = scriptedAdapter([{ text: 'OK' }]);
  const profiles = { default: [{ provider: 'cloudvendor', model: 'big', adapter: s.adapter }] };
  let created = 0;
  await assert.rejects(() => testModel('cloudvendor/big', profiles, () => { created++; throw new Error('must not run'); }, TURN_PRINCIPAL, 'a1', new AbortController().signal, { localOnly: () => true, isLocalProvider: () => false }),
    (e: unknown) => e instanceof RpcError && e.error === 'E_DENIED' && e.reason === 'local-only');
  assert.equal(created, 0);
  assert.equal(s.requests.length, 0);
});
test('privacy.localOnly: the switch is asked for the probing agent, and a local model is still probed', async () => {
  const s = scriptedAdapter([{ text: 'OK' }]);
  const profiles = { default: [{ provider: 'ollama', model: 'm', adapter: s.adapter }] };
  const asked: string[] = [];
  let fixture: ReturnType<typeof turnFixture> | undefined;
  try {
    const result = await testModel('ollama/m', profiles, selected => { fixture = turnFixture(s.adapter, { profiles: selected, profile: 'probe', maxRounds: 1 }, tmp.make()); return fixture.provider; }, TURN_PRINCIPAL, 'a1', new AbortController().signal,
      { localOnly: (agent) => { asked.push(agent); return true; }, isLocalProvider: (p) => p === 'ollama' });
    assert.equal(result.ok, true);
    assert.equal(s.requests.length, 1);
    assert.deepEqual(asked, ['a1']);
  } finally { fixture?.close(); }
  // switch off: a cloud model is probed as before
  const cloud = scriptedAdapter([{ text: 'OK' }]); let f2: ReturnType<typeof turnFixture> | undefined;
  try {
    const r = await testModel('cloudvendor/big', { default: [{ provider: 'cloudvendor', model: 'big', adapter: cloud.adapter }] }, selected => { f2 = turnFixture(cloud.adapter, { profiles: selected, profile: 'probe', maxRounds: 1 }, tmp.make()); return f2.provider; }, TURN_PRINCIPAL, 'a1', new AbortController().signal, { localOnly: () => false, isLocalProvider: () => false });
    assert.equal(r.ok, true);
  } finally { f2?.close(); }
});
test.todo('KNOWN GAP: engine embedding/reranker role probes require the Phase D host ports');
test('probe RPC is human-only, scope-limited and absent from WebMCP', async () => {
  const { guardMethods, LOCAL_OWNER } = await import('../../src/rbac/guard.ts');
  const { isForbiddenMethod } = await import('../../../webmcp/src/provider.ts');
  let ran = 0;
  const ctx = { signal: new AbortController().signal } as never;
  const handler = { 'models.test': async () => { ran++; return { ok: true }; } };
  for (const role of ['owner', 'admin', 'operator', 'member', 'viewer'] as const) {
    const denied = guardMethods(handler, { now: Date.now, resolve: () => ({ ...LOCAL_OWNER, kind: 'agent', role }) });
    await assert.rejects(() => denied['models.test']!({ model: 'p/m' }, ctx), (e: unknown) => e instanceof RpcError && e.reason === 'agent-principal');
  }
  const allowed = guardMethods(handler, { now: Date.now, resolve: () => LOCAL_OWNER });
  assert.deepEqual(await allowed['models.test']!({ model: 'p/m' }, ctx), { ok: true });
  assert.equal(ran, 1);
  assert.equal(isForbiddenMethod('models.test'), true);
});

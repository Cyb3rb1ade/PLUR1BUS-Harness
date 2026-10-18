import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecretStore } from '../../src/secrets/store.ts';
import { createMemoryBackend } from '../../src/secrets/memory-backend.ts';
import { createMemoryAuditSink } from '../../src/secrets/audit.ts';
import { checkDescription, SecretError } from '../../src/secrets/types.ts';
const owner = { kind: 'owner' as const, id: 'owner' };
const invalid = (e: unknown) => e instanceof SecretError && e.code === 'invalid-description';
function rig() {
  const backend = createMemoryBackend(), audit = createMemoryAuditSink();
  return { backend, audit, store: createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }), fileFallback: () => false, audit }) };
}
test('descriptions refuse any contiguous eight-character part of the secret', () => {
  assert.throws(() => checkDescription("full abc exposed", "abc"), invalid);
  assert.throws(() => checkDescription('prefix 12345678 suffix', 'token-12345678-private'), invalid);
  assert.equal(checkDescription('seven: 1234567', 'token-12345678-private'), 'seven: 1234567');
  assert.throws(() => checkDescription('Emoji: 😀😃😄😁😆😅😂🤣', 'start-😀😃😄😁😆😅😂🤣-end'), invalid);
});
test('rotation cannot keep a description containing a fragment of the new value', async () => {
  const { store, backend } = rig();
  await store.set(owner, 'billing', 'old-credential-XYZ', 'Billing code 12345678');
  await assert.rejects(() => store.set(owner, 'billing', 'new-private-12345678'), invalid);
  assert.equal(await backend.get('billing'), 'old-credential-XYZ');
});
test('description-only edits change metadata, preserve value, and produce their own audit record', async () => {
  const { store, backend, audit } = rig();
  await store.set(owner, 'billing', 'private-12345678-token', 'Billing account');
  assert.equal(typeof store.describe, 'function');
  const meta = await store.describe(owner, 'billing', 'Production account');
  assert.equal(meta.description, 'Production account');
  assert.equal(await backend.get('billing'), 'private-12345678-token');
  assert.equal(audit.events.at(-1)!.action, 'secret.describe');
  await assert.rejects(() => store.describe(owner, 'billing', 'prefix 12345678'), invalid);
  assert.equal((await store.meta(owner, 'billing')).description, 'Production account');
  await store.describe(owner, 'billing', '');
  assert.equal((await store.meta(owner, 'billing')).description, undefined);
});
test('agents and the Core cannot edit descriptions; failed audit changes nothing', async () => {
  const { store, audit } = rig();
  await store.set(owner, 'billing', 'private-12345678-token', 'Billing account');
  for (const principal of [{ kind: 'agent' as const }, { kind: 'core' as const }]) await assert.rejects(() => store.describe(principal, 'billing', 'Changed'), (e: unknown) => e instanceof SecretError && e.code === 'denied');
  audit.failNext = true;
  await assert.rejects(() => store.describe(owner, 'billing', 'Changed'), (e: unknown) => e instanceof SecretError && e.code === 'audit-unavailable');
  assert.equal((await store.meta(owner, 'billing')).description, 'Billing account');
});
test('grants read view contains config references, never invented effective grants or values', async () => {
  const { defaults } = await import('@plur1bus/config-schema');
  const { buildSecretMethods } = await import('../../src/secrets/rpc.ts');
  const { store } = rig(); await store.set(owner, 'billing', 'private-12345678-token');
  const config = defaults() as any;
  config.agents.main = { model: 'fast' };
  config.modelProfiles.fast = { candidates: [{ model: 'example/model' }] };
  config.providers.example = { apiKeyRef: 'billing' };
  let who: import('../../src/secrets/types.ts').SecretPrincipal = owner;
  const methods = buildSecretMethods({ store, config: () => config, principalOf: () => who });
  const ctx = { signal: new AbortController().signal } as never;
  assert.deepEqual(await methods['secret.grants.list']({}, ctx), { agentLeasesEnabled: false, grants: [], references: [{ agentId: 'main', name: 'billing', scope: ['provider:example'], present: true, leaseAllowed: false }] });
  const meta = await methods['secret.describe']({ name: 'billing', description: 'Account for production' }, ctx);
  assert.equal(JSON.stringify(meta).includes('private-12345678-token'), false);
  who = { kind: 'agent', agentId: 'main' };
  for (const method of ['secret.describe', 'secret.grants.list'] as const) await assert.rejects(() => methods[method]({ name: 'billing', description: 'Changed' }, ctx), (e: unknown) => (e as { error?: string }).error === 'E_DENIED');
});
test('new secret RPCs reject every agent role and narrowed owner tokens at the guard', async () => {
  const { guardMethods, LOCAL_OWNER } = await import('../../src/rbac/guard.ts');
  const ctx = { signal: new AbortController().signal } as never;
  let calls = 0;
  const handlers = { 'secret.describe': async () => { calls++; }, 'secret.grants.list': async () => { calls++; } };
  for (const role of ['owner', 'admin', 'operator', 'member', 'viewer'] as const) {
    const guarded = guardMethods(handlers, { now: Date.now, resolve: () => ({ ...LOCAL_OWNER, role, kind: 'agent' }) });
    for (const name of Object.keys(handlers)) await assert.rejects(() => guarded[name]!({}, ctx), (e: unknown) => (e as { reason?: string }).reason === 'agent-principal');
  }
  const narrowed = guardMethods(handlers, { now: Date.now, resolve: () => ({ ...LOCAL_OWNER, tokenScopes: [] }) });
  for (const name of Object.keys(handlers)) await assert.rejects(() => narrowed[name]!({}, ctx), (e: unknown) => (e as { error?: string }).error === 'E_DENIED');
  assert.equal(calls, 0);
});
test('description edits preserve active leases and cannot overwrite a concurrent rotation', async () => {
  const { store, backend } = rig();
  await store.set(owner, 'billing', 'first-credential-value', 'Billing account');
  const core = { kind: 'core' as const };
  const lease = await store.lease(core, 'billing', { purpose: 'provider', profileId: 'example' });
  await store.describe(owner, 'billing', 'Production account');
  assert.equal(store.readLease(core, lease.leaseId).value, 'first-credential-value');
  for (let i = 0; i < 10; i++) {
    const value = `rotated-credential-${i}`;
    await Promise.all([store.set(owner, 'billing', value), store.describe(owner, 'billing', 'Production account')]);
    assert.equal(await backend.get('billing'), value);
  }
});
test('encrypted-file description edits keep the exact credential ciphertext and key', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tempDir } = await import('../helpers/temp-dir.ts');
  const { createFileBackend } = await import('../../src/secrets/file-backend.ts');
  const { secure } = await import('./helpers.ts');
  const dir = tempDir('p1b-description-cipher-');
  const backend = createFileBackend({ dir, secure });
  await backend.put('billing', 'private-12345678-token', new Date(), 'owner', 'Billing account');
  const before = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).entries.billing;
  const key = readFileSync(join(dir, 'store.key'));
  await backend.describe('billing', 'Production account', new Date(), 'owner');
  const after = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).entries.billing;
  assert.deepEqual([after.nonce, after.ct, after.tag], [before.nonce, before.ct, before.tag]);
  assert.deepEqual(readFileSync(join(dir, 'store.key')), key);
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createRealDiscoveryAdapters } from '../../src/discovery/real-adapters.ts';
import { InMemorySecretStore } from '../../src/auth/secret-store.ts';
import { Sensitive } from '../../src/openai-auth/ports.ts';
import { RESOURCE } from '../../src/openai-auth/profiles.ts';
import type { ProviderDefinition } from '../../src/composition/auth.ts';
import { createEgress } from '../../src/egress/service.ts';

import { definition } from "./helpers/definition.ts";
const egress = createEgress({ config: () => ({ allowHosts: ['provider.example'], allowPorts: [443], allowLoopback: false }), resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
it('real profiles use the credential pool and secret store, remain origin-bound, and read live definitions', async () => {
  const store = new InMemorySecretStore(); await store.set('key', 'synthetic-key');
  let definitions = { provider: definition('auth-profile') };
  const adapters = createRealDiscoveryAdapters({ definitions: () => definitions, store, egress, now: () => 0, openai: () => undefined });
  assert.deepEqual(adapters.profiles.list().map(p => p.id), ['provider']);
  const lease = await adapters.credentials.resolve('provider', 'https://provider.example');
  assert.equal(lease?.headerValue, 'Bearer synthetic-key');
  assert(!JSON.stringify(lease).includes('synthetic-key'));
  await assert.rejects(adapters.credentials.resolve('provider', 'https://foreign.example'), /credential_origin_mismatch/);
  await store.delete('key');
  await assert.rejects(adapters.credentials.resolve('provider', 'https://provider.example'), /no_credential/);
  definitions = { provider: { ...definition('cli'), profile: { ...definition('cli').profile, kind: 'external_cli' } } };
  assert.equal(adapters.profiles.list()[0]?.discovery, 'manual');
});
it('D110 plan route leases only its documented Models origin; external CLI and federated routes stay manual', async () => {
  const def = definition('openai:chatgpt-plan', 'codex_responses');
  def.profile.client_registration = 'dynamic_on_authorize'; def.profile.base_url = RESOURCE;
  def.openai = { credentialId: 'credential', person: 'owner' };
  Object.assign(def, { discovery: 'ollama-tags' }); // A plan route cannot be redirected to a fabricated listing protocol.
  let calls = 0;
  const adapters = createRealDiscoveryAdapters({ definitions: () => ({ plan: def }), store: new InMemorySecretStore(), egress, now: () => 0,
    openai: () => ({ async lease(id, principal) { calls++; assert.equal(id, 'credential'); assert.equal(principal.user, 'owner'); return new Sensitive('synthetic-plan'); } }) });
  assert.equal(adapters.profiles.list()[0]?.discovery, 'openai-models');
  assert.equal((await adapters.credentials.resolve('plan', 'https://api.openai.com'))?.headerValue, 'Bearer synthetic-plan');
  def.profile.base_url = 'https://chatgpt.example/backend';
  assert.equal(adapters.profiles.list()[0]?.discovery, 'manual');
  await assert.rejects(adapters.credentials.resolve('plan', 'https://chatgpt.example'), /no_credential/);
  assert.equal(calls, 1);
});

it('composition shares its refresh owner only with the exact registered auth profile', async () => {
  const { composeAuth } = await import('../../src/composition/auth.ts');
  const { defaults } = await import('@plur1bus/config-schema');
  const def = definition('shared-profile');
  const composed = composeAuth({ config: defaults(), definitions: { provider: def }, egress, secrets: {} as import('../../src/secrets/store.ts').SecretStore });
  try {
    const first = composed.credentialsForDiscovery(def); assert(first);
    assert.equal(composed.credentialsForDiscovery(structuredClone(def)), first, 'same pool and refresh owner');
    const changed = structuredClone(def); changed.profile.base_url = 'https://foreign.example/v1';
    assert.equal(composed.credentialsForDiscovery(changed), undefined, 'old credential is not rebound to a new origin');
    changed.profile = structuredClone(def.profile); changed.entries = [{ id: 'other', secretRef: 'other.key' }];
    assert.equal(composed.credentialsForDiscovery(changed), undefined, 'changed pool needs a new composition');
  } finally { composed.close(); }
});

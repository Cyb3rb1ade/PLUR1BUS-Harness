import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createCore } from '../../src/core.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { connect } from '../helpers/connect.ts';
import { localOpenAI } from './local-server.ts';
import type { AuthService } from '../../src/openai-auth/service.ts';
import type { ProviderDefinition } from '../../src/composition/auth.ts';
import { DatabaseSync } from 'node:sqlite';
test('stack: Core AuthService login → authenticated session.submit → plan usage in durable ledgers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'd110-core-')), local = await localOpenAI(), cfg = defaults(); cfg.agents.bernd = {}; cfg.engine.duplicateThreshold = 1.01;
  await writeFile(join(home, 'config.json'), JSON.stringify(cfg));
  const old = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1'; process.env.PLUR1BUS_SECRETS_KEYRING = 'memory';
  const person = 'local-owner', principal = { owner: person, user: person, agentOwner: person, deployment: 'local' as const };
  let auth!: AuthService;
  const definition: ProviderDefinition = { wireFormat: 'codex_responses', defaultModel: 'fixture-model', entries: [], billingPath: 'plan', openai: { person, credentialId: 'pending' }, profile: { id: 'openai:chatgpt-plan', display_name: 'ChatGPT', kind: 'oauth_pkce', capabilities: ['chat'], auth_header_scheme: 'Authorization: Bearer {token}', client_registration: 'dynamic_on_authorize', policy_status: 'allowed', policy_source: 'D110', policy_checked: '2026-10-08' } };
  const core = createCore({ home, clock: () => local.fake.now, testInternals: flatTestInternals(), composition: { definitions: { plan: definition }, fetch: local.transport, onOpenAI: service => { auth = service; } } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start(); assert.ok(auth);
    const login = await auth.startLogin({ principal }); await local.authorize(login.authorizeUrl); const credential = await auth.awaitLogin(login.loginId, principal); definition.openai!.credentialId = credential.id;
    client = await connect({ address: core.address, token: core.token });
    const caller = { channel: 'cli', accountId: 'fixture-host', userId: 'fixture-user' };
    const { session } = await client.call<any>('session.create', { caller, agentId: 'bernd' });
    const result = await client.call<any>('session.submit', { caller, sessionId: session.id, text: 'hello', wait: true }); assert.equal(result.state, 'completed', JSON.stringify(result)); assert.equal(result.reply, 'plan answer');
    for (const file of ['budget.sqlite','openai-plan-usage.sqlite']) { const db = new DatabaseSync(join(home, 'state', file)); const row = db.prepare(file === 'budget.sqlite' ? 'SELECT input_tokens,output_tokens,cost_micros FROM usage_event' : 'SELECT input,output FROM plan_usage').get(); assert.ok(row); db.close(); }
    const output = JSON.stringify(result) + await readFile(join(home, 'logs', 'core.log'), 'utf8') + await readFile(join(home, 'logs', 'audit.log'), 'utf8'); for (const value of local.fake.secrets) assert.equal(output.includes(value), false);
    await auth.logout(credential.id, principal);
  } finally { await client?.close(); await core.stop(); await local.close(); await rm(home, { recursive: true, force: true }); for (const [name,value] of [['PLUR1BUS_ALLOW_TEST_INTERNALS',old.allow],['PLUR1BUS_SECRETS_KEYRING',old.keyring]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { defaults } from '@plur1bus/config-schema';
import { validateLine } from '@plur1bus/log-schema';
import { createCore } from '../../src/core.ts';
import { layout } from '../../src/paths.ts';
import { FakeClock } from '../../src/discovery/testing.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { connect } from '../helpers/connect.ts';
import { definition } from './helpers/definition.ts';
import { fakeHttp } from './helpers/fake-http.ts';
import { RESOURCE } from '../../src/openai-auth/profiles.ts';

it('Core real adapters: four scanner protocols, secret/pool/plan/missing credentials, logs, notification, daily scan and restart catch-up', async () => {
  const previous = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1'; process.env.PLUR1BUS_SECRETS_KEYRING = 'memory';
  const home = tempDir('p1b-real-discovery-'), l = layout(home), clock = new FakeClock(1_800_000_000_000);
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false }, duplicateThreshold: 1.01, runtime: { recallTimeoutMs: 10000 } };
  cfg.core.logLevel = 'debug'; cfg.auth!.openai.storeBackend = 'auto';
  const openai = definition('api-profile'), anthropic = definition('anthropic-profile', 'anthropic_messages'), google = definition('google-profile', 'gemini'), ollama = { ...definition('local-profile'), discovery: 'ollama-tags' };
  openai.entries = [{ id: 'pool-key', secretRef: 'pool.key' }];
  anthropic.profile.auth_header_scheme = 'x-api-key: {token}'; google.profile.auth_header_scheme = 'x-goog-api-key: {token}';
  anthropic.profile.base_url = 'https://anthropic.example/v1'; google.profile.base_url = 'https://google.example/v1beta';
  ollama.profile.base_url = 'http://127.0.0.1:11434'; delete ollama.profile.secret_ref;
  const plan = definition('openai:chatgpt-plan', 'codex_responses'), credentialId = 'a'.repeat(64);
  plan.profile.base_url = RESOURCE; plan.profile.kind = 'oauth_pkce'; plan.profile.client_registration = 'dynamic_on_authorize'; plan.openai = { person: 'owner', credentialId };
  const missing = definition('missing-profile'); missing.profile.secret_ref = 'absent';
  const cli = definition('cli-profile'); cli.profile.kind = 'external_cli';
  cfg.providers = { openai: { ...openai, vendor: 'example-vendor' }, anthropic, google, ollama, plan, missing, cli };
  cfg.egress = { allowHosts: ['provider.example','anthropic.example','google.example','api.openai.com','127.0.0.1'], allowPorts: [443,11434], allowLoopback: true };
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const key = 'synthetic-discovery-canary', planKey = 'synthetic-plan-canary';
  const wire = fakeHttp((url, headers) => {
    if (url.hostname === 'anthropic.example') { assert.equal(headers['x-api-key'], key); assert.equal(headers['anthropic-version'], '2023-06-01'); return { body: { data: [{ id: 'claude-fixture', display_name: 'API Claude' }], has_more: false } }; }
    if (url.hostname === 'google.example') { assert.equal(headers['x-goog-api-key'], key); return { body: { models: [{ name: 'models/gemini-fixture', displayName: 'API Gemini', inputTokenLimit: 12345, supportedGenerationMethods: ['generateContent'] }] } }; }
    if (url.hostname === '127.0.0.1') { assert.equal(headers.Authorization, undefined); assert.equal(url.pathname, '/api/tags'); return { body: { models: [{ name: 'example-llama:latest' }] } }; }
    assert.equal(headers.Authorization, 'Bearer ' + (url.hostname === 'api.openai.com' ? planKey : key));
    return { body: { data: [{ id: 'example-chat-large' }] } };
  });
  const options = { home, testInternals: flatTestInternals(), clock: () => clock.now(), discovery: { clock, rng: () => 0.5, request: wire.request, resolver: async () => [{ address: '93.184.216.34', family: 4 as const }] }, composition: { fetch: async () => { throw new Error('unexpected auth HTTP'); } } };
  let core = createCore(options), client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start(); client = await connect({ address: core.address, token: core.token });
    assert.equal(wire.calls.length, 0);
    for (const name of ['key','pool.key']) await client.call('secret.set', { name, value: key });
    await client.call('secret.set', { name: 'openai.credentials.index', value: JSON.stringify([{ id: credentialId, person: 'owner', workspace: 'fixture', kind: 'oauth_pkce', billingPath: 'plan', expiresAt: clock.now() + 3 * 86400000, needsLogin: false }]) });
    await client.call('secret.set', { name: 'openai.plan.' + credentialId, value: JSON.stringify({ clientId: 'issued-fixture', sub: 'owner', workspace: 'fixture', accessToken: planKey, refreshToken: 'synthetic-refresh', scope: 'chatgpt.tokens.use.direct', expiresAt: clock.now() + 3 * 86400000, refreshExpiresAt: clock.now() + 10 * 86400000 }) });
    await client.call('events.subscribe', { names: ['models.changed'] });
    const notifications: unknown[] = []; client.onNotification((method, params) => { if (method === 'models.changed') notifications.push(params); });
    await clock.advance(60000);
    assert.equal(wire.calls.length, 5, 'four protocol scans plus documented D110 plan listing');
    const list = await client.call<any>('models.list', {});
    assert.equal(list.models.length, 5); assert.equal(list.newCount, 5); assert(list.models.every((m: any) => m.new === true)); assert(list.models.every((m: any) => m.status === 'available'));
    assert.equal(list.models.find((m: any) => m.provider === 'google').contextWindow, 12345);
    assert.equal(list.models.find((m: any) => m.provider === 'openai').contextWindow, 128000);
    assert.deepEqual(list.models.find((m: any) => m.provider === 'openai').capabilities, ['tools', 'vision', 'reasoning']);
    if (process.env.PLUR1BUS_BIN) {
      const cli = promisify(execFile);
      const json = await cli(process.env.PLUR1BUS_BIN, ['--home', home, '--json', 'model', 'list']);
      assert(JSON.parse(json.stdout).models.every((m: any) => m.new === true));
      const human = await cli(process.env.PLUR1BUS_BIN, ['--home', home, 'model', 'list']); assert(human.stdout.includes('available new'));
      const scan = await cli(process.env.PLUR1BUS_BIN, ['--home', home, '--json', 'model', 'scan', '--provider', 'openai']);
      assert.equal(JSON.parse(scan.stdout).providers[0].result, 'ok');
    }
    assert.equal((await client.call<any>('models.list', { newOnly: true })).models.length, 5);
    const failure = list.providers.find((p: any) => p.provider === 'missing'); assert.equal(failure.lastResult, 'failed:auth');
    assert.equal((await client.call<any>('models.scan', { provider: 'cli' })).providers[0].result, 'no-scanner');
    assert.equal(notifications.length, 5);
    await client.call('models.acknowledge', {}); const acknowledged = await client.call<any>('models.list', {}); assert.equal(acknowledged.newCount, 0); assert(acknowledged.models.every((m: any) => m.new === false));
    const lines = readFileSync(l.logFile('core'), 'utf8').trim().split('\n').filter(line => JSON.parse(line).event?.startsWith('model.'));
    assert(lines.length >= 6); for (const line of lines) assert.equal(validateLine(line).ok, true, line);
    assert(lines.some(line => JSON.parse(line).event === 'model.scan.failed'));
    for (const path of [l.logFile('core'), l.catalogModels]) { const text = readFileSync(path, 'utf8'); assert(!text.includes(key)); assert(!text.includes(planKey)); }
    const beforeDaily = wire.calls.length; await clock.advance(24 * 3600000 + 60000); assert.equal(wire.calls.length, beforeDaily + 5, 'daily schedule executes without restart');
    await client.close(); client = undefined; await core.stop();
    const count = wire.calls.length; await clock.advance(25 * 3600000);
    core = createCore(options); await core.start(); assert.equal(wire.calls.length, count, 'restart does not scan synchronously');
    await clock.advance(60000); assert(wire.calls.length > count, 'overdue providers catch up after restart');
  } finally {
    await client?.close(); await core.stop();
    for (const [name, value] of [['PLUR1BUS_ALLOW_TEST_INTERNALS', previous.allow], ['PLUR1BUS_SECRETS_KEYRING', previous.keyring]] as const) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

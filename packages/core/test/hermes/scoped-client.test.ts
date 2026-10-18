import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { connect } from '../helpers/connect.ts';
import { createCore } from '../../src/core.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { AdminStore } from '../../src/identity/admin-store.ts';
import { AccountStore } from '../../../api/src/account-store.ts';
import { TokenService } from '../../../api/src/tokens.ts';

/** Repo files, independent of the working directory (CI runs the package tests from packages/core). */
const resolve = (rel: string): string => resolvePath(fileURLToPath(new URL('../../../../', import.meta.url)), rel);
test('approved Hermes token attaches to running core, stays in one agent, and revocation is live', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hm4-client-'));
  const cfg = defaults(); cfg.agents['hermes-test'] = {}; cfg.agents.other = {};
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const core = createCore({ home, testInternals: flatTestInternals() });
  let c: Awaited<ReturnType<typeof connect>> | undefined, accounts: AccountStore | undefined, people: AdminStore | undefined;
  try {
    await core.start();
    people = new AdminStore({ path: join(home, 'state/admin.sqlite'), ownerId: 'local-owner' });
    accounts = new AccountStore({ path: join(home, 'state/api/accounts.db'), resolve: async id => { const p = people!.person(id); return p ? { ...p, kind: 'person' } : null; } });
    const tokens = new TokenService({ store: accounts.tokens, clock: { now: Date.now } });
    const approved = await tokens.create('local-owner', { name: 'hermes-test', scopes: ['agent.read', 'agent.use', 'doctor.read'] });
    c = await connect({ address: core.address, token: approved.token });
    assert.equal((await c.call<any>('core.status')).instanceId, core.status().instanceId);
    await c.call('agent.status', { agentId: 'hermes-test' });
    const caller = { channel: 'cli', accountId: 'hermes', userId: 'synthetic' };
    await c.call('memory.recall', { caller, agentId: 'hermes-test', sessionKey: 's1', query: 'synthetic' });
    for (const [method, params] of [['agent.status', { agentId: 'other' }], ['core.shutdown', {}], ['secret.list', {}], ['agent.create', { name: 'forbidden' }]] as const) await assert.rejects(c.call(method, params), (e: any) => e.error === 'E_DENIED');
    const provisionedHome = join(home, 'synthetic-hermes'); mkdirSync(provisionedHome);
    const provision = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--conditions=source', resolve('scripts/hermes/approve-client.mjs'), '--home', home, '--agent', 'hermes-test', '--hermes-home', provisionedHome], { timeout: 15000 });
    assert.equal(JSON.parse(provision.stdout).approved, true);
    const tokenFile = join(home, 'client.token');
    writeFileSync(tokenFile, approved.token + '\n', { mode: 0o600 });
    // Proves the real Python client cannot possibly read the installation owner's credential.
    unlinkSync(join(home, 'run/core.token'));
    const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const fake = await promisify(execFile)(python, [resolve('hosts/hermes/tests/fake_existing.py'), home, tokenFile, 'hermes-test'], { timeout: 15000, env: { ...process.env, PYTHONPATH: resolve('clients/python/plur1bus-memory-client/src') } });
    assert.equal(JSON.parse(fake.stdout).attached, true);
    await tokens.revoke('local-owner', approved.record.id);
    await assert.rejects(c.call('core.status'), (e: any) => e.error === 'E_DENIED');
    await assert.rejects(connect({ address: core.address, token: 'plb_123456789abc_' + 'x'.repeat(43) }));
    assert.equal(core.status().process.state, 'ready');
  } finally { await c?.close(); accounts?.close(); people?.close(); await core.stop({ budgetMs: 5000 }); rmSync(home, { recursive: true, force: true }); }
});

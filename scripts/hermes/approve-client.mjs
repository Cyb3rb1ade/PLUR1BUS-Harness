// Explicit owner provisioning only. Hermes itself never reads these service credentials.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, coreAddress, createSecurePath } from '@plur1bus/module-api';
import { AccountStore } from '../../packages/api/src/account-store.ts';
import { TokenService } from '../../packages/api/src/tokens.ts';
const { values } = parseArgs({ options: { home: { type: 'string' }, agent: { type: 'string' }, 'hermes-home': { type: 'string' }, 'allow-forget': { type: 'boolean' } } });
if (!values.home || !values.agent || !values['hermes-home'] || !/^hermes-[a-z0-9_-]{1,57}$/.test(values.agent)) throw new Error('usage: --home ABS --agent AGENT --hermes-home ABS [--allow-forget] (use the derived hermes-* agent id, max 64 chars)');
const home = resolve(values.home), hermes = resolve(values['hermes-home']);
const file = join(hermes, 'plur1bus-client.token');
if (!existsSync(hermes) || existsSync(file)) throw new Error('Hermes home must exist; refuse to overwrite an existing credential');
const token = readFileSync(join(home, 'run/core.token'), 'utf8').trim();
const pid = Number(readFileSync(join(home, 'run/core.pid'), 'utf8').split(/\s+/)[0]);
const opts = { address: coreAddress(home), token, expectedServerPid: pid };
const owner = await connect(opts);
let service, accounts, issued;
try {
  if (!owner.hello.capabilities?.features.includes('hermes.scoped-client')) throw new Error('update the host-mode core to an HM4-capable release before provisioning; no credentials changed');
  try { await owner.call('agent.status', { agentId: values.agent }); }
  catch (e) { if (e.error !== 'E_AGENT_UNKNOWN' && e.error !== 'E_NOT_FOUND') throw e; await owner.call('agent.create', { name: values.agent }); }
  service = await connect({ ...opts, api: { clientId: 'harness-api', token: readFileSync(join(home, 'run/api-delegation.token'), 'utf8').trim() } });
  accounts = new AccountStore({ path: join(home, 'state/api/accounts.db'), resolve: async userId => (await service.call('admin.api.person.resolve', { userId })).person });
  const tokens = new TokenService({ store: accounts.tokens, clock: { now: Date.now } });
  issued = await tokens.create('local-owner', { name: values.agent, scopes: ['agent.use', 'agent.read', 'doctor.read', ...(values['allow-forget'] ? ['memory.forget'] : [])] });
  try {
    writeFileSync(file, issued.token + '\n', { mode: 0o600, flag: 'wx' });
    if (!createSecurePath()(file, { mode: 0o600 }).applied) throw new Error('could not restrict client token permissions');
  } catch (e) { await tokens.revoke('local-owner', issued.record.id); throw e; }
  console.log(JSON.stringify({ approved: true, agentId: values.agent, tokenId: issued.record.id, expiresAt: issued.record.expiresAt }));
} finally { accounts?.close(); await service?.close(); await owner.close(); }

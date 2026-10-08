// Test-only Core bootstrap for CLI→supervisor→Core acceptance. All wire responses are synthetic, in-memory.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createCore } from '../../../packages/core/dist/index.js';
import { flatTestInternals } from '../../../packages/core/test/helpers/flat-embedder.ts';
import { wireFixture } from '../../../packages/core/test/integration/wire-fixture.ts';
if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== '1') throw new Error('test internals required');
const { values } = parseArgs({ options: { home: { type: 'string' }, instance: { type: 'string' }, lifeline: { type: 'string' } }, strict: false });
const wire = process.env.PLUR1BUS_TEST_TURN_WIRE;
if (!['chat_completions', 'anthropic_messages', 'codex_responses', 'gemini'].includes(wire)) throw new Error('invalid fixture wire');
const fixture = wireFixture(wire, [{ call: { name: 'file_read', args: { path: join(values.home, 'agents', 'bernd', 'workspace', 'fixture.txt') } } }, { text: 'fixture done' }]);
const profile = { id: 'fixture', display_name: 'Fixture', kind: 'api_key', capabilities: ['chat'], auth_header_scheme: wire === 'anthropic_messages' || wire === 'gemini' ? 'x-api-key: {token}' : 'Authorization: Bearer {token}', base_url: 'https://fixture.invalid/v1', secret_ref: 'fixture.key', policy_status: 'allowed', policy_source: 'synthetic', policy_checked: '2026-10-08' };
let stopping = false;
const stop = budgetMs => { if (stopping) return; stopping = true; core.stop(budgetMs === undefined ? {} : { budgetMs }).then(() => process.exit(0), () => process.exit(1)); };
const core = createCore({ home: values.home, ...(values.instance ? { instanceId: values.instance } : {}), ...(values.lifeline === 'stdin' ? { lifeline: process.stdin, supervisorConfig: {} } : {}), testInternals: flatTestInternals(), composition: { definitions: { fixture: { profile, entries: [], wireFormat: wire, defaultModel: wire === 'anthropic_messages' ? 'claude-sonnet-4-5' : 'gpt-4.1' } }, fetch: fixture.fetch }, onShutdownRequested: stop, onOrphanGraceExpired: () => stop() });
process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
await core.start();
console.log(JSON.stringify({ ready: true, address: core.address, pid: process.pid }));

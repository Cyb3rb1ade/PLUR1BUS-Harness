// Isolated subprocess: actual Core composition, deterministic mock SSE, no real credentials.
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { defaults } from '@plur1bus/config-schema';
import { connect } from '@plur1bus/module-api';
import { createCore } from '../../packages/core/src/core.ts';
import { flatTestInternals } from '../../packages/core/test/helpers/flat-embedder.ts';
import { wireFixture } from '../../packages/core/test/integration/wire-fixture.ts';
import { distribution } from './metrics.mjs';

process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1';
process.env.PLUR1BUS_SECRETS_KEYRING = 'memory';
const home = mkdtempSync(join(tmpdir(), 'p1b-budget-'));
const real = process.argv.includes('--real-models');
const cacheIndex = process.argv.indexOf('--models-cache');
if (real && cacheIndex < 0) throw new Error('real models need --models-cache');
if (real) symlinkSync(resolve(process.argv[cacheIndex + 1]!), join(home, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
const cfg = defaults(); cfg.agents.bench = {}; cfg.engine.duplicateThreshold = 1.01;
writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
const caller = { channel: 'cli', accountId: 'benchmark', userId: 'synthetic' };
const samples: any = { schema: 'plur1bus-runtime/v1', modelMode: real ? 'real' : 'flat-embedder', results: [], errors: [] };
let dispatched = 0, start = 0, firstDelta = 0;
let previous = ''; const usage: any[] = [];
const definition = { wireFormat: 'anthropic_messages' as const, defaultModel: 'claude-sonnet-4-5', entries: [], profile: { id: 'fixture', display_name: 'Benchmark mock', kind: 'api_key' as const, capabilities: ['chat' as const], auth_header_scheme: 'x-api-key: {token}', base_url: 'https://fixture.invalid/v1', secret_ref: 'fixture.key', policy_status: 'allowed' as const, policy_source: 'synthetic', policy_checked: '2026-10-16' } };
const fetchMock: typeof fetch = async (url, init) => {
  dispatched = performance.now() - start;
  const body = JSON.parse(String(init?.body));
  // Token counts are a documented deterministic mock tokenizer, never actual vendor usage.
  // Longest common request prefix simulates a prefix cache; no padding or preset hit ratio.
  const prefix = JSON.stringify({ tools: body.tools, system: body.system, messages: body.messages });
  let same = 0; while (same < Math.min(prefix.length, previous.length) && prefix[same] === previous[same]) same++;
  const input = Math.ceil(prefix.length / 4), read = Math.floor(same / 4);
  previous = prefix; usage.push({ input, read, write: input - read, output: 10 });
  return wireFixture('anthropic_messages', [{ text: 'benchmark done', inputTokens: input, cacheRead: read, cacheWrite: input - read }]).fetch(url, init);
};
const core = createCore({ home, ...(!real ? { testInternals: flatTestInternals() } : {}), composition: { definitions: { fixture: definition }, fetch: fetchMock } });
let client: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await core.start();
  client = await connect({ address: core.address, expectedServerPid: process.pid, token: core.token, callTimeoutMs: 30000 });
  const deadline = performance.now() + 120000;
  while (!core.status().engine.ready) { if (performance.now() > deadline) throw new Error('model warmup timeout'); await new Promise(r => setTimeout(r, 20)); }
  await client.call('secret.set', { name: 'fixture.key', value: 'synthetic-benchmark-only' });
  await client.call('events.subscribe', { names: ['session.event'] });
  client.onNotification((name, params: any) => { if (name === 'session.event' && params.event.type === 'delta' && firstDelta === 0) firstDelta = performance.now() - start; });
  const { session } = await client.call<any>('session.create', { caller, agentId: 'bench' });
  const b2: number[] = [], b3: number[] = [];
  for (let i = -3; i < 30; i++) {
    firstDelta = 0; dispatched = 0; start = performance.now();
    const r = await client.call<any>('session.submit', { caller, sessionId: session.id, text: `Benchmark turn ${i + 3}`, wait: true });
    await new Promise(r => setImmediate(r));
    if (r.state !== 'completed' || !firstDelta || !dispatched) throw new Error('mock turn failed or missing timing');
    if (i >= 0) { b2.push(dispatched); b3.push(firstDelta); }
  }
  samples.results.push({ budget: 'B2', scope: 'RPC submit to mock fetch (CLI launch excluded)', limitMs: 300, ...distribution(b2, 3) }, { budget: 'B3', scope: 'RPC submit to client delta (in-memory SSE t=0)', limitMs: 400, ...distribution(b3, 3) });
  previous = ''; usage.length = 0;
  const cacheSession = (await client.call<any>('session.create', { caller, agentId: 'bench' })).session;
  for (let i = 0; i < 20; i++) await client.call('session.submit', { caller, sessionId: cacheSession.id, text: `Cache script ${i}`, wait: true });
  const eligible = usage.slice(2); const share = eligible.reduce((n, u) => n + u.read, 0) / eligible.reduce((n, u) => n + u.input, 0);
  samples.results.push({ budget: 'B5', share, turns: structuredClone(usage), eligibleFromTurn: 3, tokenizer: 'synthetic ceil(serialized request chars/4); longest common prefix cache', passed: share >= .90 });
  const golden: number[] = [];
  for (let i = 0; i < 20; i++) {
    previous = ''; const s = (await client.call<any>('session.create', { caller, agentId: 'bench' })).session;
    await client.call('session.submit', { caller, sessionId: s.id, text: `Golden task ${i}: reply with the synthetic benchmark result.`, wait: true });
    golden.push(usage.at(-1).input + usage.at(-1).output);
  }
  samples.results.push({ budget: 'B7', corpus: 'golden-synthetic-20/v1', tokensPerTask: golden, total: golden.reduce((a, b) => a + b, 0), accounting: 'mock provider usage, not vendor tokenizer' });
  const queries = Array.from({ length: 500 }, (_, i) => `benchmark fact topic ${i % 10}, query ${i}`);
  const times: number[] = []; let overruns = 0;
  for (let i = -10; i < queries.length; i++) {
    const r = await client.call<any>('memory.recall', { caller, agentId: 'bench', sessionKey: 'fixed-corpus', query: queries[Math.max(0, i)]!, joined: true, budget: { softMs: 400, hardMs: 1200 } });
    if (i >= 0) { if (!Number.isFinite(r.timing?.totalMs)) throw new Error('missing engine recall timing'); times.push(r.timing.totalMs); if (r.timing.totalMs > 1200 || r.timing.exceededBudget) overruns++; }
  }
  samples.results.push({ budget: 'B4', corpusSha256: createHash('sha256').update(JSON.stringify(queries)).digest('hex'), corpus: 'fixed 500 queries over synthetic turn captures', overruns, ...distribution(times, 10) });
  samples.results.push({ budget: 'B10', status: 'partial', rssBytes: process.memoryUsage().rss, reason: 'RSS observation only: two embedding identities plus reranker and configured-ceiling LRU eviction soak still missing; cannot mark B10 passed' });
} catch (e: any) { samples.errors.push(e.message); }
finally { await client?.close(); await core.stop({ budgetMs: 5000 }); rmSync(home, { recursive: true, force: true }); }
writeFileSync(process.argv[2]!, JSON.stringify(samples, null, 2) + '\n');
process.exitCode = samples.errors.length ? 1 : 0;

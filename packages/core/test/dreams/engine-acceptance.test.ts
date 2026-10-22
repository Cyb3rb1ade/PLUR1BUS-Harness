import { it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { defaults } from '@plur1bus/config-schema';
import type { Engine, Principal } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import { createAgentRegistry } from '../../src/agents.ts';
import { bindEngine } from '../../src/engine.ts';
import { buildEngineConfig } from '../../src/engine-config.ts';
import { createHarnessHost } from '../../src/host.ts';
import { createLogger } from '../../src/logger.ts';
import { layout } from '../../src/paths.ts';
import { FakeClock } from '../../src/discovery/testing.ts';
import { createCandidateSource, readCandidateMemory, type A1MemoryOperations } from '../../src/dreams/producer.ts';
import { DreamScheduler } from '../../src/dreams/scheduler.ts';
import { DreamStore } from '../../src/dreams/store.ts';
import type { CandidatePromotionResult } from '../../src/dreams/types.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { tempDir } from '../helpers/temp-dir.ts';

const user = { origin: 'user', background: false } as const;
const system = { origin: 'system', background: false } as const;
const DAY = 86_400_000;
type CuratedMemory = Required<Pick<A1MemoryOperations, 'stats' | 'promote'>>;

// Compatibility detection is also the ordinary installed-pin test: no fake
// Engine replacement, TODO, or skip. Strict source/pin acceptance must fail if
// the actual Engine lacks either operation or reports an older contract.
function curated(engine: Engine, t: TestContext): CuratedMemory | null {
  const memory = engine.memory as typeof engine.memory & A1MemoryOperations;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(engine.contract);
  const available = match?.[1] === '1' && Number(match[2]) >= 17
    && typeof memory.stats === 'function' && typeof memory.promote === 'function';
  if (process.env.PLUR1BUS_REQUIRE_CURATED_ENGINE === '1' || process.env.PLUR1BUS_ENGINE_ACCEPTANCE_SOURCE) assert.ok(available, `requires actual Engine contract >=1.17.0, found ${engine.contract}`);
  if (!available) {
    assert.equal(memory.stats, undefined, 'installed Engine has no recall-stats API');
    assert.equal(memory.promote, undefined, 'installed Engine has no promotion API');
    t.diagnostic(`actual installed Engine ${engine.contract}: curated-memory contract unavailable; Controller pin acceptance remains required`);
    return null;
  }
  return { stats: memory.stats!.bind(engine.memory), promote: memory.promote!.bind(engine.memory) };
}

async function fixture(t: TestContext, promotion = { enabled: true, maxPromotionsPerRun: 0 }) {
  const l = layout(tempDir('p1b-dream-real-engine-'));
  for (const dir of [l.state, l.logs, l.agents, l.lancedb]) mkdirSync(dir, { recursive: true });
  const cfg = defaults();
  cfg.agents.alpha = {};
  const agents = createAgentRegistry(cfg, l);
  agents.scaffold('alpha');
  const workspaceDir = agents.workspaceOf('alpha')!;
  const principal: Principal = { agentId: 'alpha', workspace: `workspace-dir:v1:${realpathSync(workspaceDir)}`, channel: 'cli', accountId: 'fixture', chat: { id: 'fixture', kind: 'direct' }, trust: 'proved' };
  const logger = createLogger({ file: l.logFile('core'), role: 'core', level: 'warn' });
  const engineConfig = { ...buildEngineConfig(cfg, l), autoCapture: true, autoRecall: true,
    neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false },
    dailyConsolidation: { enabled: true, lancedbOptimize: { enabled: false } },
    runtime: { recallTimeoutMs: 10_000 }, duplicateThreshold: 1.01, schicht15: promotion,
  };
  const host = createHarnessHost({ layout: l, logger, config: cfg, engineConfig, agents, events() {} });
  host.runtime = { llm: { complete: async () => ({ text: '{"importance":0.9,"intensity":0,"dominant":"neutral","emotions":{}}', provider: 'fixture', model: 'fixture', usage: {} }) } };
  let engine = bindEngine(host, engineConfig, flatTestInternals());
  let store = new DreamStore(join(l.state, 'dreams-acceptance.sqlite'));
  const clock = new FakeClock(Date.now());
  let scheduler: DreamScheduler | undefined;
  let captures = 0;
  let notified = false;
  const jobCalls: string[] = [];
  function makeScheduler(memory: CuratedMemory, beforePromote?: (ids: readonly string[]) => Promise<void>, afterPromote?: (receipt: CandidatePromotionResult) => void) {
    const source = createCandidateSource({
      list: () => readCandidateMemory(query => engine.memory.list(query, principal, user)),
      stats: (_agentId, ids) => memory.stats(ids, principal, user),
      promote: async (_agentId, ids) => {
        await beforePromote?.(ids);
        const receipt = await memory.promote({ ids }, principal, system);
        afterPromote?.(receipt);
        return receipt;
      },
    });
    // All maintenance runs call the actual Engine registry. GC is explicitly
    // disabled; its genuine skipped receipt is a permitted non-primary skip.
    scheduler = new DreamScheduler({ store, clock, logger, logsDir: join(l.logs, 'dreams-acceptance'), agents: () => ['alpha'], defaultTimezone: 'UTC', staggerWindowS: 0, phases: { deep: { minCorpus: 1 } },
      engine: { jobs: { list: () => engine.jobs.list(), run: async (job, agentId, options) => { const spec = engine.jobs.list().find(item => item.name === job); assert.ok(spec, `actual registry provides ${job}`); jobCalls.push(job); return engine.jobs.run(spec.name, agentId, options); } } }, candidates: source,
    });
    // Use one real capture as the small-fixture corpus floor; forward only
    // actual capture results, once, just as the Core composition does.
    scheduler.syncAgents();
    if (!notified) { for (let i = 0; i < captures; i++) scheduler.recordCapture('alpha', 0.5); notified = true; }
    return scheduler;
  }
  t.after(async () => { await scheduler?.stop(); store.close(); await engine.close({ budgetMs: 5_000 }); await logger.close(); });
  return {
    l, principal, workspaceDir, clock, jobCalls, get engine() { return engine; }, get store() { return store; }, makeScheduler,
    async restart() { await scheduler?.stop(); store.close(); await engine.close({ budgetMs: 5_000 }); engine = bindEngine(host, engineConfig, flatTestInternals()); store = new DreamStore(join(l.state, 'dreams-acceptance.sqlite')); await clock.jump(DAY); },
    async seedAndRecall(n: number) {
      const texts: string[] = [];
      for (let i = 0; i < n; i++) {
        const text = ['Lighthouse architecture decision: preserve the durable amber lamp setting for the north coast.', 'We decided to deploy release pipelines only on Tuesday mornings after checklist approval.'][i]!;
        texts.push(text);
        const result = await engine.capture({ agentId: 'alpha', principal, agent: user, incognito: false, runId: randomUUID(), sessionKey: 'agent:alpha:main', messages: [{ role: 'user', content: text }, { role: 'assistant', content: 'Noted.' }], signal: AbortSignal.timeout(10_000) }).done;
        assert.ok(result.stored > 0, JSON.stringify(result));
        captures += result.stored;
      }
      assert.equal((await engine.jobs.run('emotion-refine', 'alpha')).outcome, 'completed');
      const cards = await engine.memory.list({ since: 0, limit: 100 }, principal, user);
      const ids = texts.map(text => { const card = cards.items.find(row => row.text.includes(text)); assert.ok(card); assert.equal(card.scope, 'agent-private'); return card.id; });
      for (const query of ['lighthouse architecture', 'which amber lamp setting', 'durable lighthouse decision']) {
        const result = await engine.recall({ query, principal, agent: user, signal: AbortSignal.timeout(10_000), budget: { hardMs: 10_000, softMs: 10_000 } });
        assert.equal(result.degraded, null);
        for (const id of ids) assert.ok(result.blocks.some(block => block.text.includes(id)), `actual rendered recall includes ${id}`);
      }
      return ids;
    },
  };
}

it('A3 actual Engine recall stats, scheduler promotion and post-write restart recovery', { timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const memory = curated(f.engine, t);
  if (!memory) return;
  const ids = await f.seedAndRecall(1);
  const before = await memory.stats(ids, f.principal, user);
  assert.equal(before.items[0]!.recalls, 3);
  assert.equal(before.items[0]!.distinctQueries, 3);
  assert.ok(before.items[0]!.lastRecalledAt! > 0);
  const path = join(f.workspaceDir, 'memory', 'KNOWLEDGE.md');
  const scheduler = f.makeScheduler(memory, undefined, receipt => {
    assert.deepEqual(receipt.items.map(item => [item.id, item.outcome, item.reason]), [[ids[0], 'promoted', 'integrated']]);
    assert.ok(readFileSync(path, 'utf8').includes(ids[0]!));
    assert.equal(f.store.listCandidates('alpha', 'promoted').length, 0);
    throw new Error('simulated interruption after Engine commit before Harness ledger receipt');
  });
  const interrupted = await scheduler.runPhase('alpha', 'deep', { trigger: 'manual' });
  assert.equal(interrupted.outcome, 'failed', JSON.stringify(interrupted));
  assert.match(interrupted.error!.message, /simulated interruption/);
  assert.deepEqual(f.jobCalls, ['consolidate-daily', 'auto-accept-stale', 'gc-run']);
  assert.equal(f.store.listCandidates('alpha', 'shortlisted').length, 1);
  assert.equal(f.store.listCandidates('alpha', 'promoted').length, 0);
  const body = readFileSync(path, 'utf8');
  assert.equal((body.match(/<!-- plur1bus-promotion:/g) ?? []).length, 1);
  await f.restart();
  const reopened = curated(f.engine, t)!;
  assert.deepEqual(await reopened.stats(ids, f.principal, user), before, 'public counters persist across actual Engine reopen');
  const recovery = f.makeScheduler(reopened);
  assert.equal(recovery.reconcile(), 0, 'the interrupted run was recorded failed, not an open phantom run');
  const recovered = await recovery.runPhase('alpha', 'deep', { trigger: 'manual' });
  assert.equal(recovered.outcome, 'completed', JSON.stringify(recovered));
  assert.equal(recovered.counts.promoted, 1);
  const row = f.store.listCandidates('alpha', 'promoted')[0]!;
  const decision = row.decision as { engine: { id: string; outcome: string; reason: string } };
  assert.deepEqual(decision.engine, { id: ids[0], outcome: 'skipped', reason: 'already-promoted' });
  assert.equal(row.recalls, 3); assert.equal(row.uniqueQueries, 3);
  assert.equal(readFileSync(path, 'utf8'), body, 'recovery never appends duplicate source evidence');
});

it('A3 actual disabled, cap, live-lock and removed-source receipts never falsely promote the ledger', { timeout: 120_000 }, async t => {
  for (const scenario of ['disabled', 'cap', 'lock', 'lifecycle'] as const) {
    const f = await fixture(t, { enabled: scenario !== 'disabled', maxPromotionsPerRun: scenario === 'cap' ? 1 : 0 });
    const memory = curated(f.engine, t);
    if (!memory) return;
    const ids = await f.seedAndRecall(2);
    const receipts: CandidatePromotionResult[] = [];
    const scheduler = f.makeScheduler(memory, async selected => {
      assert.equal(selected.length, 2, 'both real sources passed the 3 distinct recall gates');
      if (scenario === 'lock') {
        const dir = join(f.workspaceDir, '.adaptive-learning'); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'knowledge-update.lock'), JSON.stringify({ nonce: randomUUID(), pid: process.pid, host: hostname(), acquiredAt: Date.now() }), { flag: 'wx' });
      }
      if (scenario === 'lifecycle') for (const id of ids) assert.equal((await f.engine.memory.forget(id, f.principal, user)).archived, true);
    }, receipt => { receipts.push(receipt); });
    const result = await scheduler.runPhase('alpha', 'deep', { trigger: 'manual' });
    assert.equal(result.outcome, 'completed', `${scenario}: ${JSON.stringify(result)}`);
    assert.deepEqual(f.jobCalls, ['consolidate-daily', 'auto-accept-stale', 'gc-run']);
    assert.equal(receipts.length, 1);
    const expectedReason = { disabled: 'disabled', cap: 'cap-reached', lock: 'lock-busy', lifecycle: 'not-live' }[scenario];
    const expectedPromoted = scenario === 'cap' ? 1 : 0;
    assert.equal(receipts[0]!.items.filter(item => item.reason === expectedReason).length, 2 - expectedPromoted, `${scenario}: ${JSON.stringify(receipts)}`);
    assert.equal(result.counts.promoted, expectedPromoted);
    assert.equal(f.store.listCandidates('alpha', 'promoted').length, expectedPromoted);
    const shortlisted = f.store.listCandidates('alpha', 'shortlisted');
    assert.equal(shortlisted.length, 2 - expectedPromoted);
    for (const row of shortlisted) assert.equal((row.decision as { engine: { reason: string } }).engine.reason, expectedReason);
    const path = join(f.workspaceDir, 'memory', 'KNOWLEDGE.md');
    assert.equal(existsSync(path), expectedPromoted > 0);
    if (expectedPromoted) assert.equal((readFileSync(path, 'utf8').match(/<!-- plur1bus-promotion:/g) ?? []).length, 1);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createCore } from '../../src/core.ts';
import { connect } from '../helpers/connect.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { scriptedAdapter } from '../composition/helpers.ts';
import type { SessionEvent, SessionEventsResult, SessionSubmitResult } from '@plur1bus/rpc-schema';

test('D103 system: RPC turns refresh skill metadata, retain loaded bodies and apply edits in a new session', async t => {
  const previous = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  t.after(() => {
    for (const [name, value] of [['PLUR1BUS_ALLOW_TEST_INTERNALS', previous.allow], ['PLUR1BUS_SECRETS_KEYRING', previous.keyring]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = '1';
  process.env.PLUR1BUS_SECRETS_KEYRING = 'memory';
  const home = tempDir('d103-core-'); const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { duplicateThreshold: 1.01, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  cfg.modelRoles.decision = 'triage';
  // Triage (200 ms) and the skill choice (100 ms) keep their production budgets for reference hardware; a shared CI runner
  // (Windows) can outlast them. This lifecycle test exercises the recorded model decision; these budgets catch a hang.
  cfg.decision.timeoutMs = 10_000; cfg.decision.budgets = { triage: 10_000, skills: 10_000 };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const wire = scriptedAdapter([{ text: 'done' }]);
  const recorded = { schema: 'plur1bus.triage/1', shape: 'single', tasks: [{ id: 'report', summary: 'Create quarterly report', start: 0, end: 23, categories: { 'docs.create': 1 }, modelClass: { small: 1, medium: 0, large: 0, frontier: 0 }, chosenClass: 'small', effort: 'low', dependsOn: [], confidence: 1, reason: 'fixture' }] };
  // The role handles both triage and final skill choices through the real TurnRunner/provider path.
  const classifier = { adapter: { async *stream(request: Parameters<typeof wire.adapter.stream>[0]) {
    const user=request.messages.filter(m=>m.role==='user').at(-1)?.content;
    const payload=JSON.parse(typeof user==='string'?user:'{}') as {options?:{id:string}[]};
    const options=payload.options;
    const id=options?.find(o=>o.id!=='none')?.id ?? 'none';
    const text=JSON.stringify(options?{id,probabilities:Object.fromEntries(options.map(o=>[o.id,o.id===id?1:0])),confidence:1}:recorded);
    yield* scriptedAdapter([{text}]).adapter.stream(request);
  } } };
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false }, composition: { providers: { profiles: { triage: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: classifier.adapter }], default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: wire.adapter }] } } } });
  await core.start(); const client = await connect({ address: core.address, token: core.token });
  try {
    const caller = { channel: 'cli', accountId: 'host', userId: 'alice' };
    const { session } = await client.call<{ session: { id: string } }>('session.create', { caller, agentId: 'bernd' });
    const loadData = (event: SessionEvent) => event.data as { id?: string; name?: string; args?: { name?: string } };
    const turn = async (sessionId = session.id) => {
      const result = await client.call<SessionSubmitResult>('session.submit',
        { caller, sessionId, text: 'Create quarterly report', wait: true });
      assert.equal(result.state, 'completed');
      const { events } = await client.call<SessionEventsResult>('session.events', { caller, sessionId });
      const current = events.filter(event => event.turnId === result.turnId);
      const loads = current.filter(event => event.type === 'tool.call' && loadData(event).name === 'skill.load');
      const request = wire.requests.at(-1)!;
      const system = request.messages.filter(message => message.role === 'system')
        .map(message => message.content).join('\n');
      return { request, system, loads, current };
    };
    const first = await turn();
    assert.doesNotMatch(first.system, /reports:/);
    assert.equal(first.loads.length, 0);
    assert(!JSON.stringify(first.request).includes('local-report-workflow'));
    mkdirSync(join(home, 'skills/reports'), { recursive: true });
    writeFileSync(join(home, 'skills/reports/SKILL.md'), '---\nname: reports\ndescription: Create quarterly report\ncategory: docs.create\n---\nlocal-report-workflow');
    const setEnabled = (enabled: boolean) => writeFileSync(join(home, 'skills/index.json'), JSON.stringify({ version: 1, skills: [{ id: 'reports', enabled }] }));
    setEnabled(true);
    const installed = await turn();
    assert.match(installed.system, /reports: Create quarterly report/);
    assert.equal(installed.loads.length, 1);
    assert.equal(loadData(installed.loads[0]!).args?.name, 'reports');
    const installedResult = installed.current.find(event => event.type === 'tool.result'
      && loadData(event).id === loadData(installed.loads[0]!).id)!;
    assert.equal(JSON.parse((installedResult.data as { output: string }).output).value.text, 'local-report-workflow');
    assert.doesNotMatch(installed.system, /local-report-workflow/);
    writeFileSync(join(home, 'skills/reports/SKILL.md'),
      '---\nname: reports\ndescription: Create revised quarterly report\ncategory: docs.create\n---\nrevised-local-report-workflow');
    const edited = await turn();
    assert.match(edited.system, /reports: Create revised quarterly report/);
    assert.equal(edited.loads.length, 0);
    assert(JSON.stringify(edited.request).includes('local-report-workflow'));
    assert(!JSON.stringify(edited.request).includes('revised-local-report-workflow'));
    const { session: newSession } = await client.call<{ session: { id: string } }>('session.create',
      { caller, agentId: 'bernd' });
    const refreshed = await turn(newSession.id);
    assert.equal(refreshed.loads.length, 1);
    const revisedResult = refreshed.current.find(event => event.type === 'tool.result'
      && loadData(event).id === loadData(refreshed.loads[0]!).id)!;
    assert.equal(JSON.parse((revisedResult.data as { output: string }).output).value.text,
      'revised-local-report-workflow');
    setEnabled(false);
    const disabled = await turn(newSession.id);
    assert.doesNotMatch(disabled.system, /reports:/);
    assert.equal(disabled.loads.length, 0);
    assert(!disabled.request.tools?.some(tool => tool.name === 'skill_load' || tool.name === 'skill_read'));
  } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
});

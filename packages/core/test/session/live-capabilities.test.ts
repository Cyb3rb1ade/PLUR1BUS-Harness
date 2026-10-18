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

test('D103 system: install, update and disable between RPC turns without restarting the core', async () => {
  const home = tempDir('d103-core-'); const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { duplicateThreshold: 1.01, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  cfg.modelRoles.decision = 'triage';
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const wire = scriptedAdapter([{ text: 'done' }]);
  const recorded = { schema: 'plur1bus.triage/1', shape: 'single', tasks: [{ id: 'report', summary: 'Create quarterly report', start: 0, end: 23, categories: { 'docs.create': 1 }, modelClass: { small: 1, medium: 0, large: 0, frontier: 0 }, chosenClass: 'small', effort: 'low', dependsOn: [], confidence: 1, reason: 'fixture' }] };
  const classifier = scriptedAdapter([{ text: JSON.stringify(recorded) }]);
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false }, composition: { providers: { profiles: { triage: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: classifier.adapter }], default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: wire.adapter }] } } } });
  await core.start(); const client = await connect({ address: core.address, token: core.token });
  try {
    const caller = { channel: 'cli', accountId: 'host', userId: 'alice' };
    const { session } = await client.call<{ session: { id: string } }>('session.create', { caller, agentId: 'bernd' });
    const turn = async () => {
      const result = await client.call<{ state: string }>('session.submit', { caller, sessionId: session.id, text: 'Create quarterly report', wait: true });
      assert.equal(result.state, 'completed'); return JSON.stringify(wire.requests.at(-1));
    };
    assert(!(await turn()).includes('local-report-workflow'));
    mkdirSync(join(home, 'skills/reports'), { recursive: true });
    writeFileSync(join(home, 'skills/reports/SKILL.md'), '---\nname: reports\ndescription: Create quarterly report\ncategory: docs.create\n---\nlocal-report-workflow');
    const setEnabled = (enabled: boolean) => writeFileSync(join(home, 'skills/index.json'), JSON.stringify({ version: 1, skills: [{ id: 'reports', enabled }] }));
    setEnabled(true); assert((await turn()).includes('local-report-workflow'));
    setEnabled(false); assert(!(await turn()).includes('local-report-workflow'));
  } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
});

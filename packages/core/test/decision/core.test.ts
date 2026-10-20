import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { validateParams } from '@plur1bus/rpc-schema';
import { createCore } from '../../src/core.ts';
import { connect } from '../helpers/connect.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { scriptedAdapter } from '../composition/helpers.ts';
test('full Core routes triage, mapped decision events and synthetic diagnostic through the shared service', async () => {
  const home = tempDir('decision-core-'), cfg = defaults(); cfg.agents.bernd = {}; cfg.modelRoles.decision = 'decision';
  cfg.engine = { duplicateThreshold: 1.01, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg));
  const triage = { schema: 'plur1bus.triage/1', shape: 'single', tasks: [{ id: 'task', summary: 'Search', start: 0, end: 6, categories: { 'web.research': 1 }, modelClass: { small: 1, medium: 0, large: 0, frontier: 0 }, chosenClass: 'small', effort: 'low', dependsOn: [], confidence: 1, reason: 'secret-model-prose' }] };
  const decision = scriptedAdapter([{ text: JSON.stringify(triage) }, { text: JSON.stringify({ id: 'even', probabilities: { even: 1, odd: 0 }, confidence: 1 }) }]);
  const main = scriptedAdapter([{ text: 'done' }]);
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false }, composition: { providers: { profiles: { decision: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: decision.adapter }], default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: main.adapter }] } } } });
  await core.start(); const rpc = await connect({ address: core.address, token: core.token });
  try {
    const caller = { channel: 'cli', accountId: 'host', userId: 'alice' };
    const { session } = await rpc.call<{ session: { id: string } }>('session.create', { caller, agentId: 'bernd' });
    const result = await rpc.call<{ state: string }>('session.submit', { caller, sessionId: session.id, text: 'Search', wait: true }); assert.equal(result.state, 'completed');
    const { events } = await rpc.call<{ events: { type: string; data: Record<string, unknown> }[] }>('session.events', { caller, sessionId: session.id });
    const trace = events.filter(e => e.type === 'decision.completed'); assert.equal(trace.length, 1); assert.equal(trace[0]!.data.outcome, 'accepted'); assert(!JSON.stringify(trace).includes('secret-model-prose')); assert(!JSON.stringify(trace).includes('Search'));
    const before = await rpc.call<{ requests: number; failures: number }>('decision.status', {}); assert.equal(before.requests, 1); assert.equal(before.failures, 0);
    const probe = await rpc.call<{ ok: boolean; outcome: string }>('decision.test', { agentId: 'bernd' }); assert.equal(probe.ok, true); assert.equal(probe.outcome, 'accepted');
    const request = decision.requests[1]!; assert.deepEqual(request.tools, []); assert(JSON.stringify(request.messages).includes('Is this integer even or odd?')); assert(!JSON.stringify(request.messages).includes('Search'));
    const after = await rpc.call<{ requests: number }>('decision.status', {}); assert.equal(after.requests, 2);
    assert.equal(validateParams('decision.test', { agentId: 'bernd', prompt: 'arbitrary' }).ok, false);
    const replay = await rpc.call<{ events: unknown[] }>('session.events', { caller, sessionId: session.id }); assert.equal(replay.events.length, events.length);
  } finally { await rpc.close(); await core.stop({ budgetMs: 5000 }); }
});

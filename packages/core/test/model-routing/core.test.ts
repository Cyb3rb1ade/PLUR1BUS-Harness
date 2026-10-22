import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaults } from '@plur1bus/config-schema';
import { createCore } from '../../src/core.ts';
import { connect } from '../helpers/connect.ts';
import { flatTestInternals } from '../helpers/flat-embedder.ts';
import { tempDir } from '../helpers/temp-dir.ts';
import { scriptedAdapter } from '../composition/helpers.ts';
import type { StreamingAdapter } from '../../../providers/src/index.ts';
test('Core persists actual model/reason, restores a completed session choice across restart, and leaks no prompt into trace', async () => {
  const home = tempDir('f5-model-core-'), cfg = defaults(); cfg.agents.bernd = { model: 'cheap', modelPolicy: { mode: 'auto', tiers: ['cheap', 'quality'], perTurn: false } }; cfg.modelRoles.decision = 'decision';
  cfg.engine = { duplicateThreshold: 1.01, neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } };
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg)); let routingCalls = 0, prefer = 'cheap';
  const classifier: StreamingAdapter = { async *stream(request) {
    const body = JSON.parse(String(request.messages.findLast(m => m.role === 'user')?.content));
    const output = 'message' in body ? { schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] } : (routingCalls++, { id: prefer, probabilities: { cheap: prefer === 'cheap' ? 1 : 0, quality: prefer === 'quality' ? 1 : 0 }, confidence: 1 });
    const text = JSON.stringify(output); yield { type: 'text_delta', text }; yield { type: 'done', result: { text, toolCalls: [], finishReason: 'stop', rawFinishReason: 'stop', usage: { inputTokens: 40, outputTokens: 20 }, meta: {} } };
  } };
  const cheap = scriptedAdapter([{ text: 'cheap' }]), quality = scriptedAdapter([{ text: 'quality' }]);
  const make = () => createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false }, composition: { providers: { profiles: { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: quality.adapter }], decision: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: classifier }], cheap: [{ provider: 'fixture', model: 'gpt-4.1-mini', adapter: cheap.adapter }], quality: [{ provider: 'fixture', model: 'gpt-4.1', adapter: quality.adapter }] } } } });
  let core = make(); await core.start(); let rpc = await connect({ address: core.address, token: core.token });
  const caller = { channel: 'cli', accountId: 'host', userId: 'alice' };
  try {
    const { session } = await rpc.call<{ session: { id: string } }>('session.create', { caller, agentId: 'bernd' });
    const first = await rpc.call<{ state: string }>('session.submit', { caller, sessionId: session.id, text: 'private-marker-small-task', wait: true }); assert.equal(first.state, 'completed');
    assert.equal(routingCalls, 1); assert.equal(cheap.requests.length, 1);
    await rpc.close(); await core.stop({ budgetMs: 5000 }); prefer = 'quality';
    core = make(); await core.start(); rpc = await connect({ address: core.address, token: core.token });
    const second = await rpc.call<{ state: string }>('session.submit', { caller, sessionId: session.id, text: 'private-marker-complex-architecture', wait: true }); assert.equal(second.state, 'completed');
    assert.equal(routingCalls, 1); assert.equal(cheap.requests.length, 2); assert.equal(quality.requests.length, 0);
    const { events } = await rpc.call<{ events: { type: string; data: Record<string, unknown> }[] }>('session.events', { caller, sessionId: session.id });
    const routed = events.filter(e => e.type === 'model.selected'); assert.equal(routed.length, 2); assert.equal(routed[0]!.data.model, 'gpt-4.1-mini'); assert.equal(routed[1]!.data.reasonCode, 'session-cache'); assert(!JSON.stringify(routed).includes('private-marker'));
  } finally { await rpc.close(); await core.stop({ budgetMs: 5000 }); }
});

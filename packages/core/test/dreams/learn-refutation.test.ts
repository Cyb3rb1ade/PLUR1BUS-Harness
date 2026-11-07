import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../../src/dreams/learn/aggregation.ts';
import { refuteFinding, wordFinding, evidenceView } from '../../src/dreams/learn/refutation.ts';
import type { Transcript } from '../../src/dreams/learn/types.ts';

const ref = { sessionId: 'session', turnId: 'turn', sourceId: 'message', source: 'message' as const, trust: 'person' as const, day: '2026-11-01', agentId: 'agent', owner: 'owner' };
const finding = () => ({ ...aggregate([{ kind: 'knowledge', change: 'add', text: 'A fact', evidence: [ref] }], { scope: 'agent', owner: 'owner', agentId: 'agent' }, 'run', 1)[0]!, desiredTier: 'A' as const });
const source = { session: { id: 'session', owner: 'owner', agentId: 'agent' }, messages: [{ id: 'message', sessionId: 'session', turnId: 'turn', text: 'Evidence' }, { id: 'unrelated', text: 'PRIVATE_UNRELATED_MARKER' }], events: [] } as unknown as Transcript;
test('all skeptic verdicts stay manual in shadow and the skeptic only sees referenced evidence', async () => {
  for (const verdict of ['holds', 'refuted', 'insufficient']) {
    const f = await refuteFinding(finding(), [source], async (stage, _key, data) => {
      assert.equal(stage, 'skeptic'); assert.doesNotMatch(JSON.stringify(data), /PRIVATE_UNRELATED_MARKER/);
      assert.deepEqual(Object.keys(data as object).sort(), ['evidence', 'finding', 'verify']);
      return { text: JSON.stringify({ verdict }), model: 'fixture/large', inputTokens: 10, outputTokens: 5 };
    });
    assert.equal(f.skeptic, verdict); assert.equal(f.effectiveTier, 'C'); assert.equal(f.status, 'pending');
  }
});
test('evidence from another owner is refused and C findings do not request a skeptic', async () => {
  assert.throws(() => evidenceView(finding(), [{ ...source, session: { ...source.session, owner: 'other' } }]), /rights-changed/);
  const f = { ...finding(), desiredTier: 'C' as const };
  assert.deepEqual(await refuteFinding(f, [], async () => { assert.fail('no model call'); }), f);
});
test('wording cannot mutate actions, targets or evidence and rejects extra authority fields', async () => {
  const f = finding(); const result = await wordFinding(f, async () => ({ text: '{"text":"A clearer fact"}', model: 'fixture/large', inputTokens: 2, outputTokens: 3 }));
  assert.deepEqual(result.target, f.target); assert.deepEqual(result.evidence, f.evidence); assert.equal(result.change, f.change);
  await assert.rejects(wordFinding(f, async () => ({ text: '{"text":"A fact","desiredTier":"A"}', model: 'fixture/large', inputTokens: 2, outputTokens: 3 })), /invalid-output/);
});

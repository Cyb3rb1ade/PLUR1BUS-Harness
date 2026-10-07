import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triage, chooseClass, escalate, applyAtBoundary, ruleClassifier } from '../../src/triage/index.ts';
import { CapabilityIndex } from '../../src/toolcall/capabilities.ts';
const row = { id: 'search', name: 'web.search', description: 'Search reviews online', category: 'web.research', kind: 'tool' as const, effect: 'read' as const, risk: 'low' as const, source: 'harness', version: '1' };
test('incremental index, filters, explainability, immutable snapshots and unchanged-intent routing', () => {
  const index = new CapabilityIndex(); index.upsert(row);
  assert.equal(index.search('reviews')[0]?.entry.id, 'search');
  index.upsert({ ...row, id: 'skill', kind: 'skill' }); assert.equal(index.search('reviews', { kind: 'skill' }).length, 1);
  assert.ok(index.route('reviews', { 'web.research': 1 }, 1).items[0]?.reasons.length);
  const a = index.route('reviews', { 'web.research': 1 }, 1); const b = index.route('reviews', { 'web.research': 1 }, 1); assert.equal(b.cached, true);
  index.remove('search'); assert.equal(index.route('reviews', { 'web.research': 1 }, 1).cached, false);
  assert.equal(index.categoriesPrefix(), index.categoriesPrefix()); assert.equal(a.items.length, 1);
});
test('triage English/German segmentation, cost thresholds and boundary-only changes', () => {
  assert.equal(triage('Search reviews; then create a report').tasks.length, 2);
  assert.equal(triage('Suche Bewertungen; danach erstelle einen Bericht').tasks.length, 2);
  assert.equal(chooseClass({ small: .1, medium: .75, large: .12, frontier: .03 }), 'medium');
  assert.equal(chooseClass({ small: .1, medium: .75, large: .12, frontier: .03 }, 'quality'), 'large');
  assert.equal(escalate('medium', false), 'large'); assert.equal(escalate('medium', true), 'medium');
  assert.equal(applyAtBoundary('small', 'large', false), 'small');
  let calls = 0; triage('yes', { activeTask: 'k1', classifier: input => { calls++; return ruleClassifier(input); } }); assert.equal(calls, 0);
});
test('classifier distributions rejected if malformed; confidence bumps one class', () => {
  assert.throws(() => chooseClass({ small: -1, medium: 1, large: 0, frontier: 1 }), /distribution/);
  assert.equal(chooseClass({ small: 1, medium: 0, large: 0, frontier: 0 }, 'balanced', .4), 'medium');
});
test('profile table respects provider order and allowed profiles; no hidden class fallback', async () => {
  const { resolveClass } = await import('../../src/triage/classes.ts');
  assert.deepEqual(resolveClass('medium', ['anthropic', 'local'], new Set(['local:14-32b'])), { provider: 'local', profile: '14-32b' });
  assert.equal(resolveClass('frontier', ['local'], new Set(['local:70b-plus'])), undefined);
  assert.equal(escalate('frontier', false), 'frontier');
});
test('classifier called once and result preserved; followup async port is skipped', async () => {
  const { triageWithClassifier } = await import('../../src/triage/index.ts');
  let calls = 0; const original = ruleClassifier({ message: 'Search reviews', cost: 'balanced' });
  triage('Search reviews', { classifier: () => { calls++; return original; } }); assert.equal(calls, 1);
  assert.deepEqual(original, ruleClassifier({ message: 'Search reviews', cost: 'balanced' }));
  await triageWithClassifier('ja', async () => { throw Error('must skip'); }, { activeTask: 'k1' });
});

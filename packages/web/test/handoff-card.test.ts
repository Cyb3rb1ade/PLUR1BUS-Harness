import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffCardData } from '../src/pages/projects/handoff-card.ts';
test('handoff and partial return cards are recognized as data', () => {
  assert.deepEqual(handoffCardData(JSON.stringify({ schema: 'plur1bus.handoff/1', id: 'ho_one', objective: '<script>untrusted</script>', kind: 'delegate', doneWhen: ['test green'] })), { schema: 'plur1bus.handoff/1', id: 'ho_one', title: '<script>untrusted</script>', status: 'delegate', criteria: ['test green'] });
  assert.equal(handoffCardData(JSON.stringify({ schema: 'plur1bus.return/1', id: 'rt_one', summary: 'Partial', status: 'partial' }))?.status, 'partial');
  for (const text of ['ordinary **markdown**', '{}', 'null', 'x'.repeat(32769)]) assert.equal(handoffCardData(text), null);
});

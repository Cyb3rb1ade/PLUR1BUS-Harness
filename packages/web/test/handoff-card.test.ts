import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerArea } from '../src/i18n/index.ts';
import * as projects from '../src/i18n/projects.ts';
import { HandoffContent, handoffCardData } from '../src/pages/projects/handoff-card.ts';
test('handoff and partial return cards are recognized as data', () => {
  assert.deepEqual(handoffCardData(JSON.stringify({ schema: 'plur1bus.handoff/1', id: 'ho_one', objective: '<script>untrusted</script>', kind: 'delegate', doneWhen: ['test green'] })), { schema: 'plur1bus.handoff/1', id: 'ho_one', title: '<script>untrusted</script>', status: 'delegate', criteria: ['test green'] });
  assert.equal(handoffCardData(JSON.stringify({ schema: 'plur1bus.return/1', id: 'rt_one', summary: 'Partial', status: 'partial' }))?.status, 'partial');
  for (const text of ['ordinary **markdown**', '{}', 'null', 'x'.repeat(32769)]) assert.equal(handoffCardData(text), null);
});
test('handoff status labels resolve for snake_case wire statuses', () => {
  registerArea('projects', projects);
  for (const [status, label] of [['done_with_concerns', 'Done with concerns'], ['needs_context', 'Needs context']] as const) {
    const vnode = HandoffContent({ content: JSON.stringify({ schema: 'plur1bus.return/1', id: 'rt_one', summary: 'S', status }) });
    assert.match(JSON.stringify(vnode), new RegExp(label));
  }
});

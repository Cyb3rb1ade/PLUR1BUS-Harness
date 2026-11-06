import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { alsAgentScopePort, runWithAgentScope, scopeFor } from '../../src/collab/scope.ts';
import { owner } from '../collab/helpers.ts';
import { nativeCardFixture } from './native-card-fixture.ts';

test('a consultation never selects a writable project root or asks for a card mount', async () => {
  let rootCalls = 0;
  let turns = 0;
  const runner = composedAgentRunner({ id: 'fixture', async *stream(req) {
    turns++;
    assert.equal(req.codingWorktree, undefined, 'a consultation is not a writable card assignment');
    yield { type: 'delta', text: 'Consultation complete' };
  } }, alsAgentScopePort(), '/unused', [], undefined, {
    root() { rootCalls++; return '/unrelated-project-root'; },
  });
  await runWithAgentScope(scopeFor('worker', 'project'), () => runner.run({
    agentId: 'worker', principal: owner(), question: 'Review only', context: '',
    signal: new AbortController().signal,
  }));
  assert.equal(turns, 1);
  assert.equal(rootCalls, 0, 'an unbound consultation must not select the project checkout');
});

test('card checkout lookup rechecks the receiving agent assignment in the live board', () => {
  const b = nativeCardFixture();
  try {
    assert.equal(b.port.root('worker', b.project.id, b.card.id), b.tree.path);
    assert.equal(b.port.root('other', b.project.id, b.card.id), null,
      'project membership without this card assignment grants no coding checkout');
    b.collab.boardStore.assign(b.project.id, b.card.id, { kind: 'agent', id: 'worker' }, false,
      { kind: 'person', id: b.who.userId });
    assert.equal(b.port.root('worker', b.project.id, b.card.id), null, 'assignment removal is live');
    assert.equal(b.port.root('worker', b.project.id, 'unknown-card'), null);
  } finally { b.close(); }
});

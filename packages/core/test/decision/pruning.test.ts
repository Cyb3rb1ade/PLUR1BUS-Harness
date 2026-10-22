import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '@plur1bus/config-schema';
import { DecisionClient } from '../../src/decision/client.ts';
import { decisionPruningPort } from '../../src/decision/pruning.ts';
import { ToolPruner, defaultPrune } from '../../src/session/pruning.ts';
import { SessionStore } from '../../src/session/store.ts';
for (const mode of ['valid', 'uncertain', 'malformed', 'cloud'] as const) test(`production pruning keeps protected pairs and treats ${mode} output conservatively`, async () => {
  const cfg = defaults(); const store = new SessionStore({ path: ':memory:' }); const session = store.createSession({ kind: 'direct', agentId: 'a', owner: 'owner' });
  const add = (name: string) => { const { turn } = store.beginTurn(session.id, 'Read', 1); store.appendEvent(turn.id, 'tool.call', { id: name, name, args: {} }); store.appendEvent(turn.id, 'tool.result', { id: name, output: 'data '.repeat(300) }); store.completeTurn(turn.id, { text: 'done', tokens: 1 }); };
  add('file.read'); add('audit.check'); add('recent');
  let calls = 0;
  const client = new DecisionClient({ config: () => cfg, backends: { role: { local: () => mode !== 'cloud', async run() { calls++; return mode === 'malformed' ? {} : { id: 'drop', probabilities: { keep: .1, truncate: 0, drop: .9 }, confidence: mode === 'uncertain' ? .2 : .9 }; } } } });
  const pruner = new ToolPruner(store, { ...defaultPrune(), keepLastTurns: 1 }, { decide: decisionPruningPort(client, () => ({ agentId: 'a', principal: 'owner', signal: new AbortController().signal })) });
  try { assert.equal(await pruner.run(session.id), mode === 'valid' ? 1 : 0); assert.equal(calls, mode === 'cloud' ? 0 : 1); assert.equal(pruner.view(session.id).find(p => p.call.data.name === 'audit.check')!.hidden, false); assert.equal(pruner.view(session.id).find(p => p.call.data.name === 'recent')!.hidden, false); } finally { store.close(); }
});

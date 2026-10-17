import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { defaults } from '@plur1bus/config-schema';
import { createAgentRegistry } from '../../src/agents.ts';
import { layout } from '../../src/paths.ts';
import { engineTurnMemory } from '../../src/session/memory-port.ts';
import { openSessionService } from '../../src/session/service.ts';
import { createCollab } from '../../src/collab/service.ts';
import { composedAgentRunner } from '../../src/composition/collaboration.ts';
import { alsAgentScopePort } from '../../src/collab/scope.ts';
import { collaborationTools } from '../../src/tools/collaboration.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { scriptedAdapter, turnFixture, useTempDirs } from '../composition/helpers.ts';

const tmp = useTempDirs('m5-isolation-');
test('real SQLite stores + fake engine: peer agent-private and user markers never reach caller, pool, remote or prompt', async t => {
  const home = tmp.make(); const cfg = defaults(); cfg.agents.a1 = {}; cfg.agents.b1 = {};
  const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, async close() {} } as never;
  for (const id of ['a1', 'b1']) mkdirSync(join(home, 'agents', id, 'workspace'), { recursive: true });
  const agents = createAgentRegistry({ config: () => cfg }, layout(home), log);
  const stores = Object.fromEntries(['a1', 'b1', 'pool', 'remote'].map(id => { const db = new DatabaseSync(join(home, `${id}.sqlite`)); db.exec('CREATE TABLE memory(scope TEXT, body TEXT)'); return [id, db]; }));
  for (const scope of ['agent-private', 'user']) stores.b1!.prepare('INSERT INTO memory VALUES (?, ?)').run(scope, `peer-${scope}-isolation-marker`);
  const accessed: string[] = [];
  const fakeEngine = {
    async recall(input: { principal: { agentId: string } }) { const id = input.principal.agentId; accessed.push(`read:${id}`); return { blocks: stores[id]!.prepare('SELECT body FROM memory').all().map(r => ({ name: 'memory', text: r.body, chars: String(r.body).length, droppable: true })), capChars: 8000 }; },
    capture(input: { agentId: string; messages: unknown }) { accessed.push(`write:${input.agentId}`); stores[input.agentId]!.prepare('INSERT INTO memory VALUES (?, ?)').run('agent-private', JSON.stringify(input.messages)); return { id: 'capture', done: Promise.resolve({ stored: 1, skipped: 0 }) }; },
    async checkpoint() {},
  };
  const memory = engineTurnMemory({ engine: fakeEngine as never, config: () => cfg, agents, logger: log, captureSignal: new AbortController().signal, isStopping: () => false });
  const owner = { kind: 'person' as const, userId: 'christian', role: 'owner' as const };
  const peerSeen: unknown[] = [];
  const collab = createCollab({ path: join(home, 'collab.sqlite'), runner: composedAgentRunner({ id: 'peer', async *stream(req) { peerSeen.push(req); yield { type: 'delta', text: 'Use a stable sort.' }; } }, alsAgentScopePort(), home) });
  const project = collab.createProject(owner, { name: 'Isolation' }); for (const a of ['a1', 'b1']) collab.addAgent(owner, project.id, a);
  const script = scriptedAdapter([{ calls: [{ id: 'advice', name: 'consult_agent', args: { projectId: project.id, toAgent: 'b1', objective: 'Sort advice' } }] }, { text: 'I use a stable sort.' }]);
  const root = turnFixture(script.adapter, { topK: 100, toolsForTurn: async req => {
    const reg = new ToolRegistry();
    for (const tool of collaborationTools({ collab, enabled: () => true, principal: () => owner, authority: { approvals: { get: () => undefined }, grants: { get: () => undefined }, now: Date.now, audit() {} } }, req)) reg.register(tool);
    return reg;
  } }, home);
  const sessions = openSessionService({ dbPath: join(home, 'sessions.sqlite'), clock: Date.now, logger: log, agents, isStopping: () => false, memory, provider: () => root.provider, notify() {}, signal: new AbortController().signal });
  t.after(async () => { await sessions.close(); await collab.shutdown(); root.close(); for (const db of Object.values(stores)) db.close(); });
  const session = sessions.store.createSession({ owner: owner.userId, agentId: 'a1', kind: 'direct', scope: 'private' });
  const turn = sessions.runner.submit({ session, caller: { channel: 'cli', accountId: 'local', userId: 'christian' }, text: 'Get peer sorting advice', approver: { person: owner.userId, surface: 1 } });
  const result = await turn.done;
  assert.equal(result.state, 'completed', JSON.stringify(result));
  assert.deepEqual(accessed, ['read:a1', 'write:a1']);
  const published = JSON.stringify({ peerSeen, requests: script.requests, transcript: sessions.store.listMessages(session.id), traces: collab.listTraces(owner, project.id), caller: stores.a1!.prepare('SELECT * FROM memory').all(), pool: stores.pool!.prepare('SELECT * FROM memory').all(), remote: stores.remote!.prepare('SELECT * FROM memory').all() });
  assert.ok(!published.includes('peer-agent-private-isolation-marker')); assert.ok(!published.includes('peer-user-isolation-marker'));
  assert.equal(stores.b1!.prepare('SELECT * FROM memory').all().length, 2);
});

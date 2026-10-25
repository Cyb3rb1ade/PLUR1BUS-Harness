import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCollab } from '../../src/collab/service.ts';
import { SessionStore } from '../../src/session/store.ts';
import { logsRedactionPort } from '../../src/collab/ports.ts';
import { useTempDirs } from '../composition/helpers.ts';
import { join } from 'node:path';
const tmp = useTempDirs('m5-replay-');
const owner = { userId: 'owner', kind: 'person' as const, role: 'owner' as const };
test('each delegation persists a redacted replayable session linked to W3C trace; replay is identical after reopen', async () => {
  const dir = tmp.make(); let sessions = new SessionStore({ path: join(dir, 'sessions.sqlite') });
  const make = () => createCollab({ path: join(dir, 'collab.sqlite'), sessions: () => sessions, redact: logsRedactionPort(['redact-probe-alpha']), runner: { async run() { return { text: 'redact-probe-alpha email user@example.com', inputTokens: 10, outputTokens: 8 }; } } });
  let collab = make(); tmp.onCleanup(() => { collab.close(); sessions.close(); }); // whichever pair is open by then: the test reopens both
  const p = collab.createProject(owner, { name: 'P' }); for (const id of ['a1', 'b1']) collab.addAgent(owner, p.id, id);
  const answer = await collab.consult({ principal: owner, projectId: p.id, fromAgent: 'a1', toAgent: 'b1', question: 'check redact-probe-alpha', context: '' });
  const trace = collab.getTrace(owner, answer.traceId), span = trace.spans[0]!;
  assert.ok(span.sessionId); assert.match(trace.traceparent, new RegExp(trace.traceId)); assert.deepEqual([span.inputTokens, span.outputTokens, "costEstimate" in span], [10, 8, false]);
  const first = collab.replay(owner, trace.traceId, span.spanId);
  assert.equal(first.sessionId, span.sessionId); assert.ok(first.events.some(e => e.data.provenance && JSON.stringify(e.data.provenance).includes(trace.traceId)));
  assert.ok(!JSON.stringify(first).includes('redact-probe-alpha')); assert.ok(!JSON.stringify(first).includes('user@example.com'));
  assert.deepEqual(collab.replay(owner, trace.traceId, span.spanId), first);
  assert.throws(() => collab.replay({ userId: 'other', kind: 'person', role: 'member', projectRights: { [p.id]: 'member' } }, trace.traceId, span.spanId), /access refused/);
  assert.throws(() => sessions.getOwned(span.sessionId!, 'other'));
  collab.close(); sessions.close(); sessions = new SessionStore({ path: join(dir, 'sessions.sqlite') }); collab = make();
  assert.deepEqual(collab.replay(owner, trace.traceId, span.spanId), first);
});
test('trace redaction follows credentials registered after composition startup', async () => {
  const { liveLogsRedactionPort } = await import('../../src/collab/ports.ts');
  const registered = new Set<string>(), port = liveLogsRedactionPort(() => registered);
  assert.equal(port.text('late-private-marker'), 'late-private-marker');
  registered.add('late-private-marker'); assert.ok(!port.text('late-private-marker').includes('late-private-marker'));
  assert.ok(!JSON.stringify(port.value({ transcript: 'late-private-marker' })).includes('late-private-marker'));
});

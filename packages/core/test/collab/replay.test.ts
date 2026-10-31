import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCollab } from '../../src/collab/service.ts';
import { CollabStore } from '../../src/collab/store.ts';
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
for (const [shape, traceId, spanId] of [
  ['IBAN-shaped', 'da5505d54b1a3491f41ff579e3175224', 'da5505d54b1a3491'],
  ['ordinary', 'a105f7ab7ec24989a6a1528f4ef63b44', 'a105f7ab7ec24989'],
] as const) test(`replay preserves authorized ${shape} provenance IDs while redacting untrusted content`, () => {
  const dir = tmp.make(), path = join(dir, 'collab.sqlite');
  let sessions = new SessionStore({ path: join(dir, 'sessions.sqlite') });
  const store = new CollabStore({ path });
  tmp.onCleanup(() => store.close());
  const project = store.createProject({ name: 'P', owner: owner.userId });
  const session = sessions.createSession({ kind: 'project', agentId: 'b1',
    owner: `collab-project:${project.id}`, scope: project.id, title: 'Delegation' });
  store.insertTrace({ traceId, projectId: project.id, rootAgent: 'a1', rootSpanId: spanId });
  store.insertSpan({ traceId, spanId, parentSpanId: null, agentId: 'b1', kind: 'consult' });
  store.bindSession(spanId, session.id);
  store.close();
  const secret = 'redact-probe-alpha', email = 'user@example.com', iban = 'DE89370400440532013000';
  const otherTrace = 'cf46ece1b683046fea5058b90b143074', otherSpan = 'cf46ece1b683046f';
  const content = `${secret} ${email} ${iban}`;
  const turn = sessions.beginTurn(session.id, content, 10).turn;
  const append = (data: Record<string, unknown>) => sessions.appendEvent(turn.id, 'tool.result', data).seq;
  const matched = append({ provenance: { traceId, spanId, credential: secret, email, iban,
    unknown: { traceId: otherTrace, spanId: otherSpan } }, content });
  const traceOnly = append({ provenance: { traceId } });
  const spanOnly = append({ provenance: { spanId } });
  const mismatched = append({ provenance: { traceId: otherTrace, spanId: otherSpan } });
  const matchedTrace = append({ provenance: { traceId, spanId: otherSpan } });
  const matchedSpan = append({ provenance: { traceId: otherTrace, spanId } });
  const secretIds = append({ provenance: { traceId: secret, spanId: secret } });
  const arbitrary = append({ traceId: otherTrace, spanId: otherSpan, unknown: { traceId: otherTrace } });
  const arbitraryMatched = append({ traceId, spanId, unknown: { traceId, spanId } });
  const missing = append({ content });
  const malformed = [null, content, [traceId, spanId], 42, { traceId: 42, spanId: null }]
    .map(provenance => append({ provenance }));
  const make = () => createCollab({ path, sessions: () => sessions, redact: logsRedactionPort([secret]) });
  let collab = make();
  tmp.onCleanup(() => { collab.close(); sessions.close(); });
  const first = collab.replay(owner, traceId, spanId);
  const data = (seq: number) => first.events.find(event => event.seq === seq)!.data;
  assert.equal(first.traceId, traceId);
  assert.equal(first.spanId, spanId);
  assert.deepEqual(data(matched).provenance, { traceId, spanId, credential: '[REDACTED:secret]',
    email: '[REDACTED:pii]', iban: '[REDACTED:pii]',
    unknown: { traceId: '[REDACTED:pii]', spanId: '[REDACTED:pii]' } });
  assert.deepEqual(data(traceOnly).provenance, { traceId });
  assert.deepEqual(data(spanOnly).provenance, { spanId });
  assert.deepEqual(data(mismatched).provenance, { traceId: '[REDACTED:pii]', spanId: '[REDACTED:pii]' });
  assert.deepEqual(data(matchedTrace).provenance, { traceId, spanId: '[REDACTED:pii]' });
  assert.deepEqual(data(matchedSpan).provenance, { traceId: '[REDACTED:pii]', spanId });
  assert.deepEqual(data(secretIds).provenance, { traceId: '[REDACTED:secret]', spanId: '[REDACTED:secret]' });
  assert.deepEqual(data(arbitrary), { traceId: '[REDACTED:pii]', spanId: '[REDACTED:pii]',
    unknown: { traceId: '[REDACTED:pii]' } });
  const arbitraryIds = shape === 'IBAN-shaped'
    ? { traceId: '[REDACTED:pii]', spanId: '[REDACTED:pii]' } : { traceId, spanId };
  assert.deepEqual(data(arbitraryMatched), { ...arbitraryIds, unknown: arbitraryIds });
  assert.equal(Object.hasOwn(data(missing), 'provenance'), false);
  assert.deepEqual(malformed.map(seq => data(seq).provenance), [null,
    '[REDACTED:secret] [REDACTED:pii] [REDACTED:pii]',
    shape === 'IBAN-shaped' ? ['[REDACTED:pii]', '[REDACTED:pii]'] : [traceId, spanId], 42,
    { traceId: 42, spanId: null }]);
  for (const value of [secret, email, iban, otherTrace, otherSpan]) assert.ok(!JSON.stringify(first).includes(value));
  assert.throws(() => collab.replay({ userId: 'other', kind: 'person', role: 'member',
    projectRights: { [project.id]: 'member' } }, traceId, spanId), /access refused/);
  assert.throws(() => sessions.getOwned(session.id, 'other'));
  assert.deepEqual(collab.replay(owner, traceId, spanId), first);
  collab.close(); sessions.close();
  sessions = new SessionStore({ path: join(dir, 'sessions.sqlite') });
  collab = make();
  assert.deepEqual(collab.replay(owner, traceId, spanId), first);
});
test('trace redaction follows credentials registered after composition startup', async () => {
  const { liveLogsRedactionPort } = await import('../../src/collab/ports.ts');
  const registered = new Set<string>(), port = liveLogsRedactionPort(() => registered);
  assert.equal(port.text('late-private-marker'), 'late-private-marker');
  registered.add('late-private-marker'); assert.ok(!port.text('late-private-marker').includes('late-private-marker'));
  assert.ok(!JSON.stringify(port.value({ transcript: 'late-private-marker' })).includes('late-private-marker'));
});

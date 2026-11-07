import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/session/store.ts';
import { LearnStore } from '../../src/dreams/learn/store.ts';
import { LearnRunner } from '../../src/dreams/learn/runner.ts';
import { learningSource } from '../../src/dreams/learn/source.ts';
import { brandLearningTool, learningToolMetadata, takeLearningTool } from '../../src/tools/learning-metadata.ts';
import { deriveUserPrincipal } from '../../src/identity/principals.ts';
import { defaults } from '@plur1bus/config-schema';
import { DEFAULT_LEARN_CONFIG } from '../../src/dreams/learn/types.ts';
import type { ToolResult } from '../../src/tools/dispatcher.ts';
const marker = 'PRIVATE LEARNING FIXTURE CONTENT';
function failure(tool = 'file.read'): ToolResult { return { callId: 'call', tool, isError: true, error: { code: 'tool-failed', message: marker, sourceCode: marker }, provenance: { origin: { system: 'harness:tools', agent: 'a', principal: 'owner', trust: 'untrusted' }, hops: 0, transformedBy: [] }, meta: { decision: 'allow', durationMs: 1, bytes: 1 } }; }
test('LP7 host branding and argument shapes never retain argument keys, values or diagnostic prose', () => {
  const metadata = learningToolMetadata(failure(), { [marker]: [marker, 42, false] }, true)!;
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE/); assert.equal(metadata.shape.strings, 1);
  const chunk = brandLearningTool({ output: marker }, failure(), {}, true);
  assert.equal(takeLearningTool({ ...chunk, learnTool: metadata }), null);
  assert.equal(takeLearningTool(chunk)!.errorClass, 'tool-failed'); assert.equal(takeLearningTool(chunk), null);
  assert.equal(learningToolMetadata(failure(marker), {}, false)!.tool, 'unknown');
});
test('LP7 installation uses only SQL metadata projections across authorized agents, never transcript/model/MemoryOps', async () => {
  let now = 10; const sessions = new SessionStore({ path: ':memory:', clock: () => now }), store = new LearnStore(':memory:');
  const target = { scope: 'installation' as const, owner: 'owner', agentId: 'a' }, config = defaults();
  for (const agentId of ['a', 'b']) {
    const s = sessions.createSession({ kind: 'direct', agentId, owner: deriveUserPrincipal('owner') });
    const { turn } = sessions.beginTurn(s.id, marker, 1);
    sessions.appendEvent(turn.id, 'tool.result', { output: marker, learnTool: learningToolMetadata(failure(), { [marker]: marker }, true) });
    sessions.completeTurn(turn.id, { text: marker, tokens: 1 }); now++;
  }
  const source = learningSource(sessions, { config: () => config, hasAgent: () => true, project: () => null });
  source.transcript = () => { throw Error('must not read transcript'); }; source.evidence = () => { throw Error('must not read evidence'); };
  const notices: unknown[] = [];
  const runner = new LearnRunner({ store, source, now: () => 20, principal: () => ({ userId: 'owner', kind: 'person', role: 'owner' }), config: () => ({ ...DEFAULT_LEARN_CONFIG, enabled: true }), model: { async complete() { throw Error('must not call model'); } }, notice: (r, n) => { notices.push({ r, n }); } });
  try {
    const run = await runner.run(target, { from: 0, to: 20 }, new AbortController().signal);
    assert.equal(run.outcome, 'completed'); assert.equal(run.tokens, 0);
    const findings = store.findings(run.id); assert.equal(findings.length, 1); assert.equal(findings[0]!.status, 'waiting-h3');
    assert.equal(findings[0]!.toolPattern!.count, 2); assert.deepEqual(findings[0]!.toolPattern!.affectedAgents, ['a', 'b']);
    assert.doesNotMatch(JSON.stringify({ findings, notices, metadata: source.toolErrors!(target, { from: 0, to: 20 }) }), /PRIVATE/);
    assert.equal(store.decidedFindings('owner').length, 0);
  } finally { store.close(); sessions.close(); }
});

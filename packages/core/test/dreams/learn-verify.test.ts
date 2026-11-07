import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../../src/dreams/learn/aggregation.ts';
import { verifyFinding } from '../../src/dreams/learn/verify.ts';

const finding = () => aggregate([{ kind: 'knowledge', change: 'add', text: 'Project uses Go', evidence: [], checks: [{ path: 'go.mod', contains: 'go 1.26' }] }], { scope: 'project', owner: 'person', agentId: 'agent', projectId: 'project' }, 'run', 1)[0]!;
test('verification exposes only reads and flags a repository contradiction without retaining file contents', async () => {
  const calls: string[] = [], f = finding();
  const port = { async call(name: 'file.read' | 'file.list') { calls.push(name); return { ok: true, text: 'module fixture\ngo 1.25\nPRIVATE_FILE_MARKER' }; } };
  assert.equal(await verifyFinding(f, port, new AbortController().signal), 'contradicted');
  assert.deepEqual(calls, ['file.read']); assert.doesNotMatch(JSON.stringify(f), /PRIVATE_FILE_MARKER/);
  assert.equal(await verifyFinding(f, { async call() { return { ok: true, text: 'go 1.26' }; } }, new AbortController().signal), 'supported');
});
test('verify cannot reach absolute, escaping, hidden or credential paths, or interpret a refused/truncated read as evidence', async () => {
  for (const path of ['../outside', '/etc/passwd', 'C:\\private', '.env', '.git/config', 'config/credentials.json', 'a/../../b']) {
    const f = finding(); f.checks![0]!.path = path;
    assert.equal(await verifyFinding(f, { async call() { assert.fail('must not dispatch'); } }, new AbortController().signal), 'unknown');
  }
  assert.equal(await verifyFinding(finding(), { async call() { return { ok: true, text: 'go 1.26', truncated: true }; } }, new AbortController().signal), 'unknown');
  const f = finding(); f.target = { scope: 'agent', owner: 'person', agentId: 'agent' };
  assert.equal(await verifyFinding(f, { async call() { assert.fail('agent pass must not inspect a repository'); } }, new AbortController().signal), 'not-applicable');
});

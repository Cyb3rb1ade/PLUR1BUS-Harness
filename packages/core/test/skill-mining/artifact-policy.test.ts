import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactProvenance, SelfKnowledgePolicy, type ArtifactChange } from '../../src/skill-mining/artifact-policy.ts';
import { useTempDirs } from '../composition/helpers.ts';
const dirs = useTempDirs('l11-artifacts-');
test('human skills, persona, agent instructions and project documentation always become proposals with unchanged bytes', async () => {
  const home = dirs.make(); const store = new ArtifactProvenance(join(home, 'provenance.sqlite')); const proposals: ArtifactChange[] = [];
  const guard = new SelfKnowledgePolicy(store, { async propose(change) { proposals.push(change); return { proposalId: 'proposal' }; } }, () => {});
  try {
    assert.equal(guard.writeApproval, true);
    for (const name of ['SKILL.md', 'SOUL.md', 'AGENTS.md', 'README.md']) {
      const path = join(home, name); writeFileSync(path, 'Human original');
      assert.equal((await guard.request(path, 'Agent replacement')).kind, 'proposal'); assert.equal(readFileSync(path, 'utf8'), 'Human original');
    }
    guard.setWriteApproval(false, 'owner'); const path = join(home, 'SKILL.md'); assert.equal((await guard.request(path, 'Agent replacement')).kind, 'proposal'); assert.equal(readFileSync(path, 'utf8'), 'Human original'); assert.equal(proposals.length, 5);
  } finally { store.close(); }
});
test('only owner may disable default approval; audit failure keeps it enabled; manual edits invalidate agent provenance', async () => {
  const home = dirs.make(); const path = join(home, 'SOUL.md'); writeFileSync(path, 'Agent bytes'); const store = new ArtifactProvenance(join(home, 'provenance.sqlite'));
  let fail = false; const audits: unknown[] = []; const guard = new SelfKnowledgePolicy(store, { async propose() { return { proposalId: 'p' }; } }, e => { if (fail) throw Error('audit unavailable'); audits.push(e); });
  try {
    assert.throws(() => guard.setWriteApproval(false, 'admin'), (e: any) => e.error === 'E_DENIED'); assert.throws(() => store.attribute(path, 'agent', 'admin'), (e: any) => e.error === 'E_DENIED');
    fail = true; assert.throws(() => guard.setWriteApproval(false, 'owner')); assert.equal(guard.writeApproval, true); fail = false;
    store.attribute(path, 'agent', 'owner'); assert.equal((await guard.request(path, 'Updated')).kind, 'proposal'); guard.setWriteApproval(false, 'owner'); assert.equal((await guard.request(path, 'Updated')).kind, 'agent-owned-write');
    assert.equal(readFileSync(path, 'utf8'), 'Agent bytes'); writeFileSync(path, 'Human revision'); assert.equal(store.inspect(path).author, 'human'); assert.equal((await guard.request(path, 'Updated')).kind, 'proposal'); assert.equal(readFileSync(path, 'utf8'), 'Human revision'); assert(audits.length > 0);
  } finally { store.close(); }
});
test('approval setting survives restart; observed human edits permanently revoke previous agent attribution', async () => {
  const home = dirs.make(), db = join(home, 'provenance.sqlite'), path = join(home, 'AGENTS.md'); writeFileSync(path, 'Agent bytes');
  let store = new ArtifactProvenance(db); store.attribute(path, 'agent', 'owner');
  const queue = { async propose() { return { proposalId: 'proposal' }; } };
  new SelfKnowledgePolicy(store, queue, () => {}).setWriteApproval(false, 'owner'); store.close(); store = new ArtifactProvenance(db);
  try {
    const guard = new SelfKnowledgePolicy(store, queue, () => {}); assert.equal(guard.writeApproval, false);
    writeFileSync(path, 'Human revision'); assert.equal(store.inspect(path).author, 'human'); writeFileSync(path, 'Agent bytes');
    assert.equal(store.inspect(path).author, 'human'); assert.equal((await guard.request(path, 'new')).kind, 'proposal');
  } finally { store.close(); }
});

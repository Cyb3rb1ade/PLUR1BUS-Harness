import assert from 'node:assert/strict';
import { link, lstat, mkdir, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { WorktreeMount, validateWorktreeMount } from '../../src/tools/sandbox/worktree-mount.ts';
import { nativeCardFixture } from './native-card-fixture.ts';

function mount(b: ReturnType<typeof nativeCardFixture>, agent = 'worker', card = b.card.id, sender?: string) {
  return WorktreeMount.fromStore(b.store, join(b.home, 'state'), b.project.id, card, agent, sender);
}

test('native mount issuance requires an existing active card assigned to the actual agent and sender', () => {
  const b = nativeCardFixture();
  try {
    assert.ok(mount(b));
    assert.throws(() => mount(b, 'other'));
    assert.throws(() => mount(b, 'worker', ''));
    assert.throws(() => mount(b, 'worker', 'unknown-card'));
    assert.throws(() => mount(b, 'worker', b.card.id, 'other'));
    assert.ok(mount(b, 'worker', b.card.id, 'lead'));
    b.collab.boardStore.archiveCard(b.project.id, b.card.id, true, { kind: 'person', id: b.who.userId });
    assert.throws(() => mount(b));
  } finally { b.close(); }
});

for (const lost of ['receiver', 'sender', 'card', 'project', 'worktree'] as const) {
  test(`native admission refuses a previously issued mount after losing its ${lost}`, async () => {
    const b = nativeCardFixture();
    try {
      const grant = mount(b, 'worker', b.card.id, 'lead');
      assert.equal((await validateWorktreeMount(grant, [b.tree.path])).path, b.tree.path);
      if (lost === 'receiver' || lost === 'sender') b.collab.boardStore.assign(b.project.id, b.card.id,
        { kind: 'agent', id: lost === 'receiver' ? 'worker' : 'lead' }, false, { kind: 'person', id: b.who.userId });
      else if (lost === 'card') b.collab.boardStore.archiveCard(b.project.id, b.card.id, true, { kind: 'person', id: b.who.userId });
      else if (lost === 'project') b.store.archiveProject(b.project.id);
      else b.store.markWorktreeRemoved(b.project.id, b.card.id);
      await assert.rejects(validateWorktreeMount(grant, [b.tree.path]));
    } finally { b.close(); }
  });
}

test('wire copies, forged objects, foreign roots and extra writable roots never obtain mount authority', async () => {
  const b = nativeCardFixture();
  try {
    const grant = mount(b);
    for (const forged of [JSON.parse(JSON.stringify(grant)), Object.create(WorktreeMount.prototype)])
      await assert.rejects(validateWorktreeMount(forged, [b.tree.path]));
    for (const roots of [[], [b.repo], [b.tree.path, b.repo]])
      await assert.rejects(validateWorktreeMount(grant, roots));
  } finally { b.close(); }
});

test('only hardlinks completely accounted for inside the granted card worktree are admitted', async () => {
  const b = nativeCardFixture();
  try {
    const grant = mount(b), source = join(b.tree.path, 'notes.txt'), internal = join(b.tree.path, 'internal-alias');
    await link(source, internal);
    assert.equal((await validateWorktreeMount(grant, [b.tree.path])).path, b.tree.path);
    const before = await lstat(source);
    const external = join(b.dir, 'outside-alias');
    await link(source, external);
    await utimes(source, before.atime, before.mtime);
    await assert.rejects(validateWorktreeMount(grant, [b.tree.path]), /link|alias/i);
    await unlink(external);
  } finally { b.close(); }
});

test('native admission rejects symlink entries and replacement worktree ancestry', async () => {
  const b = nativeCardFixture();
  try {
    const grant = mount(b), alias = join(b.tree.path, 'alias');
    await symlink(b.repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(validateWorktreeMount(grant, [b.tree.path]));
    await unlink(alias);
    const original = b.tree.path + '-original';
    await rename(b.tree.path, original);
    await symlink(original, b.tree.path, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(validateWorktreeMount(grant, [b.tree.path]));
  } finally { b.close(); }
});

test('cold, warm and newly populated native worktrees exceed 20000 entries without weakening alias checks', async t => {
  const b = nativeCardFixture();
  try {
    const grant = mount(b);
    async function populate(name: string) {
      const dir = join(b.tree.path, name);
      await mkdir(dir);
      for (let base = 0; base < 20100; base += 32) await Promise.all(
        Array.from({ length: Math.min(32, 20100 - base) }, (_, i) => writeFile(join(dir, `entry-${base + i}`), 'fixture')),
      );
    }
    await populate('source');
    for (const phase of ['cold', 'warm', 'new-subtree'] as const) {
      if (phase === 'new-subtree') await populate('installed-dependencies');
      const started = performance.now();
      assert.equal((await validateWorktreeMount(grant, [b.tree.path])).path, b.tree.path);
      t.diagnostic(`${phase} admissionMs=${(performance.now() - started).toFixed(2)}`);
    }
    const source = join(b.tree.path, 'installed-dependencies', 'entry-0');
    await link(source, join(b.dir, 'outside-new-subtree'));
    await assert.rejects(validateWorktreeMount(grant, [b.tree.path]), /link|alias/i);
  } finally { b.close(); }
});

/** Real SQLite assignments and the sole Git provisioner; no model or external repository. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCollab } from '../../src/collab/service.ts';
import { CollabStore } from '../../src/collab/store.ts';
import { GitWorktreeProvisioner, provisionedWorktreePort } from '../../src/external-agents/provisioner.ts';
import { owner } from '../collab/helpers.ts';
import { tempDir } from '../helpers/temp-dir.ts';

export function nativeCardFixture() {
  const dir = tempDir('native-card-');
  const home = join(dir, 'home'), repo = join(dir, 'repo');
  mkdirSync(join(home, 'state'), { recursive: true });
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  writeFileSync(join(repo, 'notes.txt'), 'original\n');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const who = owner();
  const collab = createCollab({ path: join(home, 'state', 'collab.sqlite'), home, provisionWorktrees: true });
  const project = collab.createProject(who, { name: 'Native card' });
  for (const agent of ['lead', 'worker', 'other']) collab.addAgent(who, project.id, agent);
  collab.bindRepo(who, project.id, repo, 'main');
  const card = collab.boardStore.createCard(project.id, {
    title: 'Assigned coding task', columnId: collab.boardStore.columns(project.id)[0]!.id,
  }, { kind: 'person', id: who.userId });
  for (const agent of ['lead', 'worker']) collab.boardStore.assign(project.id, card.id,
    { kind: 'agent', id: agent }, true, { kind: 'person', id: who.userId });
  const store = new CollabStore({ path: join(home, 'state', 'collab.sqlite') });
  const provisioner = new GitWorktreeProvisioner(store, join(realpathSync(home), 'state'));
  const tree = provisioner.fork({ projectId: project.id, cardId: card.id });
  const port = provisionedWorktreePort(store, () => null);
  return { dir, home: realpathSync(home), repo, who, collab, store, project, card, tree, provisioner, port,
    close() { store.close(); collab.close(); } };
}

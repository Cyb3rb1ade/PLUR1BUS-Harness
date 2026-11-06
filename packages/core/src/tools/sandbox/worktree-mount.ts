/** The sole opaque DB-backed mount identity, shared by ACP and assigned native coding turns. */
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { CollabStore } from '../../collab/store.ts';
import { cardAssignedTo } from '../../external-agents/card-assignment.ts';
import { SandboxFailure } from './types.ts';
import { invalidateWorktreeInventory, worktreeInventory, type WorktreeInventory } from './worktree-inventory.ts';

export interface WorktreeBinding {
  readonly kind: 'acp' | 'native';
  readonly stateDir: string;
  readonly path: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly dev: string;
  readonly ino: string;
  readonly projectId: string;
  readonly cardId: string | null;
  readonly agentId?: string;
  current(): boolean;
}
const bindings = new WeakMap<WorktreeMount, WorktreeBinding>();

export function selectedWorktreeMount(policy: { worktreeMount?: WorktreeMount; acpWorktree?: WorktreeMount }): WorktreeMount | undefined {
  if (policy.worktreeMount && policy.acpWorktree && policy.worktreeMount !== policy.acpWorktree)
    throw new SandboxFailure('conflicting worktree grants');
  return policy.worktreeMount ?? policy.acpWorktree;
}

export class WorktreeMount {
  private constructor() {}
  /** A native grant names only a live card assigned to the actual receiving agent. */
  static fromStore(store: CollabStore, stateDir: string, projectId: string, cardId: string, agentId: string, fromAgentId?: string): WorktreeMount {
    if (!store.getProject(projectId)?.repo || !cardAssignedTo(store, projectId, cardId, agentId, fromAgentId))
      throw new SandboxFailure('assigned active coding card required');
    return WorktreeMount.issue(store, stateDir, projectId, cardId, agentId, fromAgentId);
  }
  /** Compatibility for #820's approved ACP composition; this is not a native-turn opt-in. */
  static forAcp(store: CollabStore, stateDir: string, projectId: string, cardId: string | null): WorktreeMount {
    return WorktreeMount.issue(store, stateDir, projectId, cardId);
  }
  private static issue(store: CollabStore, stateDir: string, projectId: string, cardId: string | null, agentId?: string, fromAgentId?: string): WorktreeMount {
    const row = store.liveWorktree(projectId, cardId);
    if (!row?.gitDir || !row.commonGitDir || !row.dev || !row.ino) throw new SandboxFailure('worktree is not provisioned');
    const grant = new WorktreeMount();
    let revoked = false;
    bindings.set(grant, Object.freeze({
      kind: agentId === undefined ? 'acp' : 'native',
      stateDir: realpathSync(stateDir), dev: row.dev, ino: row.ino,
      path: row.path, gitDir: row.gitDir, commonGitDir: row.commonGitDir, projectId, cardId,
      ...(agentId === undefined ? {} : { agentId }),
      current: () => {
        if (revoked) return false;
        try {
          const live = store.liveWorktree(projectId, cardId);
          const valid = live?.id === row.id && live.path === row.path && live.gitDir === row.gitDir
            && live.commonGitDir === row.commonGitDir && live.dev === row.dev && live.ino === row.ino
            && (agentId === undefined || (store.getProject(projectId)?.repo !== undefined && cardAssignedTo(store, projectId, cardId!, agentId, fromAgentId)));
          if (!valid) { revoked = true; invalidateWorktreeInventory(grant); }
          return valid;
        } catch { revoked = true; invalidateWorktreeInventory(grant); return false; }
      },
    }));
    return Object.freeze(grant);
  }
}

/** No await may separate the last identity/revocation check from the actual process spawn. */
export function currentWorktreeBinding(grant: WorktreeMount): WorktreeBinding {
  const binding = bindings.get(grant);
  if (!binding || !binding.current()) throw new SandboxFailure('forged or revoked worktree grant');
  const identity = lstatSync(binding.path);
  if (!identity.isDirectory() || identity.isSymbolicLink() || String(identity.dev) !== binding.dev || String(identity.ino) !== binding.ino) {
    invalidateWorktreeInventory(grant);
    throw new SandboxFailure('worktree identity changed');
  }
  return binding;
}
export function nativeWorktreeBinding(grant: WorktreeMount, agentId: string, projectId: string | undefined, path?: string): WorktreeBinding {
  const binding = currentWorktreeBinding(grant);
  if (binding.kind !== 'native' || binding.agentId !== agentId || binding.projectId !== projectId || (path !== undefined && path !== binding.path))
    throw new SandboxFailure('foreign native worktree grant');
  return binding;
}
export async function validateWorktreeMount(grant: WorktreeMount, paths: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorktreeBinding & { readonly inventory?: WorktreeInventory }> {
  const binding = currentWorktreeBinding(grant);
  if (paths.length !== 1 || paths[0] !== binding.path) throw new SandboxFailure('mismatched worktree grant');
  if (!binding.path.startsWith(join(binding.stateDir, 'worktrees') + sep)) throw new SandboxFailure('worktree is outside state/worktrees');
  let path = binding.path;
  while (true) {
    options.signal?.throwIfAborted();
    if ((await lstat(path)).isSymbolicLink()) throw new SandboxFailure('symlinked worktree ancestry');
    const next = dirname(path);
    if (next === path) break;
    path = next;
  }
  if (await realpath(binding.path) !== binding.path) throw new SandboxFailure('noncanonical worktree');
  if (binding.kind === 'native') {
    const inventory = await worktreeInventory(grant, binding.path, options);
    currentWorktreeBinding(grant);
    return { ...binding, inventory };
  }
  // Preserve #820 ACP behavior; native admission has the separate stricter incremental inventory.
  let visited = 0;
  const stack = [binding.path];
  while (stack.length) for (const entry of await readdir(stack.pop()!, { withFileTypes: true })) {
    if (++visited > 20000) throw new SandboxFailure('ACP worktree alias scan exceeds safety cap');
    const target = join(entry.parentPath, entry.name), stat = await lstat(target);
    if (stat.isFile() && stat.nlink > 1) throw new SandboxFailure('ACP worktree contains a hard-linked file');
    if (stat.isDirectory()) stack.push(target);
  }
  currentWorktreeBinding(grant);
  return binding;
}

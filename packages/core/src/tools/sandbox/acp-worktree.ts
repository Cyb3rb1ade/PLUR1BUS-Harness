/** #820: an opaque, DB-backed exception for one Harness-provisioned ACP worktree. */
import { realpathSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import type { CollabStore } from "../../collab/store.ts";
import { SandboxFailure } from "./types.ts";

interface Binding {
  readonly stateDir: string;
  readonly path: string;
  readonly gitDir: string;
  readonly commonGitDir: string;
  readonly dev: string;
  readonly ino: string;
  current(): boolean;
}
const bindings = new WeakMap<AcpWorktreeMount, Binding>();

/** Cannot be constructed from wire JSON. Only the trusted provisioner can obtain a live grant. */
export class AcpWorktreeMount {
  private constructor() {}

  /** Pin a live database row; older rows without trusted Git metadata must be reprovisioned. */
  static fromStore(store: CollabStore, stateDir: string, projectId: string, cardId: string | null): AcpWorktreeMount {
    const row = store.liveWorktree(projectId, cardId);
    if (!row?.gitDir || !row.commonGitDir || !row.dev || !row.ino) throw new SandboxFailure("worktree is not provisioned");
    const grant = new AcpWorktreeMount();
    bindings.set(grant, Object.freeze({
      stateDir: realpathSync(stateDir), dev: row.dev, ino: row.ino, path: row.path, gitDir: row.gitDir, commonGitDir: row.commonGitDir,
      current: () => {
        const live = store.liveWorktree(projectId, cardId);
        return live?.id === row.id && live.path === row.path && live.gitDir === row.gitDir
          && live.commonGitDir === row.commonGitDir && live.dev === row.dev && live.ino === row.ino;
      },
    }));
    return Object.freeze(grant);
  }
}

/** Validate the opaque grant, canonical ancestry and bounded pre-mount alias scan on every launch. */
export async function validateAcpMount(grant: AcpWorktreeMount, paths: readonly string[]): Promise<Binding> {
  const binding = bindings.get(grant);
  if (!binding || !binding.current() || paths.length !== 1 || paths[0] !== binding.path)
    throw new SandboxFailure("forged or mismatched ACP worktree grant");
  const parent = join(binding.stateDir, "worktrees") + sep;
  if (!binding.path.startsWith(parent)) throw new SandboxFailure("ACP worktree is outside state/worktrees");
  const identity = await lstat(binding.path);
  if (String(identity.dev) !== binding.dev || String(identity.ino) !== binding.ino)
    throw new SandboxFailure("ACP worktree identity changed");
  let path = binding.path;
  while (true) {
    if ((await lstat(path)).isSymbolicLink()) throw new SandboxFailure("symlinked ACP worktree ancestry");
    const next = dirname(path);
    if (next === path) break;
    path = next;
  }
  if (await realpath(binding.path) !== binding.path) throw new SandboxFailure("noncanonical ACP worktree");
  let visited = 0;
  const stack = [binding.path];
  while (stack.length) {
    for (const entry of await readdir(stack.pop()!, { withFileTypes: true })) {
      if (++visited > 20000) throw new SandboxFailure("ACP worktree alias scan exceeds safety cap");
      // Dirent.parentPath is supplied by the required Node 24 runtime.
      const path = join(entry.parentPath, entry.name);
      const stat = await lstat(path);
      if (stat.isFile() && stat.nlink > 1) throw new SandboxFailure("ACP worktree contains a hard-linked file");
      if (stat.isDirectory()) stack.push(path);
    }
  }
  return binding;
}

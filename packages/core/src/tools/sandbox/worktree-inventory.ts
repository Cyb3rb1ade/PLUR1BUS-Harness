import type { BigIntStats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SandboxFailure } from './types.ts';
import { matchDeny, type DenyEntry } from '../../policy/paths.ts';

export interface InventoryEntry { readonly path: string; readonly stat: BigIntStats }
export interface WorktreeInventory {
  readonly root: string;
  readonly entries: ReadonlyMap<string, InventoryEntry>;
  readonly children: ReadonlyMap<string, ReadonlySet<string>>;
  readonly hardlinks: readonly (readonly InventoryEntry[])[];
}
const inventories = new WeakMap<object, WorktreeInventory>();
// Finite retention per live grant, rather than the former 20k traversal cutoff.
const MAX_ENTRIES = 1_000_000;
export function invalidateWorktreeInventory(grant: object): void { inventories.delete(grant); }
export function assertNoProtectedWorktreeAliases(inventory: WorktreeInventory, denied: readonly DenyEntry[]): void {
  const names = new Set(denied.filter(d => 'name' in d).map(d => (d as { name: string }).name.toLowerCase()));
  const protectedPath = (path: string) => matchDeny(path, denied) || path.split(sep).some(part => names.has(part.toLowerCase()));
  if (inventory.hardlinks.some(group => group.some(entry => protectedPath(entry.path))))
    throw new SandboxFailure('native worktree hardlink aliases a protected path');
}
function sameDirectory(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink
    && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}

/** Fresh inode/link checks on every admission; only unchanged directory enumeration is reused. */
export async function worktreeInventory(grant: object, root: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<WorktreeInventory> {
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1))
    throw new SandboxFailure('invalid worktree admission budget');
  const deadline = performance.now() + Math.min(options.timeoutMs ?? 30000, 30000);
  const check = () => {
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new SandboxFailure('worktree admission budget exhausted');
  };
  async function each<T>(items: readonly T[], visit: (item: T) => Promise<void>): Promise<void> {
    let cursor = 0, failed = false;
    const results = await Promise.allSettled(Array.from({ length: Math.min(16, items.length) }, async () => {
      while (!failed && cursor < items.length) {
        try { check(); await visit(items[cursor++]!); } catch (error) { failed = true; throw error; }
      }
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    check();
  }
  const inspect = async (path: string): Promise<InventoryEntry> => {
    check();
    const stat = await lstat(path, { bigint: true });
    if (stat.isSymbolicLink()) throw new SandboxFailure('native worktree contains a symlink');
    if (!stat.isDirectory() && !stat.isFile()) throw new SandboxFailure('native worktree contains an unsupported entry');
    return { path, stat };
  };
  async function build(previous?: WorktreeInventory): Promise<WorktreeInventory> {
    const rootEntry = await inspect(root);
    if (!rootEntry.stat.isDirectory()) throw new SandboxFailure('native worktree is not a directory');
    const entries = new Map(previous?.entries ?? []);
    const children = new Map<string, ReadonlySet<string>>(previous?.children ?? []);
    const pending: string[] = [], queued = new Set<string>();
    const put = (entry: InventoryEntry) => {
      if (entry.stat.dev !== rootEntry.stat.dev) throw new SandboxFailure('native worktree crosses a filesystem boundary');
      entries.set(entry.path, entry);
      if (entries.size > MAX_ENTRIES) throw new SandboxFailure('native worktree inventory exceeds its bounded capacity');
    };
    const enqueue = (path: string) => { if (!queued.has(path)) { queued.add(path); pending.push(path); } };
    const remove = (path: string) => {
      const stack = [path];
      while (stack.length) {
        check();
        const entry = stack.pop()!;
        for (const child of children.get(entry) ?? []) stack.push(child);
        children.delete(entry); entries.delete(entry);
      }
    };
    if (!previous) { put(rootEntry); enqueue(root); }
    else {
      let invalidated = false;
      await each([...previous.entries.values()].filter(entry => entry.stat.isDirectory()), async old => {
        let current: InventoryEntry;
        try { current = await inspect(old.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { invalidated = true; return; }
          throw error;
        }
        if (!current.stat.isDirectory() || current.stat.dev !== old.stat.dev || current.stat.ino !== old.stat.ino) {
          invalidated = true; return;
        }
        put(current);
        if (!sameDirectory(old.stat, current.stat)) enqueue(old.path);
      });
      // Replacement/removal invalidates the old tree; rebuilding shares this call's deadline.
      if (invalidated) return build();
    }
    for (let cursor = 0; cursor < pending.length; cursor++) {
      check();
      const directory = pending[cursor]!, before = await inspect(directory);
      if (!before.stat.isDirectory()) throw new SandboxFailure('worktree directory changed during admission');
      const listed = new Set((await readdir(directory)).map(name => join(directory, name)));
      for (const old of children.get(directory) ?? []) if (!listed.has(old)) remove(old);
      await each([...listed], async path => {
        const entry = await inspect(path), old = entries.get(path);
        if (old && (old.stat.dev !== entry.stat.dev || old.stat.ino !== entry.stat.ino || old.stat.isDirectory() !== entry.stat.isDirectory())) remove(path);
        put(entry);
        if (entry.stat.isDirectory() && (!old || !old.stat.isDirectory() || !sameDirectory(old.stat, entry.stat))) enqueue(path);
      });
      const after = await inspect(directory);
      if (!sameDirectory(before.stat, after.stat)) throw new SandboxFailure('worktree directory changed during admission');
      put(after); children.set(directory, listed);
    }
    // Paths, mtimes or watchers alone cannot prove the absence of a new outside alias.
    await each([...entries.values()], async expected => {
      const current = await inspect(expected.path);
      if (current.stat.dev !== expected.stat.dev || current.stat.ino !== expected.stat.ino
        || current.stat.isDirectory() !== expected.stat.isDirectory()
        || (current.stat.isDirectory() && !sameDirectory(expected.stat, current.stat)))
        throw new SandboxFailure('worktree identity changed during admission');
      put(current);
    });
    const groups = new Map<string, InventoryEntry[]>();
    for (const entry of entries.values()) {
      check();
      if (!entry.stat.isFile()) continue;
      const key = String(entry.stat.dev) + ':' + String(entry.stat.ino), group = groups.get(key);
      if (group) group.push(entry); else groups.set(key, [entry]);
    }
    const hardlinks: InventoryEntry[][] = [];
    for (const group of groups.values()) {
      if (group.some(entry => entry.stat.nlink !== BigInt(group.length)))
        throw new SandboxFailure('native worktree contains an unaccounted hardlink alias');
      if (group.length > 1) hardlinks.push(group);
    }
    return { root, entries, children, hardlinks };
  }
  try {
    const previous = inventories.get(grant);
    const result = await build(previous?.root === root ? previous : undefined);
    check(); inventories.set(grant, result); return result;
  } catch (error) { inventories.delete(grant); throw error; }
}

import { createHostctl, type Hostctl, type Options } from './index.ts';
import type { PathRoot, DenyEntry } from '../../core/src/policy/paths-index.ts';
/** Composition-owned lifetime, independent of the per-turn tool registry. No global singleton. */
export function createHostctlPool(o: Omit<Options, 'roots' | 'deny'>) {
  const instances = new Map<string, Hostctl>();
  return {
    forRoots(roots: readonly PathRoot[], deny: readonly DenyEntry[]): Hostctl {
      const key = JSON.stringify([roots, deny]); let runtime = instances.get(key);
      if (!runtime) { runtime = createHostctl({ ...o, roots, deny }); instances.set(key, runtime); }
      return runtime;
    },
    async endSession(id: string) { await Promise.all([...instances.values()].map(h => h.endSession(id))); },
    async close() { await Promise.all([...instances.values()].map(h => h.close())); instances.clear(); },
  };
}

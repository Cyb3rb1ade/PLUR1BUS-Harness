// Read-only view of discovery's atomically written catalogue. Never load/recover/mutate it.
import { readFileSync, statSync } from 'node:fs';
import { validateCatalog } from '../discovery/catalog-store.ts';
import type { ReadCatalog } from './tokens.ts';
export function readOnlyCatalog(path: string): ReadCatalog {
  let stamp = ''; let models: ReturnType<ReadCatalog['read']>['models'] = [];
  return { read() {
    try {
      const stat = statSync(path); const next = `${stat.mtimeMs}:${stat.size}`;
      if (next !== stamp) {
        if (stat.size > 16 * 1024 * 1024) return { models: [] };
        const parsed = validateCatalog(JSON.parse(readFileSync(path,'utf8')));
        models = parsed.ok ? parsed.file.models : []; stamp = next;
      }
      return { models };
    } catch { return { models: [] }; }
  } };
}

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSecurePath } from '../../module-api/src/secure-path.ts';
export interface SeenStore { load(): Promise<string[]>; save(ids: string[]): Promise<void> }
export const MAX_SEEN = 65536;
const valid = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_SEEN && v.every(x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x));
/** Claims precede handling: at-most-once within the retained bounded replay window. */
export class FileSeenStore implements SeenStore {
  readonly file: string;
  constructor(dir: string) { this.file = join(dir, 'buzz-seen.json'); }
  async load(): Promise<string[]> {
    try { const v: unknown = JSON.parse(await readFile(this.file, 'utf8')); if (valid(v)) return v; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; }
    throw new Error('Buzz replay state unavailable');
  }
  async save(ids: string[]): Promise<void> {
    if (!valid(ids)) throw new Error('invalid Buzz replay state');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    try {
      const f = await open(tmp, 'wx', 0o600);
      try { if (!createSecurePath()(tmp, { mode: 0o600 }).applied) throw new Error('Buzz permissions unavailable'); await f.writeFile(JSON.stringify(ids)); await f.sync(); } finally { await f.close(); }
      await rename(tmp, this.file);
      if (process.platform !== 'win32') { const d = await open(dirname(this.file), 'r'); try { await d.sync(); } finally { await d.close(); } }
    } finally { await rm(tmp, { force: true }); }
  }
}
export class MemorySeenStore implements SeenStore { ids: string[] = []; async load() { return [...this.ids]; } async save(ids: string[]) { this.ids = [...ids]; } }

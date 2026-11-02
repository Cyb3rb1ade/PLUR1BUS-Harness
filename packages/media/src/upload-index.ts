/** Private accounting metadata outside upload trees, so inaccessible payloads cannot stop unrelated puts. */
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, safeId } from './files.ts';
import { MediaError } from './types.ts';

export interface UploadIndexRecord {
  schema: 'media.upload-index/1'; createdAt: number; bytes: number; unavailable: boolean;
}
export const MAX_UPLOAD_INDEX_BYTES = 512;

export class UploadIndex {
  readonly root: string;
  constructor(storeRoot: string) { this.root = join(storeRoot, '.upload-index'); }

  private async directory(create = false): Promise<boolean> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      if (!(await lstat(this.root)).isDirectory()) throw new MediaError('backend_unavailable');
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  async read(id: string): Promise<UploadIndexRecord | null> {
    if (!await this.directory()) return null;
    const path = join(this.root, `${safeId(id)}.json`);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_UPLOAD_INDEX_BYTES) throw new MediaError('backend_unavailable');
      const text = await readFile(path, 'utf8');
      if (Buffer.byteLength(text) > MAX_UPLOAD_INDEX_BYTES) throw new MediaError('backend_unavailable');
      const value: unknown = JSON.parse(text);
      if (!validRecord(value)) throw new MediaError('backend_unavailable');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }

  async write(id: string, record: UploadIndexRecord): Promise<void> {
    if (!validRecord(record)) throw new MediaError('backend_unavailable');
    await this.directory(true);
    await atomicJson(join(this.root, `${safeId(id)}.json`), record);
  }

  async remove(id: string): Promise<void> {
    if (await this.directory()) await rm(join(this.root, `${safeId(id)}.json`), { force: true });
  }

  async ids(): Promise<string[]> {
    if (!await this.directory()) return [];
    return (await readdir(this.root)).filter(name => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name)).map(name => name.slice(0, -5));
  }
}

function validRecord(value: unknown): value is UploadIndexRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 4 && record.schema === 'media.upload-index/1'
    && Number.isSafeInteger(record.createdAt) && (record.createdAt as number) >= 0
    && Number.isSafeInteger(record.bytes) && (record.bytes as number) >= 0
    && typeof record.unavailable === 'boolean';
}

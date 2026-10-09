import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MediaError } from './types.ts';
export function safeId(id: string): string { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new MediaError('unsupported_parameter'); return id; }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

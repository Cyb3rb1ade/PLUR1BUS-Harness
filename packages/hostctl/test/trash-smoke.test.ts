import { it, expect } from 'vitest';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { trash } from '../src/native.ts';
it.skipIf(process.env.HOSTCTL_TRASH_SMOKE !== '1')('native Trash accepts only a newly created synthetic fixture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hostctl-trash-smoke-')); const target = join(root, `hostctl-fixture-${randomUUID()}.txt`);
  try { await writeFile(target, 'Synthetic hostctl Trash smoke fixture.'); await trash(target, new AbortController().signal); await expect(access(target)).rejects.toThrow(); }
  finally { await rm(root, { recursive: true, force: true }); }
}, 40000);

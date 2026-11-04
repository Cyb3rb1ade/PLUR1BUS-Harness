import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpBase } from './helpers/tmp.ts';
import { atomicWrite } from '../src/atomic.ts';
import { files } from '../src/files.ts';
import { configure } from '../src/config.ts';
import { failure } from '../src/errors.ts';

const publication = vi.hoisted(() => ({ beforeRename: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await publication.beforeRename?.();
    return actual.rename(...args);
  } };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
let root: string, home: string, canon: ReturnType<typeof files>['canon'];
beforeEach(async () => {
  publication.beforeRename = undefined;
  root = await mkdtemp(join(tmpBase(), 'hostctl-publish-'));
  home = await mkdtemp(join(tmpBase(), 'hostctl-publish-home-'));
  canon = files([{ id: 'fixture', path: root }], [], configure(), async () => {}, home, {}).canon;
  await writeFile(join(root, 'race.txt'), 'original');
});
afterEach(async () => {
  publication.beforeRename = undefined;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});
const write = () => atomicWrite('race.txt', Buffer.from('staged'), true, canon,
  new AbortController().signal, 65536);
const blocked = (code: string) => Object.assign(new Error('synthetic publication failure'), { code, syscall: 'rename' });

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  it(`${code} after the final check reports CHANGED only when the target was replaced`, async () => {
    const error = blocked(code);
    publication.beforeRename = async () => {
      await writeFile(join(root, 'replacement.txt'), 'other writer');
      await actualFs.rename(join(root, 'replacement.txt'), join(root, 'race.txt'));
      throw error;
    };
    await expect(write()).rejects.toMatchObject({ code: 'CHANGED' });
    expect(await readFile(join(root, 'race.txt'), 'utf8')).toBe('other writer');
    expect(await readdir(root)).toEqual(['race.txt']);
  });

  it(`${code} on an unchanged target remains the original IO_ERROR`, async () => {
    const error = blocked(code);
    publication.beforeRename = async () => { throw error; };
    try { await write(); expect.fail('publication must fail'); }
    catch (caught) { expect(caught).toBe(error); expect(failure(caught).error.code).toBe('IO_ERROR'); }
    expect(await readFile(join(root, 'race.txt'), 'utf8')).toBe('original');
    expect(await readdir(root)).toEqual(['race.txt']);
  });
}

it('an unrelated I/O error remains visible even if a concurrent writer replaced the target', async () => {
  const error = blocked('EIO');
  publication.beforeRename = async () => {
    await writeFile(join(root, 'replacement.txt'), 'other writer');
    await actualFs.rename(join(root, 'replacement.txt'), join(root, 'race.txt'));
    throw error;
  };
  await expect(write()).rejects.toBe(error);
  expect(await readdir(root)).toEqual(['race.txt']);
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from '../src/atomic.ts';
import { files } from '../src/files.ts';
import { configure } from '../src/config.ts';
import { HostctlError } from '../src/errors.ts';

let root: string, home: string, canon: ReturnType<typeof files>['canon'];
const posix = process.platform !== 'win32';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hostctl-atomic-'));
  home = await mkdtemp(join(tmpdir(), 'hostctl-atomic-home-'));
  canon = files([{ id: 'fixture', path: root }], [], configure(), async () => {}, home, {}).canon;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

const leftovers = async () => (await readdir(root)).filter(n => n.includes('.hostctl-') || n.endsWith('.tmp'));
const write = (input: string, data: Buffer, overwrite: boolean, limit = 65536, signal = new AbortController().signal, afterStage?: () => Promise<void>) =>
  atomicWrite(input, data, overwrite, canon, signal, limit, afterStage);
const codeOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e instanceof HostctlError ? e.code : (e as Error).name; } };

describe('atomicWrite: create and overwrite', () => {
  it('creates a new file through the no-overwrite link path and removes its temporary file', async () => {
    expect(await write('new.txt', Buffer.from('hello'), false)).toEqual({ bytesWritten: 5, created: true });
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('hello');
    expect(await leftovers()).toEqual([]);
  });

  it('replaces an existing file and reports created=false', async () => {
    await writeFile(join(root, 'a.txt'), 'old');
    expect(await write('a.txt', Buffer.from('new content'), true)).toEqual({ bytesWritten: 11, created: false });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new content');
    expect(await leftovers()).toEqual([]);
  });

  it.skipIf(!posix)('keeps the mode of an existing file on overwrite', async () => {
    await writeFile(join(root, 'mode.txt'), 'old'); await chmod(join(root, 'mode.txt'), 0o640);
    await write('mode.txt', Buffer.from('new'), true);
    expect((await stat(join(root, 'mode.txt'))).mode & 0o777).toBe(0o640);
  });

  it.skipIf(!posix)('creates new files with owner-only permissions', async () => {
    await write('private.txt', Buffer.from('x'), false);
    expect((await stat(join(root, 'private.txt'))).mode & 0o777).toBe(0o600);
  });

  it('accepts empty content and reports zero bytes', async () => {
    expect(await write('empty.txt', Buffer.alloc(0), false)).toEqual({ bytesWritten: 0, created: true });
    expect(await readFile(join(root, 'empty.txt'), 'utf8')).toBe('');
  });

  it('counts the limit in bytes, not characters', async () => {
    // 'é' is two UTF-8 bytes: three of them are six bytes and exceed a five-byte limit.
    expect(await codeOf(write('bytes.txt', Buffer.from('ééé'), false, 5))).toBe('TOO_LARGE');
    expect(await write('bytes.txt', Buffer.from('éé'), false, 4)).toEqual({ bytesWritten: 4, created: true });
  });

  it('accepts content exactly at the limit and refuses one byte more without creating a file', async () => {
    expect(await write('edge.txt', Buffer.alloc(8, 65), false, 8)).toMatchObject({ bytesWritten: 8 });
    expect(await codeOf(write('over.txt', Buffer.alloc(9, 65), false, 8))).toBe('TOO_LARGE');
    await expect(stat(join(root, 'over.txt'))).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });

  it('handles Unicode file names', async () => {
    expect(await write('résumé-🙂.txt', Buffer.from('ok'), false)).toMatchObject({ created: true });
    expect(await readFile(join(root, 'résumé-🙂.txt'), 'utf8')).toBe('ok');
  });
});

describe('atomicWrite: refusals', () => {
  it('refuses to overwrite when overwrite is false and the target exists', async () => {
    await writeFile(join(root, 'taken.txt'), 'keep');
    expect(await codeOf(write('taken.txt', Buffer.from('lost'), false))).toBe('EXISTS');
    expect(await readFile(join(root, 'taken.txt'), 'utf8')).toBe('keep');
    expect(await leftovers()).toEqual([]);
  });

  it('refuses a directory target with DENIED', async () => {
    await mkdir(join(root, 'folder'));
    expect(await codeOf(write('folder', Buffer.from('x'), true))).toBe('DENIED');
    expect(await leftovers()).toEqual([]);
  });

  it('refuses paths that escape the root before writing anything', async () => {
    expect(await codeOf(write('../escape.txt', Buffer.from('x'), false))).toBe('OUTSIDE_ROOT');
    expect(await leftovers()).toEqual([]);
  });

  it('throws the abort reason when the signal is already aborted, leaving no file behind', async () => {
    const ac = new AbortController(); ac.abort();
    expect(await codeOf(write('aborted.txt', Buffer.from('x'), false, 65536, ac.signal))).toBe('AbortError');
    expect(await readdir(root)).toEqual([]);
  });

  it('aborting after staging keeps the original and removes the temporary file', async () => {
    await writeFile(join(root, 'orig.txt'), 'keep me');
    const ac = new AbortController();
    expect(await codeOf(write('orig.txt', Buffer.from('never'), true, 65536, ac.signal, async () => { ac.abort(); }))).toBe('AbortError');
    expect(await readFile(join(root, 'orig.txt'), 'utf8')).toBe('keep me');
    expect(await leftovers()).toEqual([]);
  });
});

describe('atomicWrite: target changed while staging', () => {
  it('reports CHANGED when an existing target is replaced by another file during staging', async () => {
    await writeFile(join(root, 'swap.txt'), 'original');
    await writeFile(join(root, 'replacement.txt'), 'impostor');
    const code = await codeOf(write('swap.txt', Buffer.from('mine'), true, 65536, new AbortController().signal, async () => {
      await rename(join(root, 'replacement.txt'), join(root, 'swap.txt'));
    }));
    expect(code).toBe('CHANGED');
    expect(await readFile(join(root, 'swap.txt'), 'utf8')).toBe('impostor');
    expect(await leftovers()).toEqual([]);
  });

  it('reports CHANGED when a target appears during staging of a create-only write', async () => {
    await writeFile(join(root, 'appeared.txt'), 'someone else');
    const code = await codeOf(write('late.txt', Buffer.from('mine'), false, 65536, new AbortController().signal, async () => {
      await rename(join(root, 'appeared.txt'), join(root, 'late.txt'));
    }));
    expect(code).toBe('CHANGED');
    expect(await readFile(join(root, 'late.txt'), 'utf8')).toBe('someone else');
    expect(await leftovers()).toEqual([]);
  });

  it('reports CHANGED when an existing target disappears during staging', async () => {
    await writeFile(join(root, 'gone.txt'), 'bye');
    const code = await codeOf(write('gone.txt', Buffer.from('mine'), true, 65536, new AbortController().signal, async () => {
      await rm(join(root, 'gone.txt'));
    }));
    expect(code).toBe('CHANGED');
    await expect(stat(join(root, 'gone.txt'))).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
  });
});

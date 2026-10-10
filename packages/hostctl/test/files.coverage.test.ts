import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, symlink, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files } from '../src/files.ts';
import { configure } from '../src/config.ts';
import { HostctlError } from '../src/errors.ts';

let root: string, outside: string, home: string, trash: ReturnType<typeof vi.fn>;
let ops: ReturnType<typeof files>;
const posix = process.platform !== 'win32';
const signal = () => new AbortController().signal;
const run = (op: string, a: Record<string, unknown>, s: AbortSignal = signal()) => ops.run(op, a, s);
/** Resolves to the rejection value, or undefined when the promise resolves. */
const rejectionOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return e; } };
const codeOf = async (p: Promise<unknown>) => { const e = await rejectionOf(p); if (e instanceof HostctlError) return e.code; if ((e as Error)?.name === 'AbortError') return 'AbortError'; return (e as { code?: string })?.code; };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hostctl-files-'));
  outside = await mkdtemp(join(tmpdir(), 'hostctl-files-outside-'));
  home = await mkdtemp(join(tmpdir(), 'hostctl-files-home-'));
  trash = vi.fn(async () => {});
  ops = files([{ id: 'fixture', path: root }], [], configure(), trash as never, home, {});
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('path validation before any file operation', () => {
  it.each([
    ['parent traversal', '../escape.txt', 'OUTSIDE_ROOT'],
    ['nested parent traversal', 'a/../../escape.txt', 'OUTSIDE_ROOT'],
    ['POSIX UNC-style prefix', '//server/share/file', 'OUTSIDE_ROOT'],
    ['Windows UNC prefix', '\\\\server\\share\\file', 'OUTSIDE_ROOT'],
    ['uppercase credential file', '.ENV', 'DENIED'],
    ['credential variant', '.env.local', 'DENIED'],
    ['nested credential file', 'nested/.env', 'DENIED'],
  ])('refuses %s with %s', async (_label, path, code) => {
    expect(await codeOf(run('stat', { path }))).toBe(code);
  });

  it('allows a file whose name merely contains "env" after a dot', async () => {
    expect(await run('write', { path: 'my.env', content: 'fine' })).toMatchObject({ bytesWritten: 4, created: true });
    expect(await readFile(join(root, 'my.env'), 'utf8')).toBe('fine');
  });

  it('rejects a missing path, a NUL byte and a lone surrogate as INVALID_ARGUMENT', async () => {
    expect(await codeOf(run('stat', {}))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(run('stat', { path: 'a\0b' }))).toBe('INVALID_ARGUMENT');
    expect(await codeOf(run('stat', { path: '\uD800' }))).toBe('INVALID_ARGUMENT');
  });

  it('rejects unknown file operations as INVALID_ARGUMENT', async () => {
    expect(await codeOf(run('bogus', { path: 'a' }))).toBe('INVALID_ARGUMENT');
  });

  it('refuses work when the signal is already aborted', async () => {
    const ac = new AbortController(); ac.abort();
    expect(await codeOf(run('stat', { path: '.' }, ac.signal))).toBe('AbortError');
  });
});

describe('read, stat and write', () => {
  it('reads a range by offset and length and reports stat metadata', async () => {
    await writeFile(join(root, 'letters.txt'), 'abcdef');
    expect(await run('read', { path: 'letters.txt', offset: 2, length: 3 })).toMatchObject({ content: 'cde' });
    expect(await run('stat', { path: 'letters.txt' })).toMatchObject({ size: 6 });
  });

  it('reads Unicode text and refuses a length above output.maxBytes', async () => {
    await writeFile(join(root, 'uni.txt'), 'Grüße 👋');
    expect(await run('read', { path: 'uni.txt' })).toMatchObject({ content: 'Grüße 👋' });
    expect(await codeOf(run('read', { path: 'uni.txt', length: 65537 }))).toBe('INVALID_ARGUMENT');
  });

  it('refuses binary content with the binary-content failure', async () => {
    await writeFile(join(root, 'bin'), Buffer.from([0, 1, 2]));
    expect(await rejectionOf(run('read', { path: 'bin' }))).toMatchObject({ code: 'binary-content' });
  });

  it('refuses a write above output.maxBytes with TOO_LARGE and writes nothing', async () => {
    expect(await codeOf(run('write', { path: 'big', content: 'x'.repeat(65537) }))).toBe('TOO_LARGE');
    await expect(stat(join(root, 'big'))).rejects.toThrow();
  });

  it('appends to an existing file and rejects append to a missing one', async () => {
    await writeFile(join(root, 'log.txt'), 'one');
    await run('append', { path: 'log.txt', content: ' two' });
    expect(await readFile(join(root, 'log.txt'), 'utf8')).toBe('one two');
    await expect(run('append', { path: 'missing.txt', content: 'x' })).rejects.toThrow();
  });
});

describe('edit', () => {
  it('replaces exactly one occurrence, including Unicode text', async () => {
    await writeFile(join(root, 'e.txt'), 'naïve café');
    await run('edit', { path: 'e.txt', oldText: 'café', newText: 'bistro' });
    expect(await readFile(join(root, 'e.txt'), 'utf8')).toBe('naïve bistro');
  });

  it('inserts replacement text literally, without $-pattern expansion', async () => {
    await writeFile(join(root, 'dollar.txt'), 'X');
    await run('edit', { path: 'dollar.txt', oldText: 'X', newText: '$&$1$$' });
    expect(await readFile(join(root, 'dollar.txt'), 'utf8')).toBe('$&$1$$');
  });

  it.each([
    ['no match', 'abc', 'zzz'],
    ['two matches', 'twice twice', 'twice'],
    ['empty oldText', 'abc', ''],
  ])('refuses %s with NOT_UNIQUE and leaves the file unchanged', async (_label, content, oldText) => {
    await writeFile(join(root, 'n.txt'), content);
    expect(await codeOf(run('edit', { path: 'n.txt', oldText, newText: 'x' }))).toBe('NOT_UNIQUE');
    expect(await readFile(join(root, 'n.txt'), 'utf8')).toBe(content);
  });
});

describe('list and search', () => {
  it('lists entries honouring depth, and never lists credential files', async () => {
    await mkdir(join(root, 'dir')); await writeFile(join(root, 'dir', 'inner.txt'), 'x');
    await writeFile(join(root, '.env'), 'secret'); await writeFile(join(root, 'top.txt'), 'y');
    const flat = await run('list', { path: '.', depth: 0 }) as { entries: { path: string }[] };
    expect(flat.entries.map(e => e.path).sort()).toEqual(['dir', 'top.txt']);
    const deep = await run('list', { path: '.', depth: 1 }) as { entries: { path: string }[] };
    expect(deep.entries.map(e => e.path)).toContain('dir/inner.txt');
    expect(deep.entries.map(e => e.path)).not.toContain('.env');
  });

  it('marks the listing truncated when the limit is reached', async () => {
    await writeFile(join(root, 'a'), '1'); await writeFile(join(root, 'b'), '2');
    expect(await run('list', { path: '.', depth: 0, limit: 1 })).toMatchObject({ entries: expect.any(Array), truncated: true });
    expect(((await run('list', { path: '.', depth: 0, limit: 1 })) as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it('refuses depth above 16 and lists of a regular file', async () => {
    expect(await codeOf(run('list', { path: '.', depth: 17 }))).toBe('INVALID_ARGUMENT');
    await writeFile(join(root, 'plain.txt'), 'x');
    await expect(run('list', { path: 'plain.txt' })).rejects.toThrow();
  });

  it.skipIf(!posix)('does not list an entry whose symbolic link escapes the root', async () => {
    await writeFile(join(outside, 'secret.txt'), 'private');
    await symlink(outside, join(root, 'escape'));
    const listing = await run('list', { path: '.', depth: 2 }) as { entries: { path: string }[] };
    expect(listing.entries.map(e => e.path).some(p => p.startsWith('escape'))).toBe(false);
  });

  it('searches names with a Unicode query, case-sensitively', async () => {
    await writeFile(join(root, 'naïve.txt'), 'x'); await writeFile(join(root, 'plain.txt'), 'x');
    const hit = await run('search', { path: '.', query: 'ï', mode: 'name' }) as { matches: { path: string }[] };
    expect(hit.matches.map(m => m.path)).toEqual(['naïve.txt']);
    const miss = await run('search', { path: '.', query: 'NAÏVE', mode: 'name' }) as { matches: unknown[] };
    expect(miss.matches).toEqual([]);
  });

  it('searches content and skips binary files and credential files without failing', async () => {
    await writeFile(join(root, 'text.txt'), 'the needle is here');
    await writeFile(join(root, 'bin.dat'), Buffer.from([0, 255, 110, 101, 101, 100, 108, 101]));
    await writeFile(join(root, '.env'), 'needle in credentials');
    const result = await run('search', { path: '.', query: 'needle', mode: 'content' }) as { matches: { path: string }[]; backend: string };
    expect(result.matches.map(m => m.path)).toEqual(['text.txt']);
    expect(['bounded-js', 'ripgrep-verified-stdin']).toContain(result.backend);
  });

  it('reports truncation when search matches exceed the limit', async () => {
    await writeFile(join(root, 'm1.txt'), 'x'); await writeFile(join(root, 'm2.txt'), 'x');
    const result = await run('search', { path: '.', query: 'm', mode: 'name', limit: 1 }) as { matches: unknown[]; truncated: boolean };
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('refuses an empty search query', async () => {
    expect(await codeOf(run('search', { path: '.', query: '', mode: 'name' }))).toBe('INVALID_ARGUMENT');
  });
});

describe('mkdir, copy, move and trash', () => {
  it('creates one directory and refuses the root itself', async () => {
    expect(await run('mkdir', { path: 'made' })).toEqual({ created: true });
    expect((await stat(join(root, 'made'))).isDirectory()).toBe(true);
    expect(await codeOf(run('mkdir', { path: '.' }))).toBe('DENIED');
  });

  it('refuses to create a directory that already exists or whose parent is missing', async () => {
    await mkdir(join(root, 'exists'));
    await expect(run('mkdir', { path: 'exists' })).rejects.toThrow();
    await expect(run('mkdir', { path: 'no-parent/child' })).rejects.toThrow();
  });

  it('copies a file, including binary bytes, and refuses an existing destination', async () => {
    await writeFile(join(root, 'src.bin'), Buffer.from([0, 1, 2, 255]));
    await run('copy', { path: 'src.bin', destination: 'dst.bin' });
    expect(await readFile(join(root, 'dst.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await codeOf(run('copy', { path: 'src.bin', destination: 'dst.bin' }))).toBe('EXISTS');
  });

  it('refuses to copy a directory', async () => {
    await mkdir(join(root, 'dir'));
    expect(await codeOf(run('copy', { path: 'dir', destination: 'dir2' }))).toBe('DENIED');
  });

  it('moves a file and refuses a destination that exists', async () => {
    await writeFile(join(root, 'from.txt'), 'data'); await writeFile(join(root, 'taken.txt'), 'x');
    expect(await run('move', { path: 'from.txt', destination: 'to.txt' })).toEqual({ moved: true });
    expect(await readFile(join(root, 'to.txt'), 'utf8')).toBe('data');
    expect(await codeOf(run('move', { path: 'to.txt', destination: 'taken.txt' }))).toBe('EXISTS');
  });

  it.skipIf(!posix)('refuses to copy, move or trash a symbolic link', async () => {
    await writeFile(join(root, 'target.txt'), 'x');
    await symlink(join(root, 'target.txt'), join(root, 'link.txt'));
    expect(await codeOf(run('copy', { path: 'link.txt', destination: 'c.txt' }))).toBe('DENIED');
    expect(await codeOf(run('move', { path: 'link.txt', destination: 'm.txt' }))).toBe('DENIED');
    expect(await codeOf(run('trash', { path: 'link.txt' }))).toBe('DENIED');
    expect(trash).not.toHaveBeenCalled();
  });

  it('passes the canonical path and signal to the Trash backend, and refuses the root', async () => {
    await writeFile(join(root, 'bin.txt'), 'x');
    const s = signal();
    expect(await run('trash', { path: 'bin.txt' }, s)).toEqual({ trashed: true });
    expect(trash).toHaveBeenCalledOnce();
    const [trashedPath, passedSignal] = trash.mock.calls[0] as unknown as [string, AbortSignal];
    expect(trashedPath).toBe(join(await realpath(root), 'bin.txt'));
    expect(passedSignal).toBe(s);
    expect(await codeOf(run('trash', { path: '.' }))).toBe('DENIED');
  });

  it('propagates a Trash backend failure', async () => {
    await writeFile(join(root, 'fails.txt'), 'x');
    trash.mockRejectedValueOnce(new HostctlError('UNAVAILABLE', 'Native Trash is not available.'));
    expect(await codeOf(run('trash', { path: 'fails.txt' }))).toBe('UNAVAILABLE');
  });
});

it('keeps names with spaces and Unicode intact through write and list', async () => {
  await run('write', { path: 'with space ünï 🙂.txt', content: 'ok' });
  expect((await readdir(root))).toEqual(['with space ünï 🙂.txt']);
});

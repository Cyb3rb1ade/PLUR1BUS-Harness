import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textMatcher } from '../src/search.ts';

// The PATH lookup for ripgrep is replaced per test, so the bounded-JS and ripgrep branches run the same way on every machine.
const host = vi.hoisted(() => ({ program: null as string | null }));
vi.mock('../../core/src/host-tools/index.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../core/src/host-tools/index.ts')>();
  return { ...real, which: async () => host.program };
});

let dir: string;
let fakeRg: string, fakeRgExit2: string, fakeRgHang: string;
const posix = process.platform !== 'win32';
const signal = () => new AbortController().signal;

/** A fake ripgrep: checks the fixed-strings argv shape, then matches the query against stdin and exits 0 (match) or 1. */
const matcherScript = `
const args = process.argv.slice(2);
if (args[0] !== '--quiet' || args[1] !== '--fixed-strings' || args[2] !== '--') process.exit(2);
const query = args.at(-1);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => process.exit(input.includes(query) ? 0 : 1));
`;
const hangScript = 'setInterval(() => {}, 1000);';
const exitTwoScript = 'process.exit(2);';
const exitZeroScript = 'process.exit(0);';

/** Writes a POSIX launcher that runs one Node script with the same interpreter as the test. */
async function launcher(name: string, body: string): Promise<string> {
  const script = join(dir, `${name}.mjs`); const path = join(dir, name);
  await writeFile(script, body);
  await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(path, 0o755);
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hostctl-search-'));
  if (posix) {
    fakeRg = await launcher('rg-match', matcherScript);
    fakeRgExit2 = await launcher('rg-error', exitTwoScript);
    fakeRgHang = await launcher('rg-hang', hangScript);
  }
});
afterAll(async () => {
  host.program = null;
  await rm(dir, { recursive: true, force: true });
});

describe('bounded JavaScript backend (no ripgrep on PATH)', () => {
  it('reports the bounded-js backend when ripgrep is not found', async () => {
    host.program = null;
    expect((await textMatcher()).backend).toBe('bounded-js');
  });

  it.each([
    ['present substring', 'needle in haystack', 'needle', true],
    ['absent substring', 'haystack only', 'needle', false],
    ['empty query matches any text', 'anything', '', true],
    ['empty text matches nothing', '', 'a', false],
    ['case-sensitive', 'Needle', 'needle', false],
    ['Unicode and emoji', 'naïve 🙂 café', '🙂', true],
    ['regex metacharacters are literal', 'a.*b', '.*', true],
    ['regex metacharacters do not match loosely', 'aXb', 'a.b', false],
  ])('%s', async (_label, text, query, expected) => {
    host.program = null;
    const matcher = await textMatcher();
    expect(await matcher.matches(text, query, signal())).toBe(expected);
  });

  it('matches a one-megabyte text with the needle at the very end', async () => {
    host.program = null;
    const matcher = await textMatcher();
    expect(await matcher.matches('x'.repeat(1048576) + 'needle', 'needle', signal())).toBe(true);
  });

  it('rejects with the signal reason when the signal is already aborted', async () => {
    host.program = null;
    const matcher = await textMatcher();
    const ac = new AbortController(); ac.abort();
    await expect(matcher.matches('needle', 'needle', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('ripgrep backend', () => {
  it('reports the verified stdin backend when ripgrep is found', async () => {
    host.program = '/fixture/bin/rg';
    expect((await textMatcher()).backend).toBe('ripgrep-verified-stdin');
  });

  it.skipIf(!posix)('passes the query after -- and maps exit 0 to a match and exit 1 to no match', async () => {
    host.program = fakeRg;
    const matcher = await textMatcher();
    expect(await matcher.matches('the needle', 'needle', signal())).toBe(true);
    expect(await matcher.matches('the haystack', 'needle', signal())).toBe(false);
  });

  it.skipIf(!posix)('treats a query that begins with a dash as a query, not an option', async () => {
    host.program = fakeRg;
    const matcher = await textMatcher();
    expect(await matcher.matches('--flag here', '--flag', signal())).toBe(true);
  });

  it.skipIf(!posix)('delivers a one-megabyte text over stdin intact', async () => {
    host.program = fakeRg;
    const matcher = await textMatcher();
    expect(await matcher.matches('y'.repeat(1048576) + 'needle', 'needle', signal())).toBe(true);
  });

  it.skipIf(!posix)('matches Unicode text and queries', async () => {
    host.program = fakeRg;
    const matcher = await textMatcher();
    expect(await matcher.matches('Grüße 👋 日本語', '日本', signal())).toBe(true);
  });

  it.skipIf(!posix)('does not fail when the helper exits before reading its input', async () => {
    host.program = await launcher('rg-zero-early', exitZeroScript);
    const matcher = await textMatcher();
    expect(await matcher.matches('y'.repeat(1048576), 'needle', signal())).toBe(true);
  });

  it.skipIf(!posix)('falls back to a JavaScript search when the helper cannot be started', async () => {
    host.program = join(dir, 'does-not-exist-rg');
    const matcher = await textMatcher();
    expect(await matcher.matches('the needle', 'needle', signal())).toBe(true);
    expect(await matcher.matches('the haystack', 'needle', signal())).toBe(false);
  });

  it.skipIf(!posix)('rejects with the signal reason when aborted while the helper runs', async () => {
    host.program = fakeRgHang;
    const matcher = await textMatcher();
    const ac = new AbortController();
    const outcome = matcher.matches('text', 'needle', ac.signal);
    ac.abort();
    await expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.skipIf(!posix)('falls back to a JavaScript search when the helper outlives its 5 second budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      host.program = fakeRgHang;
      const matcher = await textMatcher();
      const outcome = matcher.matches('the needle', 'needle', signal());
      await vi.advanceTimersByTimeAsync(5000);
      expect(await outcome).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // UNKLAR: Ein rg-Exit-Code 2 (Fehler) wird aktuell als "kein Treffer" gewertet (code === 0). Soll stattdessen auf
  // text.includes zurückgefallen werden, damit ein Fehler nicht wie ein Nicht-Treffer aussieht?
  it.skip('UNKLAR: treats a helper error (exit 2) as a fallback search, not as no match', async () => {
    host.program = fakeRgExit2;
    const matcher = await textMatcher();
    expect(await matcher.matches('the needle', 'needle', signal())).toBe(true);
  });
});

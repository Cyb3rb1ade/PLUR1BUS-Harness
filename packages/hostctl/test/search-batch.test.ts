import { afterAll, describe, expect, it, vi } from 'vitest';
import { textMatcher } from '../src/search.ts';

// matchMany answers for many texts in one process; whatever backend it uses, its answers are those of a plain literal substring test.
// `host.program` null forces the bounded-JavaScript backend; 'real' looks ripgrep up on PATH (the test then runs against it when installed).
const host = vi.hoisted(() => ({ program: 'real' as string | null }));
vi.mock('../../core/src/host-tools/index.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../core/src/host-tools/index.ts')>();
  return { ...real, which: async (...args: Parameters<typeof real.which>) => host.program === 'real' ? real.which(...args) : host.program };
});
afterAll(() => { host.program = 'real'; });
const signal = () => new AbortController().signal;
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe.each([['bounded-js', null], ['whatever is installed', 'real']] as const)('matchMany (%s)', (_label, program) => {
  const matcher = async () => { host.program = program; return textMatcher(); };

  it('answers per text, in order, for plain, empty, repeated, multi-line and Unicode texts', async () => {
    const m = await matcher(); const texts = ['needle', '', 'hay needle hay needle', 'no match', 'two\nlines needle\nend', 'é€😀 needle', 'NEEDLE', 'a\r\nb', 'x'.repeat(100000) + 'needle'];
    expect(await m.matchMany(texts, 'needle', signal())).toEqual(texts.map(t => t.includes('needle')));
    expect(await m.matchMany(['a\nb', 'c\nd', 'a\r\nb', 'a\nb\nc'], 'a\nb', signal())).toEqual([true, false, false, true]);
    expect(await m.matchMany(['a\r\nb', 'a\rb', 'ab'], 'a\r\nb', signal())).toEqual([true, false, false]);
    expect(await m.matchMany([], 'needle', signal())).toEqual([]);
  });

  it('400 seeded batches: every answer agrees with a plain literal substring test, including queries that look like options, patterns, digits and colons', async () => {
    const SEED = 0xBA7C4; const rand = mulberry32(SEED); const m = await matcher();
    const atoms = ['alpha', 'Beta', '--version', '-e', '--pre=x', '.', '*', '+', '?', '[a-z]', '(x|y)', '^', '$', '\\', '\\d', ' ', '\t', 'é', '€', '😀', '\n', '\r\n', '\r', 'a.b', 'a\\.b', '--', '-', '#', '/', "'", '"', '|', '{1,3}', '1:', '12:x', ':'];
    const gen = (n: number) => Array.from({ length: n }, () => atoms[Math.floor(rand() * atoms.length)]!).join('');
    for (let i = 0; i < 400; i++) {
      const texts = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => gen(Math.floor(rand() * 20)));
      const cps = Array.from(texts[Math.floor(rand() * texts.length)]!); const q = rand() < 0.6 ? cps.slice(Math.floor(rand() * 3), Math.floor(rand() * cps.length) + 1).join('') : gen(1 + Math.floor(rand() * 4)); if (q === '') continue;
      expect(await m.matchMany(texts, q, signal()), `seed ${SEED} case ${i} (${m.backend}): ${JSON.stringify({ texts, q })}`).toEqual(texts.map(t => t.includes(q)));
    }
  }, 120_000);

  it('a query that cannot be handed to a process (NUL, a lone surrogate) is still answered by substring', async () => {
    const m = await matcher();
    expect(await m.matchMany(['a\0b', 'ab'], 'a\0b', signal())).toEqual([true, false]);
    expect(await m.matchMany(['x\ud800y', 'xy'], '\ud800', signal())).toEqual([true, false]);
  });

  it('rejects with the signal reason when already aborted', async () => {
    const m = await matcher(); const ac = new AbortController(); ac.abort();
    await expect(m.matchMany(['needle'], 'needle', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

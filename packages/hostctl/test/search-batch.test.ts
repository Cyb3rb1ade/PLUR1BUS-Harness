import { describe, expect, it } from 'vitest';
import { matchMany } from '../src/search.ts';

// matchMany answers for many already loaded texts in this process: its answers are those of a plain, case-sensitive literal substring test
// (`String.prototype.includes`), one per text, in input order. No ripgrep, no PATH lookup, no child process: nothing here depends on what is installed.
const signal = () => new AbortController().signal;
const plain = (texts: readonly string[], q: string) => texts.map(t => t.includes(q));
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe('matchMany', () => {
  it('answers per text, in order, for plain, empty, repeated, multi-line and Unicode texts', async () => {
    const texts = ['needle', '', 'hay needle hay needle', 'no match', 'two\nlines needle\nend', 'é€😀 needle', 'NEEDLE', 'a\r\nb', 'x'.repeat(100000) + 'needle'];
    expect(await matchMany(texts, 'needle', signal())).toEqual([true, false, true, false, true, true, false, false, true]);
    expect(await matchMany(['a\nb', 'c\nd', 'a\r\nb', 'a\nb\nc'], 'a\nb', signal())).toEqual([true, false, false, true]);
    expect(await matchMany(['a\r\nb', 'a\rb', 'ab'], 'a\r\nb', signal())).toEqual([true, false, false]);
    expect(await matchMany([], 'needle', signal())).toEqual([]);
  });

  it('a literal is not a pattern: metacharacters and option-looking strings match only themselves', async () => {
    expect(await matchMany(['a.*b', 'aXb', '--version', 'x -e y', '[a-z]', 'a', '(x|y)', 'x'], '.*', signal())).toEqual([true, false, false, false, false, false, false, false]);
    expect(await matchMany(['--version', 'version', '-e', 'e'], '--version', signal())).toEqual([true, false, false, false]);
    expect(await matchMany(['[a-z]', 'b', '(x|y)', 'x', '^$', '\\d', '5'], '[a-z]', signal())).toEqual([true, false, false, false, false, false, false]);
    expect(await matchMany(['12:x', '12', ':'], '12:', signal())).toEqual([true, false, false]);
  });

  it('400 seeded batches: every answer agrees with a plain literal substring test, including queries that look like options, patterns, digits and colons', async () => {
    const SEED = 0xBA7C4; const rand = mulberry32(SEED);
    const atoms = ['alpha', 'Beta', '--version', '-e', '--pre=x', '.', '*', '+', '?', '[a-z]', '(x|y)', '^', '$', '\\', '\\d', ' ', '\t', 'é', '€', '😀', '\n', '\r\n', '\r', 'a.b', 'a\\.b', '--', '-', '#', '/', "'", '"', '|', '{1,3}', '1:', '12:x', ':', '\0', '\ud800', '\udc00', '﻿'];
    const gen = (n: number) => Array.from({ length: n }, () => atoms[Math.floor(rand() * atoms.length)]!).join('');
    for (let i = 0; i < 400; i++) {
      const texts = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => gen(Math.floor(rand() * 20)));
      const cps = Array.from(texts[Math.floor(rand() * texts.length)]!); const q = rand() < 0.6 ? cps.slice(Math.floor(rand() * 3), Math.floor(rand() * cps.length) + 1).join('') : gen(1 + Math.floor(rand() * 4)); if (q === '') continue;
      expect(await matchMany(texts, q, signal()), `seed ${SEED} case ${i}: ${JSON.stringify({ texts, q })}`).toEqual(plain(texts, q));
    }
  }, 120_000);

  it('NUL, lone surrogates and a leading byte order mark are ordinary characters of the text and of the query', async () => {
    expect(await matchMany(['a\0b', 'ab', '\0', 'a'], 'a\0b', signal())).toEqual([true, false, false, false]);
    expect(await matchMany(['a\0b', 'ab'], '\0', signal())).toEqual([true, false]);
    expect(await matchMany(['x\ud800y', 'xy', '\ud800', '\udc00'], '\ud800', signal())).toEqual([true, false, true, false]);
    expect(await matchMany(['\ud83d', '😀', '\ude00'], '\ud83d', signal())).toEqual([true, true, false]); // a code unit, as `includes` says
    expect(await matchMany(['﻿needle', 'needle'], 'needle', signal())).toEqual([true, true]);
    expect(await matchMany(['﻿needle', 'needle'], '﻿needle', signal())).toEqual([true, false]);
  });

  it('large texts: a 32 MiB batch (32 files of 1 MiB) with the literal at the start, the end, across nothing and nowhere', async () => {
    const mib = (s: string) => s.padEnd(1 << 20, 'x'); const tail = (s: string) => 'x'.repeat((1 << 20) - s.length) + s;
    const texts = Array.from({ length: 32 }, (_, i) => i % 4 === 0 ? mib('needle') : i % 4 === 1 ? tail('needle') : i % 4 === 2 ? 'x'.repeat(1 << 20) : 'xxneed' + 'x'.repeat((1 << 20) - 12) + 'lexxxx');
    expect(await matchMany(texts, 'needle', signal())).toEqual(texts.map((_, i) => i % 4 < 2));
  });

  it('rejects with the signal reason when already aborted, and stops between two texts of a batch', async () => {
    const ac = new AbortController(); ac.abort();
    await expect(matchMany(['needle'], 'needle', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(matchMany([], 'needle', ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const reason = new Error('stop'); let calls = 0; let tested = 0;
    const texts = Array.from({ length: 10 }, () => ({ includes: () => { tested++; return true; } }) as unknown as string);
    const mid = { throwIfAborted: () => { if (++calls > 4) throw reason; } } as AbortSignal;
    await expect(matchMany(texts, 'x', mid)).rejects.toBe(reason);
    expect(tested).toBe(3);
  });
});

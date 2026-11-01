// SPDX-License-Identifier: MIT
export function seedValues(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('seed must be uint32');
  const tag = `item_${seed.toString(36)}`;
  const n = 3 + ((Math.imul(seed, 2654435761) >>> 0) % 11);
  return { seed, tag, n };
}
export function expandCases(template, seed) {
  const { tag, n } = seedValues(seed);
  const values = { TAG: tag, TAGWORD: tag.replaceAll('_', ' '), N: n, N2: n * 2, N3: n * 3, N4: n * 4, N5: n * 5, N6: n * 6, NM1: n - 1, NP1: n + 1, NP2: n + 2, NP3: n + 3, N100: n * 100, N119: n * 119, N119EUR: (n * 119 / 100).toFixed(2), TAGLEN: Buffer.byteLength(tag), TAGHEX: Buffer.from(tag).toString('hex'), TAGSUM: [...Buffer.from(tag)].reduce((a, b) => (a + b) % 256, 0).toString(16).padStart(2, '0') };
  const expand = value => value.replace(/__([A-Z0-9]+)__/g, (_, key) => {
    if (!(key in values)) throw new Error(`unknown seed placeholder ${key}`);
    return String(values[key]);
  });
  return Object.fromEntries(Object.entries(template).map(([scope, cases]) => [scope, cases.map(([input, expected], index) => ({ id: `${scope}-${index + 1}`, input: expand(input), expected: expand(expected) }))]));
}
export function instanceForSeed(seed) { return { taskId: '_shared', ...seedValues(seed) }; }

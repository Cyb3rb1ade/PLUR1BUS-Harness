// WCAG 2.x contrast of every text/background token pair, computed from src/styles/tokens.css (no extra package).
// Dark is the base block, light is the explicit data-theme="light" block (build.test.ts keeps it identical to the OS-light block).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

type Rgba = [number, number, number, number];

function parseColor(v: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  throw new Error(`unsupported colour: ${v}`);
}

/** Alpha-composite `top` over an opaque `base`. */
function over(top: Rgba, base: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + base[i]! * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number): number => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function ratio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const css = await readFile(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
const dark = declarations(/:root \{([^}]*)\}/.exec(css)![1]!);
const light = declarations(/:root\[data-theme="light"\] \{([^}]*)\}/.exec(css)![1]!);

// [text token, background token]. Translucent backgrounds are composited over the page (--bg), which is what the sidebar,
// hover and error tints sit on; a surface that sits on --surface is listed with it explicitly.
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ["--ink", "--bg"], ["--ink", "--surface"], ["--ink-2", "--bg"], ["--ink-2", "--surface"], ["--ink-3", "--bg"], ["--ink-3", "--surface"],
  ["--ink", "--sidebar-bg"], ["--ink-2", "--sidebar-bg"], ["--ink-3", "--sidebar-bg"],
  ["--ink", "--hover-bg"], ["--ink-2", "--hover-bg"], ["--ink", "--active-bg"], ["--ink-2", "--active-bg"],
  ["--primary-ink", "--primary-bg"],
  ["--err-ink", "--err-bg"], ["--ok-ink", "--ok-bg"], ["--warn-ink", "--warn-bg"], ["--info-ink", "--info-bg"],
  ["--ink", "--field-bg"],
];

for (const [name, tokens] of [["dark", dark], ["light", light]] as const) {
  const resolve = (token: string): Rgba => {
    const v = tokens.get(token);
    assert.ok(v, `${name}: ${token} is not defined`);
    return over(parseColor(v), parseColor(tokens.get("--bg")!));
  };

  test(`${name}: every text/background token pair has a contrast of at least 4.5:1`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      assert.ok(tokens.has(fg), `${name}: ${fg} is not defined`);
      const r = ratio(over(parseColor(tokens.get(fg)!), resolve(bg)), resolve(bg));
      assert.ok(r >= 4.5, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}:1 (< 4.5:1)`);
    }
  });

  test(`${name}: focus ring and form-field borders reach 3:1 against the page (WCAG 1.4.11)`, () => {
    for (const token of ["--focus", "--field-border"]) {
      for (const bg of ["--bg", "--surface"]) {
        const r = ratio(resolve(token), resolve(bg));
        assert.ok(r >= 3, `${name}: ${token} on ${bg} is ${r.toFixed(2)}:1 (< 3:1)`);
      }
    }
  });
}

test("the contrast function agrees with known values", () => {
  assert.equal(Math.round(ratio([0, 0, 0, 1], [255, 255, 255, 1])), 21);
  assert.ok(Math.abs(ratio(parseColor("#767676"), parseColor("#ffffff")) - 4.54) < 0.02);
});

test("both themes define the same token set", () => {
  assert.deepEqual([...light.keys()].sort(), [...dark.keys()].filter((k) => !k.startsWith("--font-")).sort());
});

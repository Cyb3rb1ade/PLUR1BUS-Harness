// Property test for the Signal message splitter (src/split.ts): splitMessage and splitStyled.
//
// Pure function test: no timers, no network, no dependency. All "random" input comes from the fixed-seed mulberry32
// generator below, so a failure message (`seed=<n> index=<i> ...`) names an input that can be rebuilt exactly. The corpus
// order is fixed: edge cases (`edge:<max>:<length>:<kind>`), generated inputs (`index=<0..599>`), hand-picked cases
// (`fixed:<name>`); the markdown corpus for splitStyled is `md:<i>`.
//
// What the code does, and therefore what is pinned here:
//  - The limit is SIGNAL_MAX_TEXT = 2000 and it is measured in UTF-16 code units (String.length), not bytes, not code points.
//    docs/channels/signal.md line 103: "Messages are split at 2000 UTF-16 code units". The code and the document agree.
//  - splitMessage cuts the text into consecutive slices and then DROPS every slice whose trim() is empty (JS Unicode
//    whitespace). It does not trim at part boundaries, adds no marker, no ellipsis and no fence. So the parts are in-order
//    substrings of the input, and every gap between them (including before the first and after the last) is whitespace-only.
//  - A cut never lands between the two halves of a surrogate pair (the `cut -= 1` guard). Nothing in the code knows about
//    extended grapheme clusters (ZWJ sequences, flags, keycaps, combining marks, CRLF).
//  - splitMessage is blind to ``` fences: it neither closes an open fence nor reopens it. The styled path (splitStyled,
//    fed by toSignalText, which turns fences into MONOSPACE ranges) re-bases every style range per part, so a code block
//    that spans several parts stays MONOSPACE in each of them.
//  - Empty input gives [] (also for whitespace-only input); an invalid `max` throws RangeError before anything else.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SIGNAL_MAX_TEXT, splitMessage, splitStyled, toSignalText } from "../src/index.ts";
import type { StyledText, TextStyleName } from "../src/index.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic generator

const SEED = 20261012;
const GENERATED_COUNT = 600;
const MARKDOWN_COUNT = 160;

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UMLAUT = "äöüßÄÖÜ";

// Each entry is exactly one extended grapheme cluster (checked against Intl.Segmenter in the corpus test below).
const CLUSTERS: Record<string, string> = {
  family: "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}", // man ZWJ woman ZWJ girl ZWJ boy, 11 units
  couple: "\u{1F469}‍❤️‍\u{1F468}", // woman ZWJ heart VS16 ZWJ man, 8 units
  rainbowFlag: "\u{1F3F3}️‍\u{1F308}", // white flag VS16 ZWJ rainbow, 6 units
  flagDE: "\u{1F1E9}\u{1F1EA}", // regional indicator pair, 4 units
  flagUS: "\u{1F1FA}\u{1F1F8}",
  flagEngland: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // black flag + tag letters, 14 units
  thumbTone: "\u{1F44D}\u{1F3FD}", // thumbs up + skin tone modifier, 4 units
  keycap: "1️⃣", // keycap sequence, 3 units
  aUmlautDecomposed: "ä", // a + combining diaeresis, 2 units
  grin: "\u{1F600}", // astral character, one surrogate pair
  clef: "\u{1D11E}",
  cjkExtB: "\u{20000}",
};
const CLUSTER_VALUES = Object.values(CLUSTERS);

const SMALL_MAX = [2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 16, 24, 31, 32, 33, 50, 64, 100, 128] as const;

function word(r: Rng, alphabet: string, lo: number, hi: number): string {
  const n = int(r, lo, hi);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[int(r, 0, alphabet.length - 1)]!;
  return s;
}

/** One unit of a "word without spaces": a letter, an umlaut or a whole cluster. */
function atom(r: Rng): string {
  const k = r();
  if (k < 0.6) return LOWER[int(r, 0, LOWER.length - 1)]!;
  if (k < 0.75) return UMLAUT[int(r, 0, UMLAUT.length - 1)]!;
  return pick(r, CLUSTER_VALUES);
}

/** A run with no whitespace that is longer than `max` (forces the hard cut). */
function longRun(r: Rng, max: number): string {
  const target = max + int(r, 1, Math.max(8, Math.floor(max / 2)));
  let s = "";
  while (s.length < target) s += atom(r);
  return s;
}

function fenced(r: Rng): string {
  const lang = pick(r, ["", "ts", "py"]);
  const lines = Array.from({ length: int(r, 1, 4) }, () => word(r, LOWER, 1, 10)).join("\n");
  const open = "```" + lang + "\n" + lines + "\n";
  return r() < 0.2 ? open : open + "```"; // 20 % stay open: an odd number of fences
}

function documentText(r: Rng, max: number, target: number): string {
  const mode = int(r, 0, 2); // 0 prose (many separators), 1 mixed, 2 dense (few separators)
  const autoSep = mode === 0 ? 0.85 : mode === 1 ? 0.4 : 0.05;
  let s = "";
  while (s.length < target) {
    const k = r();
    let t: string;
    if (k < 0.3) t = word(r, LOWER, 1, 10);
    else if (k < 0.4) t = word(r, LOWER + UMLAUT, 1, 8);
    else if (k < 0.5) t = pick(r, [" ", "  ", "\t", " "]);
    else if (k < 0.62) t = pick(r, ["\n", "\r\n", "\n\n", "\r\n\r\n"]);
    else if (k < 0.78) t = pick(r, CLUSTER_VALUES);
    else if (k < 0.86) t = fenced(r);
    else if (k < 0.9) t = "```";
    else if (k < 0.93) t = longRun(r, max);
    else t = word(r, UMLAUT, 1, 6);
    s += t;
    if (r() < autoSep) s += pick(r, [" ", " ", "\n", "\r\n", "\n\n"]);
  }
  return s;
}

/** A string of exactly `length` UTF-16 units built from whole atoms (no torn pair), padded with "a". */
function exact(length: number, next: () => string): string {
  let s = "";
  while (s.length < length) {
    const a = next();
    s += s.length + a.length <= length ? a : "a";
  }
  return s;
}

interface Case {
  id: string;
  text: string;
  max: number;
}

function buildEdgeCases(r: Rng): Case[] {
  const kinds: Record<string, () => string> = {
    words: () => word(r, LOWER, 1, 9) + " ",
    nospace: () => atom(r),
    umlauts: () => word(r, UMLAUT, 1, 6) + " ",
    umlautRun: () => UMLAUT[int(r, 0, UMLAUT.length - 1)]!,
    astral: () => (r() < 0.9 ? CLUSTERS.grin! : "a"),
    zwj: () => CLUSTERS.family!,
    mixed: () => pick(r, [word(r, LOWER, 1, 6), " ", "\n", "\r\n", "\n\n", ...CLUSTER_VALUES]),
    crlf: () => "line\r\n",
    fence: () => "```\ncode\n```\n",
  };
  const out: Case[] = [];
  for (const max of [SIGNAL_MAX_TEXT, 64, 10]) {
    for (const length of [max - 1, max, max + 1]) {
      for (const [kind, next] of Object.entries(kinds)) out.push({ id: `edge:${max}:${length}:${kind}`, text: exact(length, next), max });
    }
  }
  return out;
}

function buildGenerated(r: Rng): Case[] {
  const out: Case[] = [];
  for (let i = 0; i < GENERATED_COUNT; i++) {
    const useDefault = r() < 0.45;
    const max = useDefault ? SIGNAL_MAX_TEXT : pick(r, SMALL_MAX);
    const target = useDefault ? pick(r, [int(r, 0, 40), int(r, 1900, 2100), int(r, 2000, 5000)]) : int(r, 0, Math.min(400, max * 8));
    out.push({ id: String(i), text: documentText(r, max, target), max });
  }
  return out;
}

function buildFixed(): Case[] {
  const out: Case[] = [];
  const add = (name: string, text: string, max: number = SIGNAL_MAX_TEXT) => out.push({ id: `fixed:${name}`, text, max });
  const L = SIGNAL_MAX_TEXT;

  add("empty", "");
  add("space", " ");
  add("whitespace-mix", "   \n  ");
  add("crlf-only", "\r\n");
  add("empty-small-max", "", 2);
  add("ascii-1999", "a".repeat(L - 1));
  add("ascii-2000", "a".repeat(L));
  add("ascii-2001-no-space", "a".repeat(L + 1));
  add("ascii-4001-no-space", "a".repeat(2 * L + 1));
  add("words-2000", "a ".repeat(L / 2));
  add("words-2002", "a ".repeat(L / 2 + 1));
  add("umlauts-2000", "ä".repeat(L)); // 4000 bytes, 2000 units
  add("umlauts-2001", "ä".repeat(L + 1));
  add("emoji-1500", CLUSTERS.grin!.repeat(1500)); // 3000 units, 1500 code points
  add("emoji-1001", CLUSTERS.grin!.repeat(1001));
  add("long-umlaut-word-2100", "äöüß".repeat(525));
  add("long-emoji-word-2200", CLUSTERS.grin!.repeat(1100));
  add("long-zwj-word", CLUSTERS.family!.repeat(300)); // 3300 units, no spaces
  add("crlf-at-1999", "a".repeat(L - 1) + "\r\n" + "tail"); // forced cut lands between CR and LF
  add("crlf-lines", "line\r\n".repeat(500));
  add("crlf-blank-lines", "a\r\n\r\n".repeat(700));
  add("pair-straddles-1999", "a".repeat(L - 1) + CLUSTERS.grin! + "b"); // pair occupies units 1999 and 2000
  add("pair-straddles-small", "x" + CLUSTERS.grin!.repeat(8), 4);
  add("pairs-small-2", CLUSTERS.grin!.repeat(40), 2);
  for (let k = L - 4; k <= L + 1; k++) add(`fence-at-${k}`, "a".repeat(k) + "```\ncode\n```\ntail"); // marker straddles the cut
  add("fence-block-closed", "```\n" + "line of code\n".repeat(600) + "```\nafter");
  add("fence-block-open", "intro\n\n```ts\n" + "line of code\n".repeat(600));
  add("fence-odd-small", "```\nab\n```\n```\ncd\n", 6);
  add("fence-only", "```", 2);
  add("fence-split-by-space", "``  `", 2); // a dropped whitespace-only part sits between backticks
  add("paragraphs", ("word ".repeat(30) + "\n\n").repeat(40));
  // Malformed input: lone surrogates stay where they are, they just must not be glued into a pair by the splitter.
  add("lone-high-end", "a".repeat(L - 1) + "\uD83D" + "b");
  add("lone-low-start", "\uDE00" + "a".repeat(L));
  add("lone-high-then-pair", "\uD83D" + CLUSTERS.grin!, 3);
  add("lone-surrogates-small", "😀\uDE00\uD83D😀x", 2);
  add("zwj-edge-whitespace", " " + CLUSTERS.family! + " ", 4);

  // A cluster that starts k units before the cut, so the forced cut at `max` falls k units inside it.
  for (const max of [SIGNAL_MAX_TEXT, 10]) {
    for (const [name, c] of Object.entries(CLUSTERS)) {
      for (let k = 1; k < c.length && k < max; k++) add(`straddle:${name}@${k}:${max}`, "a".repeat(max - k) + c + "tail", max);
    }
  }
  return out;
}

const RNG = mulberry32(SEED);
const EDGE = buildEdgeCases(RNG);
const GENERATED = buildGenerated(RNG);
const FIXED = buildFixed();
const CORPUS: Case[] = [...EDGE, ...GENERATED, ...FIXED];

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function esc(s: string): string {
  return Array.from(s, (ch) => {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp < 0x7f) return ch;
    if (cp === 10) return "\\n";
    if (cp === 13) return "\\r";
    return `\\u{${cp.toString(16)}}`;
  }).join("");
}

function preview(text: string): string {
  return `"${esc(text.slice(0, 48))}${text.length > 48 ? "..." : ""}" (length ${text.length})`;
}

/** Runs `fn` for each case; a failure is rethrown with the seed and the index of the input so it can be replayed. */
function eachCase(cases: readonly Case[], fn: (c: Case) => void): void {
  for (const c of cases) {
    try {
      fn(c);
    } catch (e) {
      assert.fail(`seed=${SEED} index=${c.id} max=${c.max} input=${preview(c.text)} :: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const run = (c: Case): string[] => (c.max === SIGNAL_MAX_TEXT ? splitMessage(c.text) : splitMessage(c.text, c.max)); // default argument too

interface Span {
  start: number;
  end: number;
}

/** Places `parts` in `text`, in order, each as an exact substring, with only whitespace-only (trim() === "") gaps between. */
function align(text: string, parts: readonly string[]): Span[] | null {
  const spans: Span[] = [];
  const go = (i: number, cursor: number): boolean => {
    if (i === parts.length) return text.slice(cursor).trim() === "";
    const part = parts[i]!;
    for (let gap = 0; cursor + gap + part.length <= text.length; gap++) {
      if (gap > 0 && text[cursor + gap - 1]!.trim() !== "") break; // the gap would contain a non-whitespace unit
      if (text.startsWith(part, cursor + gap)) {
        spans.push({ start: cursor + gap, end: cursor + gap + part.length });
        if (go(i + 1, cursor + gap + part.length)) return true;
        spans.pop();
      }
    }
    return false;
  };
  return go(0, 0) ? spans : null;
}

interface Analysis {
  parts: string[];
  spans: Span[] | null;
}
const analysed = new Map<Case, Analysis>();
function analyse(c: Case): Analysis {
  let a = analysed.get(c);
  if (!a) {
    const parts = run(c);
    a = { parts, spans: align(c.text, parts) };
    analysed.set(c, a);
  }
  return a;
}
function spansOf(c: Case): Span[] {
  const { spans } = analyse(c);
  if (!spans) assert.fail("parts are not in-order substrings of the input separated only by whitespace-only gaps");
  return spans;
}

/** Offsets that are cut positions: every part start and end. */
function cutOffsets(spans: readonly Span[]): number[] {
  return [...new Set(spans.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b);
}

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(text: string): { start: Int32Array; end: Int32Array } {
  const start = new Int32Array(text.length + 1);
  const end = new Int32Array(text.length + 1);
  for (const seg of segmenter.segment(text)) {
    for (let o = seg.index; o < seg.index + seg.segment.length; o++) {
      start[o] = seg.index;
      end[o] = seg.index + seg.segment.length;
    }
  }
  start[text.length] = text.length;
  end[text.length] = text.length;
  return { start, end };
}

const fenceCount = (s: string): number => s.split("```").length - 1;

// ---------------------------------------------------------------------------------------------------------------------
// The limit and the corpus itself

test("limit: SIGNAL_MAX_TEXT is 2000 and docs/channels/signal.md documents the same number, in UTF-16 code units", () => {
  assert.equal(SIGNAL_MAX_TEXT, 2000);
  // docs/channels/signal.md line 103: "Messages are split at 2000 UTF-16 code units, preferring paragraph breaks ..."
  const doc = readFileSync(new URL("../../../docs/channels/signal.md", import.meta.url), "utf8");
  const m = /split at (\d+) UTF-16 code units/.exec(doc);
  assert.ok(m, "docs/channels/signal.md no longer states the split limit in UTF-16 code units");
  assert.equal(Number(m[1]), SIGNAL_MAX_TEXT);
});

test("corpus: at least 500 generated inputs, every required kind of content and the edge lengths are present", () => {
  assert.equal(GENERATED.length, GENERATED_COUNT);
  assert.ok(GENERATED.length >= 500);
  for (const [name, c] of Object.entries(CLUSTERS)) {
    const segs = [...segmenter.segment(c)];
    assert.equal(segs.length, 1, `${name} is not a single grapheme cluster in this ICU version`);
  }
  const has = (re: RegExp): boolean => CORPUS.some((c) => re.test(c.text));
  assert.ok(has(/[a-z]/), "ASCII");
  assert.ok(has(/[äöüß]/), "umlauts");
  assert.ok(has(/‍/), "ZWJ sequences");
  assert.ok(has(/[\u{1F1E6}-\u{1F1FF}]{2}/u), "flags");
  assert.ok(has(/[\uD800-\uDBFF][\uDC00-\uDFFF]/), "surrogate pairs");
  assert.ok(has(/```/), "fences");
  assert.ok(has(/\r\n/), "CRLF");
  assert.ok(has(/(?<!\r)\n/), "LF");
  assert.ok(CORPUS.some((c) => c.text.length > 0 && c.text.trim() === ""), "whitespace-only input");
  assert.ok(CORPUS.some((c) => (c.text.match(/\S+/g) ?? []).some((w) => w.length > c.max)), "a word longer than the limit");
  for (const len of [SIGNAL_MAX_TEXT - 1, SIGNAL_MAX_TEXT, SIGNAL_MAX_TEXT + 1]) {
    assert.ok(CORPUS.some((c) => c.max === SIGNAL_MAX_TEXT && c.text.length === len), `length ${len} at the limit`);
  }
  assert.ok(GENERATED.filter((c) => run(c).length > 1).length >= 200, "splitting is exercised by the generated inputs");
});

test("limit: it is measured in UTF-16 code units, not in bytes and not in code points", () => {
  const umlauts = splitMessage("ä".repeat(SIGNAL_MAX_TEXT));
  assert.deepEqual(umlauts.map((p) => p.length), [SIGNAL_MAX_TEXT]);
  assert.equal(Buffer.byteLength(umlauts[0]!), 2 * SIGNAL_MAX_TEXT, "one part may hold more than 2000 bytes");
  assert.deepEqual(splitMessage("ä".repeat(SIGNAL_MAX_TEXT + 1)).map((p) => p.length), [SIGNAL_MAX_TEXT, 1]);
  // 1500 emoji = 1500 code points but 3000 units: a code point limit would keep them in one part.
  assert.deepEqual(splitMessage(CLUSTERS.grin!.repeat(1500)).map((p) => p.length), [SIGNAL_MAX_TEXT, 1000]);
});

test("preference: a paragraph break wins over a later newline and space within the window (docs line 103)", () => {
  const text = "a".repeat(25) + "\n\n" + "b".repeat(5) + "\n" + "c".repeat(5) + " " + "d".repeat(20);
  assert.deepEqual(splitMessage(text, 40), ["a".repeat(25) + "\n\n", "b".repeat(5) + "\n" + "c".repeat(5) + " " + "d".repeat(20)]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 1: every part is within the limit

test("property 1: every part is within the limit (UTF-16 units) and not empty", () => {
  eachCase(CORPUS, (c) => {
    for (const p of analyse(c).parts) {
      assert.ok(p.length >= 1, "empty part");
      assert.ok(p.length <= c.max, `part of ${p.length} units exceeds ${c.max}`);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 2: the parts give back the text, apart from whitespace-only parts that are dropped

test("property 2: parts are in-order substrings of the input; only whitespace-only parts are dropped, nothing is trimmed or added", () => {
  eachCase(CORPUS, (c) => {
    const { parts } = analyse(c);
    spansOf(c); // contiguous substrings separated by whitespace-only gaps
    for (const p of parts) assert.ok(p.trim().length > 0, "a whitespace-only part was returned");
    assert.equal(parts.length === 0, c.text.trim() === "", "no parts exactly when the input is whitespace-only");
    if (c.text.length <= c.max) assert.deepEqual(parts, c.text.trim() === "" ? [] : [c.text], "a short input is returned untouched, not trimmed");
    if (!/\s/.test(c.text)) assert.equal(parts.join(""), c.text, "an input without any whitespace must come back unchanged");
  });
});

test("property 2: splitStyled without styles returns exactly the parts of splitMessage", () => {
  eachCase(CORPUS, (c) => {
    const styled = c.max === SIGNAL_MAX_TEXT ? splitStyled({ text: c.text, styles: [] }) : splitStyled({ text: c.text, styles: [] }, c.max);
    assert.deepEqual(styled.map((s) => s.text), analyse(c).parts);
    for (const s of styled) assert.deepEqual(s.styles, []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 3: surrogate pairs and grapheme clusters

test("property 3a: no cut falls between the two halves of a surrogate pair", () => {
  eachCase(CORPUS, (c) => {
    for (const o of cutOffsets(spansOf(c))) {
      if (o <= 0 || o >= c.text.length) continue;
      assert.ok(!(isHigh(c.text.charCodeAt(o - 1)) && isLow(c.text.charCodeAt(o))), `cut at ${o} tears a surrogate pair`);
    }
  });
});

// The splitter keeps extended grapheme clusters (ZWJ sequences, flags, keycaps, combining sequences, CRLF) whole whenever
// a cluster fits into the limit; a longer cluster cannot be kept whole and is not counted.
test(
  "property 3b: no extended grapheme cluster is split (Intl.Segmenter on the original)",
  () => {
    let first = "";
    let bad = 0;
    for (const c of CORPUS) {
      const { start, end } = graphemes(c.text);
      for (const o of cutOffsets(spansOf(c))) {
        if (start[o] === o) continue;
        // A cluster longer than the limit cannot be kept whole: that tear is unavoidable, so it is not counted.
        if (end[o]! - start[o]! > c.max) continue;
        bad++;
        if (!first) {
          first = `seed=${SEED} index=${c.id} max=${c.max} cut at ${o} splits cluster [${start[o]}, ${end[o]}) "${esc(c.text.slice(start[o], end[o]))}" around "${esc(c.text.slice(Math.max(0, o - 6), o))}|${esc(c.text.slice(o, o + 6))}"`;
        }
        break;
      }
    }
    assert.equal(bad, 0, `${first} (${bad} of ${CORPUS.length} inputs have a cut inside a grapheme cluster)`);
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Property 4: fences

test("property 4a: splitMessage is blind to ``` fences, it neither closes nor reopens an open one", () => {
  let oddParts = 0;
  eachCase(CORPUS, (c) => {
    const { parts } = analyse(c);
    spansOf(c); // every part is an exact substring, so no fence was appended to or prepended to a part
    // The cuts are the same when every fence is replaced by three neutral characters of the same length.
    const neutral = c.text.replaceAll("```", "~~~");
    const same = c.max === SIGNAL_MAX_TEXT ? splitMessage(neutral) : splitMessage(neutral, c.max);
    assert.deepEqual(same.map((p) => p.length), parts.map((p) => p.length), "fences influence where the text is cut");
    for (const p of parts) if (fenceCount(p) % 2 === 1) oddParts++;
  });
  assert.ok(oddParts >= 20, `only ${oddParts} parts with an open fence in the corpus`);
  // The one place the documented reopening happens is the styled path, pinned by the next test.
});

function markdownDocument(r: Rng, target: number): string {
  const w = (): string => word(r, LOWER + UMLAUT, 1, 9);
  const code = (): string => Array.from({ length: int(r, 1, 8) }, () => word(r, LOWER, 3, 30)).join("\n");
  let s = "";
  while (s.length < target) {
    const k = r();
    if (k < 0.25) s += w() + " ";
    else if (k < 0.33) s += `**${w()} ${w()}** `;
    else if (k < 0.4) s += `*${w()}* `;
    else if (k < 0.46) s += `~~${w()}~~ `;
    else if (k < 0.5) s += `||${w()}|| `;
    else if (k < 0.58) s += "`" + w() + "` ";
    else if (k < 0.71) s += "\n```" + pick(r, ["", "ts"]) + "\n" + code() + "\n```\n";
    else if (k < 0.73) s += "\n```\n" + code() + "\n";
    else if (k < 0.8) s += pick(r, CLUSTER_VALUES) + " ";
    else if (k < 0.86) s += "\n\n";
    else if (k < 0.9) s += `\n# ${w()}\n`;
    else if (k < 0.93) s += `\n- ${w()}\n`;
    else if (k < 0.96) s += `[${w()}](https://example.org/${word(r, LOWER, 1, 8)}) `;
    else s += "\r\n";
  }
  return s;
}

const STYLE_NAMES: TextStyleName[] = ["BOLD", "ITALIC", "STRIKETHROUGH", "MONOSPACE", "SPOILER"];
function coverage(s: StyledText, name: TextStyleName): Uint8Array {
  const cov = new Uint8Array(s.text.length);
  for (const st of s.styles) {
    assert.ok(st.start >= 0 && st.length > 0 && st.start + st.length <= s.text.length, `style range ${st.start}+${st.length} is outside the text`);
    if (st.style === name) cov.fill(1, st.start, st.start + st.length);
  }
  return cov;
}

test("property 4b: splitStyled reopens a style that spans a cut (a code block stays MONOSPACE in every part), per character", () => {
  const r = mulberry32(SEED ^ 0x5eed);
  let spanning = 0;
  let monoSpanning = 0;
  for (let i = 0; i < MARKDOWN_COUNT; i++) {
    const useDefault = r() < 0.25;
    const max = useDefault ? SIGNAL_MAX_TEXT : pick(r, [8, 12, 20, 33, 64, 100] as const);
    const styled = toSignalText(markdownDocument(r, useDefault ? int(r, 2000, 5000) : int(r, 20, 900)));
    try {
      const chunks = useDefault ? splitStyled(styled) : splitStyled(styled, max);
      const spans = align(styled.text, chunks.map((c) => c.text));
      assert.ok(spans, "chunk texts are not in-order substrings of the converted text separated by whitespace-only gaps");
      assert.deepEqual(chunks.map((c) => c.text), useDefault ? splitMessage(styled.text) : splitMessage(styled.text, max));
      const original: Record<string, Uint8Array> = Object.fromEntries(STYLE_NAMES.map((n) => [n, coverage(styled, n)]));
      chunks.forEach((chunk, k) => {
        assert.ok(chunk.text.length <= max, `chunk ${k} has ${chunk.text.length} units`);
        for (const n of STYLE_NAMES) {
          const local = coverage(chunk, n);
          const base: number = spans[k]!.start;
          for (let j = 0; j < local.length; j++) {
            if (local[j] !== original[n]![base + j]) assert.fail(`${n} coverage differs at chunk ${k} offset ${j} (global ${base + j})`);
          }
        }
      });
      const cuts = cutOffsets(spans);
      for (const st of styled.styles) {
        if (cuts.some((o) => o > st.start && o < st.start + st.length)) {
          spanning++;
          if (st.style === "MONOSPACE") monoSpanning++;
        }
      }
    } catch (e) {
      assert.fail(`seed=${SEED} index=md:${i} max=${max} input=${preview(styled.text)} :: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  assert.ok(spanning >= 20, `only ${spanning} style ranges span a cut`);
  assert.ok(monoSpanning >= 10, `only ${monoSpanning} code ranges span a cut`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 5: empty input

test("property 5: empty input gives [] (also whitespace-only), splitStyled the same, and a bad max still throws first", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("", 2), []);
  assert.deepEqual(splitMessage(" "), []);
  assert.deepEqual(splitMessage("   \n  "), []);
  assert.deepEqual(splitMessage("\r\n\t "), []);
  assert.deepEqual(splitStyled({ text: "", styles: [] }), []);
  assert.deepEqual(splitStyled({ text: " \n ", styles: [{ start: 0, length: 3, style: "MONOSPACE" }] }), []);
  assert.deepEqual(splitMessage(" ".repeat(3 * SIGNAL_MAX_TEXT)), []);
  for (const bad of [1, 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitMessage("", bad), RangeError);
    assert.throws(() => splitStyled({ text: "", styles: [] }, bad), RangeError);
  }
});

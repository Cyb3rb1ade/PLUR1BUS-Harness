// Property test for splitMessage (src/split.ts), step 4 of the contract work: deterministic, pure, no timers, no network.
//
// Facts taken from the code and the docs (and what this file pins):
// - Limit: DISCORD_MAX_TEXT = 2000 UTF-16 code units (src/split.ts). docs/channels/discord.md, section 9, line 125 says
//   "Messages longer than 2000 characters are split." and section 10, line 142 says "`edit` takes one message of at most
//   2000 characters." The first test below reads the doc and compares the number with the constant.
// - Cut rule: the cut prefers "\n\n", then "\n", then " " inside the second half of the window, else it is a hard cut at the
//   budget. The separator stays at the END of the left part. Nothing is trimmed at a boundary.
// - What the code ADDS: when a cut falls inside an open code fence, the left part gets a closer ("\n```", or just "```" when
//   the left piece already ends in "\n") and the right part gets an opener ("```" + language + "\n"). Closer and opener always
//   have exactly three backticks, even for a fence opened with four (pinned below). The language in the opener is the first word
//   of the info string, cut to 12 code units. The LAST part never gets a closer: a fence that is unterminated in the input stays
//   unterminated there.
// - What the code REMOVES: whitespace-only parts (Discord rejects empty content). Nothing else. So joining the parts, after
//   removing the added closers and openers, gives back the input minus whitespace-only stretches.
// - Surrogate pairs are never torn (the hard cut steps back by one unit). Grapheme clusters (ZWJ sequences, flags, CRLF,
//   combining marks) ARE torn by the hard cut: see the KNOWN GAP in property 3b.
// - Empty input: "", "\n" and "   " all give [] (the one empty part is dropped as whitespace-only).
//
// Replay: every generated case is derived from (seed, limit, index) alone, so `caseAt(seed, limit, index)` rebuilds exactly the
// input a failure message names. Hand-picked cases carry `seed=-` and an index of the form `hand:<name>`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DISCORD_MAX_TEXT, splitMessage } from "../src/index.ts";

// ---- deterministic PRNG --------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Rng {
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return {
    int: (n) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p) => next() < p,
  };
}

// ---- vocabulary ----------------------------------------------------------------------------------------------

const ASCII_WORDS = ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "Lorem", "ipsum", "dolor", "sit", "amet", "x", "42", "foo_bar", "a-b"];
const UMLAUT_WORDS = ["Übergrößenträger", "Straße", "äöüß", "Größe", "schön", "Mädchen", "Fußgängerübergang", "Öl", "ÄÖÜ"];

const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"; // man, woman, girl, boy joined by ZWJ: 11 code units
const WOMAN_TECH = "\u{1F469}\u{200D}\u{1F4BB}"; // woman technologist
const RAINBOW_FLAG = "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}"; // white flag, VS16, ZWJ, rainbow
const FLAG_DE = "\u{1F1E9}\u{1F1EA}"; // two regional indicators
const FLAG_US = "\u{1F1FA}\u{1F1F8}";
const FLAG_FR = "\u{1F1EB}\u{1F1F7}";
const THUMB_TONE = "\u{1F44D}\u{1F3FD}"; // thumbs up with skin-tone modifier
const KEYCAP = "1\u{FE0F}\u{20E3}";
const ASTRAL = ["\u{1F600}", "\u{1D4B3}", "\u{20BB7}"]; // grinning face, math script X, a CJK ideograph: one pair each
const EMOJI = [...ASTRAL, FAMILY, WOMAN_TECH, RAINBOW_FLAG, FLAG_DE, FLAG_US, FLAG_FR, THUMB_TONE, KEYCAP, "\u{2764}\u{FE0F}"];
const CODE_WORDS = ["const", "let", "x", "=>", "(a,", "b)", "{", "}", "return", "foo()", "'äöüß'", "\"Größe\"", "\u{1F600}", "0x1f", "i++;"];
const LANGS = ["", "ts", "python", "js", "c++", "typescriptreact"]; // the last one is longer than 12 and gets cut

const SEPS = [" ", " ", " ", "\n", "\n\n", " \n"];
const EOLS = ["\n", "\r\n", "\n\n", "\r\n\r\n"];

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;

/** Exactly `n` code units, built from `s` (padded with "x"), never ending in a lone high surrogate. */
function exactLen(s: string, n: number): string {
  let t = s.length >= n ? s.slice(0, n) : s + "x".repeat(n - s.length);
  if (n > 0 && isHigh(t.charCodeAt(n - 1))) t = t.slice(0, n - 1) + "z";
  return t;
}

function prose(r: Rng, pool: readonly string[], target: number, seps: readonly string[] = SEPS): string {
  let s = "";
  while (s.length < target) s += r.pick(pool) + r.pick(seps);
  return s;
}

function target(r: Rng, limit: number, scale = 1): number {
  return Math.max(1, Math.round(r.pick([0.4, 1, 1.5, 2.5, 4]) * limit * scale));
}

// ---- generators (each returns a well-formed string) ----------------------------------------------------------

type Gen = (r: Rng, limit: number, scale?: number) => string;

const genAscii: Gen = (r, limit, scale = 1) => prose(r, ASCII_WORDS, target(r, limit, scale));
const genUmlaut: Gen = (r, limit, scale = 1) => prose(r, [...UMLAUT_WORDS, ...ASCII_WORDS], target(r, limit, scale));
const genEmoji: Gen = (r, limit, scale = 1) => prose(r, [...ASCII_WORDS, ...EMOJI, ...EMOJI], target(r, limit, scale), [" ", "", "", "\n"]);

const UNIT_SETS: readonly (readonly string[])[] = [
  ["a"],
  ["ä", "ö", "ü", "ß"],
  ASTRAL,
  [FAMILY],
  [FLAG_DE, FLAG_US, FLAG_FR],
  EMOJI,
  ["a", "ä", "\u{1F600}", FAMILY],
];

/** One word with no whitespace, around or above the limit, optionally between two bits of prose. */
const genLongWord: Gen = (r, limit) => {
  const n = r.pick([limit - 1, limit, limit + 1, 2 * limit, 2 * limit + 1, Math.floor(2.5 * limit), 3 * limit + 7]);
  const units = r.pick(UNIT_SETS);
  let w = "";
  while (w.length < n) w += r.pick(units);
  w = exactLen(w, n);
  const before = r.chance(0.5) ? prose(r, ASCII_WORDS, r.int(Math.floor(limit / 2))) : "";
  const after = r.chance(0.5) ? ` ${prose(r, ASCII_WORDS, r.int(Math.floor(limit / 2)))}` : "";
  return before + w + after;
};

function codeBlock(r: Rng, limit: number, terminated: boolean): string {
  const lang = r.pick(LANGS);
  const eol = r.chance(0.2) ? "\r\n" : "\n";
  const lines: string[] = [];
  let size = 0;
  const goal = Math.round(r.pick([0.3, 1, 1.7, 3]) * limit);
  while (size < goal) {
    const line = " ".repeat(r.int(3) * 2) + prose(r, CODE_WORDS, r.int(60) + 1, [" "]).trimEnd();
    lines.push(line);
    size += line.length + eol.length;
  }
  // No other backtick is ever generated, so a fence line is always a deliberate one.
  return `\`\`\`${lang}${eol}${lines.join(eol)}${terminated ? `${eol}\`\`\`` : ""}`;
}

/** Prose, one to three code blocks, prose. Only the last block may be left open, and then nothing follows it. */
const genCode: Gen = (r, limit) => {
  const blocks = 1 + r.int(3);
  let s = "";
  for (let i = 0; i < blocks; i++) {
    if (r.chance(0.5)) s += `${prose(r, ASCII_WORDS, r.int(Math.floor(limit / 2)) + 1)}\n`;
    const last = i === blocks - 1;
    const open = last && r.chance(0.25);
    s += codeBlock(r, limit, !open);
    if (!open) s += "\n";
  }
  return s;
};

const genNewlines: Gen = (r, limit, scale = 1) => {
  const goal = target(r, limit, scale);
  const pool = [...ASCII_WORDS, ...UMLAUT_WORDS, "\u{1F600}", FAMILY];
  let s = "";
  while (s.length < goal) {
    const line = r.chance(0.15) ? r.pick(["", " ", "\t", "  "]) : prose(r, pool, r.int(50) + 1, [" "]).trimEnd();
    s += line + r.pick(EOLS);
  }
  return s;
};

const genMixed: Gen = (r, limit) => {
  const parts: Gen[] = [genAscii, genUmlaut, genEmoji, genNewlines, genLongWord, (rr, l) => codeBlock(rr, l, true)];
  const n = 2 + r.int(3);
  const segs: string[] = [];
  for (let i = 0; i < n; i++) segs.push(r.pick(parts)(r, limit, 0.5));
  // Segments are always joined by a line break, so a fence line stays at a line start and nothing trails a closer.
  let s = segs.join(r.pick(["\n", "\n\n"]));
  if (r.chance(0.15)) s += `\n${codeBlock(r, limit, false)}`;
  return s;
};

/** Lengths around the limit (limit-1, limit, limit+1 and the same around twice the limit) with fillers that stress the edge. */
const genEdge: Gen = (r, limit) => {
  const n = r.pick([limit - 1, limit, limit + 1, 2 * limit - 1, 2 * limit, 2 * limit + 1]);
  switch (r.int(9)) {
    case 0: return exactLen(prose(r, ASCII_WORDS, n + 20), n);
    case 1: return "a".repeat(n);
    case 2: return exactLen("äöüß".repeat(Math.ceil(n / 4) + 1), n);
    case 3: return exactLen(r.pick(ASTRAL).repeat(Math.ceil(n / 2) + 1), n);
    case 4: return exactLen("a".repeat(limit - 1) + r.pick(ASTRAL) + "a".repeat(n), n); // a pair straddles the limit
    case 5: return exactLen("a".repeat(Math.max(0, limit - 3)) + FAMILY + "a".repeat(n), n); // a ZWJ sequence straddles it
    case 6: return exactLen(Array.from({ length: n }, (_, i) => `line ${i}\n`).join(""), n);
    case 7: return exactLen(`\`\`\`ts\n${prose(r, CODE_WORDS, n + 20, [" ", "\n"])}\n\`\`\`\n`, n);
    default: return exactLen("a".repeat(limit - 1) + "\r\n" + prose(r, ASCII_WORDS, n), n); // CRLF straddles the limit
  }
};

const KINDS: readonly (readonly [string, Gen])[] = [
  ["ascii", genAscii],
  ["umlaut", genUmlaut],
  ["emoji", genEmoji],
  ["longword", genLongWord],
  ["code", genCode],
  ["newlines", genNewlines],
  ["mixed", genMixed],
  ["edge", genEdge],
];

// ---- cases ---------------------------------------------------------------------------------------------------

interface Case {
  seed: number | "-";
  index: number | string;
  kind: string;
  limit: number;
  text: string;
}

const SEED_MAIN = 20261012;
const SEED_SMALL = 20261013;
const SMALL_LIMIT = 64; // splitMessage takes the limit as a parameter; a small one makes every property bite on short inputs
const GENERATED_PER_SET = 600;

function caseAt(seed: number, limit: number, index: number): Case {
  // One PRNG per case, so a case can be rebuilt from (seed, limit, index) without generating its predecessors.
  const r = makeRng((seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const [kind, gen] = KINDS[index % KINDS.length] as (typeof KINDS)[number];
  return { seed, index, kind, limit, text: gen(r, limit) };
}

const generated = (seed: number, limit: number): Case[] => Array.from({ length: GENERATED_PER_SET }, (_, i) => caseAt(seed, limit, i));

const L = DISCORD_MAX_TEXT;
const A = (n: number): string => "a".repeat(n);
const FAMILY_RUN = FAMILY.repeat(Math.ceil((2.5 * L) / FAMILY.length));
const CODE_LINES = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");

const HAND: ReadonlyArray<{ name: string; text: string; limit?: number }> = [
  { name: "empty", text: "" },
  { name: "single newline", text: "\n" },
  { name: "spaces only", text: "   " },
  { name: "whitespace only, longer than the limit", text: " \n".repeat(L) },
  { name: "limit-1", text: A(L - 1) },
  { name: "limit", text: A(L) },
  { name: "limit+1", text: A(L + 1) },
  { name: "limit+1 ending in two newlines", text: `${A(L - 1)}\n\n` },
  { name: "limit plus a newline", text: `${A(L)}\n` },
  { name: "astral pair straddles the limit", text: `${A(L - 1)}\u{1F600}` },
  { name: "astral pair ends exactly at the limit", text: `${A(L - 2)}\u{1F600}` },
  { name: "astral only, no separators", text: "\u{1F600}".repeat(L) },
  { name: "ZWJ family run, no separators", text: FAMILY_RUN },
  { name: "ZWJ family straddles the limit", text: `${A(L - 3)}${FAMILY}${A(40)}` },
  { name: "flag run, no separators", text: FLAG_DE.repeat(L) },
  { name: "flag run shifted by one unit", text: `x${FLAG_DE.repeat(L)}` },
  { name: "umlauts, no separators, 4x limit", text: "äöüß".repeat(L) },
  { name: "decomposed umlauts", text: "a\u{308}o\u{308}u\u{308}".repeat(L) },
  { name: "decomposed umlauts shifted by one unit", text: `b${"a\u{308}".repeat(L)}` },
  { name: "CRLF straddles the limit", text: `${A(L - 1)}\r\n${"b".repeat(50)}` },
  { name: "CRLF lines", text: "line\r\n".repeat(L) },
  { name: "LF lines", text: "line\n".repeat(L) },
  { name: "paragraphs", text: `${"p ".repeat(30)}\n\n`.repeat(100) },
  { name: "fenced block over several parts", text: `intro\n\`\`\`ts\n${CODE_LINES}\n\`\`\`\noutro`, limit: 200 },
  { name: "fence with a language longer than 12", text: `\`\`\`typescriptreact\n${"x ".repeat(L)}\n\`\`\`\ntail` },
  { name: "fence without a language", text: `\`\`\`\n${"word ".repeat(L)}\n\`\`\`\ntail` },
  { name: "unterminated fence over several parts", text: `intro\n\`\`\`py\n${"y = 1\n".repeat(L)}` },
  { name: "fence with one unbroken line", text: `\`\`\`\n${A(2 * L + 5)}\n\`\`\`` },
  { name: "two fenced blocks", text: `\`\`\`js\n${"a;\n".repeat(L)}\`\`\`\nmiddle\n\`\`\`sh\n${"ls\n".repeat(L)}\`\`\`\n` },
  { name: "fence with CRLF line ends", text: `\`\`\`ts\r\n${"let a = 1;\r\n".repeat(L)}\`\`\`\r\nend`, limit: 300 },
  { name: "four-backtick fence", text: `\`\`\`\`ts\n${"x ".repeat(30)}\n\`\`\`\`\ntail`, limit: 40 },
  { name: "small limit, fence and umlauts", text: `\`\`\`ts\n${"äö ".repeat(40)}\n\`\`\`\n${"\u{1F600}".repeat(40)}`, limit: 32 },
];

const HAND_CASES: Case[] = HAND.map((h) => ({ seed: "-", index: `hand:${h.name}`, kind: "hand", limit: h.limit ?? L, text: h.text }));
const GENERATED_MAIN = generated(SEED_MAIN, L);
const GENERATED_SMALL = generated(SEED_SMALL, SMALL_LIMIT);
const ALL_CASES: Case[] = [...HAND_CASES, ...GENERATED_MAIN, ...GENERATED_SMALL];

// ---- failure messages: every assertion names the seed and the index ------------------------------------------

function preview(text: string): string {
  const shown = text.length > 90 ? `${text.slice(0, 40)}...${text.slice(-40)}` : text;
  return `${JSON.stringify(shown)} (len=${text.length})`;
}

function where(c: Case): string {
  return `seed=${c.seed} index=${c.index} kind=${c.kind} limit=${c.limit} input=${preview(c.text)}`;
}

function check(c: Case, ok: boolean, what: string): void {
  assert.ok(ok, `${where(c)}: ${what}`);
}

function checkEqual<T>(c: Case, actual: T, expected: T, what: string): void {
  assert.deepStrictEqual(actual, expected, `${where(c)}: ${what}`);
}

// ---- recovering what the splitter added -----------------------------------------------------------------------

interface Piece {
  /** Offsets into the original text covered by this part (without the added opener and closer). */
  start: number;
  end: number;
  /** The language in the opener this part starts with, or null when it starts with original text. */
  reopened: string | null;
  /** Whether this part ends with an added closer. */
  closed: boolean;
}

interface Tail {
  pieces: Piece[];
  /** Whitespace-only stretches of the original that no part contains. */
  gaps: Array<[number, number]>;
}

/**
 * Walks the original and the parts together. Each part is `[opener] + piece + [closer]`; the opener is present exactly when the
 * previous part got a closer, the closer is "```" when the piece ends in a newline and "\n```" otherwise, and the last part never
 * gets one. Whitespace-only parts may be missing between parts (at least half a window long, see `minGap`) and at the end (any
 * length: the remainder after the last cut). Returns null when no such
 * reading of the parts reproduces the original, which is the failure of property 2.
 */
function recover(original: string, parts: readonly string[], limit: number): Tail | null {
  const memo = new Map<string, Tail | null>();
  // A whitespace-only part that is dropped in the middle was cut as a whole piece, and the splitter never cuts a piece shorter than
  // half the window (a separator must sit in the second half of it) unless it is the last. So a shorter gap is trimmed boundary
  // whitespace, not a dropped part, and is rejected: the splitter trims nothing.
  const minGap = Math.floor(limit / 2) + 1;

  const go = (k: number, pos: number, mustReopen: boolean): Tail | null => {
    const key = `${k}:${pos}:${mustReopen}`;
    if (memo.has(key)) return memo.get(key) ?? null;
    let res: Tail | null = null;
    if (k === parts.length) {
      if (!mustReopen && original.slice(pos).trim() === "") res = { pieces: [], gaps: pos < original.length ? [[pos, original.length]] : [] };
    } else {
      let run = 0;
      if (!mustReopen) while (pos + run < original.length && /\s/.test(original.charAt(pos + run))) run++;
      for (let g = 0; g <= run && res === null; g = g === 0 ? minGap : g + 1) res = tryPart(k, pos, g, mustReopen);
    }
    memo.set(key, res);
    return res;
  };

  const tryPart = (k: number, gapStart: number, gap: number, mustReopen: boolean): Tail | null => {
    const part = parts[k] as string;
    const pos = gapStart + gap;
    let body = part;
    let lang: string | null = null;
    if (mustReopen) {
      const m = /^```([^`\s]{0,12})\n/.exec(part);
      if (!m) return null;
      lang = m[1] as string;
      body = part.slice(m[0].length);
    }
    const options: Array<{ core: string; closed: boolean }> = [];
    if (k < parts.length - 1) {
      if (body.endsWith("```") && body.slice(0, -3).endsWith("\n")) options.push({ core: body.slice(0, -3), closed: true });
      if (body.endsWith("\n```") && !body.slice(0, -4).endsWith("\n")) options.push({ core: body.slice(0, -4), closed: true });
    }
    options.push({ core: body, closed: false });
    for (const { core, closed } of options) {
      if (core.length === 0 || !original.startsWith(core, pos)) continue;
      const rest = go(k + 1, pos + core.length, closed);
      if (!rest) continue;
      const piece: Piece = { start: pos, end: pos + core.length, reopened: lang, closed };
      return { pieces: [piece, ...rest.pieces], gaps: gap > 0 ? [[gapStart, pos], ...rest.gaps] : rest.gaps };
    }
    return null;
  };

  return go(0, 0, false);
}

/**
 * A dropped whitespace-only remainder after the last part only exists when the last piece ended at a cut: on a separator (space or
 * newline) or, for a hard cut, exactly at the window (the part, opener included, is the whole limit). Otherwise the missing tail
 * would be trimmed whitespace.
 */
function trailingGapIsACut(c: Case, parts: readonly string[], tail: Tail): boolean {
  const last = tail.pieces[tail.pieces.length - 1];
  const gap = tail.gaps.find(([, e]) => e === c.text.length);
  if (!gap || !last) return true;
  return /[ \n]$/.test(c.text.slice(last.start, last.end)) || (parts[parts.length - 1] as string).length === c.limit;
}

// ---- running the splitter once per case -----------------------------------------------------------------------

interface Run {
  c: Case;
  parts: string[];
  tail: Tail | null;
}

let cachedRuns: Run[] | undefined;
function runs(): Run[] {
  cachedRuns ??= ALL_CASES.map((c) => {
    let parts: string[];
    try {
      // The main set goes through the default limit on purpose, so the default argument is covered too.
      parts = c.limit === DISCORD_MAX_TEXT ? splitMessage(c.text) : splitMessage(c.text, c.limit);
    } catch (err) {
      throw new Error(`${where(c)}: splitMessage threw ${String(err)}`);
    }
    return { c, parts, tail: recover(c.text, parts, c.limit) };
  });
  return cachedRuns;
}

// ---- fence model used by property 4 (counts fence lines, like the existing tests do) -----------------------------

const fenceLines = (s: string): number => s.split("\n").filter((l) => l.startsWith("```")).length;

/** The open fence at `pos` of `text` (its language as the splitter reopens it), or null when no fence is open there. */
function openFenceAt(text: string, pos: number): { lang: string } | null {
  let open: { lang: string } | null = null;
  for (const line of text.slice(0, pos).split("\n")) {
    if (!line.startsWith("```")) continue;
    open = open ? null : { lang: (line.replace(/^`+/, "").trim().split(/\s+/)[0] as string).slice(0, 12) };
  }
  return open;
}

// ---- tests -----------------------------------------------------------------------------------------------------

test("generator: at least 500 inputs per set, deterministic, and every feature the task names is present", () => {
  assert.equal(GENERATED_MAIN.length >= 500, true);
  assert.equal(GENERATED_SMALL.length >= 500, true);
  assert.deepStrictEqual(caseAt(SEED_MAIN, L, 37), GENERATED_MAIN[37], "replay of one case gives the same input");
  assert.deepStrictEqual(generated(SEED_MAIN, L).map((c) => c.text), GENERATED_MAIN.map((c) => c.text), "same seed, same inputs");
  for (const c of [...GENERATED_MAIN, ...GENERATED_SMALL]) check(c, c.text.isWellFormed(), "generated input must be well-formed UTF-16");
  const has = (pred: (t: string) => boolean): number => GENERATED_MAIN.filter((c) => pred(c.text)).length;
  assert.ok(has((t) => /[äöüß]/.test(t)) >= 50, "umlauts");
  assert.ok(has((t) => /[\u{10000}-\u{10FFFF}]/u.test(t)) >= 50, "astral characters");
  assert.ok(has((t) => t.includes("\u{200D}")) >= 50, "ZWJ sequences");
  assert.ok(has((t) => /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(t)) >= 20, "flag sequences");
  assert.ok(has((t) => t.includes("```")) >= 50, "fenced blocks");
  assert.ok(has((t) => t.includes("\r\n")) >= 50, "CRLF");
  assert.ok(has((t) => t.includes("\n\n")) >= 50, "blank lines");
  assert.ok(has((t) => /\S{2001,}/u.test(t)) >= 20, "a word longer than the limit");
  for (const n of [L - 1, L, L + 1]) assert.ok(has((t) => t.length === n) >= 5, `length ${n}`);
});

test("limit: DISCORD_MAX_TEXT equals the number in docs/channels/discord.md", () => {
  const doc = readFileSync(new URL("../../../docs/channels/discord.md", import.meta.url), "utf8");
  // Section 9 (line 125): "Messages longer than 2000 characters are split."
  const split = /Messages longer than (\d+) characters are split/.exec(doc);
  assert.ok(split, "docs/channels/discord.md no longer says how long a message may be before it is split");
  assert.equal(Number(split[1]), DISCORD_MAX_TEXT);
  // Section 10 (line 142): "`edit` takes one message of at most 2000 characters."
  const edit = /one message of at most (\d+) characters/.exec(doc);
  assert.ok(edit, "docs/channels/discord.md no longer states the per-message limit for edit");
  assert.equal(Number(edit[1]), DISCORD_MAX_TEXT);
  assert.equal(DISCORD_MAX_TEXT, 2000);
});

test("property 1: every part is within the limit, no part is empty, and a text that fits stays one part", () => {
  for (const { c, parts } of runs()) {
    parts.forEach((p, k) => {
      check(c, p.length <= c.limit, `part ${k} has ${p.length} code units, limit ${c.limit}`);
      check(c, [...p].length <= c.limit, `part ${k} has more than ${c.limit} characters`);
      check(c, p.trim().length > 0, `part ${k} is empty or whitespace-only (Discord rejects that)`);
    });
    if (c.text.length <= c.limit && c.text.trim().length > 0) checkEqual(c, parts, [c.text], "a text within the limit is returned unchanged, untrimmed");
    // Whitespace-only parts are dropped, so the test is on the span between the first and the last visible character.
    if (c.text.trim().length > c.limit) check(c, parts.length >= 2, "a text whose visible span is above the limit must be split");
  }
});

test("property 2: joining the parts gives back the input, except the added fence closers and openers and dropped whitespace-only parts", () => {
  let multiPart = 0;
  let withGap = 0;
  for (const { c, parts, tail } of runs()) {
    check(c, tail !== null, `no reading of the parts reproduces the input; parts=${JSON.stringify(parts.map((p) => p.length))}`);
    if (!tail) continue;
    // Whole input covered, in order, no overlap, nothing trimmed: pieces and gaps tile [0, length) exactly.
    const spans = [...tail.pieces.map((p) => [p.start, p.end] as const), ...tail.gaps].sort((a, b) => a[0] - b[0]);
    let at = 0;
    for (const [s, e] of spans) {
      checkEqual(c, s, at, "pieces and dropped stretches leave a hole or overlap");
      at = e;
    }
    checkEqual(c, at, c.text.length, "pieces and dropped stretches stop short of the end");
    for (const [s, e] of tail.gaps) check(c, c.text.slice(s, e).trim() === "", "only whitespace may be dropped");
    check(c, trailingGapIsACut(c, parts, tail), "the dropped whitespace at the end does not follow a cut, so it was trimmed off the last part");
    if (parts.length > 1) multiPart++;
    if (tail.gaps.length > 0) withGap++;
    const joined = tail.pieces.map((p) => c.text.slice(p.start, p.end)).join("");
    const withoutGaps = [...tail.gaps].reverse().reduce((t, [s, e]) => t.slice(0, s) + t.slice(e), c.text);
    checkEqual(c, joined, withoutGaps, "join of the pieces must equal the input minus the dropped whitespace-only stretches");
  }
  assert.ok(multiPart >= 500 && withGap >= 3, `the property must be exercised: multiPart=${multiPart} withGap=${withGap}`);
});

test("pinned examples: separators stay on the left, whitespace-only parts go, nothing else is trimmed", () => {
  assert.deepStrictEqual(splitMessage("aaaaaaa bbbbbbb ccccccc", 16), ["aaaaaaa bbbbbbb ", "ccccccc"]);
  assert.deepStrictEqual(splitMessage(`${A(L - 1)}\n\n`), [`${A(L - 1)}\n`]);
  assert.deepStrictEqual(splitMessage(`${A(L)}\n`), [A(L)]);
  assert.deepStrictEqual(splitMessage(`${A(L - 1)}\u{1F600}`), [A(L - 1), "\u{1F600}"]);
  assert.deepStrictEqual(splitMessage(A(L + 1)), [A(L), "a"]);
  assert.deepStrictEqual(splitMessage("   leading and trailing   "), ["   leading and trailing   "]);
  // The closer is "```" when the piece already ends in a newline, "\n```" otherwise; the opener repeats the language.
  assert.deepStrictEqual(splitMessage("```ts\nabc\ndef\nghi\njkl\n```\ntail", 16), ["```ts\nabc\n```", "```ts\ndef\n```", "```ts\nghi\n```", "```ts\njkl\n```\n", "tail"]);
  assert.deepStrictEqual(splitMessage("```ts\nabcdef\nghijkl\nmnopqr\n```", 24), ["```ts\nabcdef\nghijkl\n```", "```ts\nmnopqr\n```"]);
  // A language longer than 12 code units is cut to 12 in the opener.
  const long = splitMessage(`\`\`\`typescriptreact\n${"x ".repeat(40)}\n\`\`\``, 64);
  assert.ok(long.length >= 2 && long[1]?.startsWith("```typescriptre\n"), JSON.stringify(long[1]));
  // An unterminated fence stays unterminated in the last part: only a cut gets a closer.
  const open = splitMessage(`\`\`\`py\n${"y = 1\n".repeat(40)}`, 64);
  assert.ok(open.length >= 2 && open.slice(0, -1).every((p) => fenceLines(p) % 2 === 0) && fenceLines(open[open.length - 1] as string) % 2 === 1, JSON.stringify(open));
});

test("property 3a: no surrogate pair is split", () => {
  for (const { c, parts, tail } of runs()) {
    parts.forEach((p, k) => check(c, p.isWellFormed(), `part ${k} contains a lone surrogate`));
    for (const piece of tail?.pieces ?? []) {
      for (const b of [piece.start, piece.end]) {
        const torn = b > 0 && b < c.text.length && isHigh(c.text.charCodeAt(b - 1)) && isLow(c.text.charCodeAt(b));
        check(c, !torn, `a cut at ${b} falls between the halves of a surrogate pair`);
      }
    }
  }
});

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemeBoundaries(s: string): Set<number> {
  const b = new Set<number>([s.length]);
  for (const seg of GRAPHEMES.segment(s)) b.add(seg.index);
  return b;
}

function around(s: string, pos: number): string {
  let window = s.slice(Math.max(0, pos - 6), pos + 6);
  if (window.length > 0 && isLow(window.charCodeAt(0))) window = window.slice(1);
  if (window.length > 0 && isHigh(window.charCodeAt(window.length - 1))) window = window.slice(0, -1);
  return [...window].map((ch) => `U+${(ch.codePointAt(0) as number).toString(16).toUpperCase()}`).join(" ");
}

// KNOWN GAP (product deviation, found by this test): the hard cut at the budget only steps back over a surrogate pair. It does not
// look at grapheme clusters, so a ZWJ sequence (family, technologist, rainbow flag), a flag pair, a skin-tone or VS16 emoji, a
// combining mark or CRLF can be cut in two. The ZWJ and flag tears are reachable from channel.ts:320 (toPlatformMarkdown does not
// touch them); the CRLF tear is not, because toPlatformMarkdown turns CRLF into LF before splitMessage runs.
// First failing inputs: hand-picked "ZWJ family run, no separators" (cut at 2000 inside a family emoji, right after a U+200D),
// first generated seed=20261012 index=11 (kind longword, limit 2000, cut at 4000 inside a family emoji) and, in the small-limit
// set, seed=20261013 index=27 (limit 64). Replay with caseAt(20261012, 2000, 11).
test(
  "property 3b: every cut falls on an extended grapheme cluster boundary (Intl.Segmenter)",
  { todo: "KNOWN GAP: channels-discord splitMessage: erwartet Schnitte nur an Graphem-Grenzen, tatsächlich trennt der harte Schnitt ZWJ-Sequenzen, Flaggen und CRLF (erstes Beispiel: Handfall \"ZWJ family run, no separators\", erzeugt seed=20261012 index=11)" },
  () => {
    for (const { c, tail } of runs()) {
      const boundaries = graphemeBoundaries(c.text);
      for (const piece of tail?.pieces ?? []) {
        for (const b of [piece.start, piece.end]) check(c, boundaries.has(b), `a cut at ${b} splits a grapheme cluster (code points around the cut: ${around(c.text, b)})`);
      }
    }
  },
);

test("property 4: an open fence is closed at a cut and reopened with its language in the next part", () => {
  let cuts = 0;
  let withLanguage = 0;
  let truncated = 0;
  let unterminated = 0;
  for (const { c, parts, tail } of runs()) {
    if (!tail) continue; // property 2 reports it
    const n = parts.length;
    const originalOpenAtEnd = openFenceAt(c.text, c.text.length) !== null;
    tail.pieces.forEach((piece, k) => {
      const part = parts[k] as string;
      const last = k === n - 1;
      const openAtCut = openFenceAt(c.text, piece.end);
      if (!last) {
        // A part that is cut inside a fence is closed in itself; a part cut outside a fence is left alone.
        check(c, piece.closed === (openAtCut !== null), `part ${k}: closer ${piece.closed ? "added" : "missing"} but the fence is ${openAtCut ? "open" : "closed"} at the cut`);
        check(c, fenceLines(part) % 2 === 0, `part ${k} has an odd number of fence lines`);
        const next = tail.pieces[k + 1] as Piece;
        if (openAtCut) {
          checkEqual(c, next.reopened, openAtCut.lang, `part ${k + 1} must reopen the fence with its language`);
          cuts++;
          if (openAtCut.lang !== "") withLanguage++;
          if (openAtCut.lang.length === 12) truncated++;
        } else checkEqual(c, next.reopened, null, `part ${k + 1} starts with an opener although no fence was open`);
      } else {
        // The last part has no cut after it: no closer is added, so an unterminated fence stays unterminated.
        check(c, !piece.closed, "the last part must not get a closer");
        check(c, (fenceLines(part) % 2 === 1) === originalOpenAtEnd, `last part: fence lines ${fenceLines(part)}, input ends ${originalOpenAtEnd ? "inside" : "outside"} a fence`);
        if (originalOpenAtEnd && n > 1) unterminated++;
      }
    });
    checkEqual(c, tail.pieces[0]?.reopened ?? null, null, "the first part never starts with an opener");
  }
  // The property is not vacuous: the inputs really cut inside fences, with and without a language, with a cut language, and some
  // leave the fence open at the end.
  assert.ok(cuts >= 200 && withLanguage >= 100 && truncated >= 5 && unterminated >= 10, `cuts=${cuts} withLanguage=${withLanguage} truncated=${truncated} unterminated=${unterminated}`);
});

// Pinned semantics for a fence opened with more than three backticks (property 4 counts fence lines, so this passes there too): the
// closer the splitter appends and the opener it writes always have exactly three backticks, whatever the original fence used. The
// original's own four-backtick closer is left alone where it is not cut. Observation, not asserted as a rule: src/split.ts's own
// fence tracking (fenceAfter, "like CommonMark") only closes a fence with at least as many backticks as the opener, so by that rule
// part 0 below is not closed; Discord's renderer may well end a block at the first ```. Nothing here claims that is a bug.
test("property 4: a fence opened with four backticks gets a three-backtick closer and a three-backtick opener", () => {
  const text = `\`\`\`\`ts\n${"x ".repeat(30)}\n\`\`\`\`\ntail`;
  const parts = splitMessage(text, 40);
  assert.ok(parts.length >= 3, JSON.stringify(parts));
  assert.ok((parts[0] as string).startsWith("````ts\n") && (parts[0] as string).endsWith("\n```") && !(parts[0] as string).endsWith("````"), JSON.stringify(parts[0]));
  assert.ok((parts[1] as string).startsWith("```ts\nx") && !(parts[1] as string).startsWith("````"), JSON.stringify(parts[1]));
  assert.ok((parts[parts.length - 1] as string).endsWith("\n````\ntail"), JSON.stringify(parts[parts.length - 1]));
  for (const part of parts.slice(0, -1)) assert.equal(fenceLines(part) % 2, 0, JSON.stringify(part));
});

test("property 5: empty and whitespace-only input give an empty list, never an empty part", () => {
  for (const max of [undefined, 16, 64, DISCORD_MAX_TEXT]) {
    for (const text of ["", "\n", "   ", "\r\n", "\t \n ", " \n".repeat(L)]) {
      const parts = max === undefined ? splitMessage(text) : splitMessage(text, max);
      assert.deepStrictEqual(parts, [], `splitMessage(${JSON.stringify(text.length > 20 ? `${text.slice(0, 20)}...` : text)}, ${String(max)})`);
    }
  }
  assert.deepStrictEqual(splitMessage(""), []);
});

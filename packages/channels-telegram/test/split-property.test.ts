// Deterministic property test for the Telegram message splitter (src/split.ts).
//
// What the code does (read from src/split.ts, not guessed):
//   - `splitMessage(text, max = TELEGRAM_MAX_TEXT)` cuts at most `max` UTF-16 code units at a time. It prefers to cut
//     right AFTER the last "\n\n", else "\n", else " " that lies inside the window and in its second half (index >=
//     floor(max / 2)); otherwise it cuts hard at `max`. The separator therefore stays at the END of the left part.
//   - A cut that would land between a high and a low surrogate moves one code unit to the left.
//   - Nothing is trimmed, added or rewritten. The only text that can disappear is a whole chunk for which
//     `chunk.trim().length === 0` (the final `filter`). That can happen at the start, in the middle or at the end.
//   - It is NOT aware of grapheme clusters (ZWJ sequences, flags, CR LF, combining marks) and NOT aware of ``` fences.
//
// Limit: the only numeric source is the constant TELEGRAM_MAX_TEXT in src/split.ts. docs/channels/telegram.md states no
// number: line 12 only lists "Text splitting, surrogate safety" and line 93 says escaping happens "after splitting".
// So the properties compare against the constant, and one separate test pins the constant to Telegram's published
// Bot API limit of 4096 characters per text message (a repo constant, not a repo doc).
//
// Replay: every generated input is a pure function of (SEED, index). A failure message starts with
// `seed=<n> index=<i>`; rebuild the input with `generateInput(SEED, i)` (hand-picked cases have fixed indices).

import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeText, splitMessage, TELEGRAM_MAX_TEXT } from "../src/split.ts";

const SEED = 20261012;
const GENERATED = 600;
const LIMIT = TELEGRAM_MAX_TEXT;

// ---------------------------------------------------------------------------------------------------------------------
// Local PRNG (mulberry32), no dependency.

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

const int = (rng: Rng, n: number): number => Math.floor(rng() * n); // 0 .. n-1
const range = (rng: Rng, lo: number, hi: number): number => lo + int(rng, hi - lo + 1); // lo .. hi
function pick<T>(rng: Rng, xs: readonly T[]): T {
  return xs[int(rng, xs.length)] as T;
}

// ---------------------------------------------------------------------------------------------------------------------
// Building blocks. Emoji are written as escapes so the source stays readable and editor independent.

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const UMLAUTS = ["ä", "ö", "ü", "ß", "Ä", "Ö", "Ü"] as const;
const COMBINING = ["ä", "ö", "ü", "é"] as const; // decomposed (NFD) umlauts and accents
const ZWJ_FAMILY = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}"; // man, woman, girl, boy: 11 code units
const ZWJ_TECH = "\u{1F469}‍\u{1F4BB}"; // woman technologist
const ZWJ_RAINBOW = "\u{1F3F3}️‍\u{1F308}"; // rainbow flag: VS16 + ZWJ
const FLAG_DE = "\u{1F1E9}\u{1F1EA}"; // two regional indicators
const FLAG_JP = "\u{1F1EF}\u{1F1F5}";
const EMOJI = [
  "\u{1F600}", // surrogate pair
  ZWJ_FAMILY,
  ZWJ_TECH,
  ZWJ_RAINBOW,
  FLAG_DE,
  FLAG_JP,
  "\u{1F44D}\u{1F3FD}", // thumbs up + skin tone modifier
  "1️⃣", // keycap
  "❤️", // BMP character + VS16
] as const;
const ASTRAL = ["\u{1D4B3}", "\u{2070E}", "\u{10348}"] as const; // astral, not emoji
const SPACES = [" ", " ", " ", "  ", "\t"] as const;
const NEWLINES = ["\n", "\r\n", "\n\n", "\r\n\r\n"] as const;
const LONG_UNITS = [
  "x",
  "ä",
  "`",
  "\u{1D4B3}",
  "\u{1F600}",
  ZWJ_FAMILY,
  ZWJ_RAINBOW,
  FLAG_DE,
  "é",
] as const;
const WS_RUN_UNITS = [" ", "\n", "\t", " ", "\r\n", "\n\n", " \n"] as const;

const PROFILES = ["ascii", "german", "emoji", "astral", "fence", "newlines", "mixed"] as const;
type Profile = (typeof PROFILES)[number];
const SIMPLE_PROFILES = PROFILES.filter((p) => p !== "mixed");

function word(rng: Rng, extra: readonly string[] = []): string {
  const n = range(rng, 1, 12);
  let w = "";
  for (let k = 0; k < n; k++) w += extra.length > 0 && rng() < 0.3 ? pick(rng, extra) : LETTERS.charAt(int(rng, 26));
  return w;
}

function piece(rng: Rng, profile: Profile): string {
  switch (profile) {
    case "ascii":
      return word(rng) + pick(rng, SPACES);
    case "german":
      return (rng() < 0.2 ? word(rng, COMBINING) : word(rng, UMLAUTS)) + pick(rng, SPACES);
    case "emoji":
      return rng() < 0.7 ? pick(rng, EMOJI) : `${word(rng)} `;
    case "astral":
      return rng() < 0.7 ? pick(rng, ASTRAL) : `${word(rng)} `;
    case "fence": {
      const r = rng();
      if (r < 0.2) return `\`\`\`${rng() < 0.5 ? "ts" : ""}\n`;
      if (r < 0.35) return "```\n";
      return `${word(rng)} ${word(rng)}\n`;
    }
    case "newlines":
      return word(rng) + pick(rng, NEWLINES);
    case "mixed":
      return piece(rng, pick(rng, SIMPLE_PROFILES));
  }
}

/** Exactly `target` UTF-16 code units: whole pieces while they fit, then ASCII letters as padding. */
function buildExact(rng: Rng, profile: Profile, target: number): string {
  let out = "";
  let misses = 0;
  while (out.length < target && misses < 8) {
    const p = piece(rng, profile);
    if (out.length + p.length <= target) {
      out += p;
      misses = 0;
    } else misses++;
  }
  while (out.length < target) out += LETTERS.charAt(int(rng, 26));
  return out;
}

/** One unbroken word (no space anywhere inside) that is at least LIMIT - 1 code units long. */
function longWord(rng: Rng): string {
  const unit = pick(rng, LONG_UNITS);
  const target = range(rng, LIMIT - 1, 3 * LIMIT);
  const body = unit.repeat(Math.ceil(target / unit.length));
  const lead = rng() < 0.5 ? `${word(rng)} ` : "";
  const tail = rng() < 0.3 ? ` ${word(rng)}` : "";
  return lead + body + tail;
}

/** Ordinary text with one long whitespace run (start, middle or end), so whole chunks become whitespace-only. */
function withWhitespaceRun(rng: Rng, profile: Profile): string {
  const target = range(rng, LIMIT, Math.floor(2.5 * LIMIT));
  const pieces: string[] = [];
  let len = 0;
  while (len < target) {
    const p = piece(rng, profile);
    pieces.push(p);
    len += p.length;
  }
  const runLen = pick(rng, [range(rng, 2040, 2060), range(rng, 4094, 4098), range(rng, 5000, 9000)]);
  const unit = pick(rng, WS_RUN_UNITS);
  pieces.splice(int(rng, pieces.length + 1), 0, unit.repeat(Math.ceil(runLen / unit.length)));
  return pieces.join("");
}

/** A pure function of (seed, index): this is the replay entry point named in every failure message. */
function generateInput(seed: number, index: number): string {
  const rng = mulberry32((seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const profile = pick(rng, PROFILES);
  switch (index % 8) {
    case 0:
      return buildExact(rng, profile, LIMIT - 1);
    case 1:
      return buildExact(rng, profile, LIMIT);
    case 2:
      return buildExact(rng, profile, LIMIT + 1);
    case 3:
      return buildExact(rng, profile, int(rng, 301));
    case 4:
      return buildExact(rng, profile, range(rng, LIMIT - 60, LIMIT + 60));
    case 5:
      return buildExact(rng, profile, range(rng, 2 * LIMIT - 30, 3 * LIMIT + 30));
    case 6:
      return longWord(rng);
    default:
      return withWhitespaceRun(rng, profile);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The corpus: hand-picked hard cases first (fixed indices), then GENERATED pseudo-random inputs.

const x = (n: number): string => "x".repeat(n);

const HAND_PICKED: ReadonlyArray<{ label: string; text: string }> = [
  { label: "empty", text: "" },
  { label: "single space", text: " " },
  { label: "whitespace only, mixed", text: "  \n " },
  { label: "whitespace only, limit long", text: " ".repeat(LIMIT) },
  { label: "whitespace only, CRLF, 2x limit", text: "\r\n".repeat(LIMIT) },
  { label: "one char", text: "a" },
  { label: "long word, limit-1", text: x(LIMIT - 1) },
  { label: "long word, limit", text: x(LIMIT) },
  { label: "long word, limit+1", text: x(LIMIT + 1) },
  { label: "long word, 2x limit", text: x(2 * LIMIT) },
  { label: "long word, 2x limit+1", text: x(2 * LIMIT + 1) },
  { label: "words, exactly limit", text: "a ".repeat(LIMIT / 2) },
  { label: "words, limit+1", text: `${"a ".repeat(LIMIT / 2)}b` },
  { label: "CR|LF straddles the limit", text: `${x(LIMIT - 1)}\r\ny` },
  { label: "surrogate pair straddles the limit", text: `a${"\u{1F600}".repeat(LIMIT / 2)}` },
  { label: "astral run, no spaces", text: "\u{2070E}".repeat(2500) },
  { label: "ZWJ family run", text: ZWJ_FAMILY.repeat(400) },
  { label: "ZWJ family run, shifted by one", text: `a${ZWJ_FAMILY.repeat(400)}` },
  { label: "flag run, shifted by one", text: `a${FLAG_DE.repeat(1100)}` },
  { label: "combining mark straddles the limit", text: `x${"é".repeat(2100)}` },
  { label: "NFC umlauts, no spaces", text: "äöüß".repeat(1200) },
  { label: "umlaut words", text: "größe überprüfung ".repeat(300) },
  { label: "paragraph break in second half", text: `${"a".repeat(3000)}\n\n${"b".repeat(3000)}` },
  { label: "newline in second half", text: `${"a".repeat(3000)}\n${"b".repeat(3000)}` },
  { label: "space in second half", text: `${"a".repeat(3000)} ${"b".repeat(3000)}` },
  { label: "only break is in the first half", text: `${"a".repeat(100)}\n\n${"b".repeat(5000)}` },
  {
    label: "paragraph break beats later newline and space",
    text: `${"a".repeat(3000)}\n\n${"b".repeat(500)}\n${"c".repeat(500)} ${"d".repeat(3000)}`,
  },
  { label: "LF lines", text: "line\n".repeat(1000) },
  { label: "CRLF lines", text: "line\r\n".repeat(1000) },
  { label: "CR run then letter", text: `${"\r".repeat(5000)}a` },
  { label: "open fence across parts", text: `\`\`\`ts\n${"const a = 1;\n".repeat(500)}\`\`\`\n` },
  { label: "closed fences", text: "```\ncode\n```\n".repeat(500) },
  { label: "fence marker torn at the limit", text: `${x(LIMIT - 2)}\`\`\`${"y".repeat(10)}` },
  { label: "backtick run", text: "`".repeat(5000) },
  { label: "whitespace chunk dropped in the middle", text: `${"a".repeat(LIMIT)}${" ".repeat(LIMIT)}b` },
  { label: "whitespace chunk dropped at the start", text: `${" ".repeat(LIMIT)}${"b".repeat(10)}` },
  { label: "trailing whitespace dropped", text: `${"a".repeat(10)}${" ".repeat(5000)}` },
  { label: "no-break spaces then letter", text: `${" ".repeat(LIMIT)}x` },
  { label: "markdown and html specials", text: "_*[]()~`>#+-=|{}.!\\&<>".repeat(400) },
];

interface Case {
  index: number;
  label: string;
  text: string;
}

const CORPUS: readonly Case[] = [
  ...HAND_PICKED.map((h, index) => ({ index, label: h.label, text: h.text })),
  ...Array.from({ length: GENERATED }, (_, g) => {
    const index = HAND_PICKED.length + g;
    return { index, label: "generated", text: generateInput(SEED, index) };
  }),
];

// ---------------------------------------------------------------------------------------------------------------------
// Assertion helper: every failure names seed and index, plus the case label, length and head of the input.

function must(c: Case, ok: boolean, detail: () => string): void {
  if (ok) return;
  assert.fail(
    `seed=${SEED} index=${c.index} case=${c.label} len=${c.text.length} head=${JSON.stringify(c.text.slice(0, 24))}: ${detail()}`,
  );
}

const hasContent = (s: string): boolean => s.trim().length > 0;
const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

interface Alignment {
  /** Offset in the original text where each part starts / ends. */
  starts: number[];
  ends: number[];
}

/**
 * The exact losslessness rule, as a walk over the original: the parts, in order, are verbatim slices of the text;
 * whatever lies between two parts, before the first part or after the last one is whitespace only (by
 * String.prototype.trim). A gap before or between parts is made of whole non-final chunks, and the splitter never
 * makes a non-final chunk shorter than floor(max / 2) (its break search starts at that index), so such a gap is at
 * least that long. Only the trailing gap can be shorter, because the last chunk may have any length.
 */
function align(c: Case, parts: readonly string[], max: number): Alignment {
  const text = c.text;
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;
  parts.forEach((part, k) => {
    const at = text.indexOf(part, cursor);
    must(c, at >= 0, () => `max=${max}: part ${k} (len ${part.length}) is not a verbatim slice at or after offset ${cursor}`);
    const gap = text.slice(cursor, at);
    must(c, !hasContent(gap), () => `max=${max}: text dropped before part ${k} is not whitespace-only: ${JSON.stringify(gap.slice(0, 20))}`);
    must(
      c,
      gap.length === 0 || gap.length >= Math.floor(max / 2),
      () => `max=${max}: dropped gap before part ${k} has length ${gap.length}, shorter than a whole chunk (${Math.floor(max / 2)})`,
    );
    starts.push(at);
    ends.push(at + part.length);
    cursor = at + part.length;
  });
  const trailing = text.slice(cursor);
  must(c, !hasContent(trailing), () => `max=${max}: text after the last part is not whitespace-only: ${JSON.stringify(trailing.slice(0, 20))}`);
  return { starts, ends };
}

// ---------------------------------------------------------------------------------------------------------------------
// Corpus guard: the corpus is deterministic and covers what the task asks for.

function fnv1a(h: number, s: string): number {
  let acc = h;
  for (let k = 0; k < s.length; k++) {
    acc ^= s.charCodeAt(k);
    acc = Math.imul(acc, 16777619) >>> 0;
  }
  return acc >>> 0;
}

test("corpus: deterministic, at least 500 generated inputs, covers every required class", () => {
  const generated = CORPUS.filter((c) => c.label === "generated");
  assert.ok(generated.length >= 500, `only ${generated.length} generated inputs`);
  let hash = 2166136261;
  let total = 0;
  for (const c of CORPUS) {
    hash = fnv1a(hash, `${c.text.length}:`);
    hash = fnv1a(hash, c.text);
    total += c.text.length;
  }
  // A change here means the generator or the hand-picked list changed: update both numbers on purpose, not by accident.
  assert.equal(CORPUS.length, HAND_PICKED.length + GENERATED);
  assert.deepEqual({ hash, total }, { hash: 2734908569, total: 3757940 }, `seed=${SEED} corpus fingerprint changed`);
  const count = (re: RegExp): number => generated.filter((c) => re.test(c.text)).length;
  const lengths = (n: number): number => generated.filter((c) => c.text.length === n).length;
  for (const [name, n] of [
    ["ZWJ sequences", count(/‍/)],
    ["astral characters", count(/[\u{10000}-\u{10FFFF}]/u)],
    ["regional-indicator flags", count(/[\u{1F1E6}-\u{1F1FF}]/u)],
    ["umlauts", count(/[äöüß]/)],
    ["decomposed accents", count(/[̀-ͯ]/)],
    ["``` fences", count(/```/)],
    ["CRLF", count(/\r\n/)],
    ["bare LF", count(/(?<!\r)\n/)],
    ["unbroken words longer than the limit", count(new RegExp(`\\S{${LIMIT + 1},}`, "u"))],
    ["long whitespace runs", count(new RegExp(`\\s{${LIMIT / 2},}`))],
    [`length ${LIMIT - 1}`, lengths(LIMIT - 1)],
    [`length ${LIMIT}`, lengths(LIMIT)],
    [`length ${LIMIT + 1}`, lengths(LIMIT + 1)],
  ] as const)
    assert.ok(n >= 20, `corpus covers too little: ${name} in only ${n} generated inputs`);
  for (const c of CORPUS) must(c, !LONE_SURROGATE.test(c.text), () => "the input itself must be well-formed UTF-16");
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 1: every part is within the platform limit.

test("property 0: the limit constant is Telegram's published 4096 (docs/channels/telegram.md names no number)", () => {
  assert.equal(TELEGRAM_MAX_TEXT, 4096);
});

test("property 1: every part is within the limit; text that fits is returned whole", () => {
  for (const c of CORPUS) {
    const parts = splitMessage(c.text);
    parts.forEach((p, k) => {
      must(c, p.length <= LIMIT, () => `part ${k} has ${p.length} code units, limit is ${LIMIT}`);
      must(c, hasContent(p), () => `part ${k} is whitespace-only`);
    });
    if (c.text.length <= LIMIT)
      must(
        c,
        parts.length === (hasContent(c.text) ? 1 : 0) && (parts.length === 0 || parts[0] === c.text),
        () => `text within the limit was split or altered: ${parts.length} parts`,
      );
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 2: joining the parts gives the text back, except for dropped whitespace-only chunks.

test("property 2: parts are verbatim, contiguous slices; only whitespace-only chunks are ever dropped", () => {
  for (const c of CORPUS) {
    const parts = splitMessage(c.text);
    align(c, parts, LIMIT);
    // Text without any whitespace has no droppable chunk, so it must round-trip exactly.
    if (!/\s/.test(c.text)) must(c, parts.join("") === c.text, () => "text without whitespace did not round-trip");
    // Text without a whitespace run of at least half the limit has no droppable chunk except a trailing one.
    if (!new RegExp(`\\s{${LIMIT / 2},}`).test(c.text)) {
      const tail = c.text.slice(parts.join("").length);
      must(c, c.text.startsWith(parts.join("")), () => "without a long whitespace run, only trailing text may be missing");
      must(c, !hasContent(tail), () => "the trailing remainder must be whitespace-only");
    }
  }
});

test("property 2 pinned: the separator stays at the end of the left part, nothing is trimmed, whitespace chunks vanish", () => {
  const a = "a".repeat(3000);
  const b = "b".repeat(3000);
  assert.deepEqual(splitMessage(`${a}\n\n${b}`), [`${a}\n\n`, b]);
  assert.deepEqual(splitMessage(`${a}\n${b}`), [`${a}\n`, b]);
  assert.deepEqual(splitMessage(`${a} ${b}`), [`${a} `, b]);
  // A paragraph break wins over a later newline or space inside the same window.
  const mixed = `${a}\n\n${"b".repeat(500)}\n${"c".repeat(500)} ${"d".repeat(3000)}`;
  assert.deepEqual(splitMessage(mixed), [`${a}\n\n`, mixed.slice(3002)]);
  // A break in the first half of the window is ignored: hard cut at the limit.
  const early = `${"a".repeat(100)}\n\n${"b".repeat(5000)}`;
  assert.deepEqual(splitMessage(early), [early.slice(0, LIMIT), early.slice(LIMIT)]);
  // No trimming inside a part, and no padding.
  assert.deepEqual(splitMessage("  a  "), ["  a  "]);
  assert.deepEqual(splitMessage("\n\na\n\n"), ["\n\na\n\n"]);
  // Whole whitespace-only chunks vanish: in the middle, at the start and at the end.
  assert.deepEqual(splitMessage(`${"a".repeat(LIMIT)}${" ".repeat(LIMIT)}b`), ["a".repeat(LIMIT), "b"]);
  assert.deepEqual(splitMessage(`${" ".repeat(LIMIT)}${"b".repeat(10)}`), ["b".repeat(10)]);
  assert.deepEqual(splitMessage(`${"a".repeat(10)}${" ".repeat(5000)}`), [`${"a".repeat(10)}${" ".repeat(LIMIT - 10)}`]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 3: no surrogate pair and no grapheme cluster is split.

function boundaries(c: Case, parts: readonly string[], max: number): number[] {
  const { starts, ends } = align(c, parts, max);
  return [...new Set([...starts, ...ends])];
}

function checkSurrogates(c: Case, parts: readonly string[], max: number): void {
  parts.forEach((p, k) => must(c, !LONE_SURROGATE.test(p), () => `max=${max}: part ${k} contains a lone surrogate`));
  for (const b of boundaries(c, parts, max))
    must(
      c,
      !(b > 0 && b < c.text.length && isHigh(c.text.charCodeAt(b - 1)) && isLow(c.text.charCodeAt(b))),
      () => `max=${max}: boundary at offset ${b} splits a surrogate pair`,
    );
}

test("property 3a: no surrogate pair is split at a part boundary", () => {
  for (const c of CORPUS) checkSurrogates(c, splitMessage(c.text), LIMIT);
});

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function clusterStarts(text: string): Set<number> {
  const set = new Set<number>([text.length]);
  for (const s of segmenter.segment(text)) set.add(s.index);
  return set;
}

const hex = (s: string): string => [...s].map((ch) => `U+${(ch.codePointAt(0) as number).toString(16).toUpperCase()}`).join(" ");

test("property 3b: every part boundary falls on a grapheme boundary of the original", () => {
  let bad = 0;
  const firstOf: { hand?: string; generated?: string } = {};
  let firstCase: Case | undefined;
  for (const c of CORPUS) {
    const ok = clusterStarts(c.text);
    const parts = splitMessage(c.text);
    const hit = boundaries(c, parts, LIMIT).find((b) => !ok.has(b));
    if (hit === undefined) continue;
    bad++;
    const inside = segmenter.segment(c.text).containing(hit);
    const where = inside ? `${hex(inside.segment)} (offset ${inside.index}, ${inside.segment.length} code units)` : "(unknown)";
    const what = `index=${c.index} case=${c.label}: boundary at offset ${hit} lies inside the cluster ${where}`;
    firstCase ??= c;
    if (c.label === "generated") firstOf.generated ??= what;
    else firstOf.hand ??= what;
  }
  if (firstCase !== undefined)
    must(
      firstCase,
      false,
      () => `${bad} of ${CORPUS.length} inputs cut inside a grapheme cluster; first hand-picked: ${firstOf.hand ?? "none"}; first generated: ${firstOf.generated ?? "none"}`,
    );
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 4: fenced code blocks.
//
// splitMessage has no fence logic: it neither closes an open ``` fence at the end of a part nor reopens it at the start
// of the next one, and it can even cut through the three backticks. The reopening described in docs/channels/telegram.md
// (line 93, "long code blocks reopen independently") is done by rebasing `pre` entities in channel.ts, not by this
// function; with parseMode the fence text stays literal. So the rule pinned here is "fence-agnostic and verbatim".

const FENCE = "```";
const fences = (s: string): number => s.split(FENCE).length - 1;

test("property 4: fences are neither closed nor reopened; cut points ignore backticks", () => {
  let openSplits = 0;
  for (const c of CORPUS) {
    const parts = splitMessage(c.text);
    const { starts, ends } = align(c, parts, LIMIT);
    // Fence-agnostic: the same text with every backtick replaced by a plain letter is cut at the same places.
    const neutral = splitMessage(c.text.replaceAll("`", "q"));
    must(
      c,
      JSON.stringify(neutral.map((p) => p.length)) === JSON.stringify(parts.map((p) => p.length)),
      () => "cut points depend on backticks",
    );
    parts.forEach((p, k) => {
      if (k === parts.length - 1 || fences(p) % 2 === 0) return;
      openSplits++;
      // The part stays open (no closing fence appended) and the next part starts with the original text, no reopening.
      must(c, !p.endsWith(FENCE) || c.text.startsWith(FENCE, (ends[k] as number) - FENCE.length), () => `part ${k} got a closing fence that is not in the text`);
      must(c, !(parts[k + 1] as string).startsWith(FENCE) || c.text.startsWith(FENCE, starts[k + 1] as number), () => `part ${k + 1} got a reopening fence that is not in the text`);
    });
  }
  // The loop must have met splits inside open fences, otherwise it proves nothing.
  assert.ok(openSplits >= 20, `seed=${SEED}: only ${openSplits} splits inside an open fence in the corpus`);
});

test("property 4 pinned: an open fence stays open in part 1 and part 2 starts with plain text", () => {
  const text = `\`\`\`ts\n${"const a = 1;\n".repeat(500)}\`\`\`\n`;
  const parts = splitMessage(text);
  assert.equal(parts.length, 2);
  assert.equal(parts.join(""), text);
  assert.equal(fences(parts[0] as string), 1); // odd: the fence is still open at the end of part 1
  assert.ok(!(parts[0] as string).endsWith(FENCE));
  assert.ok(!(parts[1] as string).startsWith(FENCE)); // and it is not reopened
  assert.equal(fences(parts[1] as string), 1); // the closing fence is the only one in part 2

  // A hard cut can tear the marker itself: neither part holds a complete fence.
  const torn = splitMessage(`${x(LIMIT - 2)}\`\`\`${"y".repeat(10)}`);
  assert.deepEqual(torn, [`${x(LIMIT - 2)}\`\``, `\`${"y".repeat(10)}`]);
  assert.deepEqual(torn.map(fences), [0, 0]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 5: empty input.

test("property 5: empty and whitespace-only input give an empty array, never an empty string", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("", 2), []);
  for (const ws of [" ", "\n", "\r\n", "  \n ", "\t", " ", " ", "﻿", " ".repeat(LIMIT + 1)])
    assert.deepEqual(splitMessage(ws), [], `whitespace-only ${JSON.stringify(ws.slice(0, 8))}`);
  for (const c of CORPUS)
    if (!hasContent(c.text)) must(c, JSON.stringify(splitMessage(c.text)) === "[]", () => "whitespace-only input must give []");
});

// ---------------------------------------------------------------------------------------------------------------------
// Extra: the same invariants at small explicit limits, where cuts land on surrogate pairs and separators far more often.

const SMALL_LIMITS = [2, 3, 5, 8, 17, 64, 257] as const;

test("properties 1, 2 and 3a also hold at small explicit limits", () => {
  for (const c of CORPUS) {
    const limits: readonly number[] = c.text.length <= 1500 ? SMALL_LIMITS : [1001, 1777];
    for (const max of limits) {
      const parts = splitMessage(c.text, max);
      parts.forEach((p, k) => {
        must(c, p.length <= max, () => `max=${max}: part ${k} has ${p.length} code units`);
        must(c, hasContent(p), () => `max=${max}: part ${k} is whitespace-only`);
      });
      if (c.text.length <= max)
        must(c, JSON.stringify(parts) === JSON.stringify(hasContent(c.text) ? [c.text] : []), () => `max=${max}: text that fits was split or altered`);
      checkSurrogates(c, parts, max);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Extra: escaping happens per part, after splitting. Escaping is context-free, so no escape pair or entity can be torn.
// The limit applies to the unescaped chunk (Telegram counts the text after parsing), so escaped output may be longer.

const MD_RESERVED = "_*[]()~`>#+-=|{}.!\\";

function unescapeMarkdownV2(s: string): string | undefined {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch === "\\") {
      if (i + 1 >= s.length || !MD_RESERVED.includes(s.charAt(i + 1))) return undefined; // dangling or invalid escape
      out += s.charAt(++i);
    } else if (MD_RESERVED.includes(ch)) return undefined; // a reserved character that is not escaped
    else out += ch;
  }
  return out;
}

function unescapeHtml(s: string): string | undefined {
  if (/[<>]/.test(s)) return undefined;
  const decoded = s.replace(/&(amp|lt|gt);/g, (_m, name: string) => (name === "amp" ? "&" : name === "lt" ? "<" : ">"));
  return /&(?!(?:amp|lt|gt);)/.test(s) ? undefined : decoded;
}

test("escaping each part gives valid, reversible, tear-free output that equals escaping the joined text", () => {
  for (const c of CORPUS) {
    const parts = splitMessage(c.text);
    for (const part of parts) {
      must(c, unescapeMarkdownV2(escapeText(part, "MarkdownV2")) === part, () => "MarkdownV2 escape is not reversible or leaves a bare reserved character");
      must(c, unescapeHtml(escapeText(part, "HTML")) === part, () => "HTML escape is not reversible or leaves a raw <, > or &");
    }
    for (const mode of ["MarkdownV2", "HTML"] as const)
      must(
        c,
        parts.map((p) => escapeText(p, mode)).join("") === escapeText(parts.join(""), mode),
        () => `${mode}: escaping per part differs from escaping the joined parts`,
      );
  }
});

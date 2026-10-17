// Property test for splitMessage (src/split.ts), deterministic: one fixed seed, a local mulberry32 PRNG, no timers,
// no network, no dependency.
//
// Every failure message carries `seed=<n> index=<i>`. Case i is reproducible on its own: it is built from a PRNG seeded
// with (SEED, i), so `buildCases()[i]` replays it without running the cases before it.
//
// What the code does (src/split.ts) and what this file pins:
//  * Limit: SLACK_MAX_TEXT = 3500 by default; the unit is UTF-16 code units (`String.length`), not code points and not
//    bytes. Doc: docs/channels/slack.md line 156 ("Long text is split at 3500 characters (buttons: 2900 per section)")
//    and line 179 ("must fit in one Slack message (3500 characters)"). Code and docs agree. The caller may pass a
//    smaller or larger `max` (>= 16, integer); the part limit is then that `max`.
//  * Part = [reopen prefix "```\n"] + body + [closer "\n```"]. The splitter never trims at a boundary: it cuts right
//    after a "\n\n", "\n" or " " (the separator stays at the end of the earlier part) or hard at the limit.
//  * Removed from the input, exactly: (a) whole chunks that are whitespace-only (they are dropped), and (b) one "\n"
//    at the end of a body that gets a closer (the closer's own "\n" takes its place).
//  * Added to the input, exactly: "\n```" at the end of a part whose body leaves a fence open, and "```\n" at the start
//    of the next part. The last part is never closed, so an unterminated fence in the input stays unterminated.
//  * A fence line is a line (split on "\n") that starts with three backticks in column 0. Indented or inline "```" does
//    not count. That is the code's own definition (FENCE_LINE) and is what property 4 uses.
//  * Surrogate pairs are never split (documented). Extended grapheme clusters (ZWJ sequences, flags, combining marks,
//    CRLF) are kept whole too (property 3b).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SLACK_MAX_TEXT, SLACK_SECTION_MAX, splitMessage } from "../src/index.ts";

const SEED = 20261012;

// ---------------------------------------------------------------- PRNG and helpers

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

function caseRng(index: number): Rng {
  return mulberry32((SEED + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

const int = (rng: Rng, n: number): number => Math.floor(rng() * n);
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[int(rng, xs.length)]!;

// ---------------------------------------------------------------- fragment pools

const ASCII_WORDS = ["alpha", "beta", "gamma", "delta", "x", "ok", "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "Hello,", "world.", "a1b2", "foo_bar", "path/to/file.ts", "key=value"];
const UMLAUT_WORDS = ["\u00e4\u00f6\u00fc\u00df", "Gr\u00f6\u00dfe", "\u00dcbergr\u00f6\u00dfentr\u00e4ger", "\u00c4\u00d6\u00dc", "Stra\u00dfe", "sch\u00f6n"];
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
const FLAG_DE = "\u{1F1E9}\u{1F1EA}";
const CLUSTERS = [
  FAMILY,
  "\u{1F469}\u200D\u{1F4BB}", // woman technologist
  "\u{1F3F3}\uFE0F\u200D\u{1F308}", // rainbow flag
  "\u{1F3F4}\u200D\u2620\uFE0F", // pirate flag
  FLAG_DE,
  "\u{1F1FA}\u{1F1F8}", // US flag
  "\u{1F1EB}\u{1F1F7}", // FR flag
  "\u{1F44D}\u{1F3FD}", // thumbs up, skin tone
  "1\uFE0F\u20E3", // keycap
  "\u2764\uFE0F", // red heart with variation selector
  "\u{1F9D1}\u{1F3FD}\u200D\u{1F680}", // astronaut with skin tone
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // tag-sequence flag
];
const ASTRALS = ["\u{1F600}", "\u{1D4B3}", "\u{2070E}", "\u{10348}", "\u{1F680}"];
const COMBINING = ["e\u0301", "a\u0308", "n\u0303", "c\u0327"];
const NEWLINES = ["\n", "\n\n", "\r\n", "\r\n\r\n"];
const BLANKS = [" ", "  ", "\t", "\n", "\r\n", "\u00a0", "\u2003"];
const TOKENS = ["<https://example.test/a|label>", "<@U01>", "<!here>", "<#C01|general>", "a<b", "x>y", "<", ">", "<>", "<<a>>"];

function fenceBlock(rng: Rng): string {
  const nl = pick(rng, ["\n", "\r\n"]);
  const lang = pick(rng, ["", "ts", "json", "sh"]);
  const lines = Array.from({ length: 1 + int(rng, 12) }, () => `${pick(rng, ASCII_WORDS)} ${pick(rng, ASCII_WORDS)} ${"c".repeat(int(rng, 30))}`);
  const closed = rng() < 0.75;
  return "```" + lang + nl + lines.join(nl) + (closed ? nl + "```" : "") + nl;
}

function longWord(rng: Rng, limit: number): string {
  const target = limit + 1 + int(rng, limit);
  const unit = pick(rng, ["ascii", "family", "flag", "astral", "umlaut", "combining", "mixed"]);
  let s = "";
  while (s.length < target) {
    if (unit === "ascii") s += String.fromCharCode(97 + int(rng, 26));
    else if (unit === "family") s += FAMILY;
    else if (unit === "flag") s += FLAG_DE;
    else if (unit === "astral") s += pick(rng, ASTRALS);
    else if (unit === "umlaut") s += pick(rng, UMLAUT_WORDS);
    else if (unit === "combining") s += pick(rng, COMBINING);
    else s += pick(rng, [...CLUSTERS, ...ASTRALS, ...COMBINING, "ab", "\u00e4"]);
  }
  return s;
}

const MODES = ["prose", "unicode", "fenced", "longword", "newlines", "tokens", "blank", "chaos"] as const;
type Mode = (typeof MODES)[number];

function fragment(rng: Rng, mode: Mode, limit: number): string {
  switch (mode) {
    case "prose": {
      const r = rng();
      if (r < 0.12) return pick(rng, NEWLINES);
      if (r < 0.2) return pick(rng, UMLAUT_WORDS) + " ";
      return pick(rng, ASCII_WORDS) + (rng() < 0.9 ? " " : ". ");
    }
    case "unicode": {
      const pool = pick(rng, [CLUSTERS, ASTRALS, COMBINING, UMLAUT_WORDS, ASCII_WORDS]);
      return pick(rng, pool) + (rng() < 0.7 ? " " : "");
    }
    case "fenced":
      return rng() < 0.5 ? pick(rng, ASCII_WORDS) + " " + pick(rng, ASCII_WORDS) + pick(rng, NEWLINES) : fenceBlock(rng);
    case "longword":
      return longWord(rng, limit) + (rng() < 0.5 ? " " : pick(rng, NEWLINES));
    case "newlines":
      return pick(rng, ASCII_WORDS) + pick(rng, NEWLINES);
    case "tokens":
      return pick(rng, TOKENS) + (rng() < 0.6 ? " " : "") + pick(rng, ASCII_WORDS) + " ";
    case "blank":
      return pick(rng, BLANKS);
    case "chaos":
      return pick(rng, [...CLUSTERS, ...ASTRALS, ...COMBINING, ...UMLAUT_WORDS, ...ASCII_WORDS, ...NEWLINES, ...TOKENS, "```", "```\n", "\n```\n", " ", "`", "``"]);
  }
}

// ---------------------------------------------------------------- cases

interface Case {
  index: number;
  kind: string;
  text: string;
  /** Effective limit (what the part length is checked against). */
  limit: number;
  /** True: call `splitMessage(text)` without a second argument (the documented default, 3500). */
  useDefault: boolean;
}

const LIMITS = [16, 17, 20, 24, 31, 32, 40, 64, 100, 200, 500, SLACK_SECTION_MAX, SLACK_MAX_TEXT];

type HandCase = [kind: string, text: string, max: number | undefined];

const LINES_30 = Array.from({ length: 30 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
const HAND_PICKED: HandCase[] = [
  ["empty", "", undefined],
  ["space", " ", undefined],
  ["newline", "\n", undefined],
  ["crlf", "\r\n", undefined],
  ["whitespace-block", "   \n\n  ", undefined],
  ["whitespace-longer-than-limit", " \n".repeat(40), 16],
  ["hello", "hello", undefined],
  ["limit-1-ascii", "a".repeat(SLACK_MAX_TEXT - 1), undefined],
  ["limit-ascii", "a".repeat(SLACK_MAX_TEXT), undefined],
  ["limit+1-ascii", "a".repeat(SLACK_MAX_TEXT + 1), undefined],
  ["limit+1-words", "word ".repeat(701).slice(0, SLACK_MAX_TEXT + 1), undefined],
  ["long-word-2x-limit", "x".repeat(2 * SLACK_MAX_TEXT), undefined],
  ["long-word-limit+1-max16", "x".repeat(17), 16],
  ["paragraphs-default", `${"p".repeat(2000)}\n\n${"p".repeat(2000)}\n\n${"p".repeat(2000)}`, undefined],
  ["astral-run-max16", "a".repeat(9) + "\u{1F600}".repeat(20), 16],
  ["astral-pair-straddles-room", "a".repeat(11) + "\u{1F600}".repeat(10), 16],
  ["astral-code-points-below-limit", "\u{1F600}".repeat(SLACK_MAX_TEXT / 2 + 1), undefined],
  ["bytes-not-counted", "\u00e4".repeat(SLACK_MAX_TEXT), undefined],
  ["family-zwj-run-max16", FAMILY.repeat(40), 16],
  ["family-zwj-run-default", FAMILY.repeat(400), undefined],
  ["flags-aligned", FLAG_DE.repeat(30), 16],
  ["flags-offset-by-one", "a" + FLAG_DE.repeat(30), 16],
  ["keycap-and-heart", "1\uFE0F\u20E3\u2764\uFE0F".repeat(20), 16],
  ["combining-marks-offset", "x" + "e\u0301".repeat(40), 16],
  ["umlauts-long-word", "\u00e4\u00f6\u00fc\u00df".repeat(30), 16],
  ["crlf-straddles-room", "a".repeat(11) + "\r\n" + "b".repeat(30), 16],
  ["crlf-paragraphs", "para one is here\r\n\r\npara two is here\r\n\r\npara three is here\r\n\r\npara four", 40],
  ["lf-paragraphs", "para one is here\n\npara two is here\n\npara three is here\n\npara four", 40],
  ["fence-spans-chunks-lf", "```\n" + LINES_30.join("\n") + "\n```", 200],
  ["fence-spans-chunks-lang", "```ts\n" + LINES_30.join("\n") + "\n```\nafter the block", 200],
  ["fence-spans-chunks-crlf", "```\r\n" + LINES_30.join("\r\n") + "\r\n```", 200],
  ["fence-unterminated", "intro\n```\n" + LINES_30.join("\n"), 100],
  ["fence-body-ends-with-newline", "```\n" + "line\n".repeat(60), 64],
  ["fence-empty-block", "```\n```", 16],
  ["fence-inline-triple-backticks", "say ```inline``` then text ".repeat(10), 40],
  ["fence-indented-not-a-fence", "  ```\n" + "abc def ".repeat(20) + "\n  ```", 40],
  ["two-fenced-blocks", "```\naaa bbb ccc\n```\nmiddle prose here\n```\nddd eee fff ggg hhh\n```", 24],
  ["fence-exactly-limit", "```\n" + "c".repeat(SLACK_MAX_TEXT - 8) + "\n```", undefined],
  ["fence-limit+1", "```\n" + "c".repeat(SLACK_MAX_TEXT - 7) + "\n```", undefined],
  ["angle-token-straddles", "w".repeat(20) + " <https://example.test/" + "x".repeat(10) + "|label> " + "z".repeat(20), 50],
  ["angle-token-longer-than-room", "<" + "x".repeat(100) + ">", 20],
  ["angle-lone-lt-gt", "a < b and c > d ".repeat(10), 20],
  ["min-limit-words", "abcdefghij ".repeat(30), 16],
  ["trailing-whitespace-chunk", "x".repeat(40) + " ".repeat(40), 16],
  ["leading-whitespace-chunk", " ".repeat(40) + "x".repeat(40), 16],
  ["whitespace-run-then-word", " ".repeat(5000) + "b", 16],
];

const FILLERS: Record<string, (rng: Rng) => () => string> = {
  words: (rng) => () => pick(rng, ASCII_WORDS) + " ",
  longword: () => () => "x",
  zwj: (rng) => () => pick(rng, CLUSTERS),
  lines: (rng) => () => pick(rng, ASCII_WORDS) + pick(rng, ["\n", "\r\n", " "]),
  fence: (rng) => {
    let first = true;
    return () => {
      const f = first ? "```\n" : pick(rng, ASCII_WORDS) + "\n";
      first = false;
      return f;
    };
  },
};

/** Exactly `n` UTF-16 units: whole fragments while they fit, padded with ASCII "a". */
function exactLength(next: () => string, n: number): string {
  let s = "";
  for (;;) {
    const f = next();
    if (s.length + f.length > n) break;
    s += f;
  }
  return s + "a".repeat(n - s.length);
}

function buildCases(): Case[] {
  const cases: Case[] = [];
  for (const [kind, text, max] of HAND_PICKED) {
    cases.push({ index: cases.length, kind: `hand:${kind}`, text, limit: max ?? SLACK_MAX_TEXT, useDefault: max === undefined });
  }
  for (const limit of LIMITS) {
    for (const delta of [-1, 0, 1]) {
      for (const [name, make] of Object.entries(FILLERS)) {
        const index = cases.length;
        const text = exactLength(make(caseRng(index)), limit + delta);
        cases.push({ index, kind: `edge:${name}:${delta > 0 ? "+" : ""}${delta}`, text, limit, useDefault: limit === SLACK_MAX_TEXT });
      }
    }
  }
  for (let n = 0; n < 500; n++) {
    const index = cases.length;
    const rng = caseRng(index);
    const limit = pick(rng, LIMITS);
    const useDefault = limit === SLACK_MAX_TEXT && rng() < 0.75;
    const mode = pick(rng, MODES);
    const target = Math.min(12000, Math.max(1, Math.floor(limit * (0.3 + rng() * 3.5))));
    let text = "";
    while (text.length < target) text += fragment(rng, mode, limit);
    cases.push({ index, kind: `random:${mode}`, text, limit, useDefault });
  }
  return cases;
}

const CASES = buildCases();
const GENERATED = CASES.filter((c) => !c.kind.startsWith("hand:"));

// ---------------------------------------------------------------- running and reporting

function show(s: string, n = 56): string {
  const chars = [...s];
  return JSON.stringify(chars.length > n ? chars.slice(0, n).join("") + "..." : s);
}

function fail(c: Case, message: string): never {
  assert.fail(`seed=${SEED} index=${c.index} kind=${c.kind} max=${c.limit} len=${c.text.length} input=${show(c.text)}: ${message}`);
}

const RUNS = new Map<number, string[]>();
function partsOf(c: Case): string[] {
  let parts = RUNS.get(c.index);
  if (!parts) {
    try {
      parts = c.useDefault ? splitMessage(c.text) : splitMessage(c.text, c.limit);
    } catch (error) {
      return fail(c, `splitMessage threw ${String(error)}`);
    }
    RUNS.set(c.index, parts);
  }
  return parts;
}

// ---------------------------------------------------------------- decoding the parts back onto the input

const FENCE_LINE = /^```/;
const REOPEN = "```\n";
const CLOSER = "\n```";

/** Fence state after `body`, starting from `inside` (the code's own rule: lines starting with ``` in column 0). */
function toggles(body: string, inside: boolean): boolean {
  let s = inside;
  for (const line of body.split("\n")) if (FENCE_LINE.test(line)) s = !s;
  return s;
}

interface Piece {
  reopen: boolean;
  closer: boolean;
  /** Body offsets in the original input: text.slice(start, end) is the part's own content. */
  start: number;
  end: number;
}

/**
 * Could `length` whitespace units be whole dropped chunks? Between the chunks the splitter cuts, a non-final chunk is
 * between half the room and the room long (room = limit - 4, the space kept for a closer); only a chunk cut in front of a
 * "<" token and the final chunk can be shorter. This is what makes a trimmed separator (one or two units) different from
 * a dropped chunk, so a splitter that trims at boundaries cannot pass property 2.
 */
function gapAllowed(length: number, limit: number, atEnd: boolean, next: string | undefined): boolean {
  const room = limit - CLOSER.length;
  const min = Math.floor(room / 2);
  const whole = (n: number): boolean => {
    if (n === 0) return true;
    for (let k = 1; k * min <= n; k++) if (n <= k * room) return true;
    return false;
  };
  if (whole(length)) return true;
  if (!atEnd && next !== "<") return false;
  for (let s = 1; s <= Math.min(length, atEnd ? limit : room); s++) if (whole(length - s)) return true;
  return false;
}

/**
 * Finds where each part's own content sits in the original. Allowed edits, nothing else:
 *  - a gap of whitespace between parts (whole dropped whitespace-only chunks, see gapAllowed), also before the first and
 *    after the last part;
 *  - a reopen prefix "```\n" and a closer "\n```" (one "\n" at the end of the body is absorbed by the closer).
 * strict: the wrappers must follow the fence state exactly (reopen iff the previous body left a fence open; closer iff
 * this body leaves one open and the part is not the last; a gap only while no fence is open).
 * lenient: wrappers may appear anywhere (isolates a lossless-join failure from a fence-semantics failure).
 */
function decode(text: string, parts: string[], strict: boolean, limit: number): Piece[] | null {
  const failed = new Set<string>();
  const out: Piece[] = [];
  const go = (i: number, pos: number, inside: boolean): boolean => {
    const key = `${i}:${pos}:${inside}`;
    if (failed.has(key)) return false;
    if (i === parts.length) {
      const tail = text.slice(pos);
      if (tail.trim() === "" && (!strict || !inside || tail === "") && (tail === "" || gapAllowed(tail.length, limit, true, undefined))) return true;
      failed.add(key);
      return false;
    }
    const part = parts[i]!;
    const isLast = i === parts.length - 1;
    let run = 0;
    while (pos + run < text.length && /\s/.test(text[pos + run]!)) run++;
    const maxGap = strict && inside ? 0 : run;
    for (let gap = 0; gap <= maxGap; gap++) {
      const start = pos + gap;
      let verdict: boolean | undefined;
      const gapFine = (): boolean => (verdict ??= gap === 0 || gapAllowed(gap, limit, false, text[start]));
      const reopens = strict ? [inside] : part.startsWith(REOPEN) ? [true, false] : [false];
      for (const reopen of reopens) {
        if (reopen && !part.startsWith(REOPEN)) continue;
        const core = reopen ? part.slice(REOPEN.length) : part;
        // no closer: the core is the body
        if (text.startsWith(core, start) && gapFine()) {
          const after = toggles(core, inside);
          if (!strict || isLast || !after) {
            if (go(i + 1, start + core.length, after)) {
              out.push({ reopen, closer: false, start, end: start + core.length });
              return true;
            }
          }
        }
        // closer: the core ends with "\n```"; the body is the core without it, plus the "\n" the closer absorbed
        if (core.endsWith(CLOSER) && !(strict && isLast)) {
          const bodyCore = core.slice(0, -CLOSER.length);
          for (const absorbed of [false, true]) {
            if (!absorbed && bodyCore.endsWith("\n")) continue; // the code strips exactly one trailing "\n", so one would remain
            const body = absorbed ? bodyCore + "\n" : bodyCore;
            if (!text.startsWith(body, start) || !gapFine()) continue;
            const after = toggles(body, inside);
            if (strict && !after) continue;
            if (go(i + 1, start + body.length, after)) {
              out.push({ reopen, closer: true, start, end: start + body.length });
              return true;
            }
          }
        }
      }
    }
    failed.add(key);
    return false;
  };
  if (!go(0, 0, false)) return null;
  return out.reverse();
}

function located(c: Case): Piece[] {
  const parts = partsOf(c);
  const pieces = decode(c.text, parts, true, c.limit) ?? decode(c.text, parts, false, c.limit);
  if (!pieces) return fail(c, "parts cannot be placed on the input (see property 2)");
  return pieces;
}

function boundariesOf(c: Case): number[] {
  const set = new Set<number>();
  for (const p of located(c)) {
    set.add(p.start);
    set.add(p.end);
  }
  set.delete(0);
  set.delete(c.text.length);
  return [...set].sort((a, b) => a - b);
}

const hex = (s: string): string => [...s].map((ch) => "U+" + ch.codePointAt(0)!.toString(16).toUpperCase()).join(" ");

// ---------------------------------------------------------------- the decoder has teeth

test("decoder self-check: tampered parts are rejected, so the join and fence properties cannot pass vacuously", () => {
  const text = "```\n" + LINES_30.join("\n") + "\n```";
  const parts = splitMessage(text, 200);
  assert.ok(parts.length >= 3);
  assert.ok(decode(text, parts, true, 200), "untouched parts decode strictly");
  const mutate = (i: number, f: (p: string) => string): string[] => parts.map((p, j) => (j === i ? f(p) : p));
  assert.equal(decode(text, mutate(0, (p) => p.slice(0, -5) + "\n```"), false, 200), null, "a lost character is not allowed");
  assert.equal(decode(text, mutate(1, (p) => p + "x"), false, 200), null, "an added character is not allowed");
  assert.equal(decode(text, mutate(0, (p) => p.slice(0, -CLOSER.length)), true, 200), null, "an open fence left unclosed is rejected strictly");
  assert.equal(decode(text, mutate(1, (p) => p.slice(REOPEN.length)), true, 200), null, "a missing reopen is rejected strictly");
  assert.ok(decode(text, mutate(1, (p) => p.slice(REOPEN.length)), false, 200), "lenient mode accepts a missing reopen (that is a fence issue, not a join issue)");
  assert.equal(decode(text, [parts[1]!, parts[0]!, ...parts.slice(2)], false, 200), null, "reordered parts are rejected");
  assert.equal(decode(text, parts.slice(0, -1), false, 200), null, "a lost trailing part is rejected");
  assert.equal(decode("a" + " ".repeat(6) + "b", ["a", "b"], false, 16)?.length, 2, "a whole dropped whitespace chunk may be missing between parts");
  assert.equal(decode("a b", ["a", "b"], false, 16), null, "one trimmed separator is not a dropped chunk");
  assert.equal(decode("a\n\nb", ["a", "b"], false, 16), null, "a trimmed paragraph break is not a dropped chunk");
  assert.equal(decode("axb", ["a", "b"], false, 16), null, "a missing non-whitespace character is rejected");
  assert.equal(decode("a  ", ["a"], false, 16)?.length, 1, "the final chunk may be any whitespace");
});

// ---------------------------------------------------------------- corpus self-checks

test("corpus: at least 500 generated inputs, fixed seed, every required class is present and the properties are not vacuous", () => {
  assert.ok(GENERATED.length >= 500, `generated=${GENERATED.length}`);
  assert.equal(new Set(CASES.map((c) => c.index)).size, CASES.length);
  const has = (re: RegExp): number => CASES.filter((c) => re.test(c.text)).length;
  assert.ok(has(/[\u{10000}-\u{10FFFF}]/u) >= 50, "astral characters");
  assert.ok(has(/\u200D/) >= 30, "ZWJ sequences");
  assert.ok(has(/[\u{1F1E6}-\u{1F1FF}]{2}/u) >= 20, "flag sequences");
  assert.ok(has(/[\u00e4\u00f6\u00fc\u00df]/) >= 30, "umlauts");
  assert.ok(has(/```/) >= 40, "fences");
  assert.ok(has(/\r\n/) >= 30, "CRLF");
  assert.ok(has(/\n/) >= 100, "LF");
  assert.ok(CASES.filter((c) => c.text.split(/\s+/).some((w) => w.length > c.limit)).length >= 40, "words longer than the limit");
  for (const delta of [-1, 0, 1]) {
    const n = CASES.filter((c) => c.text.length === c.limit + delta).length;
    assert.ok(n >= 40, `length limit${delta >= 0 ? "+" : ""}${delta} cases: ${n}`);
  }
  assert.ok(CASES.filter((c) => c.text.trim() === "").length >= 20, "blank inputs");
  assert.ok(CASES.filter((c) => partsOf(c).length > 1).length >= 300, "inputs that really split");
  const pieces = CASES.flatMap((c) => decode(c.text, partsOf(c), true, c.limit) ?? []);
  assert.ok(pieces.filter((p) => p.closer).length >= 40, "closed fences");
  assert.ok(pieces.filter((p) => p.reopen).length >= 40, "reopened fences");
});

// ---------------------------------------------------------------- property 1: limit

test("P1: documented limit constants (docs/channels/slack.md lines 156 and 179: 3500 characters, 2900 per section)", () => {
  assert.equal(SLACK_MAX_TEXT, 3500);
  assert.equal(SLACK_SECTION_MAX, 2900);
});

test("P1: the limit counts UTF-16 code units, not code points and not bytes, and the default is 3500", () => {
  // 1751 astral characters: 1751 code points (< 3500) but 3502 UTF-16 units (> 3500), so they must split.
  const astral = "\u{1F600}".repeat(SLACK_MAX_TEXT / 2 + 1);
  assert.equal([...astral].length, 1751);
  const split = splitMessage(astral);
  assert.ok(split.length >= 2, "3502 UTF-16 units do not fit one part");
  for (const p of split) assert.ok(p.length <= SLACK_MAX_TEXT, `part ${p.length}`);
  // Exactly 3500 units made of 1750 astral characters fit one part.
  const fits = "\u{1F600}".repeat(SLACK_MAX_TEXT / 2);
  assert.deepEqual(splitMessage(fits), [fits]);
  // 3500 umlauts are 7000 bytes in UTF-8 but 3500 units: one part.
  const umlauts = "\u00e4".repeat(SLACK_MAX_TEXT);
  assert.deepEqual(splitMessage(umlauts), [umlauts]);
  // The default is the constant: 3500 fits, 3501 does not.
  assert.deepEqual(splitMessage("a".repeat(3500)), ["a".repeat(3500)]);
  assert.ok(splitMessage("a".repeat(3501)).length >= 2);
});

test("P1: every part is within the limit (UTF-16 code units), for every input; text within the limit stays one part", () => {
  for (const c of CASES) {
    const parts = partsOf(c);
    for (const [i, p] of parts.entries()) {
      if (p.length > c.limit) fail(c, `part ${i} has ${p.length} units, over the limit ${c.limit}`);
    }
    if (c.text.length <= c.limit && c.text.trim() !== "") {
      if (parts.length !== 1 || parts[0] !== c.text) fail(c, `text within the limit must come back as one identical part, got ${parts.length} parts`);
    }
  }
});

// ---------------------------------------------------------------- property 2: join

test("P2: the parts join back to the original except for the pinned separators (whitespace-only chunks, one absorbed newline, the fence wrappers)", () => {
  for (const c of CASES) {
    const parts = partsOf(c);
    for (const [i, p] of parts.entries()) {
      if (p.trim() === "") fail(c, `part ${i} is whitespace-only (the splitter drops those)`);
    }
    if (!decode(c.text, parts, false, c.limit)) {
      fail(c, `parts do not rebuild the input (lengths ${parts.map((p) => p.length).join(",")}; first part ${show(parts[0] ?? "")})`);
    }
  }
});

// ---------------------------------------------------------------- property 3: boundaries

test("P3a: no surrogate pair is split at a part boundary and every part is well-formed UTF-16", () => {
  for (const c of CASES) {
    assert.ok(c.text.isWellFormed(), `generator produced a lone surrogate (index ${c.index})`);
    for (const [i, p] of partsOf(c).entries()) {
      if (!p.isWellFormed()) fail(c, `part ${i} contains a lone surrogate`);
    }
    for (const b of boundariesOf(c)) {
      const hi = c.text.charCodeAt(b - 1);
      const lo = c.text.charCodeAt(b);
      if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) fail(c, `boundary at offset ${b} splits the surrogate pair ${hex(c.text.slice(b - 1, b + 1))}`);
    }
  }
});

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemeBoundaries(s: string): Set<number> {
  const set = new Set<number>([s.length]);
  for (const seg of segmenter.segment(s)) set.add(seg.index);
  return set;
}

test(
  "P3b: no extended grapheme cluster is split at a part boundary (Intl.Segmenter)",
  () => {
    for (const c of CASES) {
      const bounds = graphemeBoundaries(c.text);
      for (const b of boundariesOf(c)) {
        if (bounds.has(b)) continue;
        let torn = "";
        for (const seg of segmenter.segment(c.text)) if (seg.index < b && b < seg.index + seg.segment.length) torn = hex(seg.segment);
        fail(c, `boundary at offset ${b} splits the grapheme cluster ${torn}`);
      }
    }
  },
);

// ---------------------------------------------------------------- property 4: fences

test("P4: a fence left open by a part is closed in that part and reopened by the next (closer \"\\n```\", reopen \"```\\n\"); the last part is never closed", () => {
  for (const c of CASES) {
    const parts = partsOf(c);
    for (const [i, p] of parts.entries()) {
      // Output-local invariant: counted from outside, every part but the last has an even number of fence lines
      // (an open fence = odd count, which the code closes). The last part is odd only when the input ends inside a fence.
      if (i < parts.length - 1 && toggles(p, false)) fail(c, `part ${i} (not the last) leaves a fence open: ${show(p.slice(-24))}`);
    }
    if (!decode(c.text, parts, true, c.limit)) {
      fail(c, `wrappers do not follow the fence state (reopen iff the previous body left a fence open, closer iff this body does and the part is not last); parts=${parts.length}`);
    }
  }
});

// ---------------------------------------------------------------- property 5: empty input

test("P5: empty input gives exactly [] (no empty part), for the default and for explicit limits; invalid limits still throw first", () => {
  assert.deepEqual(splitMessage(""), []);
  for (const max of [16, 17, 100, SLACK_SECTION_MAX, SLACK_MAX_TEXT, 100000]) assert.deepEqual(splitMessage("", max), [], `max=${max}`);
  for (const c of CASES.filter((x) => x.text === "")) assert.deepEqual(partsOf(c), [], `index=${c.index}`);
  for (const bad of [0, 15, 16.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => splitMessage("", bad), RangeError, `max=${String(bad)}`);
  }
});

test("P5: whitespace-only input of any length also gives [] (whitespace-only chunks are dropped)", () => {
  const blanks = CASES.filter((c) => c.text.trim() === "");
  assert.ok(blanks.length >= 20);
  for (const c of blanks) {
    if (partsOf(c).length !== 0) fail(c, `expected [] for whitespace-only input, got ${partsOf(c).length} parts`);
  }
  for (const c of CASES.filter((x) => x.text.trim() !== "")) {
    if (partsOf(c).length === 0) fail(c, "non-blank input produced no part");
  }
});

// ---------------------------------------------------------------- determinism of the corpus

test("corpus: rebuilding the cases from the seed gives identical inputs", () => {
  const again = buildCases();
  assert.equal(again.length, CASES.length);
  for (const [i, c] of CASES.entries()) assert.deepEqual(again[i], c, `seed=${SEED} index=${i}`);
});

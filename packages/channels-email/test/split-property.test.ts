// Step 4: message splitting as a deterministic property test over src/split.ts.
//
// What the code does (read from src/split.ts, pinned here, not invented):
//  - Email has no small per-message limit. EMAIL_MAX_BODY_CHARS = 200 000 is a body CAP; production (channel.ts) only
//    calls truncateBody and never splitMessage. splitMessage is exported for API symmetry and is what splits, so it is
//    the unit under test; truncateBody gets a short companion test at the end.
//  - The limit is measured in UTF-16 code units (String.prototype.length), not code points, graphemes or bytes.
//  - docs/channels/email.md names no body limit and no splitting rule (checked: no "200", "cap", "truncat" or "split"
//    in it). packages/channels-email/README.md line 47 says "Bodies are capped at 200 000 characters with a notice";
//    that agrees with the constant, which is asserted below.
//  - splitMessage(text, max = EMAIL_MAX_BODY_CHARS) throws RangeError unless max is an integer >= 2. While the rest is
//    longer than max it cuts at the last "\n```\n" boundary that closes an open fence (second half of the window), else
//    at the last "\n\n", "\n" or " " in the second half of the window, else hard at max. The separator stays at the
//    END of the earlier part. Only a surrogate pair at a hard cut is protected (cut moves back by one unit).
//  - Nothing is trimmed and nothing is added, but chunks that are whitespace-only (including the empty one) are dropped.
//    So "" and any whitespace-only text give [].
//  - Fences: the code does NOT close an open fenced block at the end of a part and does NOT reopen it in the next part.
//    It only PREFERS to end a part right after a closing fence line when that line is in the second half of the window.
//    A block that does not fit in a window is torn open with no fence inserted. Property 4 pins exactly that.
//
// Replay: every generated case is a pure function of (SEED, index): buildCase(index). A failure message starts with
// `seed=<SEED> index=<i>`; hand-picked cases start with `seed=<SEED> case=hand:<name>`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EMAIL_MAX_BODY_CHARS, splitMessage, truncateBody } from "../src/split.ts";

const SEED = 20261012;
const LIMIT = EMAIL_MAX_BODY_CHARS;

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
const below = (r: Rng, n: number): number => Math.floor(r() * n);
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[below(r, xs.length)]!;

// ---------------------------------------------------------------------------------------------------------------------
// Alphabet
// ---------------------------------------------------------------------------------------------------------------------
const ZWJ = "‍";
const regional = (letter: string): string => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65);
const flag = (cc: string): string => regional(cc[0]!) + regional(cc[1]!);
const FAMILY = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`; // 11 UTF-16 units, one grapheme
const EMOJI_CLUSTERS: readonly string[] = [
  FAMILY,
  `\u{1F469}${ZWJ}\u{1F4BB}`,
  `\u{1F3F3}️${ZWJ}\u{1F308}`,
  `\u{1F3F4}${ZWJ}☠️`,
  `\u{1F9D1}\u{1F3FD}${ZWJ}\u{1F680}`,
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // England flag, 14 units
  flag("DE"),
  flag("FR"),
  flag("JP"),
  "1️⃣",
  "\u{1F44D}\u{1F3FD}",
  "❤️",
  "\u{1F600}",
  "\u{1F642}",
];
const ASTRAL: readonly string[] = ["\u{1D11E}", "\u{20000}", "\u{1F600}", "\u{10348}", "\u{1D518}", "\u{2A6B2}"];
const COMBINING: readonly string[] = ["ä", "ö", "ü", "é", "ñ", "Z̧̆", "ṩ"];
const WORDS: readonly string[] = ["alpha", "beta", "gamma", "delta", "lorem", "ipsum", "dolor", "sit", "amet", "mail", "reply", "thread", "ok", "x", "Re:", "http://example.test/a?b=c"];
const UMLAUT_WORDS: readonly string[] = ["Grüße", "Müller", "Äpfel", "Öl", "Übung", "Straße", "schön", "Bär", "größer", "Fuß", "Mädchen", "Löwe", "äöüß", "ÄÖÜß"];
const KINDS = ["ascii", "umlaut", "emoji-prose", "emoji-dense", "astral", "fenced", "long-word", "newlines", "combining", "whitespace", "mixed"] as const;
type Kind = (typeof KINDS)[number];

function fencedBlock(r: Rng): string {
  const lang = pick(r, ["", "ts", "js", "py"]);
  const lines = Array.from({ length: 1 + below(r, 4) }, () => `const ${pick(r, WORDS).replace(/\W/g, "_")} = ${below(r, 100)};`);
  // A leading "\n" keeps the opening fence at the start of a line even after a piece without a trailing newline.
  const closed = r() < 0.8;
  return `\n\`\`\`${lang}\n${lines.join("\n")}${closed ? "\n```\n" : "\n"}`;
}

function piece(kind: Kind, r: Rng): string {
  switch (kind) {
    case "ascii": return pick(r, WORDS) + (r() < 0.1 ? "\n\n" : r() < 0.15 ? "\n" : " ");
    case "umlaut": return pick(r, UMLAUT_WORDS) + (r() < 0.1 ? "\n" : " ");
    case "emoji-prose": return (r() < 0.5 ? pick(r, EMOJI_CLUSTERS) : pick(r, WORDS)) + (r() < 0.7 ? " " : "");
    case "emoji-dense": return pick(r, EMOJI_CLUSTERS) + (r() < 0.1 ? "a" : "");
    case "astral": return pick(r, ASTRAL);
    case "fenced": return r() < 0.5 ? fencedBlock(r) : r() < 0.2 ? `\`${pick(r, WORDS)}\` ` : pick(r, WORDS) + (r() < 0.3 ? "\n" : " ");
    case "long-word": return r() < 0.6 ? pick(r, WORDS).replace(/\s/g, "") : r() < 0.5 ? pick(r, UMLAUT_WORDS) : pick(r, ASTRAL);
    case "newlines": return pick(r, WORDS) + pick(r, ["\n", "\r\n", "\n\n", "\r\n\r\n", " ", "\r\n"]);
    case "combining": return pick(r, COMBINING) + (r() < 0.3 ? "b" : "");
    case "whitespace": return pick(r, WORDS) + pick(r, [" ".repeat(1 + below(r, 12)), "\t", "\n".repeat(1 + below(r, 4)), " ", " ", "\r\n"]);
    case "mixed": return piece(pick(r, KINDS.filter((k) => k !== "mixed")), r);
  }
}

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;
const loneSurrogate = (s: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

/** Text of exactly `n` UTF-16 units made of `kind` pieces; never ends inside a surrogate pair. */
function textOfLength(kind: Kind, r: Rng, n: number): string {
  let s = "";
  while (s.length < n) s += piece(kind, r);
  if (s.length === n) return s;
  let cut = n;
  if (isHigh(s.charCodeAt(cut - 1)) && isLow(s.charCodeAt(cut))) cut -= 1;
  s = s.slice(0, cut);
  while (s.length < n) s += "x";
  return s;
}

/** Filler of exactly `n` units from letters, spaces and (optionally) newlines. No backticks. */
function filler(r: Rng, n: number, newlines: boolean): string {
  let s = "";
  while (s.length < n) {
    const w = pick(r, ["ab", "cde", "f", "ghij", "klmno", "p"]);
    s += w + (newlines && r() < 0.2 ? "\n" : " ");
  }
  return s.slice(0, n);
}

// ---------------------------------------------------------------------------------------------------------------------
// Corpus: pure function of (SEED, index)
// ---------------------------------------------------------------------------------------------------------------------
interface Case {
  readonly id: string;
  /** Index into the generated corpus; null for hand-picked cases. */
  readonly index: number | null;
  readonly kind: string;
  readonly max: number;
  readonly text: string;
  /** Hand-picked and big cases call splitMessage(text) so that the default limit is what is exercised. */
  readonly defaultLimit: boolean;
  /** Fence-preference cases: the exact length of the first part (cut right after the closing fence line). */
  readonly expectFenceCut?: number;
  /** Cases built from a code block that is much longer than a window. */
  readonly longBlock?: boolean;
}

const SMALL_MAXES = [2, 3, 7, 16, 33, 64, 120] as const;
const N_SMALL = 770; // kinds (11) x length modes (5) x maxes (7) all coprime: 385 combinations, twice
const BIG_LENGTHS = [LIMIT - 1, LIMIT, LIMIT + 1, 2 * LIMIT + 1] as const;
const N_BIG = KINDS.length * BIG_LENGTHS.length; // 44
const N_FENCE = 40;
const N_LONG_BLOCK = 20;
const N_GENERATED = N_SMALL + N_BIG + N_FENCE + N_LONG_BLOCK;

function rngFor(index: number): Rng {
  return mulberry32((SEED ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
}

function buildCase(index: number): Case {
  const r = rngFor(index);
  if (index < N_SMALL) {
    const kind = KINDS[index % KINDS.length]!;
    const max = SMALL_MAXES[index % SMALL_MAXES.length]!;
    const mode = index % 5;
    const len =
      mode === 0 ? max - 1 : mode === 1 ? max : mode === 2 ? max + 1 : mode === 3 ? 1 + below(r, 8 * max) : pick(r, [2 * max, 2 * max + 1, 3 * max - 1]);
    return { id: `gen:${index}`, index, kind, max, text: textOfLength(kind, r, len), defaultLimit: false };
  }
  if (index < N_SMALL + N_BIG) {
    const j = index - N_SMALL;
    const kind = KINDS[j % KINDS.length]!;
    const len = BIG_LENGTHS[Math.floor(j / KINDS.length)]!;
    return { id: `gen:${index}`, index, kind, max: LIMIT, text: textOfLength(kind, r, len), defaultLimit: true };
  }
  if (index < N_SMALL + N_BIG + N_FENCE) {
    // "...[head]\n```\n[code]\n```\n[tail]" where the closing "\n```\n" starts at f in [floor(max/2), max-5]:
    // the code prefers to end the first part right after that closing fence line (cut = f + 5).
    const max = 40 + below(r, 81);
    const floor = Math.floor(max / 2);
    const open = "\n```\n";
    const f = floor + below(r, max - 5 - floor + 1);
    const h = below(r, f - open.length + 1);
    const c = f - open.length - h;
    const head = filler(r, h, false);
    const code = filler(r, c, true);
    const tail = filler(r, max - f - 5 + 1 + below(r, max), true);
    return { id: `gen:${index}`, index, kind: "fence-closes-in-window", max, text: head + open + code + "\n```\n" + tail, defaultLimit: false, expectFenceCut: f + 5 };
  }
  // A block much longer than the window: opener inside the first half, closer far away.
  const max = 20 + below(r, 41);
  const floor = Math.floor(max / 2);
  const head = filler(r, below(r, floor - 6 + 1), false);
  const code = filler(r, 5 * max + below(r, 2 * max), true);
  const tail = filler(r, 1 + below(r, floor), false);
  return { id: `gen:${index}`, index, kind: "fence-longer-than-window", max, text: `${head}\n\`\`\`\n${code}\n\`\`\`\n${tail}`, defaultLimit: false, longBlock: true };
}

const HAND: ReadonlyArray<{ name: string; text: string; max?: number; expectFenceCut?: number }> = [
  { name: "empty", text: "" },
  { name: "empty-max2", text: "", max: 2 },
  { name: "whitespace-only", text: " \n\r\n\t  " },
  { name: "one-char", text: "a" },
  { name: "limit-1-spaces", text: "word ".repeat(LIMIT).slice(0, LIMIT - 1) },
  { name: "limit-spaces", text: "word ".repeat(LIMIT).slice(0, LIMIT) },
  { name: "limit+1-spaces", text: "word ".repeat(LIMIT).slice(0, LIMIT + 1) },
  { name: "limit-ascii-no-spaces", text: "a".repeat(LIMIT) },
  { name: "limit+1-ascii-no-spaces", text: "a".repeat(LIMIT + 1) },
  { name: "long-umlaut-word-2L+17", text: "ö".repeat(2 * LIMIT + 17) },
  { name: "astral-pair-straddles-limit", text: `x${"\u{1F642}".repeat(LIMIT / 2)}` },
  { name: "paragraphs-crlf", text: "Absatz eins\r\n\r\nAbsatz zwei\r\n\r\nAbsatz drei\r\n".repeat(6), max: 40 },
  { name: "umlauts", text: "Grüße aus Köln, schöne Straße. ".repeat(10), max: 16 },
  { name: "paragraph-break", text: "eins zwei\n\ndrei vier\n\nfuenf sechs", max: 14 },
  { name: "surrogates-max2", text: "a\u{1F642}b\u{1F642}", max: 2 },
  { name: "whitespace-run-drops-chunks", text: `a${" ".repeat(30)}b`, max: 10 },
  { name: "trailing-newline-dropped", text: `${"a".repeat(10)}\n`, max: 10 },
  { name: "fence-closes-in-window", text: "ab\n```\ncode\n```\nrest of the message here", max: 20, expectFenceCut: 16 },
  { name: "fence-longer-than-window", text: `intro\n\`\`\`\n${"line of code\n".repeat(10)}\`\`\`\nafter`, max: 30 },
  { name: "unterminated-fence", text: `\`\`\`\n${"x ".repeat(40)}`, max: 20 },
  { name: "family-zwj-hard-cut", text: `${"a".repeat(10)}${FAMILY.repeat(3)}`, max: 16 },
  { name: "flags-hard-cut", text: flag("DE").repeat(5), max: 6 },
  { name: "keycap-hard-cut", text: `aaaaa1️⃣bbbbb`, max: 7 },
  { name: "crlf-hard-cut", text: `${"a".repeat(9)}\r\nb`, max: 10 },
  { name: "combining-hard-cut", text: `${"a".repeat(10)}̈b`, max: 10 },
];

function buildHand(k: number): Case {
  const h = HAND[k]!;
  return {
    id: `hand:${h.name}`,
    index: null,
    kind: "hand",
    max: h.max ?? LIMIT,
    text: h.text,
    defaultLimit: h.max === undefined,
    ...(h.expectFenceCut !== undefined ? { expectFenceCut: h.expectFenceCut } : {}),
  };
}

const SPECS: Case[] = [
  ...Array.from({ length: N_GENERATED }, (_, i) => buildCase(i)),
  ...HAND.map((_, k) => buildHand(k)),
];

function where(c: Case): string {
  return c.index === null
    ? `seed=${SEED} case=${c.id} max=${c.max} len=${c.text.length}`
    : `seed=${SEED} index=${c.index} kind=${c.kind} max=${c.max} len=${c.text.length}`;
}

/** assert with replay information; `msg` is only evaluated on failure. */
function check(c: Case, cond: unknown, msg: () => string): void {
  if (!cond) assert.fail(`${where(c)}: ${msg()}`);
}

const preview = (s: string): string => JSON.stringify(s.length > 70 ? `${s.slice(0, 40)}...${s.slice(-25)}` : s);

const results = new Map<Case, string[]>();
function partsOf(c: Case): string[] {
  let parts = results.get(c);
  if (parts === undefined) {
    try {
      parts = c.defaultLimit ? splitMessage(c.text) : splitMessage(c.text, c.max);
    } catch (e) {
      assert.fail(`${where(c)}: splitMessage threw ${String(e)}`);
    }
    results.set(c, parts);
  }
  return parts;
}

interface Placement {
  readonly starts: number[];
  readonly ends: number[];
}

/**
 * Locates every part as a contiguous slice of `text`, in order. Everything between parts (and before the first and
 * after the last) must be whitespace-only: those are the dropped whitespace-only chunks. Returns the reason on failure.
 * When a part contains a non-whitespace character its position is unique, so scanning forward is exact.
 */
function place(text: string, parts: readonly string[]): Placement | string {
  const starts: number[] = [];
  const ends: number[] = [];
  let p = 0;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    let q = p;
    while (!text.startsWith(part, q)) {
      if (q >= text.length || text.charAt(q).trim() !== "") return `part ${k} (${preview(part)}) is not the next slice of the input; text between offset ${p} and the next non-whitespace is not whitespace-only`;
      q += 1;
    }
    starts.push(q);
    ends.push(q + part.length);
    p = q + part.length;
  }
  if (text.slice(p).trim() !== "") return `non-whitespace text was lost after the last part (offset ${p}: ${preview(text.slice(p))})`;
  return { starts, ends };
}

function mustPlace(c: Case): Placement {
  const placed = place(c.text, partsOf(c));
  check(c, typeof placed !== "string", () => String(placed));
  return placed as Placement;
}

const fenceLines = (s: string): number => s.match(/^```/gm)?.length ?? 0;
const count = (s: string, ch: string): number => s.split(ch).length - 1;

// ---------------------------------------------------------------------------------------------------------------------
// Corpus sanity
// ---------------------------------------------------------------------------------------------------------------------
test("corpus: at least 500 generated cases, edge lengths max-1/max/max+1 present, only well-formed text", () => {
  assert.ok(N_GENERATED >= 500, `generated cases: ${N_GENERATED}`);
  const generated = SPECS.filter((c) => c.index !== null);
  assert.equal(generated.length, N_GENERATED);
  for (const edge of [-1, 0, 1]) {
    assert.ok(generated.some((c) => c.text.length === c.max + edge), `no generated case with length max${edge >= 0 ? "+" : ""}${edge}`);
    assert.ok(generated.some((c) => c.defaultLimit && c.text.length === LIMIT + edge), `no generated case with length limit${edge >= 0 ? "+" : ""}${edge}`);
  }
  for (const c of generated) check(c, !loneSurrogate(c.text), () => "the generator produced a lone surrogate");
  // Determinism of the generator itself.
  for (const i of [0, 1, 137, 600, N_SMALL + 3, N_SMALL + N_BIG + 5, N_GENERATED - 1]) assert.equal(buildCase(i).text, buildCase(i).text);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 1: every part is within the limit
// ---------------------------------------------------------------------------------------------------------------------
test("property 1: every part is within the limit (EMAIL_MAX_BODY_CHARS UTF-16 units, 200 000, README.md line 47)", () => {
  // The constant is the limit. docs/channels/email.md states no number; README.md line 47 says "capped at 200 000 characters".
  assert.equal(EMAIL_MAX_BODY_CHARS, 200_000);
  for (const c of SPECS) {
    const parts = partsOf(c);
    for (const [k, part] of parts.entries()) {
      // What the code measures is part.length, i.e. UTF-16 code units. Not code points, graphemes or bytes.
      check(c, part.length <= c.max, () => `part ${k} has ${part.length} UTF-16 units, limit ${c.max}`);
      check(c, part.length > 0, () => `part ${k} is empty`);
    }
  }
});

test("a text within the limit comes back unchanged as one part (no trimming), one unit over the limit gives the exact split", () => {
  for (const c of SPECS) {
    if (c.text.length <= c.max && c.text.trim() !== "") check(c, JSON.stringify(partsOf(c)) === JSON.stringify([c.text]), () => `expected [text], got ${partsOf(c).length} parts`);
  }
  assert.deepEqual(splitMessage("a".repeat(LIMIT)), ["a".repeat(LIMIT)]);
  assert.deepEqual(splitMessage("a".repeat(LIMIT + 1)), ["a".repeat(LIMIT), "a"]);
  assert.deepEqual(splitMessage(" a ", 3), [" a "]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 2: joining gives back the original, except for the documented drop of whitespace-only chunks
// ---------------------------------------------------------------------------------------------------------------------
test("property 2: parts are in-order slices of the input; only whole whitespace-only chunks are dropped; nothing is trimmed or added", () => {
  for (const c of SPECS) {
    const parts = partsOf(c);
    const { starts, ends } = mustPlace(c);
    const half = Math.floor(c.max / 2);
    let prevEnd = 0;
    let dropped = 0;
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]!;
      check(c, part.trim().length > 0, () => `part ${k} is whitespace-only; the splitter must drop those`);
      // A dropped chunk is a whole chunk, and a non-final chunk is at least floor(max/2) units long. So a gap before a
      // kept part is empty or at least that long; a shorter, non-empty gap would mean boundary whitespace was trimmed.
      const gap = starts[k]! - prevEnd;
      check(c, gap === 0 || gap >= half, () => `${gap} whitespace units removed before part ${k}: boundary whitespace was trimmed`);
      dropped += gap;
      prevEnd = ends[k]!;
    }
    dropped += c.text.length - prevEnd;
    if (dropped === 0) check(c, parts.join("") === c.text, () => "join of the parts differs from the input although no chunk was dropped");
    // No character other than whitespace is lost or added.
    check(c, parts.join("").replace(/\s/g, "") === c.text.replace(/\s/g, ""), () => "non-whitespace content differs");
  }
});

test("property 2 (pinned separators): the separator stays at the end of the earlier part; dropped chunks are exactly the whitespace-only ones", () => {
  assert.deepEqual(splitMessage("eins zwei\n\ndrei vier\n\nfuenf sechs", 14), ["eins zwei\n\n", "drei vier\n\n", "fuenf sechs"]);
  assert.deepEqual(splitMessage(`a${" ".repeat(30)}b`, 10), [`a${" ".repeat(9)}`, " b"]); // two whole chunks of 10 spaces dropped
  assert.deepEqual(splitMessage(`${"a".repeat(10)}\n`, 10), ["a".repeat(10)]); // the trailing "\n" is a whitespace-only chunk
  assert.deepEqual(splitMessage("Grüße aus Köln", 9), ["Grüße ", "aus Köln"]); // the last space at index <= max-1 is index 5
  assert.deepEqual(splitMessage("ab\n```\ncode\n```\nrest of the message here", 20), ["ab\n```\ncode\n```\n", "rest of the message ", "here"]);
  assert.deepEqual(splitMessage("a\u{1F642}b\u{1F642}", 2), ["a", "\u{1F642}", "b", "\u{1F642}"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 3: surrogate pairs and grapheme clusters
// ---------------------------------------------------------------------------------------------------------------------
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

function cutsOf(c: Case): number[] {
  const { starts, ends } = mustPlace(c);
  const all = new Set<number>();
  for (const p of [...starts, ...ends]) if (p > 0 && p < c.text.length) all.add(p);
  return [...all].sort((a, b) => a - b);
}

test("property 3a: no surrogate pair is split at any cut, and every part is well-formed UTF-16", () => {
  for (const c of SPECS) {
    for (const p of cutsOf(c)) check(c, !(isHigh(c.text.charCodeAt(p - 1)) && isLow(c.text.charCodeAt(p))), () => `cut at offset ${p} splits a surrogate pair`);
    for (const [k, part] of partsOf(c).entries()) check(c, !loneSurrogate(part), () => `part ${k} contains a lone surrogate`);
  }
});

// KNOWN GAP (see todo text): src/split.ts protects only surrogate pairs. A hard cut at max, which is what happens when
// no separator lies in the second half of the window, can land inside CRLF, a combining sequence, a regional-indicator
// flag, a keycap or a ZWJ sequence. A cluster that fits into one part (length <= max) must not be torn; a cluster that
// is longer than max cannot be kept whole, so a cut inside it is not counted.
test(
  "property 3b: every cut falls on an extended grapheme cluster boundary of the original (Intl.Segmenter), unless the cluster is longer than max",
  { todo: "KNOWN GAP: channels-email splitMessage: erwartet Schnitt nur an Graphem-Grenzen (CRLF, kombinierende Zeichen, Flaggen und ZWJ-Sequenzen bleiben ganz, solange sie in einen Teil passen), tatsächlich fällt der harte Schnitt bei max mitten in solche Cluster; nur Surrogatpaare sind geschützt" },
  () => {
    for (const c of SPECS) {
      const segments = graphemes.segment(c.text);
      for (const p of cutsOf(c)) {
        const seg = segments.containing(p);
        if (seg === undefined || seg.index === p) continue;
        const clusterLength = seg.segment.length;
        check(c, clusterLength > c.max, () => `cut at offset ${p} is inside the grapheme cluster ${JSON.stringify(seg.segment)} (offset ${seg.index}, ${clusterLength} units, fits into max ${c.max})`);
      }
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// Property 4: fenced code blocks (the code does NOT close and reopen; it only prefers to cut after a closing fence)
// ---------------------------------------------------------------------------------------------------------------------
test("property 4a: no fence marker is added or lost (backticks and line-start fences are conserved)", () => {
  for (const c of SPECS) {
    const joined = partsOf(c).join("");
    check(c, count(joined, "`") === count(c.text, "`"), () => `backtick count ${count(joined, "`")} in the parts, ${count(c.text, "`")} in the input`);
    // For max >= 6 a hard cut cannot land inside a line-start fence marker, and a cut right before one keeps it at a line start.
    if (c.max >= 6) {
      const total = partsOf(c).reduce((n, part) => n + fenceLines(part), 0);
      check(c, total === fenceLines(c.text), () => `${total} line-start fences in the parts, ${fenceLines(c.text)} in the input`);
    }
  }
});

test("property 4b: a block whose closing fence line ends inside the second half of the window is kept whole; the part ends right after that line", () => {
  let seen = 0;
  for (const c of SPECS) {
    if (c.expectFenceCut === undefined) continue;
    seen += 1;
    const parts = partsOf(c);
    const cut = c.expectFenceCut;
    check(c, parts[0] === c.text.slice(0, cut), () => `first part is ${preview(parts[0] ?? "")}, expected the text up to and including the closing fence line (${cut} units)`);
    check(c, parts[0]!.endsWith("\n```\n"), () => "first part does not end with the closing fence line");
    check(c, fenceLines(parts[0]!) % 2 === 0, () => "first part has an odd number of line-start fences");
  }
  assert.equal(seen, N_FENCE + 1); // N_FENCE generated plus one hand-picked
});

test("property 4c: a block longer than the window is torn open; the code neither closes it in the part nor reopens it in the next part", () => {
  let seen = 0;
  for (const c of SPECS) {
    if (c.longBlock !== true) continue;
    seen += 1;
    const parts = partsOf(c);
    check(c, parts.length >= 5, () => `only ${parts.length} parts`);
    check(c, fenceLines(parts[0]!) === 1, () => `first part has ${fenceLines(parts[0]!)} line-start fences, expected the opening one only`); // odd, and not closed
    check(c, count(parts[0]!, "`") === 3, () => "first part holds something other than the one opening fence marker");
    check(c, !parts[0]!.endsWith("```") && !parts[0]!.endsWith("```\n"), () => "first part was closed with a fence");
    for (const k of [1, 2, 3]) check(c, !parts[k]!.includes("`"), () => `part ${k} contains a backtick: a fence was reopened or closed`);
  }
  assert.equal(seen, N_LONG_BLOCK);
  // Hand-picked: same semantics with an unterminated block and with a block that is too long for one window.
  const unterminated = splitMessage(`\`\`\`\n${"x ".repeat(40)}`, 20);
  assert.equal(count(unterminated.join(""), "`"), 3);
  assert.ok(unterminated.slice(1).every((part) => !part.includes("`")), JSON.stringify(unterminated));
});

// ---------------------------------------------------------------------------------------------------------------------
// Property 5: empty input and invalid limit
// ---------------------------------------------------------------------------------------------------------------------
test("property 5: empty and whitespace-only input give [] (the empty chunk is dropped); an invalid limit throws RangeError even for empty input", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("", 2), []);
  assert.deepEqual(splitMessage("", LIMIT + 1), []);
  assert.deepEqual(splitMessage(" \n\r\n\t   "), []);
  assert.deepEqual(splitMessage(" ".repeat(25), 10), []);
  for (const bad of [1, 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitMessage("x", bad), RangeError, `max=${bad}`);
    assert.throws(() => splitMessage("", bad), RangeError, `empty text, max=${bad}`);
  }
  for (const c of SPECS) if (c.text.trim() === "") check(c, partsOf(c).length === 0, () => `expected [], got ${JSON.stringify(partsOf(c))}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Companion: truncateBody is what channel.ts actually calls (bodies are capped, not split)
// ---------------------------------------------------------------------------------------------------------------------
test("truncateBody: within the cap unchanged; above it the result is the prefix, the notice, at most max units, no torn surrogate pair", () => {
  const notice = "[gekürzt]";
  for (const c of SPECS) {
    if (c.max < notice.length + 3) continue; // the notice itself does not fit into max
    const r = c.defaultLimit ? truncateBody(c.text, notice) : truncateBody(c.text, notice, c.max);
    if (c.text.length <= c.max) {
      check(c, r.truncated === false && r.text === c.text, () => "text within the cap was changed");
      continue;
    }
    const tail = `\n\n${notice}`;
    check(c, r.truncated === true, () => "text above the cap is not marked truncated");
    check(c, r.text.length <= c.max, () => `result has ${r.text.length} units, cap ${c.max}`);
    check(c, r.text.endsWith(tail), () => "result does not end with a blank line and the notice");
    const prefix = r.text.slice(0, r.text.length - tail.length);
    check(c, c.text.startsWith(prefix), () => "result does not start with a prefix of the input");
    check(c, prefix.length >= c.max - tail.length - 1, () => `prefix has only ${prefix.length} units, at most one unit may be given up for a surrogate pair`);
    check(c, !loneSurrogate(prefix), () => "truncation tore a surrogate pair");
  }
  assert.deepEqual(truncateBody("", notice), { text: "", truncated: false });
});

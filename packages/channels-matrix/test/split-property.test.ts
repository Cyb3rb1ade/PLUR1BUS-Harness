// Property test for splitMessage (src/split.ts), step 4 of the contract work: deterministic, pure, no timers, no network.
//
// Facts taken from the code and from docs/channels/matrix.md (and pinned here):
// - Limit: MATRIX_MAX_BODY_BYTES = 16 000 UTF-8 BYTES of the Markdown source (not UTF-16 units, not characters).
//   docs/channels/matrix.md, section 10 "Limits", line 132: "Outbound text per event: 16000 UTF-8 bytes of Markdown source."
//   Line 133 adds "Fences are closed and reopened across chunks." The first test reads the doc and compares the number.
//   splitMessage(text, max) takes any max >= 512; the bulk of the corpus runs at small max values so that every input yields
//   many boundaries, and a slice runs at the real constant. A part is measured with TextEncoder, exactly as the code does.
//   (channel.ts publishes the same number as `maxMessageChars`; a UTF-16 length never exceeds the byte length, so a consumer
//   that reads it as characters is safe.)
// - Packing: the text is cut into lines at "\n" only. Whole lines are packed into a part; a line longer than max-256 bytes
//   (RESERVE, the room kept for a closing fence) is hard-split on CODE POINT boundaries, preferring a space in its second half.
// - What the code REMOVES (and nothing else): the "\n" between two lines that land in different parts; empty lines that would
//   start a part (so also leading empty lines of the whole text, when the text is split at all); whitespace-only parts. Nothing
//   is ever trimmed: spaces, tabs and a "\r" stay where they are. With CRLF text this means the "\r" stays at the end of the
//   left part and only the "\n" is dropped. A text that fits in one part is returned verbatim, leading blank lines included.
// - What the code ADDS: only a fence closer, "\n" + the opening marker, at the end of a part that ends inside a fenced code
//   block, and a reopen line at the start of the next part: the opening line itself, or the bare marker when the opening line is
//   longer than 128 bytes (MAX_REOPEN_BYTES), followed by "\n". A fence that is still open at the end of the SOURCE stays open in
//   the last part: the splitter does not repair the author's own unterminated fence.
// - Empty input: "", and any whitespace-only input (String.prototype.trim), give [].
//
// Property 1 does not hold without exception: a part can exceed `max` by the closer that flush() appends, when the line that
// opens a fence is the one that fills the part (KNOWN GAP, overshoot at most "\n" + the marker; a second test pins that bound).
//
// Property 3 is split in two. 3a (no surrogate pair is torn) holds. 3b (no extended grapheme cluster is torn) does not: the hard
// split works on code points. A cut between CR and LF is not counted: the line break itself is the separator the code removes.
//
// Property 4 is split in four. 4a holds: a fenced block that crosses a part boundary is closed in the left part and reopened
// in the right one, and every part is balanced on its own. Three product deviations were found and are tracked as KNOWN GAPs:
//   (i)   the reopen line is glued to the next piece when a hard-split code line continues across the boundary;
//   (ii)  fences in CRLF text are not recognised at all (the opening regex stops at "\r"), so nothing is closed or reopened;
//   (iii) a closing fence line that is longer than the reserved closer (trailing spaces, longer marker) and is the line that
//         overflows leaves the left part unclosed, and the right part starts with that closing line, which then opens a new fence.
//
// Replay: every generated case is derived from (seed, index) alone: caseAt(SEED, index) rebuilds exactly the input a failure
// message names. Structured edge cases carry `seed=- index=edge:<name>` and hand-picked cases `seed=- index=hand:<name>`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MATRIX_MAX_BODY_BYTES, splitMessage } from "../src/split.ts";

// ---- deterministic PRNG (local, no dependency) ----------------------------------------------------------------

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

const SEED = 20261012;
const GENERATED = 600;
const SMALL_MAXES = [512, 512, 513, 600, 777, 1000, 1024, 2048] as const;
/** Mirrors the unexported constants of src/split.ts. */
const RESERVE = 256;
const MAX_REOPEN_BYTES = 128;

const enc = new TextEncoder();
const bytes = (s: string): number => enc.encode(s).length;
const isBlank = (s: string): boolean => s.trim() === "";
const short = (s: string, n = 48): string => JSON.stringify(s.length <= n ? s : `${s.slice(0, n / 2)}…${s.slice(-n / 2)}`);
const codePoints = (s: string): string =>
  [...s].map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`).join(" ");

// ---- vocabulary -----------------------------------------------------------------------------------------------

const ASCII_WORDS = ["lorem", "ipsum", "dolor", "sit", "amet", "matrix", "room", "event", "split", "chunk", "fence", "body", "42", "a-b"];
const UMLAUT_WORDS = ["äöüß", "Übergrößenträger", "Straße", "Mädchen", "schön", "Öl", "ÄÖÜ"];
const ASTRAL = ["\u{1F600}", "\u{1F389}", "\u{1D518}", "\u{2070E}", "\u{10348}"]; // 4 bytes, a surrogate pair each
const FAMILY = ["\u{1F468}", "\u{1F469}", "\u{1F467}", "\u{1F466}"].join("\u200D"); // man, woman, girl, boy joined by ZWJ
const FLAG_DE = "\u{1F1E9}\u{1F1EA}"; // two regional indicators
const CLUSTERS: readonly string[] = [
  FAMILY,
  "\u{1F469}\u200D\u{1F4BB}", // woman technologist
  "\u{1F3F3}\uFE0F\u200D\u{1F308}", // rainbow flag
  "\u{1F9D1}\u{1F3FD}\u200D\u{1F680}", // astronaut with skin tone
  "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}", // kiss
  FLAG_DE,
  "\u{1F1FA}\u{1F1F8}", // US flag
  "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // England (tag sequence)
  "\u{1F44D}\u{1F3FD}", // thumbs up with skin tone
  "1\uFE0F\u20E3", // keycap
  "e\u0301", // e + combining acute
  "u\u0308", // u + combining diaeresis
  "a\u0323\u0302", // a + two combining marks
];

// ---- generators -----------------------------------------------------------------------------------------------

function proseLine(rng: Rng): string {
  const words: string[] = [];
  for (let n = 1 + rng.int(14); n > 0; n--) {
    const roll = rng.int(100);
    words.push(roll < 60 ? rng.pick(ASCII_WORDS) : roll < 80 ? rng.pick(UMLAUT_WORDS) : roll < 90 ? rng.pick(ASTRAL) : rng.pick(CLUSTERS));
  }
  return words.join(" ") + (rng.chance(0.05) ? "  " : "");
}

function emojiLine(rng: Rng): string {
  const items: string[] = [];
  for (let n = 1 + rng.int(40); n > 0; n--) items.push(rng.chance(0.7) ? rng.pick(CLUSTERS) : rng.pick(ASTRAL));
  return items.join(rng.chance(0.5) ? "" : " ");
}

/** A word without spaces that is longer than `limit` bytes (the hard-split window), sometimes with one space inside. */
function longWord(rng: Rng, limit: number): string {
  const want = limit + 1 + rng.int(limit * 2);
  const mode = rng.int(10);
  const units: readonly string[] =
    mode < 2 ? ["q"] : mode < 3 ? ["ä", "ö", "ü", "ß"] : mode < 4 ? ASTRAL : mode < 8 ? [rng.pick(CLUSTERS)] : [...CLUSTERS, "x", "ä"];
  const out: string[] = [];
  for (let size = 0; size < want; ) {
    const u = rng.pick(units);
    out.push(u);
    size += bytes(u);
  }
  if (rng.chance(0.3)) out.splice(rng.int(out.length), 0, " ");
  return out.join("");
}

function codeLine(rng: Rng): string {
  const indent = " ".repeat(2 * rng.int(3));
  if (rng.chance(0.2)) return `${indent}// ${proseLine(rng)}`;
  return `${indent}const ${rng.pick(["alpha", "größe", "count", "naïve", "wert"])}${rng.int(100)} = ${rng.int(1000)} * ${rng.int(1000)};`;
}

function fenceBlock(rng: Rng, limit: number): string {
  const marker = rng.pick(["```", "```", "```", "````", "~~~", "~~~~"]);
  const info = rng.chance(0.05) ? "x".repeat(130 + rng.int(100)) : rng.pick(["", "ts", "python", 'json {"a": 1}', "md", "sh -e"]);
  const indent = rng.chance(0.15) ? " ".repeat(1 + rng.int(3)) : "";
  const lines = [indent + marker + info];
  for (let n = 1 + rng.int(40); n > 0; n--) {
    const roll = rng.int(100);
    if (roll < 10) lines.push(longWord(rng, limit)); // a code line longer than the hard-split window
    else if (roll < 16) lines.push(marker.startsWith("`") ? (marker.length === 3 ? "~~~" : "```") : "```"); // fence of another kind or length: content
    else if (roll < 20) lines.push(`${marker.slice(0, 3)}ts`); // marker with an info string cannot close: content
    else if (roll < 24) lines.push("");
    else lines.push(codeLine(rng));
  }
  const roll = rng.int(100);
  if (roll < 70) lines.push(marker);
  else if (roll < 78) {
    // unterminated: no closing line
  } else {
    // a valid closing line that is longer than the closer the splitter reserves ("\n" + marker)
    lines.push(
      rng.pick([
        () => marker + " ".repeat(1 + rng.int(40)),
        () => " ".repeat(1 + rng.int(3)) + marker,
        () => marker + marker[0]!.repeat(1 + rng.int(4)),
      ])(),
    );
  }
  return lines.join("\n");
}

interface RandomText {
  text: string;
  tags: string[];
}

function randomText(rng: Rng, max: number): RandomText {
  const limit = max - RESERVE;
  const target = Math.floor(max * rng.pick([0.5, 1, 1.3, 2, 3, 5]));
  const tags = new Set<string>();
  const lines: string[] = [];
  for (let size = 0; size < target; ) {
    const roll = rng.int(100);
    let seg: string;
    if (roll < 34) seg = proseLine(rng);
    else if (roll < 44) {
      tags.add("umlaut");
      seg = Array.from({ length: 1 + rng.int(8) }, () => rng.pick(UMLAUT_WORDS)).join(" ");
    } else if (roll < 56) {
      tags.add("emoji");
      seg = emojiLine(rng);
    } else if (roll < 76) {
      tags.add("fence");
      seg = fenceBlock(rng, limit);
    } else if (roll < 84) {
      tags.add("long-word");
      seg = longWord(rng, limit);
    } else if (roll < 90) {
      tags.add("blank");
      seg = rng.pick(["", "", "   ", "\t", " "]);
    } else if (roll < 93) seg = rng.pick(["```js `inline` text", "```x```"]); // fence look-alikes: not fences
    else seg = rng.pick(["# ", "- ", "> ", "1. "]) + proseLine(rng);
    lines.push(seg);
    size += bytes(seg) + 1;
  }
  let text = lines.join("\n");
  if (rng.chance(0.25)) {
    tags.add("crlf");
    text = text.replace(/\n/g, "\r\n");
  }
  if (rng.chance(0.1)) text = "\n".repeat(1 + rng.int(3)) + text;
  if (rng.chance(0.1)) text += "\n".repeat(1 + rng.int(3));
  return { text, tags: [...tags].sort() };
}

// ---- the corpus -----------------------------------------------------------------------------------------------

interface Case {
  seed: number | "-";
  index: number | string;
  label: string;
  text: string;
  max: number;
  kind: "random" | "edge" | "hand";
  /** Edge cases only: total size minus max, in bytes (-1, 0, +1) or null when it is a line-size edge. */
  delta: number | null;
  /** Edge cases only: the text contains no whitespace at all. */
  solid: boolean;
}

function caseAt(seed: number, index: number): Case {
  const rng = makeRng((seed + Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  const max = index % 50 === 49 ? MATRIX_MAX_BODY_BYTES : rng.pick(SMALL_MAXES);
  const { text, tags } = randomText(rng, max);
  return { seed, index, label: `random ${tags.join("+") || "plain"}`, text, max, kind: "random", delta: null, solid: false };
}

/** `unit` repeated, padded with ASCII "x" so that the result is exactly `target` UTF-8 bytes long. */
function exactBytes(unit: string, target: number): string {
  const n = Math.floor(target / bytes(unit));
  return unit.repeat(n) + "x".repeat(target - n * bytes(unit));
}

function edgeCases(): Case[] {
  const out: Case[] = [];
  const units: [string, string, boolean][] = [
    ["ascii", "a", true],
    ["umlaut", "ä", true],
    ["emoji", "\u{1F600}", true],
    ["zwj-family", FAMILY, true],
    ["flags", FLAG_DE, true],
    ["lines", "word word word word\n", false],
  ];
  for (const max of [512, MATRIX_MAX_BODY_BYTES]) {
    for (const [name, unit, solid] of units) {
      for (const delta of [-1, 0, 1]) {
        const label = `total ${name} max=${max} delta=${delta}`;
        out.push({ seed: "-", index: `edge:${label}`, label, text: exactBytes(unit, max + delta), max, kind: "edge", delta, solid });
      }
    }
    // Lines of limit-1, limit and limit+1 bytes (limit = max - RESERVE is the hard-split window), three of them so that
    // the text is split.
    for (const [name, unit] of [["ascii", "a"], ["emoji", "\u{1F600}"], ["zwj-family", FAMILY]] as const) {
      for (const delta of [-1, 0, 1]) {
        const line = exactBytes(unit, max - RESERVE + delta);
        const label = `line ${name} max=${max} delta=${delta}`;
        out.push({ seed: "-", index: `edge:${label}`, label, text: [line, line, line].join("\n"), max, kind: "edge", delta: null, solid: false });
      }
    }
  }
  return out;
}

function handCases(): Case[] {
  const rep = (s: string, n: number): string => s.repeat(n);
  const codeLines = (n: number, w: number, eol = "\n"): string => Array.from({ length: n }, (_, i) => `${i}`.padStart(3, "0") + rep("x", w)).join(eol);
  const longInfo = rep("i", 200);
  const hand: [string, string, number][] = [
    ["empty", "", 512],
    ["spaces only", "   ", 512],
    ["newlines only", "\n\n", 512],
    ["single character", "x", 512],
    ["whitespace only, longer than max", " \t\r\n".repeat(400), 512],
    ["leading blank lines before a long word", `\n\n${rep("a", 600)}`, 512],
    ["whitespace-only lines between long lines", `  \n${rep("a", 300)}\n   \n${rep("b", 300)}\n\n\n`, 512],
    ["trailing spaces survive", `${rep("a", 300)}   \n${rep("b", 300)}  `, 512],
    ["crlf prose", Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\r\n"), 512],
    ["crlf fence across parts", `intro\r\n\`\`\`ts\r\n${codeLines(40, 30, "\r\n")}\r\n\`\`\`\r\noutro`, 700],
    ["ZWJ family straddling the flush boundary", rep("x", 500) + FAMILY + rep("y", 400), 512],
    ["flag run without separators", "x" + rep(FLAG_DE, 300), 512],
    ["combining marks at the cut", rep("e\u0301", 400), 512],
    ["surrogate pairs only", rep("\u{1F600}", 400), 512],
    ["long word with a space late", `${rep("a", 200)} ${rep("b", 400)}`, 512],
    ["long word with a space early", `${rep("a", 20)} ${rep("b", 600)}`, 512],
    ["fence: hard-split code line", `\`\`\`ts\n${rep("a", 600)}\n\`\`\``, 512],
    ["fence: closing line longer than the closer", ["```", rep("a", 240), rep("b", 240), "```" + rep(" ", 30), "tail line", rep("z", 300)].join("\n"), 512],
    ["fence opener fills the part", ["a".repeat(250), "b".repeat(250), "```" + "i".repeat(95), "x", "y".repeat(100), "```"].join("\n"), 600],
    [
      "fence opener fills the part (real limit)",
      [rep("a", MATRIX_MAX_BODY_BYTES - RESERVE), "```" + rep("i", 252), "x", rep("y", 100), "```"].join("\n"),
      MATRIX_MAX_BODY_BYTES,
    ],
    ["fence: tilde", `~~~python\n${codeLines(40, 30)}\n~~~\nafter`, 512],
    ["fence: four backticks around a triple", `\`\`\`\`md\n${codeLines(10, 30)}\n\`\`\`\n${codeLines(20, 30)}\n\`\`\`\`\nafter`, 512],
    ["fence: opener longer than 128 bytes", `\`\`\`${longInfo}\n${codeLines(40, 30)}\n\`\`\`\nafter`, 512],
    ["fence: indented opener", `  \`\`\`js\n${codeLines(40, 30)}\n\`\`\`\nafter`, 512],
    ["fence: unterminated", `\`\`\`\n${"a\n".repeat(400)}`, 512],
    ["fence: info string with a backtick is not a fence", `\`\`\`js \`x\`\n${codeLines(40, 30)}`, 512],
    ["fence: plain block that crosses one boundary", `\`\`\`ts\n${codeLines(30, 30)}\n\`\`\``, 512],
    ["fence: tail of the closed block and a second block", `\`\`\`a\n${codeLines(20, 30)}\n\`\`\`\n\`\`\`b\n${codeLines(20, 30)}\n\`\`\``, 512],
    ["umlauts and emoji per line", Array.from({ length: 60 }, (_, i) => `Größe ${i} äöüß \u{1F600} ${FAMILY}`).join("\n"), 512],
  ];
  return hand.map(([name, text, max]) => ({ seed: "-", index: `hand:${name}`, label: name, text, max, kind: "hand", delta: null, solid: false }));
}

function buildCorpus(): Case[] {
  return [...Array.from({ length: GENERATED }, (_, i) => caseAt(SEED, i)), ...edgeCases(), ...handCases()];
}

const corpus = buildCorpus();

function fail(c: Case, message: string): never {
  assert.fail(`seed=${c.seed} index=${c.index} (${c.label}, max=${c.max}): ${message}`);
}

// ---- the reference fence tracker (CommonMark rules, mirrors FENCE_OPEN/FENCE_CLOSE of src/split.ts) ------------

interface Fence {
  char: string;
  marker: string;
  /** The opening line exactly as it stands in the source. */
  open: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** The fence state after one source line. A CommonMark reader sees CRLF as a line ending, so a trailing "\r" is ignored here. */
function stepFence(state: Fence | null, rawLine: string): Fence | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (state) {
    const close = FENCE_CLOSE.exec(line);
    return close && close[1]![0] === state.char && close[1]!.length >= state.marker.length ? null : state;
  }
  const open = FENCE_OPEN.exec(line);
  if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) return { char: open[1]![0]!, marker: open[1]!, open: rawLine };
  return null;
}

function openAtEnd(text: string): boolean {
  let state: Fence | null = null;
  for (const line of text.split("\n")) state = stepFence(state, line);
  return state !== null;
}

/** What the splitter writes at the start of a part that continues a fenced block. */
const reopenLine = (f: Fence): string => (bytes(f.open) <= MAX_REOPEN_BYTES ? f.open : f.marker);

class FenceIndex {
  readonly #ends: number[] = [];
  readonly #after: (Fence | null)[] = [];

  constructor(text: string) {
    let offset = 0;
    let state: Fence | null = null;
    for (const line of text.split("\n")) {
      state = stepFence(state, line);
      this.#ends.push(offset + line.length);
      this.#after.push(state);
      offset += line.length + 1;
    }
  }

  /** The fence the source is inside once text[0, pos) has been consumed: every line that ends at or before `pos` counts. */
  at(pos: number): Fence | null {
    let lo = 0;
    let hi = this.#ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.#ends[mid]! <= pos) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? null : this.#after[lo - 1]!;
  }
}

// ---- alignment of the parts with the source (properties 2, 3 and 4 read from this) ----------------------------

type IssueKind = "glued-reopen" | "crlf-fence-ignored" | "closing-line-overflow" | "other";

interface Issue {
  kind: IssueKind;
  message: string;
}

interface Analysis {
  /** First violation of property 2, or null. */
  content: string | null;
  /** Violations of property 4, in order. */
  issues: Issue[];
  /** Per boundary between part k and k+1: where the payload of k ends and the payload of k+1 starts, as source offsets. */
  cuts: { end: number; start: number }[];
  /** Number of boundaries at which the source is inside a fenced block. */
  fenceCuts: number;
  /** Number of boundaries inside a source line (hard splits). */
  midLineCuts: number;
}

/**
 * Walks the parts and the source together. For each part it strips what the splitter adds (the reopen line and its "\n", the
 * closer "\n" + marker) only where the fence tracker says a fence is open at that boundary, then locates the rest in the source
 * at or after the cursor. Everything skipped on the way must be blank: that is the exact set of removed text.
 */
function analyse(text: string, parts: readonly string[]): Analysis {
  const res: Analysis = { content: null, issues: [], cuts: [], fenceCuts: 0, midLineCuts: 0 };
  const fences = new FenceIndex(text);
  const issue = (kind: IssueKind, message: string): void => void res.issues.push({ kind, message });
  let pos = 0;
  let skipReopen = false;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k]!;
    const last = k === parts.length - 1;
    const incoming = k === 0 ? null : fences.at(pos);
    if (incoming) res.fenceCuts++;
    let rest = part;
    if (incoming && !skipReopen) {
      const reopen = reopenLine(incoming);
      if (!part.startsWith(reopen)) {
        issue(incoming.open.endsWith("\r") ? "crlf-fence-ignored" : "other", `part ${k} does not start with the reopened fence line ${short(reopen)}`);
      } else {
        rest = part.slice(reopen.length);
        if (rest.startsWith("\n")) rest = rest.slice(1);
        else if (rest !== "") {
          issue("glued-reopen", `part ${k} starts with ${short(part.slice(0, reopen.length + 16))}: the reopened fence line is not followed by a line break`);
        }
      }
    }
    skipReopen = false;

    // The first occurrence at or after the cursor whose gap is blank. If several matched, the first one is the real one: a
    // payload that began earlier would have to start with whitespace that the gap already consumed.
    const find = (s: string): number => {
      const i = text.indexOf(s, pos);
      return i >= 0 && isBlank(text.slice(pos, i)) ? i : -1;
    };
    const ia = find(rest);
    const endA = ia + rest.length;
    const stateA = ia >= 0 ? fences.at(endA) : null;
    let start = -1;
    let end = -1;
    if (ia >= 0 && stateA === null) {
      start = ia;
      end = endA;
    } else {
      const closer = /\n(`{3,}|~{3,})$/.exec(rest);
      const payloadB = closer ? rest.slice(0, closer.index) : null;
      const ib = payloadB === null ? -1 : find(payloadB);
      const endB = ib + (payloadB?.length ?? 0);
      const stateB = ib >= 0 ? fences.at(endB) : null;
      if (closer && ib >= 0 && stateB !== null && stateB.marker === closer[1]) {
        start = ib;
        end = endB;
      } else if (ia >= 0 && stateA !== null) {
        // The payload ends inside an open fence and carries no closer.
        start = ia;
        end = endA;
        if (!(last && isBlank(text.slice(endA)))) {
          const atLineEnd = endA === text.length || text[endA] === "\n";
          const next = atLineEnd && endA < text.length ? text.slice(endA + 1).split("\n", 1)[0]! : undefined;
          const kind: IssueKind = stateA.open.endsWith("\r")
            ? "crlf-fence-ignored"
            : next !== undefined && stepFence(stateA, next) === null
              ? "closing-line-overflow"
              : "other";
          issue(kind, `part ${k} ends inside the fence opened by ${short(stateA.open)} and is not closed; the next source line is ${next === undefined ? "inside a long line" : short(next)}`);
          skipReopen = true;
        } // else: the source itself ends inside a fence and the last part keeps it open (pinned)
      } else if (closer && ib >= 0) {
        start = ib;
        end = endB;
        issue("other", `part ${k} ends with a closer ${short(closer[1]!)} but the source is not inside such a fence there`);
      } else {
        res.content = `part ${k} (${short(part)}) is not a stretch of the source: after removing a reopen line and a closer it was not found at or after offset ${pos} behind a blank gap`;
        return res;
      }
    }
    if (k > 0) {
      // The exact removed stretch at a boundary: nothing (a cut inside a line) or the line break "\n" followed by whatever blank
      // text was dropped with it. If it started with a space, tab or "\r", the splitter would have trimmed the end of a line.
      const gap = text.slice(pos, start);
      if (gap !== "" && !gap.startsWith("\n")) {
        res.content = `between part ${k - 1} and part ${k} the splitter dropped ${short(gap)} (source offset ${pos}); only a line break and blank text after it may be removed, nothing is trimmed`;
        return res;
      }
      res.cuts.push({ end: pos, start });
      if (start === pos) res.midLineCuts++;
    }
    pos = end;
  }
  const tail = text.slice(pos);
  if (!isBlank(tail)) res.content = `source text after offset ${pos} is neither covered by a part nor blank: ${short(tail)}`;
  else if (parts.length > 0 && tail !== "" && !tail.startsWith("\n")) res.content = `the splitter dropped ${short(tail)} at the end of the text; only a line break and blank text after it may be removed, nothing is trimmed`;
  return res;
}

interface Run {
  parts: string[];
  analysis: Analysis;
  bounds?: Set<number>;
}

const runs = new Map<Case, Run>();
function run(c: Case): Run {
  let r = runs.get(c);
  if (!r) {
    const parts = splitMessage(c.text, c.max);
    r = { parts, analysis: analyse(c.text, parts) };
    runs.set(c, r);
  }
  return r;
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function graphemeBounds(c: Case): Set<number> {
  const r = run(c);
  if (!r.bounds) {
    r.bounds = new Set([c.text.length]);
    for (const s of segmenter.segment(c.text)) r.bounds.add(s.index);
  }
  return r.bounds;
}

// ---- documentation and constant ---------------------------------------------------------------------------------

test("limit: the constant is the documented 16000 UTF-8 bytes (docs/channels/matrix.md, section 10, line 132)", () => {
  const doc = readFileSync(new URL("../../../docs/channels/matrix.md", import.meta.url), "utf8");
  const m = /Outbound text per event: (\d+) UTF-8 bytes of Markdown source/.exec(doc);
  assert.ok(m, 'docs/channels/matrix.md section 10 must state "Outbound text per event: <n> UTF-8 bytes of Markdown source"');
  assert.equal(Number(m[1]), 16_000);
  assert.equal(MATRIX_MAX_BODY_BYTES, Number(m[1]));
  assert.match(doc, /Fences are closed and reopened across chunks\./);
});

// ---- the corpus itself ------------------------------------------------------------------------------------------

test("corpus: >= 500 generated inputs, reproducible from (seed, index), well-formed, all required families present", () => {
  const generated = corpus.filter((c) => c.kind === "random");
  assert.ok(generated.length >= 500, `${generated.length} generated inputs`);
  for (const i of [0, 1, 17, 49, 250, GENERATED - 1]) {
    const again = caseAt(SEED, i);
    assert.equal(again.text, corpus[i]!.text, `caseAt(${SEED}, ${i}) is not reproducible`);
    assert.equal(again.max, corpus[i]!.max);
  }
  const rebuilt = buildCorpus();
  assert.equal(rebuilt.length, corpus.length);
  for (const [i, c] of rebuilt.entries()) assert.ok(c.text === corpus[i]!.text && c.max === corpus[i]!.max && c.index === corpus[i]!.index, `corpus entry ${i} is not reproducible`);
  const count = (re: RegExp): number => corpus.filter((c) => re.test(c.text)).length;
  for (const c of corpus) assert.ok(c.text.isWellFormed(), `${c.index}: the generated text itself has a lone surrogate`);
  assert.ok(count(/[äöüß]/) >= 100, "umlauts");
  assert.ok(count(/[\u{10000}-\u{10FFFF}]/u) >= 100, "astral characters (surrogate pairs)");
  assert.ok(count(/\u200D/) >= 100, "ZWJ sequences");
  assert.ok(count(/\u{1F1E9}\u{1F1EA}|\u{1F1FA}\u{1F1F8}/u) >= 50, "regional-indicator flags");
  assert.ok(count(/^ {0,3}(`{3,}|~{3,})/m) >= 100, "fenced code blocks");
  assert.ok(count(/\r\n/) >= 50, "CRLF line breaks");
  assert.ok(count(/\n\n/) >= 20, "blank lines");
  assert.ok(corpus.some((c) => c.max === MATRIX_MAX_BODY_BYTES && c.kind === "random"), "random inputs at the real limit");
  // Edge sizes around the limit exist at both sizes, in bytes.
  for (const max of [512, MATRIX_MAX_BODY_BYTES]) {
    for (const delta of [-1, 0, 1]) {
      assert.ok(corpus.some((c) => c.kind === "edge" && c.max === max && c.delta === delta && bytes(c.text) === max + delta), `edge ${max}${delta >= 0 ? "+" : ""}${delta}`);
    }
  }
  // Non-vacuous: the splitter actually splits, cuts inside fences and inside lines, and cuts clusters.
  const multi = corpus.filter((c) => run(c).parts.length > 1);
  assert.ok(multi.length >= 400, `${multi.length} inputs are split into several parts`);
  assert.ok(corpus.filter((c) => run(c).analysis.fenceCuts > 0).length >= 60, "boundaries inside fenced blocks");
  assert.ok(corpus.filter((c) => run(c).analysis.midLineCuts > 0).length >= 60, "boundaries inside a source line (hard splits)");
});

// ---- property 1: every part is within the limit -------------------------------------------------------------------

// KNOWN GAP (product deviation, found by this test): put() leaves no room for the closer of a fence that is opened by the very
// line that fills the part. The check in put() uses `closer()` while `fence` is still undefined (the opening line is placed first,
// `fence` is set after it), so the "\n" + marker that flush() appends later is not part of the budget. Overshoot is at most
// 1 + the opening marker, see the pinned test below. The reproducers are the hand cases "fence opener fills the part".
test(
  "property 1: every part is at most `max` UTF-8 bytes (the real limit is the documented 16000)",
  () => {
    for (const c of corpus) {
      for (const [k, part] of run(c).parts.entries()) {
        if (bytes(part) > c.max) fail(c, `part ${k} is ${bytes(part)} bytes, over the limit of ${c.max}`);
      }
    }
  },
);

test("property 1 (regression): the fence opener that fills a part leaves room for its closer", () => {
  for (const name of ["fence opener fills the part", "fence opener fills the part (real limit)"]) {
    const c = corpus.find((x) => x.index === `hand:${name}`)!;
    const { parts } = run(c);
    assert.ok(parts.length > 1, name);
    for (const part of parts) assert.ok(bytes(part) <= c.max, `${name}: ${bytes(part)} > ${c.max}`);
  }
});

test("property 1: the default limit is MATRIX_MAX_BODY_BYTES", () => {
  const atLimit = corpus.filter((c) => c.max === MATRIX_MAX_BODY_BYTES);
  assert.ok(atLimit.length >= 30);
  for (const c of atLimit) {
    assert.deepEqual(splitMessage(c.text), run(c).parts, `seed=${c.seed} index=${c.index}: default limit differs from the constant`);
  }
});

test("edge lengths: limit-1 and limit bytes come back whole, limit+1 is split (both at 512 and at the real limit)", () => {
  const edges = corpus.filter((c) => c.kind === "edge" && c.delta !== null);
  assert.ok(edges.length >= 36);
  for (const c of edges) {
    const { parts } = run(c);
    if (c.delta! <= 0) {
      if (parts.length !== 1 || parts[0] !== c.text) fail(c, `a text of ${bytes(c.text)} bytes fits in one part and must be returned unchanged, got ${parts.length} part(s)`);
    } else if (c.solid && parts.length < 2) {
      fail(c, `a text of ${bytes(c.text)} bytes (limit+1) without whitespace must be split, got ${parts.length} part(s)`);
    }
  }
  // Lines of exactly the hard-split window (limit - 256), one byte less and one byte more.
  for (const c of corpus.filter((x) => x.kind === "edge" && x.delta === null)) {
    const { parts, analysis } = run(c);
    assert.ok(parts.length >= 2, `seed=${c.seed} index=${c.index}: three lines of the window size must be split`);
    assert.equal(analysis.content, null, `seed=${c.seed} index=${c.index}: ${analysis.content}`);
  }
});

// ---- property 2: the parts give back the original, except for the documented separators -----------------------------

test("property 2: parts, minus the added reopen lines and closers, cover the source; only blank text is dropped", () => {
  for (const c of corpus) {
    const { parts, analysis } = run(c);
    if (analysis.content !== null) fail(c, analysis.content);
    for (const [k, part] of parts.entries()) if (isBlank(part)) fail(c, `part ${k} is whitespace-only; such parts are dropped`);
    if (bytes(c.text) <= c.max && !isBlank(c.text)) {
      if (parts.length !== 1 || parts[0] !== c.text) fail(c, "a text that fits is returned as one untouched part");
    }
  }
});

test("property 2 pinned rules: exactly what is removed at a boundary and what is kept", () => {
  const a = "a".repeat(300);
  const b = "b".repeat(300);
  // The "\n" between two lines that land in different parts is the only thing removed; the parts are not trimmed.
  assert.deepEqual(splitMessage(`${a}\n${b}`, 512), [a, b]);
  assert.deepEqual(splitMessage(`${a}   \n${b}  `, 512), [`${a}   `, `${b}  `]);
  // With CRLF only the "\n" goes; the "\r" stays at the end of the left part.
  assert.deepEqual(splitMessage(`${a}\r\n${b}`, 512), [`${a}\r`, b]);
  // A hard split inside one line removes nothing at all.
  const word = "w".repeat(600);
  assert.equal(splitMessage(word, 512).join(""), word);
  // Empty lines that END a part stay in it; empty lines that would START a part are dropped, so are leading empty lines of a
  // text that has to be split. A text that fits keeps them.
  assert.deepEqual(splitMessage(`${a}\n\n\n${b}`, 512), [`${a}\n\n`, b]); // the blank lines stay in the left part, one "\n" goes
  assert.equal(splitMessage(`\n\n${"a".repeat(600)}`, 512).join(""), "a".repeat(600));
  assert.deepEqual(splitMessage("\n\nabc", 512), ["\n\nabc"]);
  // A whitespace-only part is dropped (here the 300 spaces of a second line).
  assert.deepEqual(splitMessage(`${a}\n${" ".repeat(300)}`, 512), [a]);
  // Added text: reopen line and closer, nothing else. 30 lines of 30 bytes after "```ts" do not fit in one part.
  const lines = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(28)}`);
  const parts = splitMessage(["```ts", ...lines, "```"].join("\n"), 512);
  assert.deepEqual(parts, [["```ts", ...lines.slice(0, 16), "```"].join("\n"), ["```ts", ...lines.slice(16), "```"].join("\n")]);
});

// ---- property 3: no surrogate pair and no grapheme cluster is split -------------------------------------------------

test("property 3a: no surrogate pair is split (every part is well-formed UTF-16, no cut falls between a pair)", () => {
  for (const c of corpus) {
    const r = run(c);
    for (const [k, part] of r.parts.entries()) if (!part.isWellFormed()) fail(c, `part ${k} has a lone surrogate: ${short(part)}`);
    for (const cut of r.analysis.cuts) {
      for (const pos of [cut.end, cut.start]) {
        const hi = c.text.charCodeAt(pos - 1);
        const lo = c.text.charCodeAt(pos);
        if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) fail(c, `a boundary at source offset ${pos} falls inside a surrogate pair`);
      }
    }
  }
});

// KNOWN GAP (product deviation, found by this test): hardSplit() in src/split.ts walks `for (const ch of rest)`, that is code
// points, and cuts at the byte budget. Nothing keeps ZWJ sequences, flag pairs (two regional indicators), emoji with a skin-tone
// modifier or base + combining mark together. A boundary that falls inside such a cluster is reported with the code points of
// the torn cluster. A CR directly before the removed LF is not counted (see the header).
test(
  "property 3b: every part boundary falls on a grapheme boundary of the original (Intl.Segmenter)",
  () => {
    for (const c of corpus) {
      const r = run(c);
      const bounds = graphemeBounds(c);
      for (const [k, cut] of r.analysis.cuts.entries()) {
        const lineBreakCut = c.text[cut.end - 1] === "\r" && c.text[cut.end] === "\n";
        for (const pos of lineBreakCut ? [cut.start] : [cut.end, cut.start]) {
          if (!bounds.has(pos)) {
            const seg = segmenter.segment(c.text).containing(pos)?.segment ?? "";
            fail(c, `the boundary between parts ${k} and ${k + 1} (source offset ${pos}) splits the grapheme cluster ${short(seg)} = ${codePoints(seg)}`);
          }
        }
      }
    }
  },
);

// ---- property 4: a fenced block that crosses a boundary is closed in the left part and reopened in the right one -----

test("property 4a: fenced blocks are closed and reopened across parts and every part is balanced (known deviations aside)", () => {
  for (const c of corpus) {
    const r = run(c);
    const other = r.analysis.issues.find((i) => i.kind === "other");
    if (other) fail(c, other.message);
    if (r.analysis.issues.length > 0) continue; // the three tracked deviations below
    const sourceOpen = openAtEnd(c.text);
    for (const [k, part] of r.parts.entries()) {
      const last = k === r.parts.length - 1;
      // Every part is balanced on its own, except the last one when the source itself ends inside a fence.
      if (openAtEnd(part) && !(last && sourceOpen)) fail(c, `part ${k} leaves a fence open: ${short(part.slice(-60))}`);
    }
  }
  // The source's own unterminated fence stays unterminated in the last part, and only there.
  const unterminated = splitMessage(`\`\`\`\n${"a\n".repeat(400)}`, 512);
  assert.ok(unterminated.length > 1);
  assert.ok(openAtEnd(unterminated.at(-1)!));
  for (const part of unterminated.slice(0, -1)) assert.ok(!openAtEnd(part));
  // A text that fits is not repaired either.
  assert.deepEqual(splitMessage("```\nopen", 512), ["```\nopen"]);
  // A longer marker closes with its own marker: the closer is "\n" + the opening marker, the reopen is the opening line.
  const four = splitMessage(`\`\`\`\`md\n${Array.from({ length: 30 }, (_, i) => `${i} ${"y".repeat(30)}`).join("\n")}\n\`\`\`\``, 512);
  assert.ok(four.length > 1 && four[0]!.endsWith("\n````"));
  for (const part of four.slice(1)) assert.ok(part.startsWith("````md\n") && part.endsWith("\n````"));
  // An opening line longer than 128 bytes is reopened as the bare marker.
  const longOpen = `\`\`\`${"i".repeat(200)}`;
  const parts = splitMessage(`${longOpen}\n${Array.from({ length: 30 }, (_, i) => `${i} ${"y".repeat(30)}`).join("\n")}\n\`\`\``, 512);
  assert.ok(parts.length > 1 && parts[0]!.startsWith(longOpen) && parts[0]!.endsWith("\n```"));
  for (const part of parts.slice(1)) assert.ok(part.startsWith("```\n") && !part.includes("iiii"), "reopened with the bare marker, the long info string is not repeated");
});

// KNOWN GAP (i): put(piece, newline = false) appends a hard-split continuation straight onto the reopened fence line.
test(
  "property 4b: the reopened fence line is a line of its own, also when a hard-split code line continues across the boundary",
  () => {
    for (const c of corpus) {
      const glued = run(c).analysis.issues.find((i) => i.kind === "glued-reopen");
      if (glued) fail(c, glued.message);
    }
  },
);

// KNOWN GAP (ii): FENCE_OPEN is /^ {0,3}(`{3,}|~{3,})(.*)$/ and `.` does not match "\r", so "```ts\r" is not an opening line.
test(
  "property 4c: fences in CRLF text are closed and reopened like fences in LF text",
  () => {
    for (const c of corpus) {
      const crlf = run(c).analysis.issues.find((i) => i.kind === "crlf-fence-ignored");
      if (crlf) fail(c, crlf.message);
    }
  },
);

// KNOWN GAP (iii): the closing line is placed with `fence` already cleared, so a flush right before it adds no closer and
// reopens nothing; with a closing line longer than "\n" + marker it can be the line that does not fit.
test(
  "property 4d: a closing fence line that does not fit does not leave the left part unclosed",
  () => {
    for (const c of corpus) {
      const overflow = run(c).analysis.issues.find((i) => i.kind === "closing-line-overflow");
      if (overflow) fail(c, overflow.message);
    }
  },
);

// ---- property 5: empty input has a defined result ---------------------------------------------------------------------

test("property 5: empty and whitespace-only input give [], also when it is longer than the limit", () => {
  assert.deepEqual(splitMessage(""), []);
  assert.deepEqual(splitMessage("", 512), []);
  assert.deepEqual(splitMessage("", MATRIX_MAX_BODY_BYTES), []);
  for (const ws of [" ", "\n", "\r\n", "\t", "\u00a0", "   \n  ", "\n\n", " \t\r\n\u00a0\u3000"]) {
    assert.deepEqual(splitMessage(ws), [], `whitespace-only ${JSON.stringify(ws)}`);
    for (const n of [1, 511, 512, 513, 5000]) {
      assert.deepEqual(splitMessage(ws.repeat(n), 512), [], `${n} x ${JSON.stringify(ws)} at max 512`);
    }
  }
  // Not blank means not dropped, and not trimmed.
  assert.deepEqual(splitMessage("  x  "), ["  x  "]);
  assert.deepEqual(splitMessage("\u200b"), ["\u200b"]);
  assert.deepEqual(splitMessage("x".repeat(512), 512), ["x".repeat(512)]);
});

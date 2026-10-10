// Sentence chunker for streaming TTS: LLM text deltas in, speakable chunks out. Pure and synchronous.
//
// A boundary is a run of . ! ? … (or CJK full stops) plus closing quotes/brackets, followed by whitespace, or a
// newline. The terminator at the very end of the buffer is held back until the next delta shows what follows it
// ("3." then "14" is a number), and `flush()` releases the rest at the end of the turn. German and English
// abbreviations, initials and ordinals do not end a sentence. `maxWords` caps a chunk so first audio starts early on
// long sentences: it cuts after the last comma/semicolon/colon in the second half of the window, else at the limit.

const ABBREVIATIONS = new Set([
  "z.b", "d.h", "u.a", "u.u", "i.d.r", "o.ä", "s.o", "s.u", "v.a", "z.t", "bzw", "ca", "dr", "prof", "nr", "hr", "fr", "str", "abb", "inkl", "ggf", "evtl", "usw", "etc", "vgl", "bsp", "zzgl", "max", "min", "tel", "ggü",
  "mr", "mrs", "ms", "st", "vs", "e.g", "i.e", "approx", "no", "inc", "ltd", "co", "jr", "sr", "mt", "dept", "fig",
]);
const MONTHS = new Set(["januar", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"]);
const DETERMINERS = new Set(["der", "die", "das", "den", "dem", "des", "am", "im", "zum", "zur", "beim", "vom", "auf", "ein", "eine", "einen", "einem", "einer", "mein", "dein", "sein", "unser", "euer"]);
const TERMINATORS = new Set([".", "!", "?", "…", "。", "！", "？"]);
const CLOSERS = new Set(['"', "'", ")", "]", "”", "’", "»", "«", "“"]);

export interface ChunkerOptions {
  /** Maximum words per emitted chunk. Default: unlimited. */
  maxWords?: number;
}

export class SentenceChunker {
  private buffer = "";
  private readonly maxWords: number;
  /** Everything before this index was scanned and holds no boundary yet; a push only scans the new tail. */
  private scanFrom = 0;
  private scanned = 0;

  constructor(options: ChunkerOptions = {}) {
    this.maxWords = options.maxWords !== undefined && options.maxWords > 0 ? Math.floor(options.maxWords) : Infinity;
  }

  /** Feed a text delta; returns the chunks that are complete now. */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** End of turn: release whatever is left. */
  flush(): string[] {
    const out = this.drain(true);
    this.buffer = "";
    this.scanFrom = 0;
    return out;
  }

  /** Characters the boundary scanner has examined so far (grows linearly with the input; for tests). */
  get scannedChars(): number {
    return this.scanned;
  }

  /** Text held back (not yet emitted). */
  get pending(): string {
    return this.buffer;
  }

  reset(): void {
    this.buffer = "";
    this.scanFrom = 0;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const b = findBoundary(this.buffer, this.scanFrom);
      this.scanned += b.scannedTo - this.scanFrom;
      if (b.end === undefined) { this.scanFrom = b.scannedTo; break; }
      const sentence = this.buffer.slice(0, b.end).trim();
      this.buffer = this.buffer.slice(b.end);
      this.scanFrom = 0;
      if (sentence !== "") out.push(...splitLong(sentence, this.maxWords, true).chunks);
    }
    const r = splitLong(this.buffer, this.maxWords, final);
    out.push(...r.chunks);
    if (r.rest !== this.buffer) this.scanFrom = 0; // text was cut from the front: indexes shifted
    this.buffer = r.rest;
    return out;
  }
}

/** One-shot helper for a complete text. */
export function chunkSentences(text: string, options: ChunkerOptions = {}): string[] {
  const c = new SentenceChunker(options);
  return [...c.push(text), ...c.flush()];
}

/**
 * Index just after the first valid sentence boundary at or after `from`, or undefined. `scannedTo` is where a later
 * call may resume: everything before it is settled (no boundary), a held-back terminator is re-examined next time.
 */
function findBoundary(text: string, from: number): { end: number | undefined; scannedTo: number } {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      if (text.slice(0, i).trim() !== "") return { end: i + 1, scannedTo: i + 1 };
      continue;
    }
    if (!TERMINATORS.has(ch)) continue;
    let j = i + 1;
    while (j < text.length && (TERMINATORS.has(text[j]!) || CLOSERS.has(text[j]!))) j++;
    if (j >= text.length) {
      // The terminator run touches the buffer end: wait for the next delta (the final flush emits the remainder).
      return { end: undefined, scannedTo: i };
    }
    if (!/\s/.test(text[j]!)) { i = j - 1; continue; }
    if (ch === ".") {
      const stop = isRealStop(text, i, j);
      if (stop === "wait") return { end: undefined, scannedTo: i };
      if (!stop) { i = j - 1; continue; }
    }
    return { end: j, scannedTo: j };
  }
  return { end: undefined, scannedTo: text.length };
}

/** Decide whether the "." at index i (run ends before j) closes a sentence. */
function isRealStop(text: string, i: number, j: number): boolean | "wait" {
  if (j - i > 1 && text.slice(i, j).includes("..")) return true; // ellipsis-like
  let s = i;
  while (s > 0 && !/\s/.test(text[s - 1]!)) s--;
  const token = text.slice(s, i); // word before the period, no period itself
  const lower = token.toLowerCase().replace(/^[("'“«\[]+/, "");
  if (lower === "") return true;
  if (ABBREVIATIONS.has(lower)) return false;
  // Dotted abbreviations such as "z.B." arrive as token "z.B"
  if (/^(\p{L}\.)+\p{L}$/u.test(lower) && ABBREVIATIONS.has(lower)) return false;
  // Single-letter initial: "J. Smith", "Smith, J. K."
  if (/^\p{Lu}$/u.test(token.replace(/^[("'“«\[]+/, ""))) return false;
  // Ordinal / list number: "3. Mai", "am 3. oder 4."
  if (/^\d+$/.test(lower)) {
    let k = j;
    while (k < text.length && /\s/.test(text[k]!)) k++;
    if (k >= text.length) return "wait"; // next word unknown: hold until the next delta
    const next = text.slice(k).match(/^[\p{L}\d]+/u)?.[0] ?? "";
    if (next === "") return true;
    if (k + next.length >= text.length) return "wait"; // next word may still be arriving
    if (/^\p{Ll}/u.test(next) || /^\d/.test(next) || MONTHS.has(next.toLowerCase())) return false;
    // "der 1. Platz": a German determiner or preposition before the number makes it an ordinal before a noun.
    if (/^\p{Lu}/u.test(next) && DETERMINERS.has(wordBefore(text, s))) return false;
  }
  return true;
}

function splitLong(text: string, maxWords: number, final: boolean): { chunks: string[]; rest: string } {
  if (!Number.isFinite(maxWords)) return { chunks: final && text.trim() !== "" ? [text.trim()] : [], rest: final ? "" : text };
  const chunks: string[] = [];
  let rest = text;
  for (;;) {
    const words = [...rest.matchAll(/\S+/g)];
    // Only complete words count while more text may follow.
    const complete = final || /\s$/.test(rest) ? words.length : words.length - 1;
    if (complete <= maxWords) {
      if (final && rest.trim() !== "") { chunks.push(rest.trim()); rest = ""; }
      return { chunks, rest };
    }
    let cut = maxWords;
    for (let k = maxWords - 1; k >= Math.floor(maxWords / 2); k--) {
      if (/[,;:—–)]$/.test(words[k]![0])) { cut = k + 1; break; }
    }
    const last = words[cut - 1]!;
    const idx = last.index! + last[0].length;
    chunks.push(rest.slice(0, idx).trim());
    rest = rest.slice(idx).replace(/^\s+/, "");
  }
}

/** The lower-cased word that ends just before index `end` (skipping spaces), or "". */
function wordBefore(text: string, end: number): string {
  let e = end;
  while (e > 0 && /\s/.test(text[e - 1]!)) e--;
  let b = e;
  while (b > 0 && !/\s/.test(text[b - 1]!)) b--;
  return text.slice(b, e).toLowerCase().replace(/^[("'“«\[]+|[,;:]+$/g, "");
}

export const DISCORD_MAX_TEXT = 2000;
const CLOSE = "\n```";
const FENCE_LINE = /^ {0,3}(`{3,})([^`\n]*)$/;

/** Splits `text` into chunks of at most `max` UTF-16 code units (Discord counts characters; code units are conservative).
 *  Prefers a paragraph break, then a newline, then a space inside the second half of the window; never splits a surrogate pair.
 *  A code fence that is open at a cut is closed at the end of the chunk and reopened (with its language) in the next one, so
 *  no chunk renders as a torn block. Whitespace-only chunks are dropped (Discord rejects empty content). */
export function splitMessage(text: string, max: number = DISCORD_MAX_TEXT): string[] {
  if (!Number.isInteger(max) || max < 16) throw new RangeError("max must be an integer >= 16");
  const out: string[] = [];
  let rest = text;
  let prefix = "";
  let fence = fenceAfter(text.slice(0, 0), undefined);
  while (prefix.length + rest.length > max) {
    let cut = cutFor(rest, max - prefix.length);
    let state = fenceAfter(rest.slice(0, cut), fence);
    if (state) {
      cut = cutFor(rest, max - prefix.length - CLOSE.length);
      state = fenceAfter(rest.slice(0, cut), fence);
    }
    cut = Math.max(1, cut);
    const prev = rest.charCodeAt(cut - 1);
    const next = rest.charCodeAt(cut);
    if (cut > 1 && prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    const piece = rest.slice(0, cut);
    state = fenceAfter(piece, fence);
    out.push(prefix + piece + (state ? (piece.endsWith("\n") ? "```" : CLOSE) : ""));
    rest = rest.slice(cut);
    fence = state;
    prefix = state ? `\`\`\`${state.lang}\n` : "";
  }
  out.push(prefix + rest);
  return out.filter((c) => c.trim().length > 0);
}

function cutFor(s: string, budget: number): number {
  if (s.length <= budget) return s.length;
  const floor = Math.floor(budget / 2);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = s.lastIndexOf(sep, budget - sep.length);
    if (i >= floor) return graphemeCut(s, i + sep.length);
  }
  return graphemeCut(s, Math.max(1, budget));
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const LOOKAHEAD = 64;

/** Moves `cut` back to the nearest extended grapheme cluster boundary at or before it, so a ZWJ sequence, a flag pair, a
 *  skin-tone or VS16 emoji, a combining mark or CRLF is never torn. A cluster that starts at 0 and spans the whole budget
 *  cannot be kept together; then the cut stays where it is (the caller still avoids splitting a surrogate pair). */
function graphemeCut(s: string, cut: number): number {
  if (cut >= s.length) return cut;
  let best = 0;
  for (const seg of GRAPHEMES.segment(s.slice(0, cut + LOOKAHEAD))) {
    if (seg.index > cut) break;
    best = seg.index;
  }
  return best > 0 ? best : cut;
}

interface Fence {
  lang: string;
  ticks: number;
}

/** Fence state after reading `piece` starting in state `initial` (line-oriented, like CommonMark). */
function fenceAfter(piece: string, initial: Fence | undefined): Fence | undefined {
  let state = initial;
  for (const line of piece.split("\n")) {
    const m = FENCE_LINE.exec(line);
    if (!m) continue;
    const ticks = m[1]!.length;
    const info = m[2]!.trim();
    if (!state) state = { lang: info.split(/\s+/)[0]!.slice(0, 12), ticks };
    else if (info === "" && ticks >= state.ticks) state = undefined;
  }
  return state;
}

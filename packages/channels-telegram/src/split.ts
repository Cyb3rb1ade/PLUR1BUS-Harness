export const TELEGRAM_MAX_TEXT = 4096;

/** Splits `text` into chunks of at most `max` UTF-16 code units (counting code units is conservative: Telegram's limit is
 *  in characters). Lossless apart from dropping whitespace-only chunks, which Telegram rejects. Prefers to break after a
 *  paragraph break, then a newline, then a space, within the second half of the window; never splits a surrogate pair or a grapheme cluster (unless one cluster exceeds `max`). */
export function splitMessage(text: string, max: number = TELEGRAM_MAX_TEXT): string[] {
  if (!Number.isInteger(max) || max < 2) throw new RangeError("max must be an integer >= 2");
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = breakPoint(rest, max);
    const prev = rest.charCodeAt(cut - 1);
    const next = rest.charCodeAt(cut);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    cut = graphemeSafeCut(rest, cut, Math.max(1, Math.floor(max / 2)));
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out.filter((c) => c.trim().length > 0);
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LOOKAHEAD = 64;

/** Moves `cut` back to the nearest grapheme-cluster boundary (CR+LF, flags, ZWJ sequences, combining marks stay whole).
 *  `rest` starts on a boundary. A chunk never gets shorter than `floor` (half the window);
 *  if no boundary lies in [floor, cut] (e.g. one cluster longer than half the window) the surrogate-safe cut stays. */
function graphemeSafeCut(rest: string, cut: number, floor: number): number {
  let best = 0;
  for (const seg of SEGMENTER.segment(rest.slice(0, cut + LOOKAHEAD))) {
    if (seg.index > cut) break;
    if (seg.index >= floor) best = seg.index;
  }
  return best > 0 ? best : cut;
}

function breakPoint(s: string, max: number): number {
  const floor = Math.floor(max / 2);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = s.lastIndexOf(sep, max - sep.length);
    if (i >= floor) return i + sep.length;
  }
  return max;
}

/** Escape literal text; splitting happens before escaping so neither entities nor escape pairs can be torn. */
export function escapeText(text: string, mode: "MarkdownV2" | "HTML"): string {
  return mode === "HTML"
    ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

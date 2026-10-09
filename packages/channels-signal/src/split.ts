import type { StyledText, TextStyle } from "./markdown.ts";

/** Conservative: Signal accepts far more, but long texts get turned into attachments by clients. */
export const SIGNAL_MAX_TEXT = 2000;

/** Splits `text` into chunks of at most `max` UTF-16 code units, never inside a surrogate pair. Prefers a paragraph break,
 *  then newline, then space within the second half of the window. Lossless apart from dropping whitespace-only chunks. */
export function splitMessage(text: string, max: number = SIGNAL_MAX_TEXT): string[] {
  return cuts(text, max)
    .map(([a, b]) => text.slice(a, b))
    .filter((c) => c.trim().length > 0);
}

function cuts(text: string, max: number): Array<[number, number]> {
  if (!Number.isInteger(max) || max < 2) throw new RangeError("max must be an integer >= 2");
  const out: Array<[number, number]> = [];
  let a = 0;
  while (text.length - a > max) {
    const win = text.slice(a, a + max + 1);
    let cut = breakPoint(win, max);
    const prev = text.charCodeAt(a + cut - 1);
    const next = text.charCodeAt(a + cut);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    out.push([a, a + cut]);
    a += cut;
  }
  out.push([a, text.length]);
  return out;
}

function breakPoint(s: string, max: number): number {
  const floor = Math.floor(max / 2);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = s.lastIndexOf(sep, max - sep.length);
    if (i >= floor) return i + sep.length;
  }
  return max;
}

/** Splits styled text; every range is clipped to the chunk and re-based, so a style that spans a cut is simply reopened
 *  in the next chunk (a long MONOSPACE block stays monospace in every message). Whitespace-only chunks are dropped. */
export function splitStyled(input: StyledText, max: number = SIGNAL_MAX_TEXT): StyledText[] {
  const out: StyledText[] = [];
  for (const [a, b] of cuts(input.text, max)) {
    const text = input.text.slice(a, b);
    if (!text.trim()) continue;
    const styles: TextStyle[] = [];
    for (const s of input.styles) {
      const from = Math.max(a, s.start),
        to = Math.min(b, s.start + s.length);
      if (to > from) styles.push({ start: from - a, length: to - from, style: s.style });
    }
    out.push({ text, styles });
  }
  return out;
}

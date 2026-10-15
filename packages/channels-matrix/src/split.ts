/** Conservative split size in UTF-8 bytes of the Markdown source (Matrix caps a whole event at 65 KiB incl. formatted_body). */
export const MATRIX_MAX_BODY_BYTES = 16_000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const enc = new TextEncoder();
const bytes = (s: string): number => enc.encode(s).length;
/** Room kept free in every chunk for a closing fence line (plus its newline). */
const RESERVE = 256;
/** A reopened fence line longer than this is replaced by its bare marker, so the reserve stays valid. */
const MAX_REOPEN_BYTES = 128;

interface Fence {
  char: string;
  marker: string;
  open: string;
}

/** Splits Markdown `text` into chunks of at most `max` UTF-8 bytes. Packs whole lines and hard-splits only lines that are
 *  longer than the window (on grapheme cluster boundaries, preferring a space). A chunk that ends inside a fenced code block is
 *  closed with a fence, and the next chunk reopens it with the same opening line, so every chunk is balanced on its own.
 *  Whitespace-only chunks are dropped. */
export function splitMessage(text: string, max: number = MATRIX_MAX_BODY_BYTES): string[] {
  if (!Number.isInteger(max) || max < 512) throw new RangeError("max must be an integer >= 512");
  if (bytes(text) <= max) return text.trim() ? [text] : [];
  const limit = max - RESERVE;
  const out: string[] = [];
  let cur = "";
  let fence: Fence | undefined;

  const closerOf = (f: Fence | undefined): string => (f ? `\n${f.marker}` : "");
  const reopenOf = (f: Fence | undefined): string => {
    if (!f) return "";
    return bytes(f.open) <= MAX_REOPEN_BYTES ? f.open : f.marker;
  };
  // `before` is the fence the already placed text ends in, `after` the one the text ends in once `piece` is placed. The budget
  // reserves the closer of `after` (an opener line fills the part together with its own closer), while a flush closes and
  // reopens `before` (a closing line that does not fit moves to the next part behind the reopened fence).
  const put = (piece: string, newline: boolean, before: Fence | undefined, after: Fence | undefined): void => {
    let sep = newline && cur !== "" ? "\n" : "";
    if (cur !== "" && bytes(cur) + bytes(sep) + bytes(piece) + bytes(closerOf(after)) > max) {
      if (cur.trim()) out.push(cur + closerOf(before));
      cur = reopenOf(before);
      // The reopened fence line always stands alone, also in front of a hard-split continuation.
      sep = cur !== "" ? "\n" : "";
    }
    cur += sep + piece;
  };

  for (const rawLine of text.split("\n")) {
    // A CommonMark reader treats CRLF as one line ending: fence detection ignores the "\r", the text keeps it.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const before = fence;
    let after = before;
    const close = fence ? FENCE_CLOSE.exec(line) : null;
    if (close && fence && close[1]![0] === fence.char && close[1]!.length >= fence.marker.length) after = undefined;
    else if (!fence) {
      const open = FENCE_OPEN.exec(line);
      if (open && open[1]!.length <= 64 && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        after = { char: open[1]![0]!, marker: open[1]!, open: rawLine };
      }
    }
    const pieces = bytes(rawLine) > limit ? hardSplit(rawLine, limit) : [rawLine];
    pieces.forEach((p, i) => put(p, i === 0, before, after));
    fence = after;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function hardSplit(line: string, limit: number): string[] {
  // Units are extended grapheme clusters; a cluster that alone exceeds the window is cut into code points as a last resort.
  const units: string[] = [];
  for (const { segment } of segmenter.segment(line)) {
    if (bytes(segment) <= limit) units.push(segment);
    else units.push(...segment);
  }
  const out: string[] = [];
  let i = 0;
  while (i < units.length) {
    let size = 0;
    let end = 0; // UTF-16 length of the piece so far
    let j = i;
    let lastSpace = -1; // piece length (UTF-16) after the last space
    let lastSpaceUnit = -1; // unit index after the last space
    while (j < units.length) {
      const u = units[j]!;
      const b = bytes(u);
      if (size + b > limit) break;
      size += b;
      end += u.length;
      j++;
      if (u === " ") {
        lastSpace = end;
        lastSpaceUnit = j;
      }
    }
    if (j >= units.length) {
      out.push(units.slice(i).join(""));
      break;
    }
    const useSpace = lastSpace > end / 2;
    const stop = useSpace ? lastSpaceUnit : j;
    out.push(units.slice(i, stop).join(""));
    i = stop;
  }
  return out;
}

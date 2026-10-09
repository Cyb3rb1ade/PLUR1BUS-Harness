/** Conservative split size in UTF-8 bytes of the Markdown source (Matrix caps a whole event at 65 KiB incl. formatted_body). */
export const MATRIX_MAX_BODY_BYTES = 16_000;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
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
 *  longer than the window (on code point boundaries, preferring a space). A chunk that ends inside a fenced code block is
 *  closed with a fence, and the next chunk reopens it with the same opening line, so every chunk is balanced on its own.
 *  Whitespace-only chunks are dropped. */
export function splitMessage(text: string, max: number = MATRIX_MAX_BODY_BYTES): string[] {
  if (!Number.isInteger(max) || max < 512) throw new RangeError("max must be an integer >= 512");
  if (bytes(text) <= max) return text.trim() ? [text] : [];
  const limit = max - RESERVE;
  const out: string[] = [];
  let cur = "";
  let fence: Fence | undefined;

  const closer = (): string => (fence ? `\n${fence.marker}` : "");
  const reopen = (): string => {
    if (!fence) return "";
    return bytes(fence.open) <= MAX_REOPEN_BYTES ? fence.open : fence.marker;
  };
  const flush = (): void => {
    if (cur.trim()) out.push(cur + closer());
    cur = reopen();
  };
  // `newline` is true for the first piece of a source line, false for hard-split continuations of the same line.
  const put = (piece: string, newline: boolean): void => {
    let sep = newline && cur !== "" ? "\n" : "";
    if (cur !== "" && bytes(cur) + bytes(sep) + bytes(piece) + bytes(closer()) > max) {
      flush();
      sep = newline && cur !== "" ? "\n" : "";
    }
    cur += sep + piece;
  };

  for (const line of text.split("\n")) {
    const close = fence ? FENCE_CLOSE.exec(line) : null;
    if (close && fence && close[1]![0] === fence.char && close[1]!.length >= fence.marker.length) {
      // The closing line belongs to the block being left: no reopen may happen while it is placed.
      fence = undefined;
    }
    const pieces = bytes(line) > limit ? hardSplit(line, limit) : [line];
    pieces.forEach((p, i) => put(p, i === 0));
    if (!fence && !close) {
      const open = FENCE_OPEN.exec(line);
      if (open && open[1]!.length <= 64 && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        fence = { char: open[1]![0]!, marker: open[1]!, open: line };
      }
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function hardSplit(line: string, limit: number): string[] {
  const out: string[] = [];
  let rest = line;
  while (bytes(rest) > limit) {
    let size = 0;
    let end = 0;
    let lastSpace = -1;
    for (const ch of rest) {
      const b = bytes(ch);
      if (size + b > limit) break;
      size += b;
      end += ch.length;
      if (ch === " ") lastSpace = end;
    }
    const cut = lastSpace > end / 2 ? lastSpace : end;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out;
}

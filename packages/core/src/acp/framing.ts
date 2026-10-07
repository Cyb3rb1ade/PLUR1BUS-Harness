// ACP stdio framing: one JSON-RPC message per line (UTF-8, `\n`; a preceding `\r` is dropped). The reader bounds a line
// by bytes before it is ever decoded, so a hostile peer cannot make the adapter buffer without limit.

/** RULING: 1 MiB per line. `session.submit` takes at most 200 000 characters of text (<= 800 KB as UTF-8), so a maximal
 *  prompt still fits with its JSON envelope; anything larger is refused rather than buffered. */
export const MAX_LINE_BYTES = 1024 * 1024;

export type LineItem = { line: string } | { overflow: true };

export class LineReader {
  readonly #max: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #discarding = false;
  constructor(maxLineBytes: number = MAX_LINE_BYTES) { this.#max = maxLineBytes; }

  push(chunk: Buffer): LineItem[] {
    const out: LineItem[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (!this.#discarding) {
        if (this.#size + piece.length > this.#max + (nl === -1 ? 0 : 1)) {
          // Bytes before the newline may include a trailing `\r`; a line is over the limit when its payload is.
          const payload = this.#size + piece.length - (nl !== -1 && piece.at(-1) === 0x0d ? 1 : 0);
          if (payload > this.#max) { out.push({ overflow: true }); this.#reset(); this.#discarding = nl === -1; }
          else { this.#chunks.push(piece); this.#size += piece.length; }
        } else { this.#chunks.push(piece); this.#size += piece.length; }
      }
      if (nl === -1) break;
      if (this.#discarding) this.#discarding = false;
      else { const item = this.#take(); if (item) out.push(item); }
      start = nl + 1;
    }
    return out;
  }

  /** The unterminated rest at end of input. */
  end(): LineItem[] {
    if (this.#discarding) { this.#discarding = false; this.#reset(); return []; }
    const item = this.#take();
    return item ? [item] : [];
  }

  #reset(): void { this.#chunks = []; this.#size = 0; }
  #take(): LineItem | null {
    let buf = Buffer.concat(this.#chunks, this.#size); this.#reset();
    if (buf.at(-1) === 0x0d) buf = buf.subarray(0, -1);
    if (buf.length > this.#max) return { overflow: true };
    return buf.length === 0 ? null : { line: buf.toString("utf8") };
  }
}

/** One message as one line. `JSON.stringify` escapes `\n`; U+2028/2029 stay literal but are no line break for this framing. */
export function encodeLine(message: unknown): string { return `${JSON.stringify(message)}\n`; }

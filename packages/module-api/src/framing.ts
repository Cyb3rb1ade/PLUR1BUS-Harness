export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class LineTooLong extends Error {
  constructor(bytes: number) { super(`line exceeds ${MAX_LINE_BYTES} bytes (${bytes})`); this.name = "LineTooLong"; }
}

export function encodeLine(value: unknown): Buffer {
  const text = JSON.stringify(value);
  if (text.includes("\n")) throw new Error("JSON.stringify never emits a raw newline; this is a bug");
  return Buffer.from(`${text}\n`, "utf8");
}

export class LineDecoder {
  #buf: Buffer = Buffer.alloc(0);

  /** Returns every complete value in the chunk; keeps the partial tail. */
  push(chunk: Buffer): unknown[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buf.subarray(start, nl);
      start = nl + 1;
      if (line.length === 0) continue;
      // Advance buffer before parse to ensure bad lines are discarded even if parse throws
      const oldBuf = this.#buf;
      this.#buf = this.#buf.subarray(start);
      try {
        out.push(JSON.parse(line.toString("utf8")));
      } catch (e) {
        // Buffer has been advanced past the bad line, so check size and rethrow
        if (this.#buf.length > MAX_LINE_BYTES) { const n = this.#buf.length; this.#buf = Buffer.alloc(0); throw new LineTooLong(n); }
        throw e;
      }
      start = 0; // Reset start since buffer has been updated
    }
    this.#buf = this.#buf.subarray(start);
    if (this.#buf.length > MAX_LINE_BYTES) { const n = this.#buf.length; this.#buf = Buffer.alloc(0); throw new LineTooLong(n); }
    return out;
  }
}

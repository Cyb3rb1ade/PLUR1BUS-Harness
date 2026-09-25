export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class LineTooLong extends Error {
  constructor(bytes: number) { super(`line exceeds ${MAX_LINE_BYTES} bytes (${bytes})`); this.name = "LineTooLong"; }
}

/** Lone surrogates serialise as `\udXXX` escapes, which strict parsers (serde_json in the Rust CLI) refuse. */
const SURROGATE_ESCAPE = /\\ud[89a-f]/i;

export function encodeLine(value: unknown): Buffer {
  let text = JSON.stringify(value);
  // Backstop for text the core does not produce itself (engine output): a well-formed pair is emitted raw, so an
  // escape here means a lone surrogate somewhere (or a literal backslash-u in content). Only then pay for a
  // replacer pass that turns every lone surrogate into U+FFFD.
  if (SURROGATE_ESCAPE.test(text)) text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "string" ? v.toWellFormed() : v));
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

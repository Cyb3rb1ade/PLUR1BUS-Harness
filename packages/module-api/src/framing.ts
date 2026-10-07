/** Maximum number of bytes accepted for an unterminated JSON-RPC line. */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Error raised when an NDJSON line exceeds {@link MAX_LINE_BYTES}. */
export class LineTooLong extends Error {
  constructor(bytes: number) { super(`line exceeds ${MAX_LINE_BYTES} bytes (${bytes})`); this.name = "LineTooLong"; }
}

/** Lone surrogates serialise as `\udXXX` escapes, which strict parsers (serde_json in the Rust CLI) refuse. */
const SURROGATE_ESCAPE = /\\ud[89a-f]/i;

/** Encodes one JSON value as UTF-8 NDJSON, including its terminating newline. */
export function encodeLine(value: unknown): Buffer {
  let text = JSON.stringify(value);
  // Backstop for text the core does not produce itself (engine output): a well-formed pair is emitted raw, so an
  // escape here means a lone surrogate somewhere (or a literal backslash-u in content). Only then pay for a
  // replacer pass that turns every lone surrogate into U+FFFD.
  if (SURROGATE_ESCAPE.test(text)) text = JSON.stringify(value, (_k, v: unknown) => (typeof v === "string" ? v.toWellFormed() : v));
  if (text.includes("\n")) throw new Error("JSON.stringify never emits a raw newline; this is a bug");
  return Buffer.from(`${text}\n`, "utf8");
}

/** What one chunk held: every parsed value, the parse errors of the lines that were not JSON, and, when the
 *  unterminated tail passed the limit, the `LineTooLong` (the connection is no longer in sync then). */
export interface DecodedChunk { values: unknown[]; bad: Error[]; tooLong?: LineTooLong }

/** Incremental NDJSON decoder that retains a partial line between chunks. */
export class LineDecoder {
  #buf: Buffer = Buffer.alloc(0);

  /** Splits the chunk into lines and parses each one on its own: a broken line never costs the valid lines around it
   *  (a request that was parsed is still answered). Keeps the partial tail. */
  decode(chunk: Buffer): DecodedChunk {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const values: unknown[] = [];
    const bad: Error[] = [];
    let start = 0;
    for (;;) {
      const nl = this.#buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buf.subarray(start, nl);
      start = nl + 1;
      if (line.length === 0) continue;
      try { values.push(JSON.parse(line.toString("utf8"))); } catch (e) { bad.push(e as Error); }
    }
    this.#buf = this.#buf.subarray(start);
    if (this.#buf.length > MAX_LINE_BYTES) {
      const n = this.#buf.length; this.#buf = Buffer.alloc(0);
      return { values, bad, tooLong: new LineTooLong(n) };
    }
    return { values, bad };
  }

  /** Returns every complete value in the chunk; keeps the partial tail. Throws the first parse error or
   *  `LineTooLong` after the whole chunk was consumed (the thrown error carries the values as `parsed`); servers use
   *  [`decode`](#decode) to answer the valid lines and reject only the broken ones. */
  push(chunk: Buffer): unknown[] {
    const { values, bad, tooLong } = this.decode(chunk);
    const failure = tooLong ?? bad[0];
    if (failure) { (failure as Error & { parsed?: unknown[] }).parsed = values; throw failure; }
    return values;
  }
}

import type { SecretFormsSnapshot } from "../../logs/secret-forms.ts";

/** A UTF-8 byte bound never introduces an incomplete final code point or an oversized replacement character. */
function utf8Prefix(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/** Retains only the source prefix plus full secret context; excess is drained without retaining input allocations. */
export class BoundedCapture {
  readonly #chunks: Uint8Array[] = [];
  readonly #limit: number;
  readonly #retention: number;
  readonly #knownSecrets: (() => SecretFormsSnapshot) | undefined;
  #bytes = 0;
  #seen = 0;
  #discarded = false;
  truncated = false;
  constructor(limit: number, knownSecrets?: () => SecretFormsSnapshot) {
    this.#limit = limit; this.#knownSecrets = knownSecrets;
    const snapshot = knownSecrets?.();
    this.#retention = limit + (snapshot ? Math.max(0, snapshot.matcher.maxSourceBytes - 1) + 3 : 0);
  }
  push(chunk: Uint8Array): void {
    if (chunk.length > this.#limit - this.#seen) this.truncated = true;
    this.#seen = Math.min(this.#limit, this.#seen + chunk.length);
    const room = this.#retention - this.#bytes;
    if (room <= 0) { if (chunk.length) this.#discarded = true; return; }
    const take = chunk.subarray(0, room);
    if (take.length < chunk.length) this.#discarded = true;
    this.#chunks.push(Uint8Array.from(take)); this.#bytes += take.length;
  }
  get retainedBytes(): number { return this.#chunks.reduce((n, c) => n + c.buffer.byteLength, 0); }
  text(complete = true): string {
    const snapshot = this.#knownSecrets?.();
    if (this.#discarded && snapshot && this.#limit + Math.max(0, snapshot.matcher.maxSourceBytes - 1) + 3 > this.#retention) {
      return utf8Prefix("[output withheld: secret context changed]", this.#limit);
    }
    const source = Buffer.concat(this.#chunks);
    // Live readers may arrive between two writes that together form a secret. Only expose the
    // prefix for which all potential matching bytes have already arrived.
    const pending = !complete && snapshot?.matcher.maxSourceBytes ? snapshot.matcher.maxSourceBytes - 1 + 3 : 0;
    const end = Math.min(this.#limit, Math.max(0, source.length - pending));
    // Process text uses UTF-8 replacement decoding. Match that complete spelling before a source-byte cut can hide it.
    const prefix = source.subarray(0, end).toString("utf8");
    const decoded = snapshot ? snapshot.matcher.maskTextWindow(source.toString("utf8"), 0, prefix.length) : prefix;
    if (Buffer.byteLength(decoded) > this.#limit) this.truncated = true;
    return utf8Prefix(decoded, this.#limit);
  }
}

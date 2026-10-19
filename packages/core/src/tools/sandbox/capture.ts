/** Drops excess chunks immediately; copies retained bytes so a tiny slice cannot retain a large input allocation. */
export class BoundedCapture {
  readonly #chunks: Uint8Array[] = [];
  readonly #limit: number;
  #bytes = 0;
  truncated = false;
  constructor(limit: number) { this.#limit = limit; }
  push(chunk: Uint8Array): void {
    const room = this.#limit - this.#bytes;
    if (room <= 0) { if (chunk.length) this.truncated = true; return; }
    const take = chunk.subarray(0, room);
    if (take.length < chunk.length) this.truncated = true;
    this.#chunks.push(Uint8Array.from(take)); this.#bytes += take.length;
  }
  get retainedBytes(): number { return this.#chunks.reduce((n, c) => n + c.buffer.byteLength, 0); }
  text(): string { return Buffer.concat(this.#chunks).toString('utf8'); }
}

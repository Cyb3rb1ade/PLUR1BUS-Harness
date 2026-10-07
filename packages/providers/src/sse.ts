import { protocolError } from "./errors.ts";

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG HTML §9.2): UTF-8 across chunk boundaries, LF/CRLF/CR line ends
 * (a CR at a chunk end waits for a possible LF), comment lines ignored, multi-line `data`, an event dispatched on
 * the blank line. An event cut off by the end of the stream is discarded, as the spec says. Any violation of the
 * limits or of UTF-8 is a `protocol` error.
 */
export class SseParser {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxEventBytes: number;
  #buf = "";
  #scanFrom = 0;
  #data: string[] = [];
  #dataBytes = 0;
  #event: string | undefined;
  #id: string | undefined;

  constructor(maxEventBytes: number) {
    this.#maxEventBytes = maxEventBytes;
  }

  push(chunk: Uint8Array): SseEvent[] {
    let text: string;
    try { text = this.#decoder.decode(chunk, { stream: true }); }
    catch (cause) { throw protocolError("stream is not valid UTF-8", { cause }); }
    this.#buf += text;
    return this.#drain(false);
  }

  /** End of input: flushes a trailing line; an unterminated event is dropped. */
  end(): SseEvent[] {
    try { this.#buf += this.#decoder.decode(); }
    catch (cause) { throw protocolError("stream is not valid UTF-8", { cause }); }
    const out = this.#drain(true);
    this.#data = []; this.#dataBytes = 0; this.#event = undefined; this.#id = undefined;
    return out;
  }

  #drain(final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    const buf = this.#buf;
    let i = 0;
    let j = Math.max(this.#scanFrom, 0);
    for (;;) {
      while (j < buf.length && buf[j] !== "\n" && buf[j] !== "\r") j++;
      if (j >= buf.length) break;
      if (buf[j] === "\r" && j + 1 === buf.length && !final) break;
      const line = buf.slice(i, j);
      i = buf[j] === "\r" && buf[j + 1] === "\n" ? j + 2 : j + 1;
      j = i;
      const ev = this.#line(line);
      if (ev) out.push(ev);
    }
    if (final && i < buf.length) {
      const ev = this.#line(buf.slice(i));
      i = buf.length;
      if (ev) out.push(ev);
    }
    this.#buf = buf.slice(i);
    this.#scanFrom = j - i;
    if (this.#buf.length > this.#maxEventBytes) throw protocolError(`SSE line exceeds ${this.#maxEventBytes} bytes`);
    return out;
  }

  #line(line: string): SseEvent | undefined {
    if (line === "") {
      const had = this.#data.length > 0;
      const ev: SseEvent = { data: this.#data.join("\n") };
      if (this.#event !== undefined) ev.event = this.#event;
      if (this.#id !== undefined) ev.id = this.#id;
      this.#data = []; this.#dataBytes = 0; this.#event = undefined;
      return had ? ev : undefined;
    }
    if (line[0] === ":") return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value[0] === " ") value = value.slice(1);
    if (field === "data") {
      this.#dataBytes += value.length + 1;
      if (this.#dataBytes > this.#maxEventBytes) throw protocolError(`SSE event exceeds ${this.#maxEventBytes} bytes`);
      this.#data.push(value);
    } else if (field === "event") this.#event = value;
    else if (field === "id" && !value.includes("\0")) this.#id = value;
    return undefined;
  }
}

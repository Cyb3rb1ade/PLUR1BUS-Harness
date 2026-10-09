import { VoiceProviderError, abortedError } from "./errors.ts";

/** Push-in, pull-out async queue with end and fail. One consumer. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | undefined;
  private rejecter: ((e: unknown) => void) | undefined;
  private done = false;
  private failure: unknown;
  private hasFailure = false;

  push(item: T): void {
    if (this.done) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      this.rejecter = undefined;
      w({ value: item, done: false });
    } else this.items.push(item);
  }
  end(): void {
    if (this.done) return;
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      this.rejecter = undefined;
      w({ value: undefined as never, done: true });
    }
  }
  fail(error: unknown): void {
    if (this.done) return;
    this.done = true;
    this.hasFailure = true;
    this.failure = error;
    if (this.rejecter) {
      const r = this.rejecter;
      this.waiter = undefined;
      this.rejecter = undefined;
      r(error);
    }
  }
  get closed(): boolean {
    return this.done;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.hasFailure) {
          this.hasFailure = false;
          return Promise.reject(this.failure);
        }
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => {
          this.waiter = resolve;
          this.rejecter = reject;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
  }
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64");
}
export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.byteLength;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function pcm16Seconds(byteLength: number, sampleRate: number): number {
  return byteLength / 2 / sampleRate;
}

/** Wrap mono pcm16 little-endian in a RIFF/WAVE container (for multipart batch ASR uploads). */
export function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new Uint8Array(44);
  const v = new DataView(header.buffer);
  const write = (o: number, s: string) => { for (let i = 0; i < s.length; i++) header[o + i] = s.charCodeAt(i); };
  write(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVE");
  write(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  write(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  return concatBytes([header, pcm]);
}

export function throwIfAborted(signal: AbortSignal | undefined, provider: string): void {
  if (signal?.aborted) throw abortedError(provider);
}

/** Resolve a text input (string or chunk stream) into an async iterable of chunks. */
export async function* textChunks(input: string | AsyncIterable<string>): AsyncGenerator<string> {
  if (typeof input === "string") yield input;
  else yield* input;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** TLS everywhere; plaintext only to a loopback host (the test fake servers, or a local relay). */
export function assertSecureTransport(url: string, provider: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new VoiceProviderError("config", `${provider}: invalid URL`, { provider });
  }
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const plain = u.protocol === "http:" || u.protocol === "ws:";
  if (!secure && !(plain && isLoopbackHost(u.hostname))) throw new VoiceProviderError("config", `${provider}: only https/wss URLs are allowed (plain http/ws only to loopback)`, { provider });
  return u;
}

import { AUDIO_LIMITS } from "./constants.ts";
import { VoiceProviderError, abortedError } from "./errors.ts";

export interface AsyncQueueOptions {
  /** Most items held for a consumer that is not reading. Past it the queue fails with `overloaded`. Unbounded when absent. */
  maxItems?: number;
}

/** Push-in, pull-out async queue with end and fail. One consumer. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private readonly maxItems: number;
  constructor(o: AsyncQueueOptions = {}) {
    this.maxItems = o.maxItems ?? Number.POSITIVE_INFINITY;
  }
  private waiter: ((r: IteratorResult<T>) => void) | undefined;
  private rejecter: ((e: unknown) => void) | undefined;
  private done = false;
  private failure: unknown;
  private hasFailure = false;

  /** False when the item was not taken: the queue is already finished, or it just overflowed and failed with `overloaded`. */
  push(item: T): boolean {
    if (this.done) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      this.rejecter = undefined;
      w({ value: item, done: false });
    } else if (this.items.length >= this.maxItems) {
      this.fail(new VoiceProviderError("overloaded", "event queue is full: the consumer is not keeping up"));
      return false;
    } else this.items.push(item);
    return true;
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

/** Duration of pcm16 mono audio. An invalid rate or length is 0 seconds, never NaN, Infinity or a negative number. */
export function pcm16Seconds(byteLength: number, sampleRate: number): number {
  if (!isSampleRate(sampleRate) || !Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return byteLength / 2 / sampleRate;
}

/** A sample rate a voice vendor can take: an integer within AUDIO_LIMITS. */
export function isSampleRate(rate: unknown): rate is number {
  return typeof rate === "number" && Number.isInteger(rate) && rate >= AUDIO_LIMITS.minSampleRate && rate <= AUDIO_LIMITS.maxSampleRate;
}
export function assertSampleRate(rate: unknown, provider: string): number {
  if (!isSampleRate(rate)) throw new VoiceProviderError("invalid_request", `${provider}: sample rate must be a whole number between ${AUDIO_LIMITS.minSampleRate} and ${AUDIO_LIMITS.maxSampleRate} Hz`, { provider });
  return rate;
}
/** A token or character count from a vendor frame: a non-negative safe integer, else undefined (never reported). */
export function countOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/** Own-property lookup: a key like "constructor" or "__proto__" is not an entry. */
export function ownValue<T>(rec: Readonly<Record<string, T>>, key: string | undefined): T | undefined {
  return key !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;
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
  // A credential in the URL would end up in config dumps and logs, and Node's fetch refuses it with a raw error anyway.
  if (u.username !== "" || u.password !== "") throw new VoiceProviderError("config", `${provider}: URLs must not carry credentials (user:password@)`, { provider });
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const plain = u.protocol === "http:" || u.protocol === "ws:";
  if (!secure && !(plain && isLoopbackHost(u.hostname))) throw new VoiceProviderError("config", `${provider}: only https/wss URLs are allowed (plain http/ws only to loopback)`, { provider });
  return u;
}

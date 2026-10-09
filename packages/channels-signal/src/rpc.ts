import type { Duplex } from "node:stream";

export type SignalErrorKind =
  | "rate-limited"
  | "untrusted-identity"
  | "not-registered"
  | "timeout"
  | "not-connected"
  | "disconnected"
  | "rpc"
  | "protocol";

/** Every message is fixed text built here; daemon-supplied strings (which can contain numbers) are never copied in. */
export class SignalRpcError extends Error {
  readonly kind: SignalErrorKind;
  readonly retryAfterMs?: number;
  readonly code?: number;
  constructor(kind: SignalErrorKind, message: string, extra: { retryAfterMs?: number; code?: number } = {}) {
    super(message);
    this.name = "SignalRpcError";
    this.kind = kind;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.code !== undefined) this.code = extra.code;
  }
}

export type TimeoutFn = (ms: number, signal: AbortSignal) => Promise<void>;

export const RATE_LIMIT_MIN_MS = 1000;
export const RATE_LIMIT_MAX_MS = 300_000;

interface RpcErrorObject {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

/** Maps a JSON-RPC error object from signal-cli to a typed error. Matching is on the message and the nested `data` only. */
export function mapRpcError(e: RpcErrorObject): SignalRpcError {
  const code = typeof e.code === "number" ? e.code : undefined;
  const blob = `${typeof e.message === "string" ? e.message : ""} ${safeJson(e.data)}`;
  const extra = code !== undefined ? { code } : {};
  if (/NotRegistered|not registered|is not registered/i.test(blob))
    return new SignalRpcError("not-registered", "signal account is not registered", extra);
  if (/UntrustedIdentity|untrusted identity/i.test(blob))
    return new SignalRpcError("untrusted-identity", "signal identity key is not trusted for the recipient", extra);
  if (/RATE_LIMIT|rate.?limit|too many requests|\b429\b/i.test(blob)) {
    const secs = /"retryAfterSeconds"\s*:\s*(\d+(?:\.\d+)?)/.exec(blob) ?? /retry.?after\D{0,12}(\d+(?:\.\d+)?)/i.exec(blob);
    const raw = secs ? Math.round(Number(secs[1]) * 1000) : RATE_LIMIT_MIN_MS;
    const retryAfterMs = Math.min(RATE_LIMIT_MAX_MS, Math.max(RATE_LIMIT_MIN_MS, raw));
    return new SignalRpcError("rate-limited", "signal rate limit", { ...extra, retryAfterMs });
  }
  return new SignalRpcError("rpc", code === -32601 ? "signal method not found" : "signal request failed", extra);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

export interface RpcClientOptions {
  stream: Duplex;
  timeoutMs: number;
  /** Deadline timer. Resolves after ms or when the signal aborts (aborting means the call settled first). */
  timeout: TimeoutFn;
  maxLineBytes: number;
  onNotification: (method: string, params: unknown) => void;
  onClose?: (reason: "closed" | "oversize") => void;
}

/** Newline-delimited JSON-RPC 2.0 over a duplex stream. Reader survives bad lines, split and coalesced chunks. */
export class JsonRpcClient {
  readonly #o: RpcClientOptions;
  readonly #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: SignalRpcError) => void }>();
  readonly #parts: Buffer[] = [];
  #partLen = 0;
  #next = 1;
  #closed = false;
  readonly closed: Promise<void>;
  #resolveClosed!: () => void;
  constructor(o: RpcClientOptions) {
    this.#o = o;
    this.closed = new Promise<void>((r) => (this.#resolveClosed = r));
    o.stream.on("data", (chunk: Buffer | string) => this.#onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk));
    o.stream.on("error", () => this.#finish("closed"));
    o.stream.on("close", () => this.#finish("closed"));
    o.stream.on("end", () => this.#finish("closed"));
  }
  get isOpen(): boolean {
    return !this.#closed;
  }
  close(): void {
    this.#finish("closed");
  }
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new SignalRpcError("not-connected", "signal daemon is not connected"));
    if (signal?.aborted) return Promise.reject(new SignalRpcError("not-connected", "signal call aborted"));
    const id = String(this.#next++);
    const ac = new AbortController();
    return new Promise<T>((resolve, reject) => {
      const settle = () => {
        ac.abort();
        this.#pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        settle();
        reject(new SignalRpcError("not-connected", "signal call aborted"));
      };
      this.#pending.set(id, {
        resolve: (v) => {
          settle();
          resolve(v as T);
        },
        reject: (e) => {
          settle();
          reject(e);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.#o.timeout(this.#o.timeoutMs, ac.signal).then(() => {
        if (!ac.signal.aborted && this.#pending.has(id)) {
          this.#pending.get(id)!.reject(new SignalRpcError("timeout", "signal request timed out"));
        }
      });
      const line = JSON.stringify({ jsonrpc: "2.0", id: Number(id), method, params }) + "\n";
      this.#o.stream.write(line, (err) => {
        if (err) this.#pending.get(id)?.reject(new SignalRpcError("disconnected", "signal daemon write failed"));
      });
    });
  }
  #finish(reason: "closed" | "oversize"): void {
    if (this.#closed) return;
    this.#closed = true;
    const err = new SignalRpcError("disconnected", "signal daemon connection closed");
    for (const p of [...this.#pending.values()]) p.reject(err);
    this.#pending.clear();
    this.#parts.length = 0;
    this.#partLen = 0;
    if (!this.#o.stream.destroyed) this.#o.stream.destroy();
    this.#resolveClosed();
    try {
      this.#o.onClose?.(reason);
    } catch {
      /* close observers must not throw into the reader */
    }
  }
  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    let off = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, off);
      if (nl < 0) {
        const rest = chunk.subarray(off);
        this.#parts.push(rest);
        this.#partLen += rest.length;
        if (this.#partLen > this.#o.maxLineBytes) this.#finish("oversize");
        return;
      }
      const tail = chunk.subarray(off, nl);
      if (this.#partLen + tail.length > this.#o.maxLineBytes) return this.#finish("oversize");
      const line = this.#parts.length ? Buffer.concat([...this.#parts, tail]) : tail;
      this.#parts.length = 0;
      this.#partLen = 0;
      off = nl + 1;
      if (line.length) this.#handle(line.toString("utf8"));
      if (this.#closed) return;
    }
  }
  #handle(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(line);
      if (!v || typeof v !== "object" || Array.isArray(v)) return;
      msg = v as Record<string, unknown>;
    } catch {
      return; // garbage line: skip it, keep the connection
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (typeof msg.method === "string") {
      if (!hasId) {
        try {
          this.#o.onNotification(msg.method, msg.params);
        } catch {
          /* handler errors never kill the reader */
        }
      } else {
        // Server-to-client requests are not part of the signal-cli protocol: answer politely and move on.
        const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
        this.#o.stream.write(reply + "\n", () => {});
      }
      return;
    }
    if (!hasId) return;
    const p = this.#pending.get(String(msg.id));
    if (!p) return;
    if (msg.error && typeof msg.error === "object") p.reject(mapRpcError(msg.error as RpcErrorObject));
    else p.resolve(msg.result);
  }
}

export function defaultTimeout(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    t.unref?.();
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

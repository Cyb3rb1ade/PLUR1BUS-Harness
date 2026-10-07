import { ChatAccumulator, parseCompletion } from "./accumulate.ts";
import { redactAll, classifyHttpError, classifyStreamError, isRecord, protocolError, ProviderError } from "./errors.ts";
import { buildRequestBody } from "./request.ts";
import { SseParser } from "./sse.ts";
import type {
  CallOptions, ChatCompletionsAdapter, ChatCompletionsConfig, ChatRequest, ChatStreamEvent, Limits, Timeouts,
} from "./types.ts";

export const DEFAULT_TIMEOUTS: Timeouts = { headersMs: 60_000, idleMs: 60_000, totalMs: 600_000 };
export const DEFAULT_LIMITS: Limits = { maxEventBytes: 4 * 1024 * 1024, maxToolArgumentBytes: 1024 * 1024, maxBodyBytes: 16 * 1024 * 1024 };
export const FORBIDDEN_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "host", "content-length", "content-type", "accept", "transfer-encoding", "connection"]);
export const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

type Cause = { kind: "aborted"; reason: unknown } | { kind: "timeout"; phase: "headers" | "idle" | "total" };

function endpoint(baseUrl: string): URL {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new TypeError("baseUrl is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError("baseUrl must be http(s)");
  if (u.username || u.password) throw new TypeError("baseUrl must not carry credentials");
  if (u.search || u.hash) throw new TypeError("baseUrl must not carry a query or fragment");
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/chat/completions`;
  return u;
}

/**
 * One call's lifetime: the combined abort signal (caller + three timeouts), the timers, and the single place
 * that decides what an interruption is. `dispose()` always runs and leaves no timer, request or listener behind.
 */
export class Run {
  readonly controller = new AbortController();
  readonly #timeouts: Timeouts;
  readonly #userSignal: AbortSignal | undefined;
  readonly #onUserAbort: () => void;
  #cause: Cause | undefined;
  #headers: NodeJS.Timeout | undefined;
  #idle: NodeJS.Timeout | undefined;
  #total: NodeJS.Timeout | undefined;

  constructor(timeouts: Timeouts, userSignal: AbortSignal | undefined) {
    this.#timeouts = timeouts;
    this.#userSignal = userSignal;
    this.#onUserAbort = () => this.#interrupt({ kind: "aborted", reason: userSignal?.reason });
    if (userSignal?.aborted) this.#onUserAbort();
    else userSignal?.addEventListener("abort", this.#onUserAbort, { once: true });
    if (timeouts.totalMs !== null) this.#total = setTimeout(() => this.#interrupt({ kind: "timeout", phase: "total" }), timeouts.totalMs);
  }

  get signal(): AbortSignal { return this.controller.signal; }

  #interrupt(c: Cause): void {
    this.#cause ??= c;
    if (!this.controller.signal.aborted) this.controller.abort(c);
  }

  throwIfInterrupted(): void {
    if (this.#cause) throw this.interruption(undefined);
  }

  armHeaders(): void {
    if (this.#timeouts.headersMs !== null) this.#headers = setTimeout(() => this.#interrupt({ kind: "timeout", phase: "headers" }), this.#timeouts.headersMs);
  }
  headersArrived(): void { clearTimeout(this.#headers); this.#headers = undefined; }

  /** A network read returned: the silence bound covers only the wait for the network, never the consumer's time. */
  idleDone(): void { clearTimeout(this.#idle); this.#idle = undefined; }

  armIdle(): void {
    clearTimeout(this.#idle);
    if (this.#timeouts.idleMs !== null) this.#idle = setTimeout(() => this.#interrupt({ kind: "timeout", phase: "idle" }), this.#timeouts.idleMs);
  }

  /** Set by the adapter once it knows its secrets; transport error text passes through it before it is stored. */
  redact: (s: string) => string = (s) => s;

  interruption(cause: unknown): ProviderError {
    const c = this.#cause;
    if (c?.kind === "timeout") return new ProviderError("timeout", `provider call timed out (${c.phase})`, { timeoutPhase: c.phase, cause });
    if (c?.kind === "aborted") return new ProviderError("aborted", "call aborted by the caller", { cause: c.reason });
    // RULING: a transport error may echo request headers (and so the credential) in its text; neither the message nor the cause chain keeps the raw text.
    const text = this.redact(cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
    const safeCause = new Error(text, cause instanceof Error && cause.cause !== undefined ? { cause: new Error(this.redact(String((cause.cause as { message?: unknown })?.message ?? cause.cause)).slice(0, 500)) } : undefined);
    safeCause.name = cause instanceof Error ? cause.name : "Error";
    safeCause.stack = `${safeCause.name}: ${text}`;
    return new ProviderError("network", `network failure: ${text}`, { cause: safeCause });
  }

  /** Any thrown value → the taxonomy. A `ProviderError` we raised ourselves passes through untouched. */
  normalise(e: unknown): ProviderError {
    if (e instanceof ProviderError) return this.#cause && e.kind === "network" ? this.interruption(e) : e;
    return this.interruption(e);
  }

  dispose(): void {
    clearTimeout(this.#headers); clearTimeout(this.#idle); clearTimeout(this.#total);
    this.#userSignal?.removeEventListener("abort", this.#onUserAbort);
    // Cancels the request and its body if still open: the socket is released on every exit path.
    if (!this.controller.signal.aborted) this.controller.abort(new Error("call finished"));
  }
}

export async function* chunks(body: ReadableStream<Uint8Array>, run: Run): AsyncGenerator<Uint8Array, void, void> {
  const reader = body.getReader();
  try {
    for (;;) {
      run.armIdle();
      const { done, value } = await reader.read();
      run.idleDone();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readText(body: ReadableStream<Uint8Array> | null, run: Run, max: number): Promise<string> {
  if (!body) return "";
  const dec = new TextDecoder("utf-8");
  let out = "", bytes = 0;
  for await (const c of chunks(body, run)) {
    bytes += c.byteLength;
    if (bytes > max) throw protocolError(`response body exceeds ${max} bytes`);
    out += dec.decode(c, { stream: true });
  }
  return out + dec.decode();
}

export function createChatCompletionsAdapter(config: ChatCompletionsConfig): ChatCompletionsAdapter {
  const url = endpoint(config.baseUrl);
  const extra: [string, string][] = [];
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new TypeError(`header "${k}" is managed by the adapter`);
    if (/[\r\n]/.test(k + v)) throw new TypeError("header contains a line break");
    extra.push([k, v]);
  }
  // RULING: caller-supplied header values (api-key style) are secrets too; they are redacted like the credential.
  const extraSecrets = extra.map(([, v]) => v);
  const doFetch = config.fetch ?? globalThis.fetch;
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const maxTokensField = config.maxTokensField ?? "max_tokens";
  const includeUsage = config.includeUsage ?? true;
  const insecureOk = url.protocol === "https:" || LOOPBACK.has(url.hostname) || config.allowInsecureHttp === true;

  async function begin(req: ChatRequest, opts: CallOptions | undefined, stream: boolean) {
    const body = JSON.stringify(buildRequestBody(req, { stream, maxTokensField, includeUsage }));
    const merged: Timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts, ...opts?.timeouts };
    // RULING: a non-stream call gets its headers only when generation ends, so its headers bound defaults to the total bound.
    if (!stream && opts?.timeouts?.headersMs === undefined && config.timeouts?.headersMs === undefined) merged.headersMs = merged.totalMs;
    const run = new Run(merged, opts?.signal);
    let secret = "";
    const redact = (s: string) => redactAll(s, secret, extraSecrets);
    run.redact = redact;
    try {
      run.throwIfInterrupted();
      let auth: string | undefined;
      try { auth = await config.credentials.authorization({ signal: run.signal }); }
      catch (e) {
        if (run.signal.aborted) throw run.interruption(e);
        throw new ProviderError("auth", "credentials provider failed", { cause: e });
      }
      run.throwIfInterrupted();
      const headers = new Headers({ "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" });
      for (const [k, v] of extra) headers.set(k, v);
      if (auth !== undefined) {
        if (auth === "" || /[\x00-\x1f\x7f]/.test(auth)) throw new ProviderError("auth", "credentials provider returned an unusable Authorization value");
        if (!insecureOk) throw new ProviderError("invalid_request", "refusing to send credentials over plain http to a non-loopback host");
        secret = auth.includes(" ") ? auth.slice(auth.lastIndexOf(" ") + 1) : auth;
        headers.set("authorization", auth);
      }
      run.armHeaders();
      let res: Response;
      try { res = await doFetch(url, { method: "POST", headers, body, signal: run.signal, redirect: "manual" }); }
      catch (e) { throw run.normalise(e); }
      run.headersArrived();
      if (!res.ok) {
        let text = "";
        try { text = await readText(res.body, run, Math.min(limits.maxBodyBytes, 64 * 1024)); } catch (e) { if (run.signal.aborted) throw run.normalise(e); }
        throw classifyHttpError(res.status, res.headers, text, Date.now(), redact);
      }
      return { run, res, redact };
    } catch (e) {
      run.dispose();
      throw e instanceof ProviderError ? e : run.normalise(e);
    }
  }

  return {
    async complete(req, opts) {
      const { run, res, redact } = await begin(req, opts, false);
      try {
        const text = await readText(res.body, run, limits.maxBodyBytes);
        let json: unknown;
        try { json = JSON.parse(text); } catch (cause) { throw protocolError("response body is not valid JSON", { cause }); }
        return await parseCompletion(json, redact, config.repair, req.tools, run.signal);
      } catch (e) {
        throw run.normalise(e);
      } finally {
        run.dispose();
      }
    },

    async *stream(req, opts): AsyncGenerator<ChatStreamEvent, void, void> {
      const { run, res, redact } = await begin(req, opts, true);
      const acc = new ChatAccumulator(redact, limits.maxToolArgumentBytes);
      try {
        const type = res.headers.get("content-type") ?? "";
        if (/^application\/(\w+\+)?json\b/i.test(type)) {
          // A 200 JSON body on a stream request: an error object some servers send in place of an SSE stream, else a server that ignored `stream`.
          const text = await readText(res.body, run, limits.maxBodyBytes);
          let json: unknown;
          try { json = JSON.parse(text); } catch (cause) { throw protocolError("response body is not valid JSON", { cause }); }
          if (isRecord(json) && json["error"] !== undefined && json["error"] !== null) throw classifyStreamError(json, redact);
          throw protocolError("expected text/event-stream, got a JSON body");
        }
        if (!/^text\/event-stream\b/i.test(type)) throw protocolError(`expected text/event-stream, got "${redact(type.slice(0, 80))}"`);
        if (!res.body) throw protocolError("response has no body");
        const parser = new SseParser(limits.maxEventBytes);
        let done = false;
        const handle = function* (events: ReturnType<SseParser["push"]>): Generator<ChatStreamEvent> {
          for (const ev of events) {
            if (done) return;
            if (ev.data === "[DONE]") { done = true; return; }
            if (ev.data === "") continue; // an empty `data:` line is a keep-alive some servers send, not an error
            let json: unknown;
            try { json = JSON.parse(ev.data); } catch (cause) { throw protocolError("SSE data is not valid JSON", { cause }); }
            yield* acc.push(json);
          }
        };
        for await (const c of chunks(res.body, run)) {
          yield* handle(parser.push(c));
          if (done) break;
        }
        if (!done) {
          yield* handle(parser.end());
          // RULING: a stream that ends without [DONE] is truncated unless the adapter was told to accept a finished one.
          if (!done && !(config.allowMissingDone && acc.finished)) throw protocolError("stream ended without [DONE]");
        }
        yield { type: "done", result: await acc.finish(config.repair, req.tools, run.signal) };
      } catch (e) {
        const err = run.normalise(e);
        if (err.partial === undefined && err.kind !== "auth" && !(err.kind === "invalid_request" && !err.contentFiltered)) err.partial = acc.snapshot();
        throw err;
      } finally {
        run.dispose();
      }
    },
  };
}

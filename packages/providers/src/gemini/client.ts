import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS, chunks, FORBIDDEN_HEADERS, LOOPBACK, readText, Run } from "../client.ts";
import { isRecord, ProviderError } from "../errors.ts";
import { SseParser } from "../sse.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Limits, Timeouts } from "../types.ts";
import { classifyGeminiHttp, classifyGeminiStreamError } from "./errors.ts";
import { buildGeminiBody, modelPath } from "./request.ts";
import { GeminiAccumulator } from "./response.ts";
import type { GeminiAdapter, GeminiConfig } from "./types.ts";

export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const KEY_HEADER = "x-goog-api-key";

function baseOf(baseUrl: string): URL {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new TypeError("baseUrl is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError("baseUrl must be http(s)");
  if (u.username || u.password) throw new TypeError("baseUrl must not carry credentials");
  // The key travels in a header only; a query or fragment on the base URL is how keys end up in URLs and logs.
  if (u.search || u.hash) throw new TypeError("baseUrl must not carry a query or fragment");
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u;
}

function endpointFor(base: URL, model: string, stream: boolean): URL {
  const u = new URL(base);
  u.pathname = `${u.pathname}/${modelPath(model)}:${stream ? "streamGenerateContent" : "generateContent"}`;
  if (stream) u.search = "?alt=sse";
  return u;
}

/**
 * The Gemini adapter (`generateContent` / `streamGenerateContent`). Same lifetime, abort and timeout machinery as the
 * chat_completions adapter (`Run`), a different wire format.
 *
 * Key handling: read from `config.credentials` on every call, sent only as the `x-goog-api-key` header, refused over
 * plain `http:` to a non-loopback host, scrubbed from every provider text the adapter stores. It is never part of the
 * URL, query, body, error message or `cause` the adapter creates itself. A missing key is an `auth` error before any I/O.
 */
export function createGeminiAdapter(config: GeminiConfig): GeminiAdapter {
  const base = baseOf(config.baseUrl ?? GEMINI_DEFAULT_BASE_URL);
  const forbidden = new Set([...FORBIDDEN_HEADERS, KEY_HEADER]);
  const extra: [string, string][] = [];
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (forbidden.has(k.toLowerCase())) throw new TypeError(`header "${k}" is managed by the adapter`);
    if (/[\r\n]/.test(k + v)) throw new TypeError("header contains a line break");
    extra.push([k, v]);
  }
  const doFetch = config.fetch ?? globalThis.fetch;
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const insecureOk = base.protocol === "https:" || LOOPBACK.has(base.hostname) || config.allowInsecureHttp === true;

  async function begin(req: ChatRequest, opts: CallOptions | undefined, stream: boolean) {
    const body = JSON.stringify(buildGeminiBody(req));
    const url = endpointFor(base, req.model, stream);
    const merged: Timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts, ...opts?.timeouts };
    // RULING: as for chat_completions, a non-stream call gets its headers when generation ends, so its headers bound defaults to the total bound.
    if (!stream && opts?.timeouts?.headersMs === undefined && config.timeouts?.headersMs === undefined) merged.headersMs = merged.totalMs;
    const run = new Run(merged, opts?.signal);
    let secret = "";
    const redact = (s: string) => (secret.length >= 6 ? s.split(secret).join("[redacted]") : s);
    try {
      run.throwIfInterrupted();
      let key: string | undefined;
      try { key = await config.credentials.apiKey({ signal: run.signal }); }
      catch (e) {
        if (run.signal.aborted) throw run.interruption(e);
        // The cause is the store's own error; this adapter adds nothing to it and has no key to add.
        throw new ProviderError("auth", "credentials provider failed", { cause: e });
      }
      run.throwIfInterrupted();
      if (key === undefined) throw new ProviderError("auth", "no API key is stored for this profile");
      if (key === "" || /[\x00-\x20\x7f]/.test(key)) throw new ProviderError("auth", "the stored API key is unusable (empty, or contains whitespace or control characters)");
      if (!insecureOk) throw new ProviderError("bad_request", "refusing to send the API key over plain http to a non-loopback host");
      secret = key;
      const headers = new Headers({ "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" });
      for (const [k, v] of extra) headers.set(k, v);
      headers.set(KEY_HEADER, key);
      run.armHeaders();
      let res: Response;
      try { res = await doFetch(url, { method: "POST", headers, body, signal: run.signal, redirect: "manual" }); }
      catch (e) { throw run.normalise(e); }
      run.headersArrived();
      if (!res.ok) {
        let text = "";
        try { text = await readText(res.body, run, Math.min(limits.maxBodyBytes, 64 * 1024)); } catch (e) { if (run.signal.aborted) throw run.normalise(e); }
        throw classifyGeminiHttp(res.status, res.headers, text, Date.now(), redact);
      }
      return { run, res, redact };
    } catch (e) {
      run.dispose();
      throw e instanceof ProviderError ? e : run.normalise(e);
    }
  }

  async function parseJson(text: string): Promise<unknown> {
    try { return JSON.parse(text); } catch (cause) { throw new ProviderError("protocol", "response body is not valid JSON", { cause }); }
  }

  return {
    async complete(req, opts): Promise<ChatResult> {
      const { run, res, redact } = await begin(req, opts, false);
      const acc = new GeminiAccumulator(redact, limits.maxToolArgumentBytes);
      try {
        const json = await parseJson(await readText(res.body, run, limits.maxBodyBytes));
        acc.push(json);
        return acc.finish();
      } catch (e) {
        throw run.normalise(e);
      } finally {
        run.dispose();
      }
    },

    async *stream(req, opts): AsyncGenerator<ChatStreamEvent, void, void> {
      const { run, res, redact } = await begin(req, opts, true);
      const acc = new GeminiAccumulator(redact, limits.maxToolArgumentBytes);
      try {
        const type = res.headers.get("content-type") ?? "";
        if (/^application\/(\w+\+)?json\b/i.test(type)) {
          // A 200 JSON body on a stream request: an error object, or a server that ignored `alt=sse` (a JSON array of chunks).
          const json = await parseJson(await readText(res.body, run, limits.maxBodyBytes));
          const first = Array.isArray(json) ? json[0] : json;
          if (isRecord(first) && first["error"] !== undefined && first["error"] !== null) throw classifyGeminiStreamError(first, redact);
          throw new ProviderError("protocol", "expected text/event-stream, got a JSON body");
        }
        if (!/^text\/event-stream\b/i.test(type)) throw new ProviderError("protocol", `expected text/event-stream, got "${type.slice(0, 80)}"`);
        if (!res.body) throw new ProviderError("protocol", "response has no body");
        const parser = new SseParser(limits.maxEventBytes);
        const handle = function* (events: ReturnType<SseParser["push"]>): Generator<ChatStreamEvent> {
          for (const ev of events) {
            if (ev.data === "") continue; // keep-alive
            let json: unknown;
            try { json = JSON.parse(ev.data); } catch (cause) { throw new ProviderError("protocol", "SSE data is not valid JSON", { cause }); }
            yield* acc.push(json);
          }
        };
        for await (const c of chunks(res.body, run)) yield* handle(parser.push(c));
        yield* handle(parser.end());
        // RULING: Gemini ends a stream by closing it (there is no [DONE]); a stream without a finishReason is truncated, an error.
        if (!acc.finished) throw new ProviderError("protocol", "stream ended without a finishReason");
        // The usage figure is cumulative in every chunk; one event with the final value, so a consumer that sums events does not double count.
        if (acc.usage) yield { type: "usage", usage: acc.usage };
        yield { type: "done", result: acc.finish() };
      } catch (e) {
        const err = run.normalise(e);
        if (err.partial === undefined && err.kind !== "auth" && err.kind !== "bad_request") err.partial = acc.snapshot();
        throw err;
      } finally {
        run.dispose();
      }
    },
  };
}

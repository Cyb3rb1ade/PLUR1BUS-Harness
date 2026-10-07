import { chunks, readText, Run } from "../client.ts";
import { isRecord, ProviderError } from "../errors.ts";
import { SseParser } from "../sse.ts";
import type { CallOptions, ChatRequest, ChatResult, ChatStreamEvent, Limits, Timeouts } from "../types.ts";
import { classifyGeminiBodyError, classifyGeminiHttpError, makeRedactor } from "./errors.ts";
import { buildGeminiBody, modelId } from "./request.ts";
import { GeminiAccumulator } from "./response.ts";
import type { GeminiAdapter, GeminiConfig } from "./types.ts";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_TIMEOUTS: Timeouts = { headersMs: 60_000, idleMs: 60_000, totalMs: 600_000 };
const DEFAULT_LIMITS: Limits = { maxEventBytes: 4 * 1024 * 1024, maxToolArgumentBytes: 1024 * 1024, maxBodyBytes: 16 * 1024 * 1024 };
const FORBIDDEN_HEADERS = new Set([
  "authorization", "proxy-authorization", "x-goog-api-key", "x-goog-user-project", "cookie", "host", "content-length", "content-type",
  "accept", "transfer-encoding", "connection",
]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const KEY_HEADER = "x-goog-api-key";

function baseOf(baseUrl: string): URL {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new TypeError("baseUrl is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError("baseUrl must be http(s)");
  if (u.username || u.password) throw new TypeError("baseUrl must not carry credentials");
  // The key travels in a header only: a query on the base URL (`?key=…`) is refused outright.
  if (u.search || u.hash) throw new TypeError("baseUrl must not carry a query or fragment");
  u.pathname = u.pathname.replace(/\/+$/, "");
  return u;
}

export function createGeminiAdapter(config: GeminiConfig): GeminiAdapter {
  const base = baseOf(config.baseUrl ?? GEMINI_BASE_URL);
  const extra: [string, string][] = [];
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new TypeError(`header "${k}" is managed by the adapter`);
    if (/[\r\n]/.test(k + v)) throw new TypeError("header contains a line break");
    extra.push([k, v]);
  }
  const doFetch = config.fetch ?? globalThis.fetch;
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const insecureOk = base.protocol === "https:" || LOOPBACK.has(base.hostname) || config.allowInsecureHttp === true;

  function urlFor(model: string, stream: boolean): URL {
    const u = new URL(base);
    u.pathname = `${base.pathname}/models/${modelId(model)}:${stream ? "streamGenerateContent" : "generateContent"}`;
    if (stream) u.search = "?alt=sse"; // the only query: a fixed, non-secret switch
    return u;
  }

  async function begin(req: ChatRequest, opts: CallOptions | undefined, stream: boolean) {
    const body = JSON.stringify(buildGeminiBody(req));
    const url = urlFor(req.model, stream);
    const merged: Timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts, ...opts?.timeouts };
    // RULING: a non-stream call gets its headers only when generation ends, so its headers bound defaults to the total bound.
    if (!stream && opts?.timeouts?.headersMs === undefined && config.timeouts?.headersMs === undefined) merged.headersMs = merged.totalMs;
    const run = new Run(merged, opts?.signal);
    let secret = "";
    const redact = makeRedactor(() => secret);
    try {
      run.throwIfInterrupted();
      let key: string | undefined;
      try { key = await config.credentials.apiKey({ signal: run.signal }); }
      catch (e) {
        if (run.signal.aborted) throw run.interruption(e);
        throw new ProviderError("auth", "credentials provider failed", { cause: e });
      }
      run.throwIfInterrupted();
      // RULING: Gemini has no keyless mode, so a missing key is an `auth` error before any I/O.
      if (key === undefined || key === "") throw new ProviderError("auth", "no API key available");
      if (key.length > 512 || /[\s\x00-\x1f\x7f]/.test(key)) throw new ProviderError("auth", "credentials provider returned an unusable API key");
      if (!insecureOk) throw new ProviderError("bad_request", "refusing to send credentials over plain http to a non-loopback host");
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
        throw classifyGeminiHttpError(res.status, res.headers, text, Date.now(), redact);
      }
      return { run, res, redact };
    } catch (e) {
      run.dispose();
      throw e instanceof ProviderError ? e : run.normalise(e);
    }
  }

  const parseJson = (text: string): unknown => {
    try { return JSON.parse(text); } catch (cause) { throw new ProviderError("protocol", "response body is not valid JSON", { cause }); }
  };

  return {
    async complete(req, opts): Promise<ChatResult> {
      const { run, res, redact } = await begin(req, opts, false);
      try {
        const json = parseJson(await readText(res.body, run, limits.maxBodyBytes));
        if (isRecord(json) && json["error"] !== undefined && json["error"] !== null) throw classifyGeminiBodyError(json, redact);
        const acc = new GeminiAccumulator(redact, limits.maxToolArgumentBytes);
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
          const json = parseJson(await readText(res.body, run, limits.maxBodyBytes));
          if (isRecord(json) && json["error"] !== undefined && json["error"] !== null) throw classifyGeminiBodyError(json, redact);
          throw new ProviderError("protocol", "expected text/event-stream, got a JSON body");
        }
        if (!/^text\/event-stream\b/i.test(type)) throw new ProviderError("protocol", `expected text/event-stream, got "${type.slice(0, 80)}"`);
        if (!res.body) throw new ProviderError("protocol", "response has no body");
        const parser = new SseParser(limits.maxEventBytes);
        const handle = function* (events: ReturnType<SseParser["push"]>): Generator<ChatStreamEvent> {
          for (const ev of events) {
            if (ev.data === "") continue;
            const json = (() => { try { return JSON.parse(ev.data) as unknown; } catch (cause) { throw new ProviderError("protocol", "SSE data is not valid JSON", { cause }); } })();
            if (isRecord(json) && json["error"] !== undefined && json["error"] !== null) throw classifyGeminiBodyError(json, redact);
            yield* acc.push(json);
          }
        };
        for await (const c of chunks(res.body, run)) yield* handle(parser.push(c));
        yield* handle(parser.end());
        // Gemini ends a stream by closing it (no sentinel): only a seen finishReason makes that complete, else it was cut off.
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

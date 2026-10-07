import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS, chunks, FORBIDDEN_HEADERS, LOOPBACK, readText, Run } from "../client.ts";
import { redactAll, isRecord, protocolError, ProviderError } from "../errors.ts";
import { SseParser } from "../sse.ts";
import type { CallOptions, ChatResult, ChatStreamEvent, Limits, Timeouts } from "../types.ts";
import { classifyAnthropicHttp, classifyAnthropicStreamError } from "./errors.ts";
import { buildAnthropicBody } from "./request.ts";
import { AnthropicAccumulator, messageToEvents } from "./response.ts";
import type { AnthropicAdapter, AnthropicConfig, AnthropicRequest } from "./types.ts";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
export const ANTHROPIC_DEFAULT_VERSION = "2023-06-01";
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
const KEY_HEADER = "x-api-key";
const VERSION_HEADER = "anthropic-version";

function endpoint(baseUrl: string): URL {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new TypeError("baseUrl is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError("baseUrl must be http(s)");
  if (u.username || u.password) throw new TypeError("baseUrl must not carry credentials");
  // The key travels in a header only; a query or fragment on the base URL is how keys end up in URLs and logs.
  if (u.search || u.hash) throw new TypeError("baseUrl must not carry a query or fragment");
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/messages`;
  return u;
}

/**
 * The anthropic_messages adapter (`POST {base}/messages`). Same lifetime, abort and timeout machinery as the other
 * adapters (`Run`), a different wire format.
 *
 * Key handling: read from `config.credentials` on every call, sent only as the `x-api-key` header, refused over plain
 * `http:` to a non-loopback host, scrubbed from every provider text the adapter stores. It is never part of the URL,
 * query, body, error message or `cause` the adapter creates itself. A missing key is an `auth` error before any I/O.
 * Route scope: the API-key route only (ADR-005 D12); the Claude Code / Agent SDK route is a different component.
 */
export function createAnthropicAdapter(config: AnthropicConfig): AnthropicAdapter {
  const url = endpoint(config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL);
  const version = config.version ?? ANTHROPIC_DEFAULT_VERSION;
  if (version === "" || /[\x00-\x20\x7f]/.test(version)) throw new TypeError("version must be a non-empty header value without whitespace");
  const defaultMaxTokens = config.defaultMaxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;
  if (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens < 1) throw new TypeError("defaultMaxTokens must be a positive integer");
  const forbidden = new Set([...FORBIDDEN_HEADERS, KEY_HEADER, VERSION_HEADER]);
  const extra: [string, string][] = [];
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (forbidden.has(k.toLowerCase())) throw new TypeError(`header "${k}" is managed by the adapter`);
    if (/[\r\n]/.test(k + v)) throw new TypeError("header contains a line break");
    extra.push([k, v]);
  }
  // RULING: caller-supplied header values (api-key style) are secrets too; they are redacted like the credential.
  const extraSecrets = extra.map(([, v]) => v);
  const doFetch = config.fetch ?? globalThis.fetch;
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const insecureOk = url.protocol === "https:" || LOOPBACK.has(url.hostname) || config.allowInsecureHttp === true;

  async function begin(req: AnthropicRequest, opts: CallOptions | undefined, stream: boolean) {
    const body = JSON.stringify(buildAnthropicBody(req, { stream, defaultMaxTokens, cache: config.cache }));
    const merged: Timeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts, ...opts?.timeouts };
    // RULING: a non-stream call gets its headers only when generation ends, so its headers bound defaults to the total bound.
    if (!stream && opts?.timeouts?.headersMs === undefined && config.timeouts?.headersMs === undefined) merged.headersMs = merged.totalMs;
    const run = new Run(merged, opts?.signal);
    let secret = "";
    const redact = (s: string) => redactAll(s, secret, extraSecrets);
    run.redact = redact;
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
      if (!insecureOk) throw new ProviderError("invalid_request", "refusing to send the API key over plain http to a non-loopback host");
      secret = key;
      const headers = new Headers({ "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" });
      for (const [k, v] of extra) headers.set(k, v);
      headers.set(VERSION_HEADER, version);
      headers.set(KEY_HEADER, key);
      run.armHeaders();
      let res: Response;
      try { res = await doFetch(url, { method: "POST", headers, body, signal: run.signal, redirect: "manual" }); }
      catch (e) { throw run.normalise(e); }
      run.headersArrived();
      if (!res.ok) {
        let text = "";
        try { text = await readText(res.body, run, Math.min(limits.maxBodyBytes, 64 * 1024)); } catch (e) { if (run.signal.aborted) throw run.normalise(e); }
        throw classifyAnthropicHttp(res.status, res.headers, text, Date.now(), redact);
      }
      return { run, res, redact };
    } catch (e) {
      run.dispose();
      throw e instanceof ProviderError ? e : run.normalise(e);
    }
  }

  function parseJson(text: string): unknown {
    try { return JSON.parse(text); } catch (cause) { throw protocolError("response body is not valid JSON", { cause }); }
  }

  return {
    async complete(req, opts): Promise<ChatResult> {
      const { run, res, redact } = await begin(req, opts, false);
      const acc = new AnthropicAccumulator(redact, limits.maxToolArgumentBytes);
      try {
        const json = parseJson(await readText(res.body, run, limits.maxBodyBytes));
        for (const frame of messageToEvents(json)) acc.push(frame);
        return await acc.finish(config.repair, req.tools, run.signal);
      } catch (e) {
        throw run.normalise(e);
      } finally {
        run.dispose();
      }
    },

    async *stream(req, opts): AsyncGenerator<ChatStreamEvent, void, void> {
      const { run, res, redact } = await begin(req, opts, true);
      const acc = new AnthropicAccumulator(redact, limits.maxToolArgumentBytes);
      try {
        const type = res.headers.get("content-type") ?? "";
        if (/^application\/(\w+\+)?json\b/i.test(type)) {
          // A 200 JSON body on a stream request: an error object some gateways send in place of an SSE stream, else a server that ignored `stream`.
          const json = parseJson(await readText(res.body, run, limits.maxBodyBytes));
          if (isRecord(json) && json["type"] === "error") throw classifyAnthropicStreamError(json, redact);
          throw protocolError("expected text/event-stream, got a JSON body");
        }
        if (!/^text\/event-stream\b/i.test(type)) throw protocolError(`expected text/event-stream, got "${redact(type.slice(0, 80))}"`);
        if (!res.body) throw protocolError("response has no body");
        const parser = new SseParser(limits.maxEventBytes);
        const handle = function* (events: ReturnType<SseParser["push"]>): Generator<ChatStreamEvent> {
          for (const ev of events) {
            if (ev.data === "") continue; // keep-alive
            let json: unknown;
            try { json = JSON.parse(ev.data); } catch (cause) { throw protocolError("SSE data is not valid JSON", { cause }); }
            yield* acc.push(json);
          }
        };
        for await (const c of chunks(res.body, run)) {
          yield* handle(parser.push(c));
          if (acc.finished) break; // message_stop is the last event; whatever the server does with the connection afterwards is not our concern
        }
        if (!acc.finished) {
          yield* handle(parser.end());
          // RULING: Anthropic ends a stream with `message_stop` (there is no [DONE]); a stream that closes without it is truncated, an error.
          if (!acc.finished) throw protocolError("stream ended without message_stop");
        }
        const usage = acc.usage;
        // The usage figures are cumulative; one event after `finish` with the final value, so a consumer that sums events does not double count.
        if (usage !== undefined) yield { type: "usage", usage };
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

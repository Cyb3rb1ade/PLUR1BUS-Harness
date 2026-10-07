import { DEFAULT_LIMITS, DEFAULT_TIMEOUTS, chunks, FORBIDDEN_HEADERS, LOOPBACK, readText, Run } from "../client.ts";
import { redactAll, isRecord, protocolError, ProviderError } from "../errors.ts";
import { SseParser } from "../sse.ts";
import type { CallOptions, ChatResult, ChatStreamEvent, Limits, Timeouts } from "../types.ts";
import { classifyResponsesHttp, classifyResponsesStreamError } from "./errors.ts";
import { buildResponsesBody } from "./request.ts";
import { ResponsesAccumulator, responseToEvents } from "./response.ts";
import type { ResponsesAdapter, ResponsesConfig, ResponsesRequest } from "./types.ts";

export const RESPONSES_DEFAULT_BASE_URL = "https://api.openai.com/v1";

function endpoint(baseUrl: string): URL {
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new TypeError("baseUrl is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new TypeError("baseUrl must be http(s)");
  if (u.username || u.password) throw new TypeError("baseUrl must not carry credentials");
  // The credential travels in a header only; a query or fragment on the base URL is how keys end up in URLs and logs.
  if (u.search || u.hash) throw new TypeError("baseUrl must not carry a query or fragment");
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/responses`;
  return u;
}

/**
 * The codex_responses adapter (OpenAI Responses API, `POST {base}/responses`). Same lifetime, abort and timeout
 * machinery as the other adapters (`Run`), a different wire format.
 *
 * Credential handling is chat_completions': a ready-made `Authorization` value from `config.credentials` on every call,
 * sent only as that header, refused over plain `http:` to a non-loopback host, scrubbed from every provider text the
 * adapter stores. The `chatgpt_plan` profile is a SWITCH only (stateless streaming, narrower request; see
 * `ResponsesProfile`): no OAuth lives here, the caller supplies the token and any account headers.
 */
export function createResponsesAdapter(config: ResponsesConfig): ResponsesAdapter {
  const url = endpoint(config.baseUrl ?? RESPONSES_DEFAULT_BASE_URL);
  const profile = config.profile ?? "openai";
  if (profile !== "openai" && profile !== "chatgpt_plan") throw new TypeError("profile must be \"openai\" or \"chatgpt_plan\"");
  if (profile === "chatgpt_plan" && config.store === true) throw new TypeError("the chatgpt_plan profile cannot store responses (store must not be true)");
  const forbidden = new Set(FORBIDDEN_HEADERS);
  const extra: [string, string][] = [];
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (forbidden.has(k.toLowerCase())) throw new TypeError(`header "${k}" is managed by the adapter`);
    if (/[\r\n]/.test(k + v)) throw new TypeError("header contains a line break");
    extra.push([k, v]);
  }
  // RULING: caller-supplied header values (account ids, api-key style headers) are secrets too; they are redacted like the credential.
  const extraSecrets = extra.map(([, v]) => v);
  const doFetch = config.fetch ?? globalThis.fetch;
  const limits: Limits = { ...DEFAULT_LIMITS, ...config.limits };
  const insecureOk = url.protocol === "https:" || LOOPBACK.has(url.hostname) || config.allowInsecureHttp === true;

  async function begin(req: ResponsesRequest, opts: CallOptions | undefined, stream: boolean) {
    const o = req.providerOptions?.responses;
    const body = JSON.stringify(buildResponsesBody(req, {
      stream, profile, store: config.store ?? false,
      reasoningEffort: o?.reasoningEffort ?? config.reasoningEffort,
      reasoningSummary: o?.reasoningSummary ?? config.reasoningSummary,
    }));
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
        throw classifyResponsesHttp(res.status, res.headers, text, Date.now(), redact);
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

  async function* stream(req: ResponsesRequest, opts?: CallOptions): AsyncGenerator<ChatStreamEvent, void, void> {
    const { run, res, redact } = await begin(req, opts, true);
    const acc = new ResponsesAccumulator(redact, limits.maxToolArgumentBytes);
    try {
      const type = res.headers.get("content-type") ?? "";
      if (/^application\/(\w+\+)?json\b/i.test(type)) {
        // A 200 JSON body on a stream request: an error object some gateways send in place of an SSE stream, else a server that ignored `stream`.
        const json = parseJson(await readText(res.body, run, limits.maxBodyBytes));
        if (isRecord(json) && isRecord(json["error"])) throw classifyResponsesStreamError(json, redact);
        throw protocolError("expected text/event-stream, got a JSON body");
      }
      if (!/^text\/event-stream\b/i.test(type)) throw protocolError(`expected text/event-stream, got "${redact(type.slice(0, 80))}"`);
      if (!res.body) throw protocolError("response has no body");
      const parser = new SseParser(limits.maxEventBytes);
      const handle = function* (events: ReturnType<SseParser["push"]>): Generator<ChatStreamEvent> {
        for (const ev of events) {
          if (ev.data === "" || ev.data === "[DONE]") continue; // keep-alive; a gateway's [DONE] carries nothing this wire needs
          let json: unknown;
          try { json = JSON.parse(ev.data); } catch (cause) { throw protocolError("SSE data is not valid JSON", { cause }); }
          yield* acc.push(json);
        }
      };
      for await (const c of chunks(res.body, run)) {
        yield* handle(parser.push(c));
        if (acc.finished) break; // the terminal event is the last one; whatever the server does with the connection afterwards is not our concern
      }
      if (!acc.finished) {
        yield* handle(parser.end());
        // RULING: the Responses stream ends with `response.completed` / `response.incomplete`; one that closes without it is truncated, an error.
        if (!acc.finished) throw protocolError("stream ended without response.completed");
      }
      const usage = acc.usage;
      if (usage !== undefined) yield { type: "usage", usage };
      yield { type: "done", result: await acc.finish(config.repair, req.tools, run.signal) };
    } catch (e) {
      const err = run.normalise(e);
      if (err.partial === undefined && err.kind !== "auth" && !(err.kind === "invalid_request" && !err.contentFiltered)) err.partial = acc.snapshot();
      throw err;
    } finally {
      run.dispose();
    }
  }

  return {
    async complete(req, opts): Promise<ChatResult> {
      if (profile === "chatgpt_plan") {
        // RULING: that backend only streams; the call streams on the wire and the result is the one the stream ends with.
        for await (const ev of stream(req, opts)) if (ev.type === "done") return ev.result;
        throw protocolError("stream ended without a result");
      }
      const { run, res, redact } = await begin(req, opts, false);
      const acc = new ResponsesAccumulator(redact, limits.maxToolArgumentBytes);
      try {
        const json = parseJson(await readText(res.body, run, limits.maxBodyBytes));
        for (const frame of responseToEvents(json)) acc.push(frame);
        return await acc.finish(config.repair, req.tools, run.signal);
      } catch (e) {
        throw run.normalise(e);
      } finally {
        run.dispose();
      }
    },
    stream,
  };
}
